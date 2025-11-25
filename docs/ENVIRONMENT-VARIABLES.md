# Environment Variables Reference

aza-pg supports comprehensive configuration through environment variables. Variables are auto-detected where possible (RAM, CPU) and provide safe defaults.

## PostgreSQL Auto-Configuration

Auto-tuning from container resource limits (cgroup v2) and system memory.

| Variable                            | Default       | Description                                                                |
| ----------------------------------- | ------------- | -------------------------------------------------------------------------- |
| `POSTGRES_MEMORY`                   | Auto-detected | RAM in MB (bypasses auto-detection). Range: 512–1048576 MB                 |
| `POSTGRES_WORKLOAD_TYPE`            | `mixed`       | `web` (200 conn), `oltp` (300), `dw` (100, stats=500), `mixed` (120)       |
| `POSTGRES_STORAGE_TYPE`             | `ssd`         | `ssd` (cost=1.1, io=200), `hdd` (cost=4.0, io=2), `san` (cost=1.1, io=300) |
| `POSTGRES_SHARED_PRELOAD_LIBRARIES` | See below     | Comma-separated preload modules                                            |
| `DISABLE_DATA_CHECKSUMS`            | `false`       | Set `true` to disable (not recommended)                                    |

**Default preload**: `auto_explain,pg_cron,pg_stat_monitor,pg_stat_statements,pgaudit,timescaledb`

**Optional preload**: `pgsodium`, `supautils`, `safeupdate`, `set_user`, `pg_partman_bgw`, `pg_plan_filter`

## PostgreSQL Connection

| Variable            | Default        | Description                                          |
| ------------------- | -------------- | ---------------------------------------------------- |
| `POSTGRES_USER`     | `postgres`     | Database superuser                                   |
| `POSTGRES_PASSWORD` | **(required)** | Superuser password (16+ chars recommended)           |
| `POSTGRES_DB`       | `postgres`     | Initial database name                                |
| `POSTGRES_BIND_IP`  | `127.0.0.1`    | Bind address: `127.0.0.1`, `0.0.0.0`, or specific IP |
| `POSTGRES_PORT`     | Stack-specific | `5432` (primary/single), `5433` (replica)            |

## Replication

| Variable                  | Default                        | Description                                                  |
| ------------------------- | ------------------------------ | ------------------------------------------------------------ |
| `POSTGRES_WAL_LEVEL`      | Stack-dependent                | `minimal` (single), `replica` (replica), `logical` (primary) |
| `PG_REPLICATION_PASSWORD` | **(required for replication)** | Replication user password                                    |
| `PG_REPLICATION_USER`     | `replicator`                   | Replication username                                         |
| `REPLICATION_SLOT_NAME`   | `replica_slot_1`               | Physical replication slot name                               |
| `PRIMARY_HOST`            | **(required for replica)**     | Primary server hostname                                      |
| `PRIMARY_PORT`            | `5432`                         | Primary server port                                          |

## PgBouncer (Primary Stack Only)

| Variable                      | Default        | Description                                                                   |
| ----------------------------- | -------------- | ----------------------------------------------------------------------------- |
| `PGBOUNCER_AUTH_PASS`         | **(required)** | Auth user password                                                            |
| `PGBOUNCER_LISTEN_ADDR`       | `0.0.0.0`      | Listen address                                                                |
| `PGBOUNCER_PORT`              | `6432`         | Listen port                                                                   |
| `PGBOUNCER_SERVER_SSLMODE`    | `prefer`       | TLS mode: `disable`, `allow`, `prefer`, `require`, `verify-ca`, `verify-full` |
| `PGBOUNCER_MAX_CLIENT_CONN`   | `200`          | Max client connections                                                        |
| `PGBOUNCER_DEFAULT_POOL_SIZE` | `25`           | Pool size per database                                                        |

## Container Resources

| Variable                         | Primary | Replica/Single | Description             |
| -------------------------------- | ------- | -------------- | ----------------------- |
| `POSTGRES_MEMORY_LIMIT`          | `2048m` | `512m`         | Hard memory limit       |
| `POSTGRES_MEMORY_RESERVATION`    | `1024m` | `256m`         | Soft memory reservation |
| `POSTGRES_CPU_LIMIT`             | `2`     | `0.5`          | CPU cores               |
| `PGBOUNCER_MEMORY_LIMIT`         | `200m`  | N/A            | PgBouncer memory        |
| `POSTGRES_EXPORTER_MEMORY_LIMIT` | `64m`   | `64m`          | Prometheus exporter     |

## Networking

| Variable                    | Default        | Description                                               |
| --------------------------- | -------------- | --------------------------------------------------------- |
| `COMPOSE_PROJECT_NAME`      | `aza-pg`       | Project name prefix                                       |
| `POSTGRES_CONTAINER_NAME`   | Stack-specific | `postgres-primary`, `postgres-replica`, `postgres-single` |
| `POSTGRES_NETWORK_NAME`     | Stack-specific | Internal network name                                     |
| `MONITORING_NETWORK`        | `monitoring`   | External monitoring network                               |
| `POSTGRES_EXPORTER_BIND_IP` | `127.0.0.1`    | Exporter bind address                                     |
| `POSTGRES_EXPORTER_PORT`    | Stack-specific | `9187` (primary), `9188` (replica), `9189` (single)       |

## Storage

| Variable                 | Default           | Description                  |
| ------------------------ | ----------------- | ---------------------------- |
| `POSTGRES_DATA_VOLUME`   | Stack-specific    | Data volume name             |
| `POSTGRES_BACKUP_VOLUME` | `postgres_backup` | Backup volume (primary only) |

## Images

| Variable                  | Default                                         | Description                                   |
| ------------------------- | ----------------------------------------------- | --------------------------------------------- |
| `POSTGRES_IMAGE`          | `ghcr.io/fluxo-kt/aza-pg:pg18`                  | PostgreSQL image (use versioned tag for prod) |
| `POSTGRES_EXPORTER_IMAGE` | `prometheuscommunity/postgres-exporter:v0.18.1` | Prometheus exporter                           |
| `PGBOUNCER_IMAGE`         | `edoburu/pgbouncer:v1.24.1-p1`                  | PgBouncer (primary only)                      |

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

# Custom RAM + workload
POSTGRES_MEMORY=4096 POSTGRES_WORKLOAD_TYPE=oltp docker compose up -d
```

## Security Notes

- Never commit `.env` files with real passwords
- Use `chmod 600 .env` on production servers
- Development uses `pg18` tag; production should use versioned tags or SHA digests
- Replication requires matching passwords across primary and replica
