# Upgrading aza-pg

Guide for upgrading PostgreSQL major versions, extensions, and handling breaking changes.

## Table of Contents

- [PostgreSQL Major Version Upgrades](#postgresql-major-version-upgrades)
- [Updating the Image (Same PostgreSQL Major)](#updating-the-image-same-postgresql-major)
- [Extension Updates](#extension-updates)
- [Breaking Changes](#breaking-changes)
- [Rollback Procedures](#rollback-procedures)

## Important: Codebase vs Runtime

This guide covers **runtime upgrade procedures** (upgrading a running production database).

**Before upgrading production**, ensure the codebase declares the target version:

```bash
# Check current PostgreSQL version in codebase
grep pgVersion scripts/extensions/manifest-data.ts
```

**If version needs updating**: See [VERSION-MANAGEMENT.md](VERSION-MANAGEMENT.md#procedure-1-update-nixpkgs-and-postgresql) to update version declarations in the codebase, regenerate, and rebuild the image.

**Then return here** to upgrade the running database.

---

## PostgreSQL Major Version Upgrades

### Prerequisites

1. **Full backup** of all databases, plus a private copy of the pgsodium root key (`$PGDATA/pgsodium_root.key`, or the file `PGSODIUM_KEY_FILE` names): a dump does not carry it, and Vault secrets restored from one decrypt only under it ([PGSODIUM-SETUP.md](PGSODIUM-SETUP.md))
2. **Test upgrade** on development/staging environment first
3. **Verify extension compatibility** with new Postgres version
4. **Plan downtime window** (typically 5-30 minutes depending on database size)

### Upgrade Path: PostgreSQL 18 → 19 (Example)

#### Step 1: Update Version in Manifest

Edit `scripts/extensions/manifest-data.ts` and update:

```typescript
// flake.nix builds nixpkgs' postgresql_<major of pgVersion> and refuses to build unless
// pgVersion equals that package's version, so set it to the one nixpkgs (flake.lock) ships:
export const MANIFEST_METADATA = {
  pgVersion: "19.0", // Changed from 18.x
  ...
};
```

#### Step 2: Verify Extension Compatibility

Check each extension supports PostgreSQL 19:

- pgvector: https://github.com/pgvector/pgvector/releases
- pg_cron: https://github.com/citusdata/pg_cron/releases
- pgAudit: https://github.com/pgaudit/pgaudit/releases

Update `scripts/extensions/manifest-data.ts` with compatible versions.

#### Step 3: Regenerate and Build

```bash
# Regenerate the manifest flake.nix reads
bun run generate

# Build the image (tagged aza-pg:pg<major of pgVersion>)
bun run build

# Verify PostgreSQL version
docker run --rm aza-pg:pg19 postgres --version
```

#### Step 4: Test Locally

```bash
# Deploy test instance
cd stacks/single
cp .env.example .env
# Edit POSTGRES_IMAGE=aza-pg:pg19
docker compose up -d

# Verify extensions load
docker compose exec postgres psql -U postgres -c "\dx"
```

#### Step 5: Perform pg_upgrade (Production)

**Option A: Automatic upgrade at start** (recommended)

Point `POSTGRES_IMAGE` at the new major's release and start the stack on the same data volume:

```bash
docker compose pull && docker compose up -d
docker compose logs -f postgres   # [MAJOR-UPGRADE] and [AUTO-CONFIG] lines report each step
```

The entrypoint finds the previous major's cluster (`/var/lib/postgresql/18/docker`) beside an empty PGDATA and upgrades it before any client connects:

- It downloads the previous release's server from its registry (digest-checked, removed when done) and runs `pg_upgrade`, with `--clone` where the filesystem supports reflinks, else `--link` when both directories share a filesystem (neither copies data files, so its time does not grow with the data), else `--copy` (PGDATA on its own mount: slower, needs the space).
- It carries everything else in the old data directory: `pg_hba.conf`, `ALTER SYSTEM` settings, the pgsodium root key, TLS files.
- Its first-start migration then updates every extension, analyses statistics `pg_upgrade` does not carry, and runs `pgbackrest stanza-upgrade` for each configured stanza. The repository must be reachable. Unmeasured: the stanza's next backup is expected to be a full one.
- On any failure the container stops and the old cluster is left as it was: the previous image still starts on it.

The old cluster stays in the volume (the log names it). With `--clone` or `--copy` it is a complete rollback: start the previous image with `PGDATA` set to it. Once it has run, this image refuses to start on the upgraded PGDATA, since each may then hold writes the other lacks: delete PGDATA to upgrade the old cluster again (losing writes made in PGDATA since the upgrade), or delete the old cluster to keep PGDATA. With `--link` it is unusable once the new server has started. Delete it when you no longer need it.

The container stops instead of upgrading, naming the reason, for a **replica** (upgrade the primary, then re-clone the replica from it) and on an image that does not carry the upgrade, and for a cluster of a major other than the one the image upgrades from.

**Option B: Backup → Restore** (slower, safer)

```bash
# Backup from old version
bun scripts/tools/backup-postgres.ts postgres backup-pg18.sql.gz

# Copy the pgsodium root key out first: it lives in the data volume, the dump does not carry it, and Vault
# secrets in the dump decrypt only under it (docs/PGSODIUM-SETUP.md)
(umask 077; docker compose exec -T -u postgres postgres sh -c 'cat "$PGDATA/pgsodium_root.key"' > pgsodium_root.key)

# Deploy new version with fresh data directory; set PGSODIUM_KEY_FILE in .env to the copy, mounted into the
# container, before this first start
docker compose down
docker volume rm postgres_data # or your POSTGRES_DATA_VOLUME
docker compose up -d

# Wait for Postgres ready
bun scripts/test/wait-for-postgres.ts

# Restore backup
bun scripts/tools/restore-postgres.ts backup-pg18.sql.gz postgres
```

#### Step 6: Extension Versions

Nothing to run: the first start on a new image updates every extension created in each database to the version the image ships, before clients connect (see "Major Extension Updates" below).

#### Step 7: Verify and Optimize

```sql
-- Analyze all databases
VACUUM ANALYZE;

-- Check for outdated statistics
SELECT * FROM pg_stat_database WHERE stats_reset < NOW() - INTERVAL '7 days';

-- Verify replication (if using replicas)
SELECT * FROM pg_stat_replication;
```

## Updating the Image (Same PostgreSQL Major)

A newer image starts on your existing data volume and brings the extensions inside existing databases up to its versions itself ([Extension Updates](#extension-updates)). The `Breaking` and `Security` entries of every release you skip over in [CHANGELOG.md](../CHANGELOG.md) name the steps that release needs, some of them before the switch; do those first.

1. Back up the databases and the pgsodium root key (see [Prerequisites](#prerequisites)): `pg_dump` does not include the key.
2. Start the new container. Before it accepts connections, it updates every extension created in each database to the version the image ships (see [Extension Updates](#extension-updates)); if one cannot be updated, the server does not start and the log names the database and the step to take.

   **When the image changes glibc, that first start also rebuilds indexes, which can take a while.** A glibc version can change how libc collations such as `en_US.utf8` (the default of every cluster created before the builtin collation) sort, which leaves text indexes built under the old one silently missing rows. Between glibc versions measured to sort `en_US.utf8` the same (Debian's 2.41 and the Nix image's 2.44 are), the entrypoint only records the new version. For any other change it rebuilds, in each database, every index that orders or filters by such a collation, then records the new version. Clients cannot connect until it is done; the log names each database and its rebuilt index count. Time it on a copy of a large database before upgrading production. Two things cannot be rebuilt and stop the container, which names them: range partitioning on such a text column (rows may now belong in another partition: move them, e.g. detach the partitions and re-insert their rows), and a `CHECK` that compares text with `<`, `<=`, `>` or `>=` (rows may now fail it: fix them, then drop and re-add the constraint). Then start the container again.

3. pgflow keeps its schema version until you run `docker exec <container> pgflow-upgrade` (see [PGFLOW.md](PGFLOW.md)).
4. If the log warns that pgsodium uses the published key, rotate it: [PGSODIUM-SETUP.md](PGSODIUM-SETUP.md#rotating-the-published-key).

## Extension Updates

> **Note:** This section covers upgrading extensions in a **running database**.
>
> To update the extension **version declared in the codebase** (before building a new image), see:
>
> - [VERSION-MANAGEMENT.md - Procedure 2](VERSION-MANAGEMENT.md#procedure-2-update-an-extension-git-tag) (Procedure 3 for cargo-pgrx extensions)

### Minor Version Updates (e.g., pgvector 0.8.1 → 0.8.2)

#### Steps 1–2: Update the Manifest

Change the version in `scripts/extensions/manifest-data.ts` and run `bun run generate`, following [VERSION-MANAGEMENT.md](VERSION-MANAGEMENT.md) (Procedure 2; Procedure 3 for cargo-pgrx extensions).

#### Step 3: Rebuild and Test

```bash
bun run build

# Test in development
cd stacks/single
docker compose down
docker compose up -d

# Verify extension version
docker compose exec postgres psql -U postgres -c "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';"
```

#### Step 4: Apply to Production

```bash
# Deploy new image: set POSTGRES_IMAGE in .env to a versioned tag (e.g. 18.6-<timestamp>) or digest
docker compose pull postgres

# Rolling update (one instance at a time)
docker compose up -d --no-deps postgres

# Verify
docker compose exec postgres psql -U postgres -c "\dx vector"
```

### Major Extension Updates (Breaking Changes)

The first start on a new image runs `ALTER EXTENSION … UPDATE` for every extension created in each database whose version the image changed, before clients connect; extensions nobody created are left alone. An extension upstream ships without an update path is dropped and recreated in the same schema, unless it owns tables (then the container stops and names the export, recreate and restore steps) or other objects depend on it (PostgreSQL's error names them). An extension the new image no longer ships is dropped when its own tables hold no rows; if they hold rows, the container stops and names the table to export first. If any update fails, the server does not start and the log names the database and the error; fix the cause and start again, since every step is retried. Read the CHANGELOG before upgrading: an upstream release can still need action before its update can run.

## Breaking Changes

### Config File Changes

If `postgresql.conf` format changes between versions:

1. Compare old vs new default configs
2. Merge custom settings carefully
3. Test with `postgres --config-file=/path/to/test.conf -C <param>` to validate

### Removed/Renamed Parameters

PostgreSQL sometimes removes deprecated settings:

```bash
# Check for deprecated settings
docker compose exec postgres postgres -C <parameter-name>

# If error: "unrecognized configuration parameter"
# Remove from postgresql.conf
```

## Rollback Procedures

### Immediate Rollback (Within 1 Hour)

```bash
# Stop new version
docker compose down

# Restore old image
docker compose up -d  # Using old tag/digest

# Restore backup if data corrupted
bun scripts/tools/restore-postgres.ts backup-pre-upgrade.sql.gz postgres
```

### Delayed Rollback (After pg_upgrade)

**WARNING:** pg_upgrade is one-way. Rollback requires restore from backup.

```bash
# Deploy old version
docker pull ghcr.io/fluxo-kt/aza-pg:18

# Start it on a new, empty data volume: in .env set POSTGRES_IMAGE to the 18 image, POSTGRES_DATA_VOLUME to a new
# name (e.g. postgres_data_rollback) and PGSODIUM_KEY_FILE to the key copy taken before the upgrade, then
docker compose up -d

# Restore backup
bun scripts/tools/restore-postgres.ts backup-pre-upgrade.sql.gz postgres
```

## Best Practices

1. **Test upgrades** on development environment first
2. **Backup before every major change** (automated + manual verification)
3. **Monitor logs** during and after upgrade for errors
4. **Staged rollout** for production (upgrade replicas first, verify, then primary)
5. **Keep old backups** for at least 30 days after upgrade
6. **Document custom changes** in your own UPGRADE_NOTES.md

## Troubleshooting

### Extension Load Failures

```sql
-- Check extension files exist
SELECT * FROM pg_available_extensions WHERE name = 'vector';

-- Check shared_preload_libraries
SHOW shared_preload_libraries;

-- Reload config (if changed without restart)
SELECT pg_reload_conf();
```

### Replication Issues After Upgrade

```sql
-- Check replication status
SELECT * FROM pg_stat_replication;

-- If replica lagging, verify versions match
SELECT version();  -- Run on both primary and replica
```

### Performance Regression

```sql
-- Update table statistics
ANALYZE VERBOSE;

-- Check for bloat
SELECT schemaname, tablename,
       pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
LIMIT 20;

-- VACUUM FULL if needed (requires downtime)
VACUUM FULL ANALYZE;
```

## Resources

- [PostgreSQL Upgrade Documentation](https://www.postgresql.org/docs/current/upgrading.html)
- [pg_upgrade Documentation](https://www.postgresql.org/docs/current/pgupgrade.html)
- [Extension Compatibility Matrix](https://www.postgresql.org/support/versioning/)
