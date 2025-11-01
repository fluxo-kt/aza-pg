# pgBackRest Backup Configuration Guide

Comprehensive guide for configuring WAL archiving and point-in-time recovery (PITR) using pgBackRest for continuous backups.

> **See also:** [OPERATIONS.md](OPERATIONS.md) for general backup operations using pg_dump/pg_restore and other operational tools.

## Overview

This guide covers pgBackRest-specific backup configuration for Point-in-Time Recovery (PITR) using continuous WAL archiving and automated backups. For simple logical backups with pg_dump, see [OPERATIONS.md](OPERATIONS.md#database-backup).

## Quick Start

### 1. Configure PostgreSQL for WAL Archiving

Add to your `postgresql.conf` (or use auto-config overrides):

```ini
# WAL Archiving for PITR
wal_level = replica                              # Already set for replication
archive_mode = on                                 # Enable archiving
archive_command = 'test ! -f /wal_archive/%f && cp %p /wal_archive/%f'  # Simple copy
archive_timeout = 300                             # Force WAL switch every 5 minutes

# Alternative: pgBackRest archive_command (recommended for production)
# archive_command = 'pgbackrest --stanza=main archive-push %p'
```

### 2. Add Volumes to Primary Stack

Edit your primary `compose.yml` to add WAL archive volume:

```yaml
services:
  postgres:
    volumes:
      # ... existing volumes ...
      - wal_archive:/wal_archive

volumes:
  wal_archive:
    name: wal-archive
```

### 3. Create pgBackRest Configuration

Create `pgbackrest.conf`:

```ini
[global]
repo1-path=/backup/repo
repo1-retention-full=7
repo1-retention-diff=4
log-level-console=info
log-level-file=debug

[main]
pg1-path=/var/lib/postgresql/data
pg1-port=5432
pg1-socket-path=/var/run/postgresql

# Compression (saves 60-80% storage)
repo1-bundle=y
repo1-block=y
compress-type=lz4
compress-level=3
```

### 4. Deploy pgBackRest

```bash
# Start pgBackRest container
docker compose -f compose.yml -f ../examples/backup/compose.yml up -d pgbackrest

# Initialize backup stanza
docker compose exec pgbackrest pgbackrest stanza-create --stanza=main

# Verify configuration
docker compose exec pgbackrest pgbackrest check --stanza=main
```

### 5. Run Backups

```bash
# Full backup (first run, then weekly)
docker compose exec pgbackrest pgbackrest backup --stanza=main --type=full

# Differential backup (daily, faster than full)
docker compose exec pgbackrest pgbackrest backup --stanza=main --type=diff

# Incremental backup (hourly, fastest)
docker compose exec pgbackrest pgbackrest backup --stanza=main --type=incr

# List backups
docker compose exec pgbackrest pgbackrest info --stanza=main
```

## Point-in-Time Recovery (PITR)

### Restore to Latest

```bash
# Stop postgres container
docker compose stop postgres

# Restore data
docker compose exec pgbackrest pgbackrest restore --stanza=main --delta

# Start postgres
docker compose start postgres
```

### Restore to Specific Time

```bash
# Stop postgres
docker compose stop postgres

# Restore to timestamp
docker compose exec pgbackrest pgbackrest restore --stanza=main \
  --type=time --target="2025-11-02 14:30:00" --target-action=promote

# Start postgres
docker compose start postgres
```

### Restore to Transaction ID

```bash
docker compose exec pgbackrest pgbackrest restore --stanza=main \
  --type=xid --target="1234567" --target-action=promote
```

## Automated Backup Schedule

Add cron job inside pgbackrest container or use host cron:

```bash
# Full backup weekly (Sunday 2 AM)
0 2 * * 0 docker compose exec -T pgbackrest pgbackrest backup --stanza=main --type=full

# Differential backup daily (2 AM)
0 2 * * 1-6 docker compose exec -T pgbackrest pgbackrest backup --stanza=main --type=diff

# Incremental backup every 6 hours
0 */6 * * * docker compose exec -T pgbackrest pgbackrest backup --stanza=main --type=incr
```

## archive_command Options

### Option 1: Simple Copy (Development)

Pros: Simple, no dependencies
Cons: No compression, no deduplication, manual cleanup

```ini
archive_command = 'test ! -f /wal_archive/%f && cp %p /wal_archive/%f'
```

### Option 2: pgBackRest (Recommended)

Pros: Compression, deduplication, automatic cleanup, PITR
Cons: Requires pgBackRest container

```ini
archive_command = 'pgbackrest --stanza=main archive-push %p'
```

### Option 3: S3/MinIO (Production)

Pros: Off-site backup, unlimited storage, disaster recovery
Cons: Requires S3-compatible storage, network dependency

```ini
# Using AWS CLI
archive_command = 'aws s3 cp %p s3://bucket/wal/%f'

# Using pgBackRest with S3
repo1-type=s3
repo1-s3-bucket=my-backup-bucket
repo1-s3-region=us-east-1
repo1-s3-key=your-access-key
repo1-s3-key-secret=your-secret-key
```

## Monitoring

### Check Archive Status

```sql
-- View archiving status
SELECT archived_count, last_archived_wal, last_archived_time
FROM pg_stat_archiver;

-- Check for archiving lag
SELECT pg_walfile_name(pg_current_wal_lsn()) AS current_wal;
```

### Check Backup Status

```bash
# List all backups with details
docker compose exec pgbackrest pgbackrest info --stanza=main

# Verify backup integrity
docker compose exec pgbackrest pgbackrest verify --stanza=main
```

## Troubleshooting

### Archive Command Failing

```bash
# Check postgres logs
docker compose logs postgres | grep archive

# Check permissions
docker compose exec postgres ls -la /wal_archive

# Test archive command manually
docker compose exec postgres sh -c 'cp /var/lib/postgresql/data/pg_wal/000000010000000000000001 /wal_archive/test'
```

### pgBackRest Errors

```bash
# Check pgBackRest logs
docker compose exec pgbackrest cat /var/log/pgbackrest/main-backup.log

# Verify stanza
docker compose exec pgbackrest pgbackrest check --stanza=main

# Reset stanza (CAUTION: deletes backups)
docker compose exec pgbackrest pgbackrest stanza-delete --stanza=main
docker compose exec pgbackrest pgbackrest stanza-create --stanza=main
```

## Storage Requirements

**WAL Generation Rate:**

- Light load: ~100MB/hour = 2.4GB/day
- Medium load: ~1GB/hour = 24GB/day
- Heavy load: ~10GB/hour = 240GB/day

**Backup Sizes (with compression):**

- Full: 40-60% of data directory size
- Differential: 10-30% of full backup size
- Incremental: 5-15% of full backup size

**Retention Example (7 full + 4 diff):**

- 100GB database
- 7 full backups × 50GB = 350GB
- 28 diff backups × 15GB = 420GB
- Total: ~770GB storage required

## Best Practices

1. **Test restores regularly** - Backup is useless if restore fails
2. **Monitor archive lag** - Alert if `last_archived_time` > 5 minutes old
3. **Use compression** - Saves 60-80% storage with minimal CPU overhead
4. **Off-site backups** - Use S3/MinIO for disaster recovery
5. **Automate cleanup** - Set retention policies to prevent disk full
6. **Verify backups** - Run `pgbackrest verify` weekly
7. **Document procedures** - Ensure team knows how to restore

## Performance Impact

**archive_command:**

- CPU: Negligible (async operation)
- I/O: ~1-2% increase (WAL already written to disk)
- Network: Depends on destination (local = none, S3 = bandwidth cost)

**Backups:**

- Full: High I/O during backup (use off-peak hours)
- Incremental: Low I/O (only changed blocks)
- Differential: Medium I/O (changes since last full)

**Recommended Schedule:**

- Full: Weekly (Sunday 2 AM)
- Differential: Daily (2 AM)
- Incremental: Every 6 hours
- Continuous WAL archiving: Always on

## Related Documentation

- **[OPERATIONS.md](OPERATIONS.md)** - General backup/restore operations with pg_dump/pg_restore
- **[PRODUCTION.md](PRODUCTION.md)** - Production deployment and monitoring
- **[ARCHITECTURE.md](ARCHITECTURE.md)** - System architecture and design
- **[pgBackRest Official Documentation](https://pgbackrest.org/)** - Complete pgBackRest reference

## Configuration Files

The example pgBackRest setup is located in `examples/backup/`:

- **compose.yml** - Docker Compose configuration for pgBackRest container
- **pgbackrest.conf** - pgBackRest configuration template

See `examples/backup/` directory for reference configurations.
