# aza-pg Quick Start Guide

Complete deployment artifacts and documentation for production PostgreSQL on Coolify + Hetzner.

## What's Included

### 📚 Documentation

- **`docs/DEPLOYMENT.md`** - Step-by-step deployment guide (10,000+ words)
- **`docs/RUNBOOKS.md`** - Operational procedures for backup/restore/failover
- **`deployments/phase1-single-vps/README.md`** - Phase 1 quick reference
- **`deployments/phase2-dual-vps/README.md`** - Phase 2 replication guide

### 🐳 Deployment Configurations

**Phase 1: Single VPS** (`deployments/phase1-single-vps/`)

- `docker-compose.yml` - Complete stack (PostgreSQL + PgBouncer + Monitoring)
- `.env.example` - Environment variables template
- `prometheus/` - Prometheus + Grafana configurations
- `pgbouncer/` - PgBouncer userlist configuration
- `pgbackrest/` - Hybrid backup configuration (Postgresus + pgBackRest)

**Phase 2: Dual VPS** (`deployments/phase2-dual-vps/`)

- `primary/` - Primary VPS configs
- `replica/` - Replica VPS configs
- `keepalived/` - VIP failover configs

### 🛠️ Automation Scripts

**Setup & Deployment** (`deployments/phase1-single-vps/scripts/`)

- `setup.sh` - Automated initial deployment
- `health-check.sh` - Daily health monitoring
- `verify.sh` - Comprehensive verification tests
- `harden-security.sh` - Security hardening automation

### 🎯 Architecture

**Phase 1: €12/month**

```
CPX31 VPS (4 vCPU, 8GB RAM)
├── PostgreSQL 18.1 (auto-tuned: 5GB RAM, 200 connections)
├── PgBouncer (2000 clients → 25 DB connections)
├── Postgresus (daily full backups, GUI)
├── pgBackRest (3x incremental backups/day)
├── Prometheus + Grafana (metrics + dashboards)
└── Hetzner S3 (encrypted backups, 7-day retention)
```

**Phase 2: €24/month**

```
Primary VPS               Replica VPS
├── PostgreSQL (RW)       ├── PostgreSQL (RO)
├── Keepalived (VIP)      ├── Keepalived (standby)
└── Monitoring            └── Monitoring

        ↓ VIP ↓
     10.0.0.100
        ↓ ↓ ↓
   Microservices
```

---

## Quick Start

### 1. Clone and Build

```bash
git clone https://github.com/yourusername/aza-pg.git
cd aza-pg

# Validate and build
bun run validate
bun run build

# Push to GitHub Container Registry
docker tag aza-pg:latest ghcr.io/USERNAME/aza-pg:18.1-latest
docker push ghcr.io/USERNAME/aza-pg:18.1-latest
```

### 2. Provision Hetzner VPS

```bash
# Via Hetzner Cloud Console or CLI
hcloud server create \
  --name aza-pg-primary \
  --type cpx31 \
  --image ubuntu-24.04 \
  --location fsn1
```

### 3. Deploy Phase 1

```bash
# SSH to VPS
ssh root@VPS_IP

# Copy deployment files
scp -r deployments/phase1-single-vps root@VPS_IP:/opt/aza-pg-stack

# Run automated setup
cd /opt/aza-pg-stack
./scripts/setup.sh
```

**Setup script will:**

- Create Docker network
- Generate PgBouncer userlist
- Start all services
- Create monitoring user
- Verify auto-configuration
- Display access information

### 4. Verify Deployment

```bash
./scripts/verify.sh
```

**Expected output:**

- 50+ automated tests
- 100% pass rate
- PostgreSQL version 18.1 confirmed
- All extensions available
- Connection pooling working

### 5. Configure Backups

**Option A: Postgresus (Daily Full Backups)**

1. Deploy via Coolify: One-click Postgresus service
2. Access UI: `http://VPS_IP:3002`
3. Add database connection
4. Configure S3 storage (Hetzner)
5. Set schedule: Daily 02:00 AM UTC
6. Test backup

**Option B: Hybrid (Recommended)**

- **Postgresus:** Daily full backups (GUI, easy restore)
- **pgBackRest:** 3x incremental backups/day (08:00, 14:00, 20:00)
- **Result:** Max 6-hour data loss (RPO)

Configure pgBackRest:

