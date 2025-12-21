# aza-pg Operational Runbooks

Detailed procedures for common operational tasks.

## Daily Operations

### Morning Health Check (5 minutes)

```bash
cd /opt/aza-pg-stack
./scripts/health-check.sh | tee -a /var/log/aza-pg-health.log
```

Review output for any failures or warnings.

**Coolify Method:**

- Go to your Service → Logs tab to review recent container output
- Check Service → Status indicator for health status
- Use Terminal tab to run: `./scripts/health-check.sh`

---

## Backup & Restore

### Hybrid Backup Strategy

**Daily Full Backup (Postgresus):**

- Schedule: 02:00 AM UTC
- Method: Logical backup via `pg_dump`
- Storage: Hetzner S3
- Retention: 7 days
- Compression: zstd level 5
- Encryption: AES-256-GCM

**Incremental Backups (pgBackRest):**

- Schedule: 08:00, 14:00, 20:00 UTC (3x/day)
- Method: Block-level incremental
- Storage: Separate Hetzner S3 bucket
- Retention: 3 full + 7 incremental
- Compression: LZ4
- Encryption: AES-256-CBC

**Result:** Max 6-hour data loss (RPO)

### Restore from Postgresus (Full Backup)

**When:** Restore from daily backup (up to 7 days ago)

```bash
# 1. Access Postgresus UI
http://VPS_IP:3002

# 2. Navigate to Backups tab

# 3. Select backup by timestamp

# 4. Click "Restore"

# 5. Choose target:
#    - Overwrite existing database (DESTRUCTIVE)
#    - Create new database (SAFE)

# 6. Wait for completion (5-30 minutes)

# 7. Verify restore
docker exec postgres psql -U postgres -d RESTORED_DB -c "SELECT count(*) FROM your_critical_table;"
```

**Coolify Method:**

- Access Postgresus UI through Coolify's exposed port (Service → Domains/Ports)
- After restore, verify via Service → Terminal tab: `psql -U postgres -d RESTORED_DB -c "SELECT count(*) FROM your_critical_table;"`

### Restore from pgBackRest (Incremental)

**When:** Point-in-time recovery or restore from incremental backup

```bash
# 1. Stop PostgreSQL
docker stop postgres

# 2. Backup current data directory
docker run --rm -v aza-pg-stack_postgres_data:/data -v /tmp:/backup ubuntu \
    tar czf /backup/postgres-data-backup-$(date +%Y%m%d%H%M%S).tar.gz /data

# 3. List available backups
pgbackrest --stanza=main info

# 4. Restore latest backup
pgbackrest --stanza=main restore

# 5. Or restore to specific point-in-time
pgbackrest --stanza=main --type=time \
    --target="2025-01-20 14:30:00" restore

# 6. Start PostgreSQL
docker start postgres

# 7. Verify recovery
docker exec postgres psql -U postgres -c "SELECT pg_is_in_recovery();"
# Should be 'f' (false) - not in recovery mode

# 8. Test data
docker exec postgres psql -U postgres -c "SELECT NOW();"
```

**Coolify Method:**

- Go to postgres Service → click Stop button
- Use Terminal tab to backup data directory and list backups
- Execute restore commands in Terminal tab
- Go to Service → click Start button
- Verify via Terminal tab: `psql -U postgres -c "SELECT pg_is_in_recovery();"`

### Manual Backup

**Full logical backup:**

```bash
# Using pg_dump (included in container)
docker exec postgres pg_dump -U postgres -Fc ${POSTGRES_DB:-main} > backup-$(date +%Y%m%d%H%M%S).dump

# Compress
gzip backup-*.dump

# Upload to S3
aws s3 cp backup-*.dump.gz s3://your-bucket/manual-backups/
```

**Coolify Method:**

- Go to postgres Service → Terminal tab
- Run: `pg_dump -U postgres -Fc ${POSTGRES_DB:-main} > /tmp/backup-$(date +%Y%m%d%H%M%S).dump`
- Download backup file via Coolify's file browser or use Terminal to upload to S3

**Incremental via pgBackRest:**

```bash
# Trigger manual incremental backup
pgbackrest --stanza=main --type=incr backup

# Trigger manual full backup (weekly)
pgbackrest --stanza=main --type=full backup
```

