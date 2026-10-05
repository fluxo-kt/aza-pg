# pgBackRest: continuous archiving and point-in-time recovery

pgBackRest ships in the image. It runs inside the postgres container: `archive_command` runs there, and pgBackRest reaches PostgreSQL through the local socket. `examples/backup/compose.yml` adds its settings (`PGBACKREST_*` variables, so every command sees the same stanza and paths) and the backup volume to a primary or single stack. For logical dumps with pg_dump, see [OPERATIONS.md](OPERATIONS.md#database-backup).

## Set up

From the stack directory (`stacks/primary` or `stacks/single`):

```bash
# 1. Make every docker compose command in this directory include the pgBackRest settings and the backup volume
#    (/backup), then start the stack
echo 'COMPOSE_FILE=compose.yml:../../examples/backup/compose.yml' >> .env
docker compose up -d

# 2. Turn on WAL archiving (ALTER SYSTEM outranks the stack's postgresql.conf); archive_mode needs a restart
docker compose exec postgres psql -U postgres -c "ALTER SYSTEM SET archive_mode = on"
docker compose exec postgres psql -U postgres -c "ALTER SYSTEM SET archive_command = 'pgbackrest archive-push %p'"
docker compose restart postgres

# 3. Create the stanza, then check that WAL really reaches the repository
docker compose exec postgres pgbackrest stanza-create
docker compose exec postgres pgbackrest check
```

`COMPOSE_FILE` matters beyond setup: `docker compose run` (restore) builds its container from the compose files, and an `up` without the settings leaves `archive_command` failing while WAL piles up in `pg_wal`. Copying the settings into your own compose file works as well.

## Back up

```bash
docker compose exec postgres pgbackrest backup --type=full   # first backup, then e.g. weekly
docker compose exec postgres pgbackrest backup --type=diff   # changes since the last full
docker compose exec postgres pgbackrest backup --type=incr   # changes since the last backup
docker compose exec postgres pgbackrest info                 # backups, their stop times, WAL range
```

Retention (in `examples/backup/compose.yml`): 7 full backups, 4 differential; older backups and the WAL only they need are expired after each backup.

Schedule from the host's cron (`docker exec` sees the container's `PGBACKREST_*` variables):

```bash
0 2 * * 0   docker exec aza-pg-postgres-primary pgbackrest backup --type=full
0 2 * * 1-6 docker exec aza-pg-postgres-primary pgbackrest backup --type=diff
0 */6 * * * docker exec aza-pg-postgres-primary pgbackrest backup --type=incr
```

## Restore

Restore writes into the data volume, so the server must be stopped; `docker compose run` starts a one-off container of the same service (same volumes and settings) for it. `--delta` rewrites only the files that differ.

```bash
docker compose stop postgres

# Latest state: the last backup plus all archived WAL
docker compose run --rm postgres pgbackrest restore --delta

# Or a point in time, e.g. just before a bad DROP TABLE
docker compose run --rm postgres pgbackrest restore --delta \
  --type=time --target="2026-10-05 14:30:00+00" --target-action=promote

docker compose start postgres
```

The target time must be at least a second past the stop time of some backup (`pgbackrest info` records it in whole seconds); otherwise restore fails with "unable to find backup set with stop time less than". `--type=xid --target=<transaction id>` and `--type=lsn` work the same way.

## Off-site repository

A repository on the same host survives a lost container, not a lost host. Add a second repository in S3-compatible storage through the same variables. `archive-push` then sends WAL to both; a backup goes to one, repo1 unless you pass `--repo=2`, so schedule backups for each:

```yaml
services:
  postgres:
    environment:
      PGBACKREST_REPO2_TYPE: s3
      PGBACKREST_REPO2_PATH: /aza-pg
      PGBACKREST_REPO2_S3_BUCKET: my-backup-bucket
      PGBACKREST_REPO2_S3_ENDPOINT: s3.amazonaws.com
      PGBACKREST_REPO2_S3_REGION: us-east-1
      PGBACKREST_REPO2_S3_KEY: ${S3_KEY}
      PGBACKREST_REPO2_S3_KEY_SECRET: ${S3_KEY_SECRET}
      PGBACKREST_REPO2_RETENTION_FULL: "4"
```

Run `pgbackrest stanza-create` again after adding it.

## Monitor

```sql
-- Archiving: failed_count growing, or last_archived_time far behind, means WAL is not leaving the server
SELECT archived_count, failed_count, last_archived_wal, last_archived_time, last_failed_time
FROM pg_stat_archiver;
```

```bash
docker compose exec postgres pgbackrest check    # archive_command works end to end
docker compose exec postgres pgbackrest verify   # repository contents are intact
```

Test a restore regularly (into a scratch stack, from the same repository): a backup that was never restored is not known to work.

## Troubleshooting

| Symptom                                                       | Cause and fix                                                                                                                      |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `archive command failed` in `docker compose logs postgres`    | Settings missing (stack started without the override) or stanza not created; run `pgbackrest check` for pgBackRest's own message   |
| `pg_wal` keeps growing                                        | Archiving fails, so PostgreSQL keeps every segment; fix the failure above, archiving catches up on its own                         |
| `WARN: environment contains invalid option`                   | A variable named `PGBACKREST_*` that is not a pgBackRest option (the stacks pass their whole `.env` into the container); rename it |
| Restore: `unable to find backup set with stop time less than` | The target is not past any backup's stop time (whole seconds, `pgbackrest info`); pick a later target                              |

Logs: `/var/log/pgbackrest/` in the container. Reference: [pgbackrest.org](https://pgbackrest.org/).
