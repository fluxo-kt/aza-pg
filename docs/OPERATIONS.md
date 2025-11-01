# Operations Guide

## Overview

This guide covers operational tools for managing aza-pg PostgreSQL deployments. These tools handle critical operations like database backup/restore, replica promotion (failover), and SSL certificate generation.

**Available Tools:**

- **backup-postgres.ts** - Create compressed database backups using pg_dump
- **restore-postgres.ts** - Restore database from backup dumps
- **promote-replica.ts** - Promote replica to primary (failover operations)
- **generate-ssl-certs.ts** - Generate self-signed SSL certificates for TLS

All tools are written in Bun TypeScript and located in `scripts/tools/`. They provide comprehensive error handling, validation, and safety checks.

## Prerequisites

### General Requirements

- **Bun runtime** installed (`bun --version`)
- **Docker** or **Docker Compose** (for container operations)
- **PostgreSQL client tools** (for backup/restore):
  - `pg_dump`, `psql`, `pg_isready` (install from https://www.postgresql.org/download/)
  - `gzip`, `gunzip` (compression tools)

### Connection Configuration

Most tools use standard PostgreSQL environment variables:

```bash
export PGHOST=localhost        # Default: localhost
export PGPORT=5432             # Default: 5432
export PGUSER=postgres         # Default: postgres
export PGPASSWORD=your_password # Required for remote connections
```

**Alternative:** Use `~/.pgpass` file for credentials (see https://www.postgresql.org/docs/current/libpq-pgpass.html)

## Tools

### Database Backup

**Script:** `scripts/tools/backup-postgres.ts`

Creates compressed logical backups using `pg_dump`. Supports local and remote PostgreSQL instances.

#### Usage

```bash
# Backup 'postgres' database to auto-named file
bun scripts/tools/backup-postgres.ts

# Backup specific database
bun scripts/tools/backup-postgres.ts mydb

# Backup to specific file
bun scripts/tools/backup-postgres.ts mydb backup.sql.gz

# Remote backup
PGHOST=db.example.com PGUSER=admin PGPASSWORD=secret \
  bun scripts/tools/backup-postgres.ts production prod_backup.sql.gz
```

#### Output Format

- **Format:** Plain SQL (gzip compressed)
- **Flags:** `--no-owner --no-acl` (portability across environments)
- **Naming:** Auto-generated with timestamp: `backup_<database>_YYYY_MM_DD_HHmmss.sql.gz`

#### Safety Features

- **Overwrite protection:** Fails if output file already exists
- **Write permission check:** Validates output directory is writable
- **Backup verification:** Tests gzip integrity after creation
- **Automatic cleanup:** Removes partial backups on failure
- **Connection validation:** Checks PostgreSQL is accessible before starting

#### Common Scenarios

**Scenario 1: Pre-deployment backup**

```bash
# Backup before risky migration
bun scripts/tools/backup-postgres.ts production pre_migration_$(date +%Y%m%d).sql.gz
```

**Scenario 2: Scheduled backups**

```bash
# Cron job (daily at 2 AM)
0 2 * * * cd /opt/aza-pg && bun scripts/tools/backup-postgres.ts production /backups/daily/backup_$(date +\%Y\%m\%d).sql.gz
```

**Scenario 3: Container backup**

```bash
# Backup from container via Docker network
PGHOST=postgres-primary PGUSER=postgres PGPASSWORD=$POSTGRES_PASSWORD \
  bun scripts/tools/backup-postgres.ts postgres container_backup.sql.gz
```

#### Troubleshooting

**Error: "Required command not found: pg_dump"**

Install PostgreSQL client tools:

```bash
# macOS
brew install postgresql@18

# Ubuntu/Debian
sudo apt-get install postgresql-client

# Alpine
apk add postgresql-client
```

**Error: "PGPASSWORD environment variable required"**

Set password for remote connections:

```bash
export PGPASSWORD='your_password'
# Or use .pgpass file
echo "hostname:5432:*:username:password" >> ~/.pgpass
chmod 600 ~/.pgpass
```

**Error: "Output directory not writable"**

```bash
# Check directory permissions
ls -la $(dirname backup.sql.gz)

# Create directory if needed
mkdir -p /path/to/backups
chmod 755 /path/to/backups
```

**Warning: Backup size unexpectedly small**

- Empty database (verify with `psql -l`)
- Wrong database name
- Insufficient permissions (check user grants)

---

### Database Restore

**Script:** `scripts/tools/restore-postgres.ts`

Restores databases from compressed or uncompressed pg_dump backups.

#### Usage

```bash
# Restore backup to 'postgres' database
bun scripts/tools/restore-postgres.ts backup.sql.gz

# Restore to specific database
bun scripts/tools/restore-postgres.ts backup.sql.gz mydb

# Remote restore
PGHOST=db.example.com PGUSER=admin PGPASSWORD=secret \
  bun scripts/tools/restore-postgres.ts backup.sql.gz production
```

#### ⚠️ Important Warnings

**DESTRUCTIVE OPERATION:**

- Restore **overwrites** the target database
- Requires user confirmation (press Enter to continue)
- **No automatic backup** is created before restore
- Cannot be undone without a backup

**Best Practice:** Always backup before restore:

```bash
# 1. Backup current state
bun scripts/tools/backup-postgres.ts mydb pre_restore_backup.sql.gz

# 2. Restore from backup
bun scripts/tools/restore-postgres.ts old_backup.sql.gz mydb
```

#### Safety Features

- **Backup validation:** Verifies file exists and gzip integrity
- **Connection check:** Ensures PostgreSQL is accessible
- **User confirmation:** Requires explicit Enter keypress
- **Post-restore verification:** Shows table statistics

#### Common Scenarios

**Scenario 1: Disaster recovery**

```bash
# 1. Ensure database exists
docker exec postgres-primary psql -U postgres -c "CREATE DATABASE production;"

# 2. Restore from backup
PGHOST=postgres-primary PGPASSWORD=$POSTGRES_PASSWORD \
  bun scripts/tools/restore-postgres.ts disaster_backup.sql.gz production
```

**Scenario 2: Clone production to staging**

```bash
# 1. Backup production
PGHOST=prod.db bun scripts/tools/backup-postgres.ts production prod_clone.sql.gz

# 2. Restore to staging database
PGHOST=staging.db bun scripts/tools/restore-postgres.ts prod_clone.sql.gz staging
```

**Scenario 3: Test restore (verify backups work)**

```bash
# 1. Create test database
docker exec postgres-primary psql -U postgres -c "CREATE DATABASE restore_test;"

# 2. Restore to test database
bun scripts/tools/restore-postgres.ts backup.sql.gz restore_test

# 3. Verify data
docker exec postgres-primary psql -U postgres -d restore_test -c "SELECT COUNT(*) FROM users;"

# 4. Clean up
docker exec postgres-primary psql -U postgres -c "DROP DATABASE restore_test;"
```

#### Troubleshooting

**Error: "Database does not exist"**

Create database before restore:

```bash
createdb -h $PGHOST -U $PGUSER mydb
# Or via psql:
psql -h $PGHOST -U $PGUSER -c "CREATE DATABASE mydb;"
```

**Error: "Conflicting extensions"**

Drop conflicting extensions with CASCADE:

```bash
psql -h $PGHOST -U $PGUSER -d mydb -c "DROP EXTENSION IF EXISTS postgis CASCADE;"
```

**Error: "Permission denied"**

Ensure user has CREATE privileges:

```bash
psql -h $PGHOST -U postgres -c "GRANT ALL ON DATABASE mydb TO your_user;"
```

**Restore hangs or is very slow**

- Large database (expected for multi-GB dumps)
- Check network bandwidth for remote restores
- Monitor with: `docker logs postgres-primary -f`

---

### Replica Promotion (Failover)

**Script:** `scripts/tools/promote-replica.ts`

Promotes a PostgreSQL replica to primary role during failover scenarios.

#### ⚠️ CRITICAL WARNINGS

**THIS IS A DANGEROUS ONE-WAY OPERATION:**

- **Cannot be undone** - Replica cannot revert to replica after promotion
- **Must stop old primary** - Failure to stop causes split-brain scenario
- **Loses replication slots** - All slots from old primary are lost
- **Breaks replication chain** - Cascading replicas must be reconfigured
- **Production impact** - Clients must be redirected to new primary

**When to Use:**

- Old primary failed and cannot be recovered
- Planned failover for maintenance
- DR (Disaster Recovery) scenario

**When NOT to Use:**

- Old primary is still running (STOP IT FIRST!)
- Just testing failover (use a test cluster)
- Uncertain about consequences

#### Usage

```bash
# Promote default replica container (interactive)
bun scripts/tools/promote-replica.ts

# Promote specific container without confirmation (DANGEROUS!)
bun scripts/tools/promote-replica.ts -c my-replica -y

# Promote without backup (faster, riskier)
bun scripts/tools/promote-replica.ts -n -y

# Custom data directory
bun scripts/tools/promote-replica.ts -c postgres-replica -d /var/lib/postgresql/data
```

#### Options

| Flag                   | Description               | Default                                          |
| ---------------------- | ------------------------- | ------------------------------------------------ |
| `-c, --container NAME` | Container name            | `postgres-replica` or `$POSTGRES_CONTAINER_NAME` |
| `-d, --data-dir PATH`  | Data directory path       | `/var/lib/postgresql/data`                       |
| `-n, --no-backup`      | Skip pre-promotion backup | `false` (backup enabled)                         |
| `-y, --yes`            | Skip confirmation prompt  | `false` (requires confirmation)                  |
| `-h, --help`           | Show help                 | -                                                |

#### Promotion Process

The script executes the following steps:

1. **Prerequisite checks:**
   - Docker is installed and running
   - Container exists and is running

2. **State verification:**
   - Confirms container is in recovery mode (`pg_is_in_recovery() = true`)
   - Fails if already a primary

3. **Pre-promotion backup** (unless `-n` flag):
   - Creates `pg_basebackup` to `/backup/pre-promotion-backup-TIMESTAMP`
   - Continues even if backup fails (with warning)

4. **User confirmation** (unless `-y` flag):
   - Shows warnings about one-way operation
   - Requires typing "yes" to proceed

5. **Container stop:**
   - Stops replica container gracefully

6. **Promotion:**
   - Starts container temporarily
   - Runs `pg_ctl promote` inside container
   - Waits for promotion to complete

7. **Verification:**
   - Confirms `pg_is_in_recovery() = false`
   - Removes `standby.signal` file

8. **Restart as primary:**
   - Restarts container in primary mode
   - Waits for PostgreSQL to accept connections (max 30 seconds)

9. **Post-promotion instructions:**
   - Shows verification commands
   - Reminds to update application connections
   - Warns about split-brain risk

#### Common Scenarios

**Scenario 1: Planned failover (maintenance)**

```bash
# 1. Stop writes to old primary
psql -h old-primary -U postgres -c "ALTER SYSTEM SET default_transaction_read_only = on; SELECT pg_reload_conf();"

# 2. Wait for replica to catch up
psql -h old-primary -U postgres -c "SELECT client_addr, state, replay_lag FROM pg_stat_replication;"

# 3. Stop old primary
docker stop postgres-primary

# 4. Promote replica
bun scripts/tools/promote-replica.ts

# 5. Update application connection strings to new primary

# 6. Reconfigure old primary as new replica (if needed)
```

**Scenario 2: Emergency failover (primary crashed)**

```bash
# 1. Confirm old primary is down
docker ps | grep postgres-primary  # Should be stopped

# 2. Promote replica immediately
bun scripts/tools/promote-replica.ts -c postgres-replica -y

# 3. Update application connection strings

# 4. Verify promotion
docker exec postgres-replica psql -U postgres -c "SELECT pg_is_in_recovery();"  # Should be 'f'

# 5. Check replication slots (will be empty)
docker exec postgres-replica psql -U postgres -c "SELECT * FROM pg_replication_slots;"
```

**Scenario 3: Cascading replicas (multi-tier replication)**

```bash
# Topology: primary → replica1 → replica2

# 1. Stop primary
docker stop postgres-primary

# 2. Promote replica1
bun scripts/tools/promote-replica.ts -c postgres-replica1

# 3. Reconfigure replica2 to replicate from replica1 (new primary)
#    Edit replica2's primary_conninfo to point to replica1
docker exec postgres-replica2 psql -U postgres -c "
  ALTER SYSTEM SET primary_conninfo = 'host=replica1 port=5432 user=replicator password=xxx';
  SELECT pg_reload_conf();
"
docker restart postgres-replica2
```

#### Post-Promotion Tasks

**Immediate (within minutes):**

1. Verify primary status:

   ```bash
   docker exec <container> psql -U postgres -c "SELECT pg_is_in_recovery();"
   # Must return: f (false)
   ```

2. Check for active connections:

   ```bash
   docker exec <container> psql -U postgres -c "SELECT COUNT(*) FROM pg_stat_activity WHERE application_name != 'psql';"
   ```

3. Update application connection strings/DNS

4. Verify applications can write to new primary

**Within hours:**

1. Set up new replicas (if needed)
2. Configure replication slots for new replicas
3. Update monitoring dashboards
4. Update backup scripts to point to new primary
5. Document the failover event

**Within days:**

1. Decide fate of old primary:
   - Decommission permanently
   - Reconfigure as new replica
   - Repurpose for testing

2. Review and update runbooks
3. Test failover procedures

#### Troubleshooting

**Error: "Container is not in recovery mode"**

Container is already a primary:

```bash
# Check status
docker exec <container> psql -U postgres -c "SELECT pg_is_in_recovery();"

# If already promoted, skip promotion
```

**Error: "Promotion verification failed: Container still in recovery mode"**

Promotion command succeeded but verification failed:

```bash
# Check PostgreSQL logs
docker logs <container> | tail -50

# Manually verify standby.signal
docker exec <container> ls -la /var/lib/postgresql/data/standby.signal

# If file exists, remove it
docker exec <container> rm -f /var/lib/postgresql/data/standby.signal
docker restart <container>
```

**Warning: Backup failed**

Pre-promotion backup failed but script continues:

- Check disk space: `docker exec <container> df -h /backup`
- Check permissions: `docker exec <container> ls -la /backup`
- Consider using `-n` flag if backup consistently fails
- **Manually backup before promotion if critical**

**PostgreSQL failed to start after promotion**

```bash
# Check logs
docker logs <container>

# Common issues:
# 1. Configuration errors in postgresql.conf
# 2. Port conflict with old primary
# 3. Insufficient memory/resources

# Rollback (if old primary still exists):
# 1. Stop promoted container
# 2. Restore old primary
# 3. Investigate issue before retrying
```

---

### SSL Certificate Generation

**Script:** `scripts/tools/generate-ssl-certs.ts`

Generates self-signed SSL certificates for PostgreSQL TLS connections.

#### ⚠️ Production Warning

**Self-signed certificates are NOT suitable for production:**

- Clients cannot verify certificate authenticity
- Vulnerable to MITM (man-in-the-middle) attacks
- No certificate revocation mechanism
- Not trusted by browsers/tools by default

**For production, use certificates from a trusted CA:**

- Let's Encrypt (free, automated)
- Commercial CA (DigiCert, GlobalSign, etc.)
- Internal PKI (company certificate authority)

**Valid use cases for self-signed certificates:**

- Development environments
- Testing TLS configuration
- Internal networks with manual trust
- Temporary setups

#### Usage

```bash
# Generate in default location with 10-year validity
bun scripts/tools/generate-ssl-certs.ts stacks/primary/certs

# Custom validity period (days)
bun scripts/tools/generate-ssl-certs.ts stacks/primary/certs 365

# Custom hostname (default: postgres.local)
POSTGRES_HOSTNAME=db.example.com \
  bun scripts/tools/generate-ssl-certs.ts stacks/primary/certs
```

#### Generated Files

| File         | Description                         | Permissions                   |
| ------------ | ----------------------------------- | ----------------------------- |
| `server.key` | Private key (keep secret!)          | `600` (read/write owner only) |
| `server.crt` | Server certificate                  | `644` (readable by all)       |
| `ca.crt`     | CA certificate (copy of server.crt) | `644` (readable by all)       |

#### Certificate Details

- **Algorithm:** RSA 2048-bit (via OpenSSL defaults)
- **Format:** X.509 (PEM encoded)
- **Subject:** `CN=<hostname>/O=PostgreSQL/C=US`
- **Self-signed:** Yes (certificate is its own CA)
- **Extensions:** None (basic certificate)

#### Common Scenarios

**Scenario 1: Enable TLS on primary stack**

```bash
# 1. Generate certificates
bun scripts/tools/generate-ssl-certs.ts stacks/primary/certs 3650

# 2. Edit stacks/primary/compose.yml - mount certs
#    volumes:
#      - ./certs:/etc/postgresql/certs:ro

# 3. Edit stacks/primary/configs/postgresql.conf - enable TLS
#    ssl = on
#    ssl_cert_file = '/etc/postgresql/certs/server.crt'
#    ssl_key_file = '/etc/postgresql/certs/server.key'

# 4. Restart stack
cd stacks/primary
docker compose down
docker compose up -d

# 5. Verify TLS enabled
docker exec postgres-primary psql -U postgres -c "SHOW ssl;"  # Should show 'on'
```

**Scenario 2: Require TLS for all connections**

```bash
# 1. Generate and mount certs (see Scenario 1)

# 2. Edit stacks/primary/configs/pg_hba.conf - change 'host' to 'hostssl'
#    Before: host    all    all    10.0.0.0/8    scram-sha-256
#    After:  hostssl all    all    10.0.0.0/8    scram-sha-256

# 3. Restart PostgreSQL
docker compose restart postgres

# 4. Test (should fail without TLS)
psql -h localhost -p 5432 -U postgres  # Fails

# 5. Test (should succeed with TLS)
psql "sslmode=require host=localhost port=5432 user=postgres"  # Success
```

**Scenario 3: Renew expiring certificates**

```bash
# 1. Check expiration
openssl x509 -in stacks/primary/certs/server.crt -noout -enddate

# 2. Backup old certs
mv stacks/primary/certs stacks/primary/certs.old

# 3. Generate new certs
bun scripts/tools/generate-ssl-certs.ts stacks/primary/certs 3650

# 4. Restart PostgreSQL (no downtime if mounted as volume)
docker compose restart postgres
```

**Scenario 4: Client certificate verification (mutual TLS)**

Not supported by this script. For client certificate verification:

1. Generate CA certificate separately
2. Generate server cert signed by CA
3. Generate client certs signed by same CA
4. Configure `ssl_ca_file` in postgresql.conf
5. Set `clientcert=verify-full` in pg_hba.conf

See PostgreSQL docs: https://www.postgresql.org/docs/current/ssl-tcp.html

#### Overwrite Protection

If certificates already exist, the script prompts for confirmation:

```
⚠ WARNING: Certificates already exist in stacks/primary/certs
Overwrite existing certificates? (y/N)
```

- Press `y` to overwrite
- Press `n` or Enter to abort

**Automatic overwrite** is not supported (no `-y` flag).

#### Integration with PostgreSQL

After generating certificates, configure PostgreSQL to use them:

**1. Mount certificates in compose.yml:**

```yaml
services:
  postgres:
    volumes:
      - ./certs:/etc/postgresql/certs:ro
```

**2. Enable SSL in postgresql.conf:**

```conf
ssl = on
ssl_cert_file = '/etc/postgresql/certs/server.crt'
ssl_key_file = '/etc/postgresql/certs/server.key'
ssl_ca_file = '/etc/postgresql/certs/ca.crt'  # Optional, for client verification
```

**3. Restart PostgreSQL:**

```bash
docker compose restart postgres
```

**4. Verify SSL is enabled:**

```bash
docker exec postgres-primary psql -U postgres -c "SHOW ssl;"
# Output: on

# Check connection uses SSL
psql "host=localhost user=postgres sslmode=require" -c "SELECT ssl_is_used();"
# Output: t (true)
```

#### Troubleshooting

**Error: "Invalid days-valid value"**

Provide a positive integer:

```bash
# Wrong
bun scripts/tools/generate-ssl-certs.ts certs abc

# Correct
bun scripts/tools/generate-ssl-certs.ts certs 3650
```

**Error: "openssl: command not found"**

Install OpenSSL:

```bash
# macOS
brew install openssl

# Ubuntu/Debian
sudo apt-get install openssl

# Alpine
apk add openssl
```

**PostgreSQL fails to start after enabling SSL**

Check logs:

```bash
docker logs postgres-primary 2>&1 | grep -i ssl
```

Common issues:

1. **Wrong file permissions:**

   ```bash
   # server.key must be 600 or less
   chmod 600 stacks/primary/certs/server.key
   ```

2. **File not found:**

   ```bash
   # Verify mount path matches postgresql.conf
   docker exec postgres-primary ls -la /etc/postgresql/certs/
   ```

3. **Invalid certificate:**
   ```bash
   # Verify certificate is valid
   openssl x509 -in stacks/primary/certs/server.crt -text -noout
   ```

**Client connection fails with "certificate verify failed"**

Self-signed certificates are not trusted by default:

```bash
# Option 1: Disable verification (insecure, dev only)
psql "host=localhost user=postgres sslmode=require"

# Option 2: Trust the CA certificate
export PGSSLROOTCERT=/path/to/ca.crt
psql "host=localhost user=postgres sslmode=verify-ca"

# Option 3: Use production CA-signed certificate
```

---

## Best Practices

### Backup Strategy

**3-2-1 Rule:**

- **3** copies of data (original + 2 backups)
- **2** different storage types (local + cloud)
- **1** off-site backup

**Backup frequency:**

- **Production:** Daily full backups + WAL archiving
- **Staging:** Daily or weekly
- **Development:** Weekly or on-demand

**Retention policy:**

- Keep daily backups for 7 days
- Keep weekly backups for 4 weeks
- Keep monthly backups for 12 months

**Automated backup script example:**

```bash
#!/usr/bin/env bash
# /opt/backup-scripts/daily-backup.sh

BACKUP_DIR=/backups/postgresql
DATE=$(date +%Y%m%d)
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Create backup
bun /opt/aza-pg/scripts/tools/backup-postgres.ts production \
  "${BACKUP_DIR}/production_${TIMESTAMP}.sql.gz"

# Upload to cloud storage
aws s3 cp "${BACKUP_DIR}/production_${TIMESTAMP}.sql.gz" \
  s3://my-backups/postgresql/

# Clean up old backups (keep 7 days)
find "${BACKUP_DIR}" -name "production_*.sql.gz" -mtime +7 -delete

# Verify backup integrity
gunzip -t "${BACKUP_DIR}/production_${TIMESTAMP}.sql.gz"
```

### Restore Testing

**Test backups monthly:**

```bash
# 1. Create test database
createdb -h localhost -U postgres restore_test

# 2. Restore latest backup
LATEST_BACKUP=$(ls -t /backups/postgresql/*.sql.gz | head -1)
bun scripts/tools/restore-postgres.ts "$LATEST_BACKUP" restore_test

# 3. Run smoke tests
psql -h localhost -U postgres -d restore_test -c "SELECT COUNT(*) FROM critical_table;"

# 4. Clean up
dropdb -h localhost -U postgres restore_test
```

### Failover Planning

**Document your failover runbook:**

1. Detection: How do you know primary is down?
2. Decision: Who approves failover?
3. Execution: Step-by-step promotion commands
4. Validation: How to verify new primary works?
5. Communication: Notify users of maintenance
6. Rollback: What if failover fails?

**Practice failover regularly:**

- **Monthly:** Review runbook
- **Quarterly:** Execute practice failover in staging
- **Annually:** Execute full DR drill in production

**Monitoring requirements:**

- Alert on primary downtime
- Alert on replication lag > 60s
- Alert on replica disconnection
- Dashboard showing primary/replica status

### SSL/TLS Security

**Certificate lifecycle:**

1. **Generation:** Use strong algorithms (RSA 2048+ or ECDSA P-256+)
2. **Deployment:** Set correct file permissions (`server.key = 600`)
3. **Monitoring:** Alert on certificates expiring in < 30 days
4. **Renewal:** Rotate certificates annually (even if valid longer)
5. **Revocation:** Have process to revoke compromised certs

**Production TLS checklist:**

- [ ] Use CA-signed certificates (not self-signed)
- [ ] Enable `sslmode=verify-full` for clients
- [ ] Require TLS for all connections (`hostssl` in pg_hba.conf)
- [ ] Disable weak ciphers (`ssl_ciphers` in postgresql.conf)
- [ ] Monitor certificate expiration
- [ ] Automate certificate renewal

### Operational Safety

**Pre-flight checks:**

- Always backup before destructive operations
- Test in staging before production
- Have rollback plan documented
- Schedule maintenance windows
- Notify users of planned downtime

**Change management:**

- Document all changes in CHANGELOG
- Use version control for configs
- Peer review operational commands
- Keep audit log of who did what

**Monitoring and alerts:**

- Monitor disk space (backups consume space)
- Monitor backup job success/failure
- Monitor restore test success
- Alert on unusual connection patterns

---

## Troubleshooting

### General Issues

**Issue: "Bun not found"**

Install Bun runtime:

```bash
curl -fsSL https://bun.sh/install | bash
```

**Issue: Permission denied when running scripts**

Make scripts executable:

```bash
chmod +x scripts/tools/*.ts
```

**Issue: Connection refused to PostgreSQL**

1. Check PostgreSQL is running:

   ```bash
   docker ps | grep postgres
   ```

2. Check port is exposed:

   ```bash
   docker ps | grep 5432
   ```

3. Check firewall rules:

   ```bash
   # macOS
   sudo pfctl -sr | grep 5432

   # Linux
   sudo iptables -L -n | grep 5432
   ```

4. Test with pg_isready:
   ```bash
   pg_isready -h localhost -p 5432 -U postgres
   ```

### Backup/Restore Issues

**Issue: Backup file is empty (0 bytes)**

- Database is empty (verify with `psql -l`)
- pg_dump failed silently (check stderr)
- Disk full during backup (check `df -h`)

**Issue: Restore fails with "extension already exists"**

Use `--clean` flag or drop extensions first:

```bash
# Option 1: Drop database and recreate
dropdb -h localhost -U postgres mydb
createdb -h localhost -U postgres mydb

# Option 2: Drop conflicting extensions
psql -h localhost -U postgres -d mydb -c "DROP EXTENSION IF EXISTS postgis CASCADE;"
```

**Issue: Backup takes hours on large database**

Consider using `pg_basebackup` for physical backups:

```bash
# Faster for multi-GB databases
pg_basebackup -h localhost -U postgres -D /backup/physical -Ft -z -P
```

Or use pgBackRest (installed in image, see PRODUCTION.md).

### Failover Issues

**Issue: Split-brain (two primaries)**

**CRITICAL - Fix immediately:**

```bash
# 1. Identify which primary has most recent data
docker exec postgres-primary psql -U postgres -c "SELECT pg_current_wal_lsn();"
docker exec postgres-replica psql -U postgres -c "SELECT pg_current_wal_lsn();"

# 2. Stop the primary with older data
docker stop <older-primary>

# 3. Reconfigure stopped instance as replica
# 4. Verify only ONE primary exists
```

**Issue: Applications still connecting to old primary**

- Update connection strings
- Update DNS records (if using DNS)
- Update load balancer configuration
- Restart application servers

**Issue: Replica promotion hangs**

Check for large checkpoint:

```bash
docker logs <replica> | grep checkpoint
```

If checkpoint takes long, wait or increase `checkpoint_completion_target`.

### SSL/TLS Issues

**Issue: "certificate verify failed" from clients**

For self-signed certs, trust the CA:

```bash
# Option 1: Use sslmode=require (verifies encryption, not identity)
psql "host=localhost sslmode=require user=postgres"

# Option 2: Provide CA certificate
psql "host=localhost sslmode=verify-ca sslrootcert=/path/to/ca.crt user=postgres"
```

**Issue: PostgreSQL logs "permission denied for server.key"**

Fix file permissions:

```bash
chmod 600 stacks/primary/certs/server.key
chown postgres:postgres stacks/primary/certs/server.key  # If using host UID mapping
```

**Issue: "server.key has group or world access"**

OpenSSL/PostgreSQL requires restrictive permissions:

```bash
# Must be 600 or less (owner read/write only)
chmod 600 server.key
```

---

## Related Documentation

### aza-pg Documentation

- **[PRODUCTION.md](PRODUCTION.md)** - Deployment guide, monitoring setup, security hardening
- **[ARCHITECTURE.md](ARCHITECTURE.md)** - System design, replication architecture
- **[TESTING.md](TESTING.md)** - Test patterns, session isolation
- **[BUILD.md](BUILD.md)** - Build instructions, CI/CD workflows
- **[AGENTS.md](../AGENTS.md)** - Quick reference, auto-config details

### PostgreSQL Official Documentation

- **[Backup and Restore](https://www.postgresql.org/docs/current/backup.html)** - Official backup strategies
- **[Replication](https://www.postgresql.org/docs/current/runtime-config-replication.html)** - Streaming replication configuration
- **[High Availability](https://www.postgresql.org/docs/current/high-availability.html)** - Failover and cluster management
- **[SSL Support](https://www.postgresql.org/docs/current/ssl-tcp.html)** - TLS/SSL configuration
- **[pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html)** - pg_dump reference
- **[pg_basebackup](https://www.postgresql.org/docs/current/app-pgbasebackup.html)** - Physical backup tool

### Third-Party Tools

- **[pgBackRest](https://pgbackrest.org/)** - Enterprise backup tool (installed in image)
- **[Patroni](https://patroni.readthedocs.io/)** - Automated failover (alternative to manual promotion)
- **[pgBouncer](https://www.pgbouncer.org/)** - Connection pooler (included in primary stack)

---

## Getting Help

**For aza-pg specific issues:**

- Review logs: `docker compose logs -f`
- Check AGENTS.md for architecture details
- Review stack-specific `.env.example` files

**For PostgreSQL issues:**

- Check PostgreSQL logs: `docker logs postgres-primary`
- Review PostgreSQL documentation
- Check system resources: `docker stats`

**For tool-specific issues:**

- Run with `-h` or `--help` flag for usage
- Check script source in `scripts/tools/` for details
- Verify prerequisites are installed
