# Production Deployment Guide

## Prerequisites

1. **Docker & Docker Compose** installed on target system
2. **Monitoring network** created: `docker network create monitoring`
3. **Environment variables** configured (copy from `.env.example`)

## Security Checklist

### Before First Deployment

- [ ] Change ALL placeholder passwords in `.env`:
  - `POSTGRES_PASSWORD` - Database superuser password
  - `PG_REPLICATION_PASSWORD` - Replication user password (if using replica)
  - `PGBOUNCER_AUTH_PASS` - PgBouncer auth function password
- [ ] Replace `ghcr.io/fluxo-kt` with your actual registry URL
- [ ] Review and adjust memory limits based on available RAM
- [ ] Ensure firewall rules allow only necessary connections

### Password Requirements

- **Minimum 16 characters** recommended
- **Avoid special chars**: `@`, `:`, `/`, `#`, `'` (can break connection strings)
- Use strong passwords from password manager

## Stack Deployment

### Primary Stack

```bash
cd stacks/primary
cp .env.example .env
# Edit .env with your values
docker compose up -d
```

**Verify:**
```bash
docker ps  # All 3-4 services healthy
docker logs postgres-primary | grep "database system is ready"
docker logs pgbouncer-primary | grep "process up"
```

### Replica Stack

**Prerequisites:** Primary must be running with `PG_REPLICATION_PASSWORD` set.

```bash
cd stacks/replica
cp .env.example .env
# Edit .env:
#   PRIMARY_HOST=<primary-ip-or-hostname>
#   PG_REPLICATION_PASSWORD=<same-as-primary>
docker compose up -d
```

**Verify Replication:**
```bash
# On replica:
docker exec postgres-replica psql -U postgres -c "SELECT * FROM pg_stat_wal_receiver;"
# Should show status='streaming'
```

### Single Stack

Minimal setup without PgBouncer or monitoring.

```bash
cd stacks/single
cp .env.example .env
docker compose up -d
```

## Monitoring Setup

### Prometheus

Add to your `prometheus.yml`:
```yaml
scrape_configs:
  - job_name: 'postgres'
    static_configs:
      - targets: ['<host>:9187']

  - job_name: 'pgbouncer'
    static_configs:
      - targets: ['<host>:9127']
```

### Available Metrics

**Postgres (port 9187):**
- `pg_up` - Database is up
- `pg_replication_lag_lag_seconds` - Replication lag (seconds)
- `pg_postmaster_uptime_seconds` - Uptime
- `pg_memory_settings_value_bytes` - Memory config values
- `pg_connection_usage_current_conn` / `pg_connection_usage_max_conn` - Active vs allowed connections

**PgBouncer (port 9127):**
- `pgbouncer_pools_cl_active` - Active client connections
- `pgbouncer_pools_sv_active` - Active server connections
- `pgbouncer_pools_cl_waiting` - Waiting clients

## Backup Configuration

### Manual Backups

```bash
# Using provided script:
./scripts/tools/backup-postgres.sh postgres backup.sql.gz

# Direct pg_dump:
docker exec postgres-primary pg_dump -U postgres postgres | gzip > backup.sql.gz
```

### Automated Backups

Use the pgBackRest helper stack under `examples/backup/`:

```bash
# Run alongside the primary stack
docker compose -f compose.yml -f ../examples/backup/compose.yml up -d pgbackrest

# Initialize and schedule backups
docker compose exec pgbackrest pgbackrest stanza-create --stanza=main
docker compose exec pgbackrest pgbackrest backup --stanza=main --type=full
```

See `examples/backup/README.md` for retention policies, cron snippets, and PITR restores.

## Troubleshooting

### PgBouncer Auth Failures

**Symptom:** Cannot connect via PgBouncer (port 6432)

**Check:**
```bash
docker logs pgbouncer-primary | grep -i error
docker exec postgres-primary psql -U postgres -c "SELECT rolname FROM pg_roles WHERE rolname = 'pgbouncer_auth';"
```

**Fix:** Ensure `PGBOUNCER_AUTH_PASS` is set in `.env` and that PgBouncer rendered `/tmp/.pgpass`:
```bash
docker exec pgbouncer-primary ls -l /tmp/.pgpass
```

### Replica Won't Connect

**Symptom:** Replica fails to start or shows replication errors