```bash
# Install
apt install pgbackrest

# Configure
cp deployments/phase1-single-vps/pgbackrest/pgbackrest.conf /etc/pgbackrest.conf
# Update S3 credentials

# Initialize
pgbackrest --stanza=main stanza-create

# Test backup
pgbackrest --stanza=main --type=incr backup

# Add to cron
crontab -e
# Add: 0 8,14,20 * * * pgbackrest --stanza=main --type=incr backup
```

### 6. Configure Monitoring

1. Access Grafana: `http://VPS_IP:3000`
   - User: `admin`
   - Pass: (from .env `GRAFANA_ADMIN_PASSWORD`)

2. Add Prometheus datasource (auto-provisioned)

3. Import dashboard:
   - Dashboard → Import
   - ID: `14114`
   - Select Prometheus datasource

4. Verify metrics:
   - PostgreSQL uptime
   - QPS (queries per second)
   - Connection pool usage
   - Disk I/O

### 7. Security Hardening

```bash
./scripts/harden-security.sh
```

**Script applies:**

- Restricts pg_hba.conf to minimal access
- Creates app-specific users (app_user, readonly)
- Sets file permissions (600 for sensitive files)
- Enables pgaudit for DDL/write operations
- Configures connection logging
- Documents manual steps (SSL, firewall, Fail2Ban)

**IMPORTANT:** Save generated passwords immediately!

---

## Connection Strings

### For Microservices (via PgBouncer)

**Internal (Docker network):**

```
postgresql://postgres:PASSWORD@pgbouncer:6432/main?pgbouncer=true
```

**Cross-stack (Coolify):**

```
1. Enable "Connect to Predefined Network" → aza-pg-network
2. Use: postgresql://postgres:PASSWORD@pgbouncer:6432/main?pgbouncer=true
```

### For Application Users

**Read-write:**

```
postgresql://app_user:PASSWORD@pgbouncer:6432/main?pgbouncer=true
```

**Read-only (reporting):**

```
postgresql://readonly:PASSWORD@pgbouncer:6432/main?pgbouncer=true
```

---

## Daily Operations

### Health Check (5 minutes)

```bash
./scripts/health-check.sh | tee -a /var/log/aza-pg-health.log
```

Review output for warnings/failures.

### Backup Verification

**Check Postgresus:**

- Access UI: `http://VPS_IP:3002`
- Verify last backup <24h old

**Check pgBackRest:**

```bash
pgbackrest --stanza=main info
```

### Query Performance

**Top 10 slowest queries:**

```bash
docker exec postgres psql -U postgres -d main -c \
  "SELECT query, mean_exec_time FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;"
```

**Check auto_explain logs:**

```bash
docker logs postgres --since 1h | grep "duration:"
```

---

## Troubleshooting

### PostgreSQL not starting

```bash
docker logs postgres --tail 100
docker restart postgres
```

### PgBouncer connection failed

```bash
docker logs pgbouncer --tail 50

# Regenerate userlist.txt
docker exec postgres psql -U postgres -Atq -c \
  "SELECT '\"' || usename || '\" \"' || passwd || '\"' FROM pg_shadow WHERE usename IN ('postgres', 'monitoring');" \
  > pgbouncer/userlist.txt

docker restart pgbouncer
```

### High replication lag (Phase 2)

```bash
# Check lag
docker exec postgres psql -U postgres -c \
  "SELECT pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()) AS lag_bytes;"

# If >10MB, investigate:
# - Network bandwidth (iftop)
# - Disk I/O (iostat -x 1)
# - Long-running queries on primary
```

**See `docs/RUNBOOKS.md` for complete troubleshooting procedures.**

---

## Costs

| Phase   | VPS | Storage | Total/Month | Savings vs Managed |
| ------- | --- | ------- | ----------- | ------------------ |
| Phase 1 | €12 | €0.25   | **€12.25**  | 87-94%             |
| Phase 2 | €24 | €0.25   | **€24.25**  | 80-90%             |

**Compared to:**

- Supabase Pro: $25/month
- AWS RDS db.t4g.large: $146/month

---

## Upgrade Path

### When to Move to Phase 2

**Triggers:**

- Validation proves product-market fit
- Uptime becomes critical (need HA)
- Can't tolerate 1-3 min manual failover
- Budget allows +€12/month

**Benefits:**

- Automatic VIP failover (3-5 sec)
- Manual DB promotion (1-3 min total RTO)
- Read scaling (connect to replica)
- Zero data loss (sync replication option)

