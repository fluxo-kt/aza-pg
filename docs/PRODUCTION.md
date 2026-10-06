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
docker logs aza-pg-postgres-primary | grep "database system is ready"
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
docker exec aza-pg-replica-postgres-replica psql -U postgres -c "SELECT * FROM pg_stat_wal_receiver;"
# Should show status='streaming'

# On primary:
docker exec aza-pg-postgres-primary psql -U postgres -c "SELECT client_addr, state, sync_state FROM pg_stat_replication;"
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
   - The primary and single stacks create their own (`postgres-primary-net`, `postgres-single-net`); the replica stack joins the primary's to reach it
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
bun scripts/tools/backup-postgres.ts postgres backup.sql.gz

# Direct pg_dump:
docker exec aza-pg-postgres-primary pg_dump -U postgres postgres | gzip > backup.sql.gz
```

### Automated Backups

pgBackRest is installed in the PostgreSQL image and available at `/usr/bin/pgbackrest`.

Continuous WAL archiving, scheduled backups and point-in-time restore: [BACKUP-PGBACKREST.md](BACKUP-PGBACKREST.md) (settings in `examples/backup/compose.yml`).

## Troubleshooting

### PgBouncer Auth Failures

**Symptom:** Cannot connect via PgBouncer (port 6432)

**Check:**

```bash
docker logs pgbouncer-primary | grep -i error
docker exec aza-pg-postgres-primary psql -U postgres -c "SELECT rolname FROM pg_roles WHERE rolname = 'pgbouncer_auth';"
```

**Fix:** Ensure `PGBOUNCER_AUTH_PASS` is set in `.env` and that PgBouncer rendered `/tmp/.pgpass`:

```bash
docker exec pgbouncer-primary ls -l /tmp/.pgpass
```

### Replica Won't Connect

**Symptom:** Replica fails to start or shows replication errors

**Check:**

1. Primary has replication user: `docker exec aza-pg-postgres-primary psql -U postgres -c "SELECT * FROM pg_roles WHERE rolname = 'replicator';"`
2. Replication slot exists: `docker exec aza-pg-postgres-primary psql -U postgres -c "SELECT * FROM pg_replication_slots;"`
3. Network connectivity: `docker exec aza-pg-replica-postgres-replica pg_isready -h <PRIMARY_HOST> -p 5432`
4. Password matches between primary and replica

### Memory Detection Issues

**Symptom:** Auto-config uses wrong RAM values

**Check logs:**

```bash
docker logs aza-pg-postgres-primary | grep "\[POSTGRES\] \[AUTO-CONFIG\]"
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
docker exec aza-pg-postgres-primary psql -U postgres -c "\dx"  # List extensions
docker logs aza-pg-postgres-primary | grep shared_preload_libraries
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

## Image Versioning

All images published to `ghcr.io/fluxo-kt/aza-pg` follow the **MM.mm-TS-TYPE** versioning scheme:

**Format:** `MM.mm-YYYYMMDDHHMM-TYPE`

- **MM**: PostgreSQL major version (e.g., `18`)
- **mm**: PostgreSQL minor version (e.g., `0`)
- **TS**: Build timestamp with minute precision (e.g., `202511092330`)
- **TYPE**: Image type (`single-node`, `primary`, `replica`)

**Example:** `18.1-202511142330-single-node`

### Available Tags

Each image is published with multiple tags for convenience:

```bash
# Full versioned tag (recommended for production - immutable)
ghcr.io/fluxo-kt/aza-pg:18.1-202511142330-single-node

# Version-specific convenience tags
ghcr.io/fluxo-kt/aza-pg:18.0-single-node  # Tracks PostgreSQL 18.0 minor
ghcr.io/fluxo-kt/aza-pg:18-single-node    # Tracks PostgreSQL 18 major
ghcr.io/fluxo-kt/aza-pg:18.0              # Latest 18.0 build (any type)
ghcr.io/fluxo-kt/aza-pg:18                # Latest 18.x build (any type)
```

### Verification

All published images are:

- **Cryptographically signed** with Cosign (keyless, OIDC-based)
- **Scanned for vulnerabilities** with Trivy (CRITICAL/HIGH blocked)
- **Multi-platform**: linux/amd64 and linux/arm64
- **Provenance-enabled**: SLSA attestations included
- **SBOM-enabled**: Software Bill of Materials included

**Verify image signature:**

```bash
cosign verify \
  --certificate-identity-regexp="^https://github.com/fluxo-kt/aza-pg/.*$" \
  --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
  ghcr.io/fluxo-kt/aza-pg:18.1-202511142330-single-node
```

**Verify SLSA build provenance attestation:**

```bash
# Using GitHub CLI (recommended)
gh attestation verify oci://ghcr.io/fluxo-kt/aza-pg@sha256:<digest> --owner fluxo-kt

# Using Cosign
cosign verify-attestation \
  --type slsaprovenance \
  --certificate-identity-regexp="^https://github.com/fluxo-kt/aza-pg/.*$" \
  --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
  ghcr.io/fluxo-kt/aza-pg@sha256:<digest>
```

**Verify BuildKit SBOM attestations:**

```bash
bun scripts/release/verify-sbom.ts --image ghcr.io/fluxo-kt/aza-pg@sha256:<digest>
```

### Version Selection for Production

**Recommended**: Use full versioned tags for production:

- ✅ Immutable (won't change unexpectedly)
- ✅ Traceable to specific build
- ✅ Easy rollback to exact version

**Not recommended**: Convenience tags for production:

- ⚠️ Mutable (updates when new builds published)
- ⚠️ Risk of unexpected changes
- ✅ OK for development/testing

## Upgrade Procedure

### PostgreSQL Minor Version

```bash
# Pull new image
docker compose pull

# Recreate containers
docker compose up -d --force-recreate

# Verify
docker exec aza-pg-postgres-primary psql -U postgres -c "SELECT version();"
```

### PostgreSQL Major Version

Requires `pg_upgrade` or dump/restore. See [UPGRADING.md](UPGRADING.md).

### Extensions

Update `Dockerfile` ARGs, rebuild image, deploy.

## Performance Tuning

### Auto-Config Baseline

Auto-config sizes memory and connections from the container's RAM, CPUs and `POSTGRES_WORKLOAD_TYPE`; the rules and caps are in [README.md "Auto-Config"](../README.md#auto-config).

**Override:** Set `POSTGRES_MEMORY=<MB>` to manually specify available RAM. A single setting is overridden with `-c name=value` or `ALTER SYSTEM`; a value in a postgresql.conf file is replaced by the tuned one.

### Extension Optimization

The aza-pg image includes multiple extensions with some disabled by default. You can reduce image size and build time by disabling unused extensions via the manifest-driven system. See [EXTENSIONS.md](EXTENSIONS.md#enabling-and-disabling-extensions) for the complete catalog and step-by-step instructions.

### Connection Limits

**PgBouncer:** Max 200 client connections (`PGBOUNCER_MAX_CLIENT_CONN` in `.env`)
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
bun scripts/tools/generate-ssl-certs.ts stacks/primary/certs
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

- `listen_addresses` comes from `POSTGRES_BIND_IP`, default `127.0.0.1` (localhost only); the entrypoint sets it at every start, so initdb's `listen_addresses = '*'` never applies
- The default `pg_hba.conf` allows connections from all RFC1918 private IP ranges when network access is enabled:
  - `10.0.0.0/8` (Class A private)
  - `172.16.0.0/12` (Class B private)
  - `192.168.0.0/16` (Class C private)

**Enabling Network Access:**

In the compose stacks PostgreSQL always listens on the stack's Docker networks, where pgbouncer, the exporters and replicas connect; `POSTGRES_BIND_IP` in `.env` only chooses the host address its port is published on. To accept connections from other hosts, set `POSTGRES_BIND_IP=0.0.0.0` (publishes on every host interface) and configure firewall rules. Running the image alone (`docker run`), `POSTGRES_BIND_IP` is PostgreSQL's listen address.

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
