# Coolify Deployment Guide

Deploy aza-pg PostgreSQL 18 on [Coolify](https://coolify.io) with auto-configuration and comprehensive extensions.

## Quick Start

1. **Create PostgreSQL resource** in Coolify (Databases → PostgreSQL)
2. **Set image**: `ghcr.io/fluxo-kt/aza-pg:18`
3. **CRITICAL**: Change volume mount path (see [Storage Configuration](#storage-configuration))
4. **Set environment variables** (at minimum: `POSTGRES_PASSWORD`)
5. **Start container**

## Storage Configuration

### Volume Mount Path (CRITICAL)

**PostgreSQL 18+ requires mounting the PARENT directory, not `/data`**

In Coolify's **Persistent Storage** settings:

| Setting          | Value                 |
| ---------------- | --------------------- |
| Destination Path | `/var/lib/postgresql` |

**NOT** `/var/lib/postgresql/data` (this is the pre-18 convention that causes startup failures)

### Why This Matters

PostgreSQL 18 changed its data directory structure to support `pg_upgrade --link` for major version migrations without mount boundary issues. The actual data directory is now `/var/lib/postgresql/18/docker`.

If you use the legacy `/var/lib/postgresql/data` mount path, you'll see this error:

```
Error: in 18+, these Docker images are configured to store database data in a
       format which is compatible with "pg_ctlcluster" (specifically, using
       major-version-specific directory names).

       Counter to that, there appears to be PostgreSQL data in:
         /var/lib/postgresql/data (unused mount/volume)
```

**Reference**: https://github.com/docker-library/postgres/pull/1259

## Environment Variables

### Required

| Variable            | Example           | Description        |
| ------------------- | ----------------- | ------------------ |
| `POSTGRES_PASSWORD` | (strong password) | Superuser password |

### Recommended

| Variable           | Default   | Description                                     |
| ------------------ | --------- | ----------------------------------------------- |
| `POSTGRES_USER`    | postgres  | Superuser name                                  |
| `POSTGRES_DB`      | postgres  | Default database                                |
| `POSTGRES_MEMORY`  | (auto)    | Container memory for auto-tuning (e.g., `2048`) |
| `POSTGRES_BIND_IP` | 127.0.0.1 | Set to `0.0.0.0` for network access             |

### Performance Tuning

| Variable                 | Options           | Description                   |
| ------------------------ | ----------------- | ----------------------------- |
| `POSTGRES_WORKLOAD_TYPE` | web/oltp/dw/mixed | Workload optimization profile |
| `POSTGRES_STORAGE_TYPE`  | ssd/hdd/san       | Storage type optimization     |

**Workload Types:**

- `mixed` (default): max_connections=120, general-purpose
- `web`: max_connections=200, balanced OLTP + read-heavy
- `oltp`: max_connections=300, high-concurrency transactions
- `dw`: max_connections=100, analytics/data warehouse

Below 8 GB of RAM these connection counts are scaled down.

## Resource Limits

Match Coolify's resource limits with `POSTGRES_MEMORY` for optimal auto-tuning:

| Coolify Setting            | Environment Variable   |
| -------------------------- | ---------------------- |
| Maximum Memory Limit: 2048 | `POSTGRES_MEMORY=2048` |

If limits don't match, you'll see warnings:

```
[POSTGRES] WARNING: Using /proc/meminfo fallback for RAM detection
[POSTGRES] WARNING: This may reflect host RAM instead of container allocation
```

### Recommended Minimums

- **Memory**: 512MB (absolute minimum), 2GB+ for production
- **CPU**: 0.5 cores minimum, 2+ for production

### Auto-Config Scaling

The tuning rules and worked examples are in the README's [Auto-Config](../README.md#auto-config) section. The startup log prints the values chosen (`[POSTGRES] [AUTO-CONFIG] RAM: …`).

## Network Configuration

### Internal Access (Default)

PostgreSQL binds to `127.0.0.1` by default (secure, internal only).

### External/Network Access

Set environment variable:

```
POSTGRES_BIND_IP=0.0.0.0
```

### Port Mapping

Default PostgreSQL port: **5432**

Configure in Coolify's **Network** → **Ports Mappings** section.

## SSL/TLS with Let's Encrypt

Coolify auto-manages Let's Encrypt certificates. However, PostgreSQL requires certificates with specific ownership (postgres user, UID 999).

### Known Issue

Coolify-mounted SSL certificates have `root:root` ownership, causing:

```
chown: changing ownership of '/var/lib/postgresql/certs/server.key': Operation not permitted
```

### Workaround Options

**Option 1: Use Coolify's Reverse Proxy (Recommended)**

Let Coolify handle SSL termination at the proxy level:

- PostgreSQL listens on internal network without SSL
- Simpler configuration, no certificate management needed
- Clients connect via Coolify's SSL-terminated proxy

**Option 2: Custom SSL via Init Script**

Use Coolify's "Initialization scripts" feature:

1. Mount certificates to a temporary location (e.g., `/coolify-certs/`)
2. Add initialization script:

```bash
#!/bin/bash
if [ -f /coolify-certs/server.crt ]; then
    mkdir -p /etc/postgresql/ssl
    cp /coolify-certs/server.crt /etc/postgresql/ssl/
    cp /coolify-certs/server.key /etc/postgresql/ssl/
    chown postgres:postgres /etc/postgresql/ssl/*
    chmod 600 /etc/postgresql/ssl/server.key
    chmod 644 /etc/postgresql/ssl/server.crt
fi
```

3. Configure PostgreSQL to use `/etc/postgresql/ssl/` paths

**Option 3: Self-Signed Certificates**

Generate certificates outside Coolify with correct permissions:

```bash
openssl req -new -x509 -days 365 -nodes -text \
  -out server.crt -keyout server.key \
  -subj "/CN=postgres"
chmod 600 server.key
```

Mount with ownership already set to UID 999 (postgres user).

## Troubleshooting

### "Error: in 18+, these Docker images are configured to store database data..."

**Cause**: Volume mounted to `/var/lib/postgresql/data` (legacy path)

**Solution**: Change Coolify volume **Destination Path** to `/var/lib/postgresql`

### "chown: changing ownership of '/var/lib/postgresql/certs/...' Operation not permitted"

**Cause**: Coolify-mounted SSL certificates have root ownership

**Solution**: See [SSL/TLS with Let's Encrypt](#ssltls-with-lets-encrypt) section

### Container restarts with "unhealthy" status

**Causes**:

1. Volume path incorrect (see above)
2. Missing `POSTGRES_PASSWORD` environment variable
3. Insufficient memory

**Debug**: Check Coolify **Logs** tab for specific error message

### "Using /proc/meminfo fallback for RAM detection"

**Cause**: No cgroup memory limit detected

**Solution**: Set `POSTGRES_MEMORY` environment variable to match Coolify's memory limit

### Connection refused

**Causes**:

1. PostgreSQL binding to localhost only (default)
2. Port not mapped correctly

**Solution**: Set `POSTGRES_BIND_IP=0.0.0.0` and verify port mapping in Network settings

### OCI runtime exec failed: broken pipe

**Cause**: Container crashed during startup, often due to volume path issue

**Solution**: Check logs for the root cause, usually the "Error: in 18+" message above

## Migration from PostgreSQL < 18

If you have existing data in `/var/lib/postgresql/data` from a pre-18 PostgreSQL image:

1. **Backup your data** using pg_dump:

   ```bash
   docker exec <container> pg_dump -U postgres -d <database> > backup.sql
   ```

2. **Delete the old volume** in Coolify (Persistent Storage → Delete)

3. **Create new volume** with mount at `/var/lib/postgresql`

4. **Restore from backup**:
   ```bash
   docker exec -i <container> psql -U postgres -d <database> < backup.sql
   ```

**Note**: Direct data migration requires `pg_upgrade` with both PostgreSQL versions present. For Coolify deployments, dump/restore is simpler and recommended.

## Extensions

On first start the image creates a baseline set in `POSTGRES_DB`, including `vector`, `vectorscale`, `timescaledb` and `pg_cron`. Create the others where you need them:

```sql
-- Full-Text Search
CREATE EXTENSION IF NOT EXISTS pgroonga;
```

See [EXTENSIONS.md](EXTENSIONS.md) for complete catalog.

## Health Check

The image's `HEALTHCHECK` runs `/usr/local/bin/healthcheck.sh`: `pg_isready`, a `SELECT 1`, and a check that the expected libraries are preloaded. Coolify reads the container's health status from it.

Default timing:

- Interval: 10 seconds
- Timeout: 5 seconds
- Retries: 3
- Start period: 120 seconds

## Best Practices

1. **Always set `POSTGRES_MEMORY`** to match Coolify's memory limit for accurate auto-tuning
2. **Use strong passwords** - aza-pg uses SCRAM-SHA-256 authentication
3. **Enable SSL** for production via Coolify's reverse proxy
4. **Configure backups** using Coolify's backup features or pg_dump scripts
5. **Monitor** with a separate postgres_exporter container (the image does not include one; `stacks/*/compose.yml` show the setup)

## Related Documentation

- [PRODUCTION.md](PRODUCTION.md) - Security hardening, TLS setup
- [EXTENSIONS.md](EXTENSIONS.md) - Complete extension catalog
- [ARCHITECTURE.md](ARCHITECTURE.md) - System design