**Coolify Method:**

- Go to postgres Service → Terminal tab
- Execute pgbackrest commands directly in the terminal

### Backup Verification

**Test restore monthly:**

```bash
# 1. Create test database
docker exec postgres psql -U postgres -c "CREATE DATABASE restore_test;"

# 2. Restore latest backup to test database
# Via Postgresus: Select database → Restore to "restore_test"

# 3. Verify data integrity
docker exec postgres psql -U postgres -d restore_test <<EOF
SELECT
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
LIMIT 10;
EOF

# 4. Clean up
docker exec postgres psql -U postgres -c "DROP DATABASE restore_test;"
```

**Coolify Method:**

- Go to postgres Service → Terminal tab
- Run all commands directly in the terminal
- Access Postgresus UI via Service → Domains for GUI restore

---

## Failover Procedures (Phase 2)

### Unplanned Failover

**Scenario:** Primary VPS failed unexpectedly

**Detection:**

- Grafana alert: "PostgreSQL down"
- Monitoring shows no response from primary
- Application errors: connection refused

**Steps:**

```bash
# 1. Verify primary is actually down
ping PRIMARY_VPS_IP
ssh root@PRIMARY_VPS_IP  # Should fail

# 2. Verify VIP migrated to replica
ping 10.0.0.100
# Should respond from REPLICA IP

# 3. SSH to replica
ssh root@REPLICA_VPS_IP

# 4. Check replication status
docker exec postgres psql -U postgres -c "SELECT pg_is_in_recovery();"
# Should show 't' (true - still in standby)

# 5. Check last received WAL
docker exec postgres psql -U postgres -c \
    "SELECT pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn();"

# 6. Promote replica to primary
docker exec postgres pg_ctl promote -D /var/lib/postgresql/data

# 7. Wait 10-30 seconds, verify promotion
docker exec postgres psql -U postgres -c "SELECT pg_is_in_recovery();"
# Should show 'f' (false - now primary)

# 8. Test write capability
docker exec postgres psql -U postgres -c \
    "INSERT INTO health_check (message) VALUES ('Failover at $(date)');"

# 9. Monitor Grafana
# - QPS should recover within 1-2 minutes
# - Connection count should normalize

# 10. Document incident
cat >> /var/log/failover.log <<EOF
Failover Event: $(date)
Primary: PRIMARY_VPS_IP (failed)
Replica promoted: REPLICA_VPS_IP
Duration: X minutes
Data loss: Estimated Y seconds of WAL
Verified by: $(whoami)
EOF

# 11. Notify team
# Send Slack/email notification

# 12. Plan primary rebuild (non-urgent, within 24h)
```

**Coolify Method:**

- Check replica postgres Service → Status indicator (should show running)
- Go to replica postgres Service → Terminal tab
- Run replication status checks: `psql -U postgres -c "SELECT pg_is_in_recovery();"`
- Promote replica: `pg_ctl promote -D /var/lib/postgresql/data`
- Verify promotion and test write capability via Terminal tab
- Monitor via Grafana (accessible through Coolify Domains)
- Document incident in your preferred logging system

**Expected Downtime:** 1-3 minutes

**Data Loss:** 0-30 seconds (async replication lag)

### Planned Failover

**Scenario:** Maintenance on primary VPS

```bash
# 1. Announce maintenance window (24h advance)

# 2. Verify replication lag <1MB
docker exec postgres psql -U postgres -c \
    "SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS lag_bytes \
     FROM pg_stat_replication;"

# 3. On PRIMARY: Lower Keepalived priority
ssh root@PRIMARY_VPS_IP
nano /etc/keepalived/keepalived.conf
# Change: priority 100 → priority 80
systemctl reload keepalived

# VIP should migrate to replica immediately

# 4. Verify VIP migrated
ping 10.0.0.100  # Should be REPLICA IP

# 5. On REPLICA: Promote to primary
docker exec postgres pg_ctl promote -D /var/lib/postgresql/data

# 6. Verify promotion
docker exec postgres psql -U postgres -c "SELECT pg_is_in_recovery();"
# Should be 'f' (false)

# 7. Perform maintenance on old primary
# - OS updates
# - Hardware changes
# - Configuration updates

# 8. Rebuild old primary as new replica
# (See "Rebuild Failed Primary" section below)

# 9. Restore Keepalived priority
# After rebuild, set priority back to 100 on original primary
```