**Check:**
1. Primary has replication user: `docker exec postgres-primary psql -U postgres -c "SELECT * FROM pg_roles WHERE rolname = 'replicator';"`
2. Replication slot exists: `docker exec postgres-primary psql -U postgres -c "SELECT * FROM pg_replication_slots;"`
3. Network connectivity: `docker exec postgres-replica pg_isready -h <PRIMARY_HOST> -p 5432`
4. Password matches between primary and replica

### Memory Detection Issues

**Symptom:** Auto-config uses wrong RAM values

**Check logs:**
```bash
docker logs postgres-primary | grep AUTO-CONFIG
```

Look for source markers: `manual`, `cgroup-v2`, or `meminfo`. If you see `meminfo` with unexpectedly large RAM, Docker is not applying limits.

**Fix:** Either set `mem_limit` / `mem_reservation` in compose (already provided in the sample files) or export `POSTGRES_MEMORY=<MB>` to pin the value.

### Extensions Not Loading

**Symptom:** `CREATE EXTENSION` fails or extensions missing

**Check:**
```bash
docker exec postgres-primary psql -U postgres -c "\dx"  # List extensions
docker logs postgres-primary | grep shared_preload_libraries
```

**Fix:** Verify `shared_preload_libraries` in postgresql.conf and restart:
```bash
docker compose restart postgres
```

## Health Checks

```bash
# Postgres
pg_isready -h localhost -p 5432 -U postgres

# PgBouncer
PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -p 6432 -U postgres -d postgres -c "SELECT 1;"

# Replication
psql -U postgres -c "SELECT client_addr, state, sync_state FROM pg_stat_replication;"
```

## Upgrade Procedure

### PostgreSQL Minor Version

```bash
# Pull new image
docker compose pull

# Recreate containers
docker compose up -d --force-recreate

# Verify
docker exec postgres-primary psql -U postgres -c "SELECT version();"
```

### PostgreSQL Major Version

Requires `pg_upgrade` or dump/restore. See [UPGRADING.md](UPGRADING.md).

### Extensions

Update `Dockerfile` ARGs, rebuild image, deploy.

## Performance Tuning

### Auto-Config Baseline

Default settings target **2GB RAM**. Auto-config scales from there.

**Memory Map:**
- `shared_buffers`: 15-25% of RAM (capped at 32GB)
- `effective_cache_size`: 75-85% of RAM
- `maintenance_work_mem`: 3.1% of RAM (capped at 2GB)
- `work_mem`: RAM/(max_connections*4) (capped at 32MB)

**Override:** Set `POSTGRES_MEMORY=<MB>` to manually specify available RAM.

### Connection Limits

**PgBouncer:** Max 200 client connections (configurable in `pgbouncer.ini`)
**Postgres:** Auto-calculated based on RAM and work_mem

**Increase:** Edit `.env`:
```env
# Not recommended unless necessary
POSTGRES_MEMORY_LIMIT=4096m  # 4GB
```

## Monitoring Alerts

Recommended Prometheus alerts:

```yaml
- alert: PostgresDown
  expr: pg_up == 0
  for: 1m

- alert: ReplicationLag
  expr: pg_replication_lag_lag_seconds > 60
  for: 5m

- alert: PgBouncerHighWait
  expr: pgbouncer_pools_cl_waiting > 10
  for: 2m

- alert: HighConnections
  expr: pg_connection_usage_current_conn / pg_connection_usage_max_conn > 0.85
  for: 5m
```

## Security Hardening

### Production Checklist

- [ ] Use TLS/SSL for Postgres connections (see [TLS Configuration](#tls-configuration))
- [ ] Limit network exposure (bind to private IPs only)
- [ ] Regular security updates (rebuild images monthly)
- [ ] Audit logs enabled (`log_connections`, `log_disconnections`)
- [ ] pgAudit configured for sensitive operations
- [ ] Regular backup testing (restore to staging)

### TLS Configuration

1. Generate certificates:
```bash
./scripts/tools/generate-ssl-certs.sh stacks/primary/certs
```

2. Uncomment TLS lines in `postgresql.conf`:
```conf
ssl = on
ssl_cert_file = '/etc/postgresql/certs/server.crt'
ssl_key_file = '/etc/postgresql/certs/server.key'
```

3. Mount certs in `compose.yml`:
```yaml
volumes:
  - ./certs:/etc/postgresql/certs:ro
```

4. Restart stack

## Getting Help

- Check logs: `docker compose logs -f`
- Review AGENTS.md for architecture details