### When to Move to Phase 3 (Production Hardening)

**Triggers:**

- Database >100GB (pgBackRest more efficient)
- Need PITR (point-in-time recovery to specific second)
- RTO <30 seconds (requires pg_auto_failover)
- Compliance/audit requirements

**Changes:**

- Replace Postgresus with pgBackRest for full backups
- Add pg_auto_failover for automatic promotion
- Add comprehensive monitoring (log aggregation, alerting)

---

## What's Built Into aza-pg

### Preloaded Extensions (Shared Libraries)

- auto_explain, pg_cron, pg_net, pg_stat_monitor, pg_stat_statements
- pgaudit, pgsodium, safeupdate, timescaledb

### Available Extensions (40 total)

**Monitoring:** pg_stat_statements, pg_stat_monitor, auto_explain, pgaudit
**Performance:** hypopg, index_advisor, pg_repack
**AI/Vector:** pgvector, pgvectorscale
**Time-series:** timescaledb, timescaledb_toolkit
**Full-text:** pg_trgm, pgroonga, rum
**Workflow:** pgflow, pg_cron, pgmq
**Security:** pgsodium, supabase_vault, pg_safeupdate
**HTTP/Webhooks:** pg_net, http
**CDC:** wal2json
**Geospatial:** postgis (disabled by default)

**See `manifest-data.ts` for complete list.**

---

## Support

### Documentation

- **DEPLOYMENT.md** - Complete deployment guide
- **RUNBOOKS.md** - Operational procedures
- **TESTING.md** - Test procedures
- **ARCHITECTURE.md** - System design

### Monitoring

- Grafana: `http://VPS_IP:3000`
- Prometheus: `http://VPS_IP:9090`
- Postgresus: `http://VPS_IP:3002`

### Logs

```bash
# All services
docker compose logs -f

# Specific service
docker logs postgres --tail 100 -f
docker logs pgbouncer --tail 100 -f
```

---

## Next Steps

1. ✅ Review this guide
2. ✅ Deploy Phase 1 (follow Quick Start above)
3. ✅ Run `./scripts/verify.sh` to validate
4. ✅ Configure backups (Postgresus + pgBackRest hybrid)
5. ✅ Set up daily health checks (cron)
6. ✅ Import Grafana dashboard (ID 14114)
7. ✅ Harden security (`./scripts/harden-security.sh`)
8. ✅ Document passwords in password manager
9. ✅ Connect first microservice via PgBouncer
10. ✅ Monitor for 30 days before Phase 2 decision

---

## Key Insights

### Why This Architecture?

**Postgresus + pgBackRest Hybrid:**

- Postgresus: GUI simplicity, perfect for daily full backups
- pgBackRest: Incremental efficiency, 3x/day reduces RPO to 6h
- Together: Best of both worlds (80% ease + 100% capability)

**PgBouncer is Essential:**

- 10 microservices × 3 replicas × 10 connections = 300+ connections
- Without pooling: Hit max_connections during deployments
- With pooling: 2000 clients → 25 DB connections (86% reduction)

**Phase 1 First:**

- 80% value with 20% effort
- Validates architecture before HA investment
- Learns operational patterns before complexity
- Proves product-market fit before scaling costs

**Auto-Config Wins:**

- Eliminates manual tuning (shared_buffers, work_mem, etc.)
- Detects hardware (cgroup v2, nproc)
- Workload-optimized (web: 200 conn, OLTP: 300 conn)
- Storage-optimized (SSD: random_page_cost=1.1)

---

## Success Criteria

After Phase 1 deployment, you should have:

- ✅ PostgreSQL 18.1 running with auto-tuned config
- ✅ PgBouncer pooling 2000 clients → 25 server connections
- ✅ Daily full backups (Postgresus) + 3x incremental (pgBackRest)
- ✅ Prometheus + Grafana monitoring with metrics
- ✅ All 40+ extensions available
- ✅ Security hardened (pg_hba.conf, app users, pgaudit)
- ✅ Automated health checks running daily
- ✅ 100% verification test pass rate

**Cost:** €12/month (87% cheaper than managed PostgreSQL)
**Reliability:** Production-grade with 7-day backup retention
**Performance:** 2000-5000 TPS on CPX31 NVMe SSD
**Maintainability:** Automated scripts + comprehensive runbooks

---

**Ready to deploy? Start with: `docs/DEPLOYMENT.md` Step 1**
