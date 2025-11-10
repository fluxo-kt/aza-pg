# Production Deployment Guide

## Prerequisites

1. **Docker & Docker Compose** installed on target system
2. **Monitoring network** created manually (see [Monitoring Network Setup](#monitoring-network-setup) below)
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
- **Special characters** like `@`, `:`, `/`, `#`, `'`, `&` are supported (automatically escaped in .pgpass) but may complicate manual connection strings
- Use strong passwords from password manager
- Test connection after setting passwords to ensure proper escaping

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

**Replication Mode:**

The primary stack uses **asynchronous replication** by default (`synchronous_standby_names = ''` in `postgresql-primary.conf`). This provides maximum flexibility and performance:

- **Asynchronous (default):** Primary commits transactions without waiting for replica confirmation. Better performance, slight risk of data loss if primary fails before replica catches up.
- **Synchronous (optional):** Set `synchronous_standby_names = 'replica_name'` to require replica confirmation before commit. Guarantees zero data loss but reduces throughput and increases latency.

To enable synchronous replication:

1. Edit `stacks/primary/configs/postgresql-primary.conf`
2. Set `synchronous_standby_names = 'replica1'` (or your replica's `application_name`)
3. Restart primary: `docker compose restart postgres`
4. Verify: `SELECT sync_state FROM pg_stat_replication;` should show `sync` instead of `async`

**Verify Replication:**

```bash
# On replica:
docker exec postgres-replica psql -U postgres -c "SELECT * FROM pg_stat_wal_receiver;"
# Should show status='streaming'

# On primary:
docker exec postgres-primary psql -U postgres -c "SELECT client_addr, state, sync_state FROM pg_stat_replication;"
# Should show sync_state='async' (or 'sync' if synchronous replication enabled)
```

### Single Stack

Minimal setup without PgBouncer or monitoring.

```bash
cd stacks/single
cp .env.example .env
docker compose up -d
```

## Monitoring Network Setup

### Why a Separate Monitoring Network?

The aza-pg stacks use **two Docker networks**:

1. **`postgres_net`** (stack-specific): Created automatically by Docker Compose
   - Isolates database traffic (PostgreSQL, PgBouncer, exporters)
   - Each stack creates its own: `postgres-primary-net`, `postgres-replica-net`, `postgres-single-net`
   - Internal communication only

2. **`monitoring`** (external, shared): Must be created manually before deployment
   - Allows multiple stacks to expose metrics to a single Prometheus instance
   - Shared across all aza-pg stacks (primary, replica, single)
   - Prevents port conflicts when running multiple stacks on the same host

### Creating the Monitoring Network

**Before first deployment**, create the external monitoring network:

```bash
docker network create monitoring
```

**Verify creation:**

```bash
docker network ls | grep monitoring
# Should show: NETWORK ID     NAME         DRIVER    SCOPE
#              <id>           monitoring   bridge    local
```

### What Happens If You Don't Create It?

**Symptom:** Stack deployment fails with error:

```
Error response from daemon: network monitoring declared as external, but could not be found
```

**Services affected:**

- `postgres_exporter` (all stacks)
- `pgbouncer_exporter` (primary stack only)

**Fix:** Create the network and redeploy:

```bash
docker network create monitoring
docker compose up -d
```

### Network Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ Host System                                                 │
│                                                             │
│  ┌─────────────────────┐      ┌─────────────────────┐     │
│  │ Primary Stack       │      │ Replica Stack        │     │
│  │                     │      │                      │     │
│  │ ┌─────────────────┐ │      │ ┌──────────────────┐ │     │
│  │ │ postgres_net    │ │      │ │ postgres_net     │ │     │
│  │ │ (internal)      │ │      │ │ (internal)       │ │     │
│  │ │                 │ │      │ │                  │ │     │
│  │ │ - PostgreSQL    │ │      │ │ - PostgreSQL     │ │     │
│  │ │ - PgBouncer     │ │      │ │                  │ │     │
│  │ └────┬────────────┘ │      │ └──────┬───────────┘ │     │
│  │      │              │      │        │             │     │
│  │ ┌────▼────────────┐ │      │ ┌──────▼───────────┐ │     │
│  │ │ Exporters       │ │      │ │ Exporters        │ │     │
│  │ │ (both networks) │ │      │ │ (both networks)  │ │     │
│  │ └────┬────────────┘ │      │ └──────┬───────────┘ │     │
│  └──────┼──────────────┘      └────────┼─────────────┘     │
│         │                               │                   │
│         └───────────┬───────────────────┘                   │
│                     │                                       │
│            ┌────────▼────────┐                              │
│            │ monitoring      │                              │
│            │ (external)      │                              │
│            │                 │                              │
│            │ - Prometheus    │                              │
│            │   (scrapes all) │                              │
│            └─────────────────┘                              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Monitoring Network Benefits

1. **Single Prometheus instance** scrapes all stacks
2. **No port conflicts** - exporters bind to stack-specific ports (9187, 9127, etc.)
3. **Network isolation** - Database traffic stays on private networks
4. **Scalability** - Add more stacks without reconfiguring Prometheus
5. **Unified dashboards** - Grafana can visualize all databases together

## Monitoring Setup

### Prometheus

Add to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: "postgres"
    static_configs:
      - targets: ["<host>:9187"] # Primary postgres_exporter
      - targets: ["<host>:9188"] # Replica postgres_exporter (if deployed)
      - targets: ["<host>:9189"] # Single postgres_exporter (if deployed)

  - job_name: "pgbouncer"
    static_configs:
      - targets: ["<host>:9127"] # Primary pgbouncer_exporter
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

pgBackRest is installed in the PostgreSQL image and available at `/usr/local/bin/pgbackrest`.

For production backup configuration, see `examples/backup/` directory which contains:

- Sample compose configuration for running pgBackRest as a separate service
- Documentation on stanza creation, backup schedules, and retention policies
- Point-in-Time Recovery (PITR) restore procedures

Example backup commands:

```bash
# Manual backup via installed pgbackrest
docker exec postgres-primary pgbackrest backup --stanza=main --type=full

# Or use the provided script
./scripts/tools/backup-postgres.sh postgres-primary backup.sql.gz
```

See `examples/backup/README.md` for comprehensive backup strategy and automation examples.

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
docker logs postgres-primary | grep "\[POSTGRES\] \[AUTO-CONFIG\]"
```

Look for source markers in the log output: `manual`, `cgroup-v2`, or `meminfo`. If you see `meminfo` with unexpectedly large RAM, Docker is not applying limits.

Example log output:

```
[POSTGRES] [AUTO-CONFIG] RAM: 2048MB (cgroup-v2), CPU: 4 cores (nproc) → shared_buffers=512MB, effective_cache_size=1536MB, ...
```

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
- `work_mem`: RAM/(max_connections\*4) (capped at 32MB)

**Override:** Set `POSTGRES_MEMORY=<MB>` to manually specify available RAM.

For comprehensive memory allocation table with specific RAM tiers and connection limits, see [AGENTS.md Auto-Config section](../AGENTS.md#auto-config).

### Extension Optimization

The aza-pg image includes 38 total catalog entries (37 enabled extensions, 1 disabled: pgq). You can reduce image size and build time by disabling unused extensions via the manifest-driven system. See [docs/EXTENSIONS.md](EXTENSIONS.md#enabling-and-disabling-extensions) for step-by-step instructions.

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

### Network Security Considerations

**Default Configuration:**

The default configuration binds to localhost only:

- `listen_addresses = '127.0.0.1'` in base config (localhost only, secure by default)
- The default `pg_hba.conf` allows connections from all RFC1918 private IP ranges when network access is enabled:
  - `10.0.0.0/8` (Class A private)
  - `172.16.0.0/12` (Class B private)
  - `192.168.0.0/16` (Class C private)

**Enabling Network Access:**

To allow network connections, set `POSTGRES_BIND_IP=0.0.0.0` in `.env` and ensure firewall rules are configured.

**Production Hardening:**

For production deployments with network access, narrow the CIDR ranges in `pg_hba.conf` to match your actual network topology:

```conf
# Instead of allowing all of 10.0.0.0/8, use your specific subnet:
host    all             all             10.10.5.0/24            scram-sha-256
```

**Why This Matters:**

- Default localhost binding (`127.0.0.1`) prevents network exposure
- When network access is enabled (`0.0.0.0`), Docker network isolation provides the primary security boundary
- pg_hba.conf acts as secondary defense-in-depth
- Narrower CIDRs reduce attack surface if Docker network is compromised

**Best Practices:**

1. Review and restrict CIDR ranges in production
2. Use firewall rules at the host level
3. Enable TLS for all production connections
4. Regularly audit `pg_hba.conf` access rules

## Getting Help

- Check logs: `docker compose logs -f`
- Review AGENTS.md for architecture details