**Coolify Method:**

- Go to primary postgres Service → Terminal tab
- Check replication lag: `psql -U postgres -c "SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS lag_bytes FROM pg_stat_replication;"`
- Keepalived configuration requires host-level access (SSH to VPS)
- Switch to replica Service → Terminal tab
- Promote: `pg_ctl promote -D /var/lib/postgresql/data`
- Verify: `psql -U postgres -c "SELECT pg_is_in_recovery();"`

**Expected Downtime:** 30-60 seconds (VIP migration + promotion)

### Rebuild Failed Primary

**After failover, rebuild old primary as new replica:**

```bash
# 1. SSH to old primary (now replica)
ssh root@OLD_PRIMARY_VPS_IP

# 2. Stop all services
cd /opt/aza-pg-stack
docker compose down

# 3. Remove old data
docker volume rm aza-pg-stack_postgres_data

# 4. Create fresh volume
docker volume create aza-pg-stack_postgres_data

# 5. Take base backup from new primary
NEW_PRIMARY_IP="10.0.0.3"  # Update to new primary's private IP

docker run --rm \
    -v aza-pg-stack_postgres_data:/var/lib/postgresql/data \
    --network aza-pg-network \
    ghcr.io/USERNAME/aza-pg:18.1-latest \
    pg_basebackup -h $NEW_PRIMARY_IP -D /var/lib/postgresql/data \
    -U replicator -v -P -W

# Enter replication password when prompted

# 6. Create standby.signal
docker run --rm \
    -v aza-pg-stack_postgres_data:/var/lib/postgresql/data \
    ghcr.io/USERNAME/aza-pg:18.1-latest \
    bash -c "touch /var/lib/postgresql/data/standby.signal"

# 7. Configure primary connection
docker run --rm \
    -v aza-pg-stack_postgres_data:/var/lib/postgresql/data \
    ghcr.io/USERNAME/aza-pg:18.1-latest \
    bash -c "echo \"primary_conninfo = 'host=$NEW_PRIMARY_IP port=5432 user=replicator password=REPL_PASSWORD'\" >> /var/lib/postgresql/data/postgresql.auto.conf"

# 8. Start services
docker compose up -d postgres

# 9. Verify replication
docker exec postgres psql -U postgres -c \
    "SELECT pg_is_in_recovery();"
# Should be 't' (true - in recovery/standby)

docker exec postgres psql -U postgres -c \
    "SELECT * FROM pg_stat_wal_receiver;"
# Should show connection to new primary

# 10. On NEW PRIMARY: Verify replica connected
ssh root@NEW_PRIMARY_VPS_IP
docker exec postgres psql -U postgres -c \
    "SELECT * FROM pg_stat_replication;"
# Should show replica connected

# 11. Configure Keepalived (BACKUP mode)
nano /etc/keepalived/keepalived.conf
# Set: state BACKUP, priority 90
systemctl restart keepalived

# 12. Start remaining services
docker compose up -d
```

**Coolify Method:**

