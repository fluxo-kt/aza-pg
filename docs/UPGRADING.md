# Upgrading aza-pg

Guide for upgrading PostgreSQL major versions, extensions, and handling breaking changes.

## Table of Contents

- [PostgreSQL Major Version Upgrades](#postgresql-major-version-upgrades)
- [Extension Updates](#extension-updates)
- [Breaking Changes](#breaking-changes)
- [Rollback Procedures](#rollback-procedures)

## PostgreSQL Major Version Upgrades

### Prerequisites

1. **Full backup** of all databases
2. **Test upgrade** on development/staging environment first
3. **Verify extension compatibility** with new Postgres version
4. **Plan downtime window** (typically 5-30 minutes depending on database size)

### Upgrade Path: PostgreSQL 18 → 19 (Example)

#### Step 1: Update Dockerfile

```dockerfile
# Update ARG in docker/postgres/Dockerfile
ARG PG_VERSION=19  # Change from 18 to 19
```

#### Step 2: Verify Extension Compatibility

Check each extension supports PostgreSQL 19:

- pgvector: https://github.com/pgvector/pgvector/releases
- pg_cron: https://github.com/citusdata/pg_cron/releases
- pgAudit: https://github.com/pgaudit/pgaudit/releases

Update extension versions and SHAs if needed.

#### Step 3: Build New Image

```bash
# Build with buildx (uses intelligent caching)
bun run build

# Verify build
docker run --rm aza-pg:pg18 postgres --version
```

**Note**: PG_VERSION is defined in `docker/postgres/Dockerfile`. After updating it, the build script automatically uses the new version.

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

**Option A: In-Place Upgrade** (faster, more complex)

```bash
# Stop current stack
docker compose down

# Create pg_upgrade container
docker run -it --rm \
  -v postgres-data-old:/var/lib/postgresql/18/data \
  -v postgres-data-new:/var/lib/postgresql/19/data \
  aza-pg:pg19 bash

# Inside container, run pg_upgrade
su - postgres
/usr/lib/postgresql/19/bin/pg_upgrade \
  --old-datadir=/var/lib/postgresql/18/data \
  --new-datadir=/var/lib/postgresql/19/data \
  --old-bindir=/usr/lib/postgresql/18/bin \
  --new-bindir=/usr/lib/postgresql/19/bin \
  --check  # Dry run first

# If check passes, run actual upgrade
/usr/lib/postgresql/19/bin/pg_upgrade \
  --old-datadir=/var/lib/postgresql/18/data \
  --new-datadir=/var/lib/postgresql/19/data \
  --old-bindir=/usr/lib/postgresql/18/bin \
  --new-bindir=/usr/lib/postgresql/19/bin
```

**Option B: Backup → Restore** (slower, safer)

```bash
# Backup from old version
bun scripts/tools/backup-postgres.ts postgres backup-pg18.sql.gz

# Deploy new version with fresh data directory
docker compose down
docker volume rm postgres-data
docker compose up -d

# Wait for Postgres ready
bun scripts/test/wait-for-postgres.ts

# Restore backup
bun scripts/tools/restore-postgres.ts backup-pg18.sql.gz postgres
```

#### Step 6: Update Extension Versions

```sql
-- After successful upgrade, update extensions
ALTER EXTENSION pgvector UPDATE;
ALTER EXTENSION pg_cron UPDATE;
ALTER EXTENSION pgaudit UPDATE;
ALTER EXTENSION pg_stat_statements UPDATE;
```

#### Step 7: Verify and Optimize

```sql
-- Analyze all databases
VACUUM ANALYZE;

-- Check for outdated statistics
SELECT * FROM pg_stat_database WHERE stats_reset < NOW() - INTERVAL '7 days';

-- Verify replication (if using replicas)
SELECT * FROM pg_stat_replication;
```

## Extension Updates

### Minor Version Updates (e.g., pgvector 0.8.1 → 0.8.2)

#### Step 1: Find New Commit SHA

```bash
# Go to GitHub releases page
# Example: https://github.com/pgvector/pgvector/releases/tag/v0.8.2
# Find commit SHA from tag (usually in URL or commit list)
```

#### Step 2: Update Dockerfile

```dockerfile
ARG PGVECTOR_VERSION=0.8.2
ARG PGVECTOR_COMMIT_SHA=<new-commit-sha>
```

#### Step 3: Rebuild and Test

```bash
# Build with buildx (uses intelligent caching)
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
# Deploy new image
docker pull ghcr.io/fluxo-kt/aza-pg:pg18-latest

# Rolling update (one instance at a time)
docker compose up -d --no-deps postgres

# Verify
docker compose exec postgres psql -U postgres -c "\dx vector"
```

### Major Extension Updates (Breaking Changes)

Some extension updates require manual migration:

```sql
-- Example: pgvector 0.7.x → 0.8.x (hypothetical breaking change)

-- 1. Backup affected tables
CREATE TABLE embeddings_backup AS SELECT * FROM embeddings;

-- 2. Update extension
ALTER EXTENSION vector UPDATE TO '0.8.0';

-- 3. Migrate data (if needed)
-- Consult extension changelog for migration steps

-- 4. Verify
SELECT COUNT(*) FROM embeddings;

-- 5. Drop backup after verification
DROP TABLE embeddings_backup;
```

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
docker pull ghcr.io/fluxo-kt/aza-pg:pg18

# Create new data directory
docker volume create postgres-data-rollback

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
SELECT * FROM pg_available_extensions WHERE name = 'pgvector';

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
