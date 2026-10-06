# Environment Variables Reference

aza-pg supports comprehensive configuration through environment variables. Variables are auto-detected where possible (RAM, CPU) and provide safe defaults.

## PostgreSQL Auto-Configuration

Auto-tuning from container resource limits (cgroup v2) and system memory.

| Variable                            | Default       | Description                                                                                                                                                |
| ----------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_MEMORY`                   | Auto-detected | RAM in MB, a plain integer (bypasses auto-detection). Range: 512–1048576 MB                                                                                |
| `POSTGRES_WORKLOAD_TYPE`            | `mixed`       | `web` (200 conn), `oltp` (300), `dw` (100, stats=500), `mixed` (120); connections are cut by 15–50% below 8 GB RAM; an unknown value falls back to `mixed` |
| `POSTGRES_STORAGE_TYPE`             | `ssd`         | `ssd` (cost=1.1, io=200), `hdd` (cost=4.0, io=2), `san` (cost=1.1, io=300); an unknown value falls back to `ssd`                                           |
| `POSTGRES_MAX_WORKER_PROCESSES`     | Auto          | `max_worker_processes`; default CPU+1 (≤4 cores) or CPU×1.5, always clamped to 8–64                                                                        |
| `POSTGRES_SHARED_PRELOAD_LIBRARIES` | See below     | Comma-separated preload modules                                                                                                                            |
| `DISABLE_DATA_CHECKSUMS`            | `false`       | Set `true` to disable (not recommended). Read only when the data directory is created                                                                      |

**Default preload**: `auto_explain,pg_cron,pg_net,pg_stat_monitor,pg_stat_statements,pgaudit,pgsodium,safeupdate,supabase_vault,timescaledb`

**Optional preload**: `supautils`, `set_user`, `pg_partman_bgw`, `plan_filter` (pg_plan_filter)

## PostgreSQL Connection

| Variable            | Default         | Description                                                                                                                                                                                                                                                                             |
| ------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_USER`     | `postgres`      | Database superuser                                                                                                                                                                                                                                                                      |
| `POSTGRES_PASSWORD` | **(required)**  | Superuser password (16+ chars recommended)                                                                                                                                                                                                                                              |
| `POSTGRES_DB`       | `POSTGRES_USER` | Initial database; also where the default extensions and pg_cron go. The stacks default it to `postgres`                                                                                                                                                                                 |
| `POSTGRES_BIND_IP`  | `127.0.0.1`     | Stacks: host address the port is published on (PostgreSQL itself listens on the stack's Docker networks). Lone container: PostgreSQL's listen address; the default lets only this container connect, so set `0.0.0.0` to use a published port. `127.0.0.1`, `0.0.0.0`, or a specific IP |
| `POSTGRES_PORT`     | Stack-specific  | `5432` (primary/single), `5433` (replica)                                                                                                                                                                                                                                               |

`POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB` also accept a `_FILE` variant (e.g. `POSTGRES_PASSWORD_FILE`) naming a file to read the value from, such as a Docker secret.

## Replication

| Variable                           | Default                           | Description                                                                                                                                                                                |
| ---------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POSTGRES_WAL_LEVEL`               | `logical`                         | `minimal`, `replica` or `logical`. The stacks set `minimal` (single), `replica` (replica), `logical` (primary)                                                                             |
| `POSTGRES_OUTPUT_PLUGIN_LIBRARIES` | `pgoutput,test_decoding,wal2json` | Logical decoding plugins that replication slots may use (`output_plugin_libraries`, PostgreSQL 18.6+ refuses any other). Comma-separated; keep `pgoutput` for built-in logical replication |
| `PG_REPLICATION_PASSWORD`          | **(required for replication)**    | Password of the `replicator` role, created with the slot when the data directory is created; unset skips both                                                                              |
| `REPLICATION_SLOT_NAME`            | `replica_slot_1`                  | Physical replication slot name (letters, digits, `_`)                                                                                                                                      |
| `POSTGRES_ROLE`                    | `primary`                         | `replica` makes the healthcheck accept a server in recovery; the replica stack sets it                                                                                                     |
| `PRIMARY_HOST`                     | **(required for replica)**        | Primary server hostname                                                                                                                                                                    |
| `PRIMARY_PORT`                     | `5432`                            | Primary server port                                                                                                                                                                        |

## pgsodium

| Variable               | Default | Description                                                                                                                                                                                                 |
| ---------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PGSODIUM_KEY_FILE`    | unset   | Path inside the container to a file holding the 64-hex-character pgsodium root key; unset, a random key is created as `pgsodium_root.key` in the data directory. See [PGSODIUM-SETUP.md](PGSODIUM-SETUP.md) |
| `ENABLE_PGSODIUM_INIT` | `false` | `true` also creates a `pgsodium_root` row in `pgsodium.key` when the data directory is created; Vault does not need it. See [PGSODIUM-SETUP.md](PGSODIUM-SETUP.md)                                          |

## PgBouncer (Primary Stack Only)

| Variable                      | Default        | Description                                                                                   |
| ----------------------------- | -------------- | --------------------------------------------------------------------------------------------- |
| `PGBOUNCER_AUTH_PASS`         | **(required)** | Auth user password                                                                            |
| `PGBOUNCER_LISTEN_ADDR`       | `0.0.0.0`      | Listen address inside the container; `127.0.0.1` cuts off the exporter and the published port |
| `PGBOUNCER_BIND_IP`           | `127.0.0.1`    | Host address the port is published on                                                         |
| `PGBOUNCER_PORT`              | `6432`         | Host port                                                                                     |
| `PGBOUNCER_SERVER_SSLMODE`    | `prefer`       | TLS mode: `disable`, `allow`, `prefer`, `require`, `verify-ca`, `verify-full`                 |
| `PGBOUNCER_MAX_CLIENT_CONN`   | `200`          | Max client connections                                                                        |
| `PGBOUNCER_DEFAULT_POOL_SIZE` | `25`           | Pool size per database                                                                        |

## Container Resources

| Variable                          | Primary | Replica/Single | Description             |
| --------------------------------- | ------- | -------------- | ----------------------- |
| `POSTGRES_MEMORY_LIMIT`           | `2048m` | `512m`         | Hard memory limit       |
| `POSTGRES_MEMORY_RESERVATION`     | `1024m` | `256m`         | Soft memory reservation |
| `POSTGRES_CPU_LIMIT`              | `2`     | `0.5`          | CPU cores               |
| `PGBOUNCER_MEMORY_LIMIT`          | `200m`  | N/A            | PgBouncer memory        |
| `POSTGRES_EXPORTER_MEMORY_LIMIT`  | `64m`   | `64m`          | Prometheus exporter     |
| `PGBOUNCER_EXPORTER_MEMORY_LIMIT` | `32m`   | N/A            | PgBouncer exporter      |

Each `*_MEMORY_LIMIT` has a matching `*_MEMORY_RESERVATION` (half the limit by default).

## Networking

| Variable                     | Default                                          | Description                                                                             |
| ---------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `COMPOSE_PROJECT_NAME`       | `aza-pg` (`aza-pg-replica` in the replica stack) | Compose project, also the container-name prefix; stacks on one host need different ones |
| `POSTGRES_NETWORK_NAME`      | Stack-specific                                   | Internal network name                                                                   |
| `MONITORING_NETWORK`         | `monitoring`                                     | External monitoring network                                                             |
| `POSTGRES_EXPORTER_BIND_IP`  | `127.0.0.1`                                      | Exporter bind address                                                                   |
| `POSTGRES_EXPORTER_PORT`     | Stack-specific                                   | `9187` (primary), `9188` (replica), `9189` (single)                                     |
| `PGBOUNCER_EXPORTER_BIND_IP` | `127.0.0.1`                                      | PgBouncer exporter bind address (primary only)                                          |
| `PGBOUNCER_EXPORTER_PORT`    | `9127`                                           | PgBouncer exporter host port (primary only)                                             |

## Storage

| Variable                 | Default           | Description                  |
| ------------------------ | ----------------- | ---------------------------- |
| `POSTGRES_DATA_VOLUME`   | Stack-specific    | Data volume name             |
| `POSTGRES_BACKUP_VOLUME` | `postgres_backup` | Backup volume (primary only) |

## Images

| Variable                   | Default                                       | Description                                   |
| -------------------------- | --------------------------------------------- | --------------------------------------------- |
| `POSTGRES_IMAGE`           | `ghcr.io/fluxo-kt/aza-pg:18`                  | PostgreSQL image (use versioned tag for prod) |
| `POSTGRES_EXPORTER_IMAGE`  | Digest-pinned in the stack's `compose.yml`    | Prometheus exporter                           |
| `PGBOUNCER_IMAGE`          | Digest-pinned in `stacks/primary/compose.yml` | PgBouncer (primary only)                      |
| `PGBOUNCER_EXPORTER_IMAGE` | Digest-pinned in `stacks/primary/compose.yml` | PgBouncer exporter (primary only)             |

## Stack Defaults

| Stack       | WAL Level | Memory                | Includes                         |
| ----------- | --------- | --------------------- | -------------------------------- |
| **primary** | `logical` | 2GB + 200MB PgBouncer | Postgres + PgBouncer + exporters |
| **replica** | `replica` | 512MB                 | Postgres + exporter              |
| **single**  | `minimal` | 512MB                 | Postgres + exporter              |

## Usage Examples

```bash
# Development
cd stacks/single && cp .env.example .env
# Edit: POSTGRES_PASSWORD=<strong-password>
docker compose up -d

# Custom RAM + workload: put them in .env (the stacks pass .env into the container; a variable set on the
# docker compose command line only fills compose's own ${...} and never reaches PostgreSQL)
echo 'POSTGRES_MEMORY=4096' >> .env && echo 'POSTGRES_WORKLOAD_TYPE=oltp' >> .env
docker compose up -d
```

## Security Notes

- Never commit `.env` files with real passwords
- Use `chmod 600 .env` on production servers
- The stacks default to the floating `:18` tag; pin a versioned tag or digest in production
- Replication requires matching passwords across primary and replica