- SSH to old primary VPS for volume management (Coolify doesn't directly manage volumes)
- Alternatively, use Coolify UI: Go to old primary Service → Stop service → delete volume via host SSH
- Use Terminal tab for pg_basebackup and configuration steps
- Go to Service → Start button to bring services back up
- Verify replication via Terminal tab: `psql -U postgres -c "SELECT pg_is_in_recovery();"`
- Check new primary via its Service → Terminal tab: `psql -U postgres -c "SELECT * FROM pg_stat_replication;"`
- Keepalived configuration requires host-level SSH access

---

## Performance Tuning

### Identify Slow Queries

```bash
# Top 10 slowest queries
docker exec postgres psql -U postgres -d ${POSTGRES_DB:-main} <<EOF
SELECT
    query,
    calls,
    total_exec_time,
    mean_exec_time,
    max_exec_time
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;
EOF

# Queries with high execution count
docker exec postgres psql -U postgres -d ${POSTGRES_DB:-main} <<EOF
SELECT
    query,
    calls,
    total_exec_time
FROM pg_stat_statements
ORDER BY calls DESC
LIMIT 10;
EOF

# Check auto_explain logs
docker logs postgres --since 1h | grep "duration:"
```

**Coolify Method:**

- Go to postgres Service → Terminal tab
- Run the SQL queries directly: `psql -U postgres -d ${POSTGRES_DB:-main}`
- Paste the query content
- View logs: Go to Service → Logs tab → search for "duration:"

### Analyze Query Plan

```bash
# Explain a specific query
docker exec postgres psql -U postgres -d ${POSTGRES_DB:-main} <<EOF
EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
SELECT * FROM your_table WHERE condition;
EOF
```

**Coolify Method:**

- Go to postgres Service → Terminal tab
- Run: `psql -U postgres -d ${POSTGRES_DB:-main}`
- Execute: `EXPLAIN (ANALYZE, BUFFERS, VERBOSE) SELECT * FROM your_table WHERE condition;`

### Missing Indexes

```bash
# Find sequential scans on large tables
docker exec postgres psql -U postgres -d ${POSTGRES_DB:-main} <<EOF
SELECT
    schemaname,
    tablename,
    seq_scan,
    seq_tup_read,
    idx_scan,
    seq_tup_read / NULLIF(seq_scan, 0) AS avg_seq_scan_size
FROM pg_stat_user_tables
WHERE seq_scan > 0
ORDER BY seq_tup_read DESC
LIMIT 10;
EOF

# Suggest indexes with hypopg
docker exec postgres psql -U postgres -d ${POSTGRES_DB:-main} <<EOF
CREATE EXTENSION IF NOT EXISTS hypopg;
CREATE EXTENSION IF NOT EXISTS index_advisor;

-- Analyze queries from pg_stat_statements
-- index_advisor will suggest indexes
EOF
```

**Coolify Method:**

- Go to postgres Service → Terminal tab
- Run: `psql -U postgres -d ${POSTGRES_DB:-main}`
- Execute the sequential scan query and hypopg commands

### Table Bloat

```bash
# Find bloated tables
docker exec postgres psql -U postgres -d ${POSTGRES_DB:-main} <<EOF
SELECT
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS total_size,
    n_dead_tup,
    n_live_tup,
    round(n_dead_tup * 100.0 / NULLIF(n_live_tup + n_dead_tup, 0), 2) AS dead_pct
FROM pg_stat_user_tables
WHERE n_dead_tup > 1000
ORDER BY n_dead_tup DESC
LIMIT 10;
EOF

# Vacuum bloated table
docker exec postgres psql -U postgres -d ${POSTGRES_DB:-main} -c \
    "VACUUM FULL ANALYZE tablename;"
```

**Coolify Method:**

- Go to postgres Service → Terminal tab
- Run: `psql -U postgres -d ${POSTGRES_DB:-main}`
- Execute bloat detection query and VACUUM command

### Connection Pool Tuning

```bash
# Check PgBouncer wait queue
docker exec pgbouncer psql -h localhost -p 6432 -U postgres -Atq -c \
    "SHOW POOLS;" | awk -F'|' '{print $1, $3, $4, $10}'

# If maxwait > 0 frequently:
# Option 1: Increase pool size
# Edit .env: PGBOUNCER_DEFAULT_POOL_SIZE=40
docker restart pgbouncer

# Option 2: Optimize queries to reduce execution time

# Option 3: Add read replica (Phase 2)
```

**Coolify Method:**

- Go to pgbouncer Service → Terminal tab
- Run: `psql -h localhost -p 6432 -U postgres -Atq -c "SHOW POOLS;" | awk -F'|' '{print $1, $3, $4, $10}'`
- To adjust pool size: Go to Service → Environment Variables → edit PGBOUNCER_DEFAULT_POOL_SIZE
- Restart: Go to Service → click Restart button

---

## Security Incident Response

### Suspected Unauthorized Access

```bash
# 1. Check active connections
docker exec postgres psql -U postgres <<EOF
SELECT
    pid,
    usename,
    application_name,
    client_addr,
    backend_start,
    state,
    query
FROM pg_stat_activity
WHERE client_addr IS NOT NULL
ORDER BY backend_start DESC;
EOF

# 2. Check failed authentication attempts
docker logs postgres --since 24h | grep "FATAL.*authentication failed"

# 3. Kill suspicious connections
docker exec postgres psql -U postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE client_addr = 'SUSPICIOUS_IP';"

# 4. Update pg_hba.conf to block IP
docker exec postgres bash -c \
    "echo 'host all all SUSPICIOUS_IP/32 reject' >> /var/lib/postgresql/data/pg_hba.conf"

docker exec postgres psql -U postgres -c "SELECT pg_reload_conf();"

# 5. Rotate password immediately
NEWPASS=$(openssl rand -base64 32)
docker exec postgres psql -U postgres -c \
    "ALTER USER postgres WITH PASSWORD '$NEWPASS';"

# Update .env with new password
# Restart PgBouncer after updating userlist.txt

# 6. Review audit logs (pgaudit)
docker exec postgres psql -U postgres -c \
    "SELECT * FROM pg_log ORDER BY log_time DESC LIMIT 100;"

# 7. Document incident
```

**Coolify Method:**

- Go to postgres Service → Terminal tab
- Check connections: `psql -U postgres` then run the pg_stat_activity query
- View failed auth: Go to Service → Logs tab → search for "FATAL.\*authentication failed"
- Kill connections via Terminal: `psql -U postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE client_addr = 'SUSPICIOUS_IP';"`
- Update pg_hba.conf via Terminal: `echo 'host all all SUSPICIOUS_IP/32 reject' >> /var/lib/postgresql/data/pg_hba.conf`
- Reload config: `psql -U postgres -c "SELECT pg_reload_conf();"`
- Rotate password via Terminal
- Update .env: Go to Service → Environment Variables → update POSTGRES_PASSWORD
- Restart PgBouncer: Go to pgbouncer Service → click Restart button

### Data Breach Containment

```bash
# 1. Immediate isolation
# Block all external access via firewall
ufw deny 5432
ufw deny 6432

# 2. Dump audit trail
docker logs postgres > /secure/postgres-audit-$(date +%Y%m%d%H%M%S).log

# 3. Take forensic snapshot
docker exec postgres pg_dump -U postgres -Fc ${POSTGRES_DB:-main} \
    > /secure/forensic-dump-$(date +%Y%m%d%H%M%S).dump

# 4. Review compromised data
# Identify affected tables/rows

# 5. Notify stakeholders

# 6. Plan remediation
# - Rotate ALL credentials
# - Review and harden pg_hba.conf
# - Enable SSL/TLS if not already
# - Implement application-level access controls

# 7. Restore access gradually
# Re-enable firewall rules with stricter controls
```

**Coolify Method:**

- Firewall changes require host-level SSH access (not managed by Coolify)
- Dump logs: Go to postgres Service → Logs tab → use browser save or Terminal tab to redirect logs to file
- Forensic snapshot: Go to Service → Terminal tab → run `pg_dump -U postgres -Fc ${POSTGRES_DB:-main} > /tmp/forensic-dump-$(date +%Y%m%d%H%M%S).dump`
- Download dump via Coolify file browser or SCP from host
- Review data via Terminal tab
- Rotate credentials via Environment Variables and restart services

---

## Troubleshooting

### PostgreSQL Won't Start

```bash
# Check logs
docker logs postgres --tail 100

# Common issues:
# 1. Data directory corrupted
#    - Restore from backup
# 2. Port conflict
#    - Check: netstat -tuln | grep 5432
# 3. Insufficient permissions
#    - Check volume ownership: docker inspect aza-pg-stack_postgres_data

# Force restart
docker restart postgres

# If still failing, check data directory
docker run --rm -v aza-pg-stack_postgres_data:/data ubuntu ls -la /data
```

**Coolify Method:**

- Go to postgres Service → Logs tab → review last 100 lines
- Check Service → Status indicator for error state
- Force restart: Go to Service → click Restart button
- Check data directory: Go to Service → Terminal tab → `ls -la /var/lib/postgresql/data`
- Port conflicts: Check via host SSH or Coolify's port mapping settings

### High CPU Usage

```bash
# Identify expensive queries
docker exec postgres psql -U postgres <<EOF
SELECT
    pid,
    now() - query_start AS duration,
    state,
    left(query, 80)
FROM pg_stat_activity
WHERE state != 'idle'
ORDER BY duration DESC;
EOF

# Kill long-running query
docker exec postgres psql -U postgres -c \
    "SELECT pg_terminate_backend(PID);"

# Check for autovacuum storms
docker exec postgres psql -U postgres -c \
    "SELECT * FROM pg_stat_activity WHERE query LIKE '%autovacuum%';"

# Tune autovacuum if needed
docker exec postgres psql -U postgres <<EOF
ALTER SYSTEM SET autovacuum_max_workers = 2;
ALTER SYSTEM SET autovacuum_naptime = '30s';
SELECT pg_reload_conf();
EOF
```

**Coolify Method:**

- Go to postgres Service → Terminal tab
- Identify queries: `psql -U postgres` then run pg_stat_activity query
- Kill query: `psql -U postgres -c "SELECT pg_terminate_backend(PID);"`
- Check autovacuum and tune via Terminal tab
- Monitor CPU: Go to Service → check resource usage metrics (if available)

### Replication Lag (Phase 2)

```bash
# Check lag on replica
docker exec postgres psql -U postgres -c \
    "SELECT pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()) AS lag_bytes;"

# Check network between primary and replica
ping REPLICA_IP
iftop  # Monitor bandwidth

# Check disk I/O on replica
iostat -x 1

# If network is saturated:
# - Increase wal_keep_size on primary
# - Add WAL compression

# If disk I/O is bottleneck:
# - Upgrade to faster storage
# - Reduce checkpoint frequency
```

**Coolify Method:**

- Go to replica postgres Service → Terminal tab
- Check lag: `psql -U postgres -c "SELECT pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()) AS lag_bytes;"`
- Network and disk I/O monitoring require host-level SSH access
- Adjust WAL settings: Go to primary Service → Terminal tab → run ALTER SYSTEM commands

### Disk Space Full

```bash
# Check space usage
df -h

# Find largest databases
docker exec postgres psql -U postgres <<EOF
SELECT
    datname,
    pg_size_pretty(pg_database_size(datname))
FROM pg_database
ORDER BY pg_database_size(datname) DESC;
EOF

# Clean up old WAL files
docker exec postgres psql -U postgres -c \
    "SELECT pg_switch_wal();"

# Remove old backups from S3

# Vacuum databases
docker exec postgres psql -U postgres -c \
    "VACUUM FULL;"

# If emergency:
# Temporarily disable WAL archiving
docker exec postgres psql -U postgres <<EOF
ALTER SYSTEM SET archive_mode = off;
SELECT pg_reload_conf();
EOF
```

**Coolify Method:**

- Check disk space: Requires host-level SSH access or Coolify server monitoring dashboard
- Go to postgres Service → Terminal tab
- Find largest databases: `psql -U postgres` then run size query
- Clean WAL: `psql -U postgres -c "SELECT pg_switch_wal();"`
- Vacuum: `psql -U postgres -c "VACUUM FULL;"`
- Disable archiving: Run ALTER SYSTEM commands via Terminal tab

---

## Monitoring & Alerts

### Critical Alerts (Immediate Response)

Configure these in Prometheus Alertmanager:

**PostgreSQL Down:**

```yaml
- alert: PostgreSQLDown
  expr: pg_up == 0
  for: 2m
  labels:
    severity: critical
  annotations:
    summary: "PostgreSQL is down"
```

**Replication Lag High:**

```yaml
- alert: ReplicationLagHigh
  expr: pg_replication_lag_bytes > 104857600 # 100MB
  for: 5m
  labels:
    severity: critical
```

**Disk Space Low:**

```yaml
- alert: DiskSpaceLow
  expr: (node_filesystem_avail_bytes / node_filesystem_size_bytes) < 0.1
  for: 5m
  labels:
    severity: critical
```

**Coolify Method:**

- Access Prometheus/Alertmanager through Coolify exposed services
- Configure alerts via Prometheus config mounted as Coolify environment variables or config files
- View active alerts in Prometheus UI (accessible via Coolify Domains)

### Warning Alerts (4-hour Response)

**Connection Pool Saturation:**

```yaml
- alert: ConnectionPoolSaturated
  expr: pgbouncer_pools_server_active_connections / pgbouncer_pools_server_used_connections > 0.9
  for: 10m
  labels:
    severity: warning
```

**Cache Hit Ratio Low:**

```yaml
- alert: CacheHitRatioLow
  expr: pg_stat_database_blks_hit / (pg_stat_database_blks_hit + pg_stat_database_blks_read) < 0.95
  for: 1h
  labels:
    severity: warning
```

**Coolify Method:**

- Same as critical alerts - manage through Prometheus/Alertmanager services in Coolify

---

## Maintenance Windows

### OS Updates

```bash
# 1. Announce maintenance (24h advance)

# 2. Take backup
pgbackrest --stanza=main --type=full backup

# 3. Update packages
apt update && apt upgrade -y

# 4. Reboot if kernel updated
reboot

# 5. Verify services after reboot
./scripts/health-check.sh

# 6. Close maintenance window
```

**Coolify Method:**

- Take backup: Go to postgres Service → Terminal tab → run `pgbackrest --stanza=main --type=full backup`
- OS updates require host-level SSH access (Coolify runs on the host, not inside containers)
- After reboot, check Service → Status indicator to ensure all services restarted
- Verify: Go to Service → Terminal tab → run `./scripts/health-check.sh`

### PostgreSQL Minor Version Upgrade

```bash
# Example: 18.1 → 18.2

# 1. Backup
pgbackrest --stanza=main --type=full backup

# 2. Pull new image
docker pull ghcr.io/USERNAME/aza-pg:18.2-latest

# 3. Update docker-compose.yml
sed -i 's/:18.1-latest/:18.2-latest/g' docker-compose.yml

# 4. Restart
docker compose up -d

# 5. Verify version
docker exec postgres psql -U postgres -c "SELECT version();"

# 6. Monitor for 24h
```

**Coolify Method:**

- Backup: Go to postgres Service → Terminal tab → `pgbackrest --stanza=main --type=full backup`
- Update image: Go to Service → Configuration → change Image field to `ghcr.io/USERNAME/aza-pg:18.2-latest`
- Restart: Click Restart button (Coolify will pull new image)
- Verify: Go to Terminal tab → `psql -U postgres -c "SELECT version();"`
- Monitor: Check Logs tab and Status indicator over 24h

### PostgreSQL Major Version Upgrade

**DO NOT use this process for major upgrades (e.g., 18 → 19).**

Major upgrades require:

1. pg_upgrade tool
2. Significant testing
3. Extended maintenance window

Consult official PostgreSQL documentation.

---

## Appendix

### Quick Reference Commands

```bash
# Health check
./scripts/health-check.sh

# Comprehensive verification
./scripts/verify.sh

# PostgreSQL shell
docker exec -it postgres psql -U postgres

# PgBouncer console
docker exec -it pgbouncer psql -h localhost -p 6432 -U postgres -d pgbouncer

# View logs
docker logs postgres --tail 100 -f
docker logs pgbouncer --tail 100 -f

# Restart services
docker compose restart postgres
docker compose restart pgbouncer

# Full stack restart
docker compose down && docker compose up -d
```

**Coolify Method:**

- Health check: Go to Service → Terminal tab → `./scripts/health-check.sh`
- Verification: Terminal tab → `./scripts/verify.sh`
- PostgreSQL shell: Go to postgres Service → Terminal tab → `psql -U postgres`
- PgBouncer console: Go to pgbouncer Service → Terminal tab → `psql -h localhost -p 6432 -U postgres -d pgbouncer`
- View logs: Go to Service → Logs tab (live streaming)
- Restart services: Go to specific Service → click Restart button
- Full stack restart: Stop all services individually, then start them

### Emergency Contacts

- Primary On-Call: [Your contact]
- Secondary On-Call: [Backup contact]
- Hetzner Support: support@hetzner.com
- Database Vendor: [If using commercial support]

### Escalation Path

1. **L1:** Run health-check.sh, review Grafana
2. **L2:** Check runbooks, attempt remediation
3. **L3:** Escalate to senior engineer
4. **L4:** Engage vendor support (if applicable)
