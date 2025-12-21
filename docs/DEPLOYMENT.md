# aza-pg Production Deployment Guide

Complete step-by-step guide for deploying aza-pg PostgreSQL 18 on Coolify-managed Hetzner servers.

## Quick Start (Phase 1: Single VPS)

**Cost:** €12/month | **Complexity:** Low

This gets you production-ready PostgreSQL with:

- Auto-tuned configuration (5GB RAM, SSD optimized)
- Connection pooling (2000 clients → 25 DB connections)
- Daily backups to S3 (7-day retention, encrypted)
- Prometheus + Grafana monitoring
- 40+ PostgreSQL extensions pre-installed

---

## Prerequisites

### Required

- [ ] Hetzner Cloud account with API token
- [ ] Domain name (for Grafana/Postgresus web UIs)
- [ ] SSH key pair (`ssh-keygen -t ed25519`)
- [ ] Docker installed locally (for testing configs)
- [ ] Git repository for storing configs

### Recommended

- [ ] Password manager (1Password, Bitwarden) for credentials
- [ ] Slack/Discord webhook for alerts (optional)

---

## Phase 1: Single VPS Foundation

### Step 1: Provision Hetzner VPS

**1.1 Create VPS via Hetzner Cloud Console**

Navigate to: Hetzner Cloud Console → Create Server

**Server Specs:**

- Type: CPX31 (4 vCPU, 8GB RAM, 160GB NVMe SSD)
- Location: Falkenstein (fsn1) - Germany
- Image: Ubuntu 24.04 LTS
- Cost: ~€12/month

**Bare VPS Alternative (CLI):**

```bash
# Install hcloud CLI first: brew install hcloud
hcloud server create \
  --name aza-pg-primary \
  --type cpx31 \
  --image ubuntu-24.04 \
  --location fsn1 \
  --ssh-key your-ssh-key-name
```

**1.2 Note Server IP**

Copy the IP address displayed in Hetzner Console.

**Bare VPS Alternative:**

```bash
hcloud server ip aza-pg-primary
# Example output: 65.108.123.45
```

**1.3 Configure DNS**

Create A records in your DNS provider:

- `grafana.yourdomain.com` → VPS IP
- `postgresus.yourdomain.com` → VPS IP

---

### Step 2: Install Coolify

**2.1 Initial Server Access**

SSH into your server to install Coolify:

**Bare VPS Alternative:**

```bash
ssh root@65.108.123.45
```

**2.2 Update System**

**Bare VPS Alternative:**

```bash
apt update && apt upgrade -y
```

**2.3 Install Coolify**

Run the official installation script:

**Bare VPS Alternative:**

```bash
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash

# Wait for installation to complete
# Access Coolify at: http://VPS_IP:8000
```

**2.4 Initial Coolify Setup**

1. Access Coolify UI: `http://VPS_IP:8000`
2. Create admin account
3. Configure domain (optional): Settings → Instance Settings → Coolify URL
4. Enable Let's Encrypt: Settings → Instance Settings → Enable SSL

**2.5 Configure Firewall**

In Coolify UI: Settings → Server → Firewall

Add rules:

- SSH (22/tcp) - Already configured
- HTTP (80/tcp) - Already configured
- HTTPS (443/tcp) - Already configured

**Bare VPS Alternative:**

```bash
# Install UFW
apt install -y ufw

# Allow SSH, HTTP, HTTPS only
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp

# Enable firewall
ufw --force enable

# Verify
ufw status
```

**2.6 Secure SSH**

**Bare VPS Alternative:**

```bash
# Edit SSH config
nano /etc/ssh/sshd_config

# Set these values:
PermitRootLogin prohibit-password
PasswordAuthentication no
PubkeyAuthentication yes

# Restart SSH
systemctl restart sshd
```

**2.7 Configure Automatic Security Updates**

**Bare VPS Alternative:**

```bash
apt install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades
# Select "Yes"
```

---

### Step 3: Create Docker Network in Coolify

**3.1 Create dedicated network for database stack**

In Coolify UI:

1. Go to: Settings → Server → Networks
2. Click: Create Network
3. Network Name: `aza-pg-network`
4. Driver: `bridge`
5. Subnet: `172.20.0.0/16`
6. Click: Create

**Why:** Allows microservices in different Coolify stacks to connect to the same database without UUID-mangled hostnames.

**How services connect to this network:**

1. When creating/editing any service in Coolify
2. Navigate to: Network tab
3. Enable: "Connect to Predefined Network"
4. Select: `aza-pg-network`
5. Save changes

**Bare VPS Alternative:**

```bash
docker network create \
  --driver bridge \
  --subnet 172.20.0.0/16 \
  aza-pg-network

# Verify
docker network inspect aza-pg-network
```

---

### Step 4: Build aza-pg Docker Image

**4.1 Clone repository locally (on your machine)**

```bash
git clone https://github.com/yourusername/aza-pg.git
cd aza-pg
```

**4.2 Verify build works**

```bash
# Run validation
bun run validate

# Build image
bun run build

# Verify image built
docker images | grep aza-pg
```

**4.3 Tag and push to GitHub Container Registry**

```bash
# Login to GHCR
echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin

# Tag image
docker tag aza-pg:latest ghcr.io/USERNAME/aza-pg:18.1-$(date +%Y%m%d%H%M%S)
docker tag aza-pg:latest ghcr.io/USERNAME/aza-pg:18.1-latest

# Push
docker push ghcr.io/USERNAME/aza-pg:18.1-$(date +%Y%m%d%H%M%S)
docker push ghcr.io/USERNAME/aza-pg:18.1-latest
```

---

### Step 5: Deploy PostgreSQL Stack in Coolify

**5.1 Create New Resource**

In Coolify UI:

1. Go to: Projects → Default Project
2. Click: Add New Resource
3. Select: Docker Compose
4. Name: `aza-pg-stack`
5. Click: Continue

**5.2 Configure Docker Compose**

1. In the Docker Compose editor, paste the content from `/opt/apps/art/infra/aza-pg/deployments/phase1-single-vps/docker-compose.yml`
2. Modify the `networks` section to reference the Coolify network:

```yaml
networks:
  aza-pg-network:
    external: true
    name: aza-pg-network
```

**5.3 Configure Environment Variables**

In Coolify UI, navigate to: Environment Variables tab

Add these variables:

```env
# PostgreSQL Configuration
POSTGRES_PASSWORD=CHANGE_ME_TO_SECURE_PASSWORD
POSTGRES_DB=main
POSTGRES_USER=postgres
POSTGRES_MEMORY=5GB
POSTGRES_WORKLOAD_TYPE=web
POSTGRES_STORAGE_TYPE=ssd

# PgBouncer Configuration
PGBOUNCER_POOL_MODE=transaction
PGBOUNCER_DEFAULT_POOL_SIZE=25
PGBOUNCER_MAX_CLIENT_CONN=2000

# Monitoring Configuration
MONITORING_PASSWORD=CHANGE_ME_TO_SECURE_PASSWORD
GRAFANA_ADMIN_PASSWORD=CHANGE_ME_TO_SECURE_PASSWORD

# Hetzner S3 Configuration (for backups)
S3_ENDPOINT=fsn1.your-objectstorage.hetzner.cloud
S3_BUCKET=aza-pg-backups-experimental
S3_ACCESS_KEY=CHANGE_ME
S3_SECRET_KEY=CHANGE_ME

# Domain Configuration
GRAFANA_DOMAIN=grafana.yourdomain.com
POSTGRESUS_DOMAIN=postgresus.yourdomain.com
```

**Generate secure passwords:**

Run locally:

```bash
openssl rand -base64 32
# Copy output and paste into Coolify environment variables
# Repeat for each password field
```

**5.4 Configure Volumes**

Copy configuration files to Coolify persistent storage:

**Method 1: Via Coolify File Manager (Recommended)**

1. In Coolify UI, go to: Storage tab
2. Create volumes for:
   - `prometheus_config`
   - `prometheus_data`
   - `grafana_data`
   - `pgbouncer_config`
   - `pgbackrest_config`
   - `postgres_data`

3. Use File Manager to upload files:
   - Upload `prometheus/prometheus.yml` to `prometheus_config` volume
   - Upload `pgbouncer/pgbouncer.ini` to `pgbouncer_config` volume
   - Upload `pgbackrest/pgbackrest.conf` to `pgbackrest_config` volume

**Method 2: Via SSH (Bare VPS Alternative)**

```bash
# SSH to VPS
ssh root@VPS_IP

# Create stack directory
mkdir -p /opt/aza-pg-stack
cd /opt/aza-pg-stack

# Copy files from repository
# - Copy docker-compose.yml
# - Copy prometheus/prometheus.yml
# - Copy pgbouncer/pgbouncer.ini
# - Copy pgbackrest/pgbackrest.conf
# - Copy grafana/ directory
# - Copy scripts/ directory
```

**5.5 Deploy the Stack**

In Coolify UI:

1. Review all configurations
2. Click: Deploy
3. Monitor deployment logs in real-time

**Verify all services started:**
Check the Services tab - all containers should show "Running" status.

**Bare VPS Alternative:**

```bash
cd /opt/aza-pg-stack
docker compose up -d

# Check all services started
docker compose ps
```

**Expected services:**

- postgres (running, port 5432/tcp)
- pgbouncer (running, port 6432/tcp)
- postgres-exporter (running, port 9187/tcp)
- prometheus (running, port 9090/tcp)
- grafana (running, port 3000/tcp)

**5.6 Verify PostgreSQL Auto-Config**

In Coolify UI, go to: Services → postgres → Logs → Execute Command

Run these commands:

```bash
# Check PostgreSQL is ready
pg_isready
# Expected: /var/run/postgresql:5432 - accepting connections

# Check auto-config applied
psql -U postgres -c "SHOW shared_buffers;"
# Expected: ~1280MB (1.25GB = 25% of 5GB)

psql -U postgres -c "SHOW max_connections;"
# Expected: 200 (web workload type)

psql -U postgres -c "SHOW random_page_cost;"
# Expected: 1.1 (SSD optimized)
```

**Bare VPS Alternative:**

```bash
docker exec postgres pg_isready
docker exec postgres psql -U postgres -c "SHOW shared_buffers;"
docker exec postgres psql -U postgres -c "SHOW max_connections;"
docker exec postgres psql -U postgres -c "SHOW random_page_cost;"
```

---

### Step 6: Configure Monitoring

**6.1 Create monitoring database user**

In Coolify UI, execute in postgres container:

```bash
psql -U postgres -c "
CREATE USER monitoring WITH PASSWORD 'YOUR_MONITORING_PASSWORD';
GRANT pg_monitor TO monitoring;
"
```

**Bare VPS Alternative:**

```bash
docker exec postgres psql -U postgres -c "
CREATE USER monitoring WITH PASSWORD 'YOUR_MONITORING_PASSWORD';
GRANT pg_monitor TO monitoring;
"
```

**6.2 Configure Grafana Domain (Optional)**

In Coolify UI:

1. Go to: Services → grafana
2. Navigate to: Domains tab
3. Add domain: `grafana.yourdomain.com`
4. Enable: SSL/TLS via Let's Encrypt
5. Save

Access Grafana at: `https://grafana.yourdomain.com`

**Without domain:** Access via port mapping at `http://VPS_IP:3000`

Login:

- Username: `admin`
- Password: Value from `GRAFANA_ADMIN_PASSWORD` in environment variables

**6.3 Add Prometheus datasource**

1. Go to: Configuration → Data Sources → Add data source
2. Select: Prometheus
3. URL: `http://prometheus:9090`
4. Click: Save & Test

**6.4 Import PostgreSQL dashboard**

1. Go to: Dashboards → Import
2. Enter ID: `14114`
3. Select Prometheus datasource
4. Click: Import

**6.5 Verify metrics**

Check dashboard shows:

- PostgreSQL version: 18.1
- Uptime: >0
- Connections: 1-5 (just monitoring)
- QPS: 0-10 (background queries)

---

### Step 7: Configure Backups with Postgresus

**7.1 Create Hetzner Object Storage bucket**

Via Hetzner Cloud Console:

1. Go to: Storage → Object Storage
2. Click: Create Bucket
3. Name: `aza-pg-backups-experimental` (NO DOTS!)
4. Region: Falkenstein (fsn1)
5. Click: Create

**7.2 Generate S3 credentials**

1. Click on bucket
2. Go to: Credentials tab
3. Click: Generate credentials
4. Copy Access Key and Secret Key
5. Update environment variables in Coolify with these values

**7.3 Deploy Postgresus**

**Option A: Via Coolify UI (Recommended)**

1. Go to: Projects → Default Project → Add New Resource
2. Select: Service → Docker Image
3. Service Name: `postgresus`
4. Image: `ghcr.io/rostislavdugin/postgresus:latest`
5. Network: Select `aza-pg-network` (under "Connect to Predefined Network")
6. Port Mapping: `3002:3002`
7. Environment Variables:
   ```
   DATABASE_URL=postgres://postgres:PASSWORD@postgres:5432/postgresus
   ```
8. Volume: Mount `/app/data` to persistent volume `postgresus_data`
9. Deploy

**Option B: Via Docker (Bare VPS Alternative)**

```bash
docker run -d \
  --name postgresus \
  --network aza-pg-network \
  -p 3002:3002 \
  -v postgresus_data:/app/data \
  -e DATABASE_URL=postgres://postgres:PASSWORD@postgres:5432/postgresus \
  ghcr.io/rostislavdugin/postgresus:latest
```

**7.4 Configure Postgresus Domain (Optional)**

In Coolify UI:

1. Go to: Services → postgresus
2. Navigate to: Domains tab
3. Add domain: `postgresus.yourdomain.com`
4. Enable: SSL/TLS via Let's Encrypt
5. Save

**7.5 Configure backup in Postgresus UI**

Access Postgresus:

- With domain: `https://postgresus.yourdomain.com`
- Without domain: `http://VPS_IP:3002`

1. Create account (first-time setup)
2. Add Database:
   - Host: `postgres` (container name on same network)
   - Port: `5432`
   - Database: `main`
   - Username: `postgres`
   - Password: From environment variable `POSTGRES_PASSWORD`
3. Configure Storage:
   - Type: S3 Compatible
   - Endpoint: From environment variable `S3_ENDPOINT`
   - Bucket: From environment variable `S3_BUCKET`
   - Access Key: From environment variable `S3_ACCESS_KEY`
   - Secret Key: From environment variable `S3_SECRET_KEY`
4. Set Schedule:
   - Frequency: Daily
   - Time: 02:00 AM UTC
   - Retention: 7 days
5. Save configuration

**7.6 Test backup**

1. In Postgresus UI: Click "Backup Now"
2. Wait for completion
3. Verify in Hetzner S3 bucket: Should see backup file

---

### Step 8: Configure PgBouncer

**8.1 Verify PgBouncer started**

In Coolify UI, execute in pgbouncer container:

```bash
psql -h localhost -p 6432 -U postgres -c "SHOW POOLS;"
```

**Bare VPS Alternative:**

```bash
docker exec pgbouncer psql -h localhost -p 6432 -U postgres -c "SHOW POOLS;"
```

**Expected output:**

```
 database | user     | cl_active | cl_waiting | sv_active | sv_idle | sv_used | sv_tested | sv_login | maxwait | pool_mode
----------+----------+-----------+------------+-----------+---------+---------+-----------+----------+---------+-----------
 main     | postgres |         0 |          0 |         0 |       0 |       0 |         0 |        0 |       0 | transaction
```

**8.2 Test connection through PgBouncer**

```bash
psql -h localhost -p 6432 -U postgres -d main -c "SELECT version();"
```

**Bare VPS Alternative:**

```bash
docker exec pgbouncer psql -h localhost -p 6432 -U postgres -d main -c "SELECT version();"
```

Should return PostgreSQL version string.

---

### Step 9: Connection String Configuration

**For microservices connecting to this database:**

**Direct PostgreSQL (internal testing only):**

```
postgresql://postgres:PASSWORD@postgres:5432/main
```

**Via PgBouncer (RECOMMENDED for all applications):**

```
postgresql://postgres:PASSWORD@pgbouncer:6432/main?pgbouncer=true
```

**For services in different Coolify stacks:**

When creating or editing any service in Coolify:

1. Navigate to: Network tab
2. Enable: "Connect to Predefined Network"
3. Select: `aza-pg-network`
4. Save changes
5. Use hostname: `pgbouncer` in connection string (DNS resolution works across network)

**Connection pooling in application code:**

Most frameworks have built-in pooling. Configure conservatively:

- Pool size per instance: 10 (NOT 50+)
- Max connections: 20
- Idle timeout: 30 seconds

Why: PgBouncer handles pooling at infrastructure level. App-level pools should be small.

---

### Step 10: Verification & Testing

**10.1 Create test database and table**

In Coolify UI, execute in postgres container:

```bash
psql -U postgres <<EOF
CREATE DATABASE test_db;
\c test_db
CREATE TABLE health_check (
  id SERIAL PRIMARY KEY,
  ts TIMESTAMP DEFAULT NOW(),
  message TEXT
);
INSERT INTO health_check (message) VALUES ('System operational');
SELECT * FROM health_check;
EOF
```

**Bare VPS Alternative:**

```bash
docker exec postgres psql -U postgres <<EOF
CREATE DATABASE test_db;
\c test_db
CREATE TABLE health_check (
  id SERIAL PRIMARY KEY,
  ts TIMESTAMP DEFAULT NOW(),
  message TEXT
);
INSERT INTO health_check (message) VALUES ('System operational');
SELECT * FROM health_check;
EOF
```

**10.2 Test backup and restore**

1. Trigger backup via Postgresus UI
2. Download backup file from S3 (optional verification)
3. Create test restore database:
   ```bash
   psql -U postgres -c "CREATE DATABASE test_restore;"
   ```
4. Upload backup via Postgresus UI to test_restore database
5. Verify data exists:
   ```bash
   psql -U postgres -d test_restore -c "SELECT * FROM health_check;"
   ```

**10.3 Load test with pgbench**

```bash
# Initialize pgbench
pgbench -U postgres -i -s 10 main

# Run benchmark (1 minute, 10 clients)
pgbench -U postgres -c 10 -j 2 -T 60 main
```

**Expected results (CPX31 with NVMe):**

- TPS: 2000-5000 (transactions per second)
- Latency: <5ms average

**10.4 Monitor resource usage**

In Coolify UI: Go to each service → Resources tab to view live CPU/RAM usage

**Bare VPS Alternative:**

```bash
# CPU and RAM
docker stats --no-stream

# Disk I/O
docker exec postgres psql -U postgres -c "SELECT * FROM pg_stat_io;"

# Connection count
docker exec postgres psql -U postgres -c "SELECT count(*) FROM pg_stat_activity;"
```

**10.5 Check auto-vacuum is working**

```bash
psql -U postgres -c "SELECT schemaname, tablename, last_autovacuum, last_autoanalyze FROM pg_stat_user_tables ORDER BY last_autovacuum DESC NULLS LAST LIMIT 10;"
```

**10.6 Verify Grafana dashboard**

Check metrics are populating:

- Uptime graph shows data
- QPS shows pgbench activity
- Connection count shows accurate numbers
- Disk usage shows database size

---

## Phase 2: Dual VPS with Failover (Optional)

Deploy when:

- Validation proves product-market fit
- Uptime becomes critical
- Budget allows +€12/month

### Step 11: Provision Replica VPS

**11.1 Create second VPS**

In Hetzner Cloud Console:

1. Create Server with same specs as primary (CPX31)
2. Name: `aza-pg-replica`
3. Location: fsn1
4. Image: Ubuntu 24.04 LTS

**Bare VPS Alternative:**

```bash
hcloud server create \
  --name aza-pg-replica \
  --type cpx31 \
  --image ubuntu-24.04 \
  --location fsn1 \
  --ssh-key your-ssh-key-name
```

**11.2 Create private network**

In Hetzner Cloud Console:

1. Go to: Networks
2. Click: Create Network
3. Name: `aza-pg-private`
4. IP Range: `10.0.0.0/16`
5. Add Subnet:
   - Network Zone: eu-central
   - IP Range: `10.0.0.0/24`
6. Attach Servers:
   - aza-pg-primary → IP: `10.0.0.2`
   - aza-pg-replica → IP: `10.0.0.3`

**Bare VPS Alternative:**

```bash
# Create network
hcloud network create \
  --name aza-pg-private \
  --ip-range 10.0.0.0/16

# Create subnet
hcloud network add-subnet aza-pg-private \
  --network-zone eu-central \
  --type server \
  --ip-range 10.0.0.0/24

# Attach servers
hcloud server attach-to-network aza-pg-primary --network aza-pg-private --ip 10.0.0.2
hcloud server attach-to-network aza-pg-replica --network aza-pg-private --ip 10.0.0.3
```

**11.3 Setup Coolify on replica VPS**

Repeat Steps 2-3 on replica VPS:

- Install Coolify
- Configure firewall
- Create Docker network

---

### Step 12: Configure Streaming Replication

**12.1 On Primary: Create replication user**

Execute in postgres container:

```bash
psql -U postgres <<EOF
CREATE USER replicator WITH REPLICATION ENCRYPTED PASSWORD 'SECURE_REPLICATION_PASSWORD';
EOF
```

**12.2 On Primary: Configure pg_hba.conf**

```bash
bash -c "echo 'host replication replicator 10.0.0.3/32 scram-sha-256' >> /var/lib/postgresql/data/pg_hba.conf"

# Reload PostgreSQL
psql -U postgres -c "SELECT pg_reload_conf();"
```

**12.3 On Primary: Enable WAL archiving**

```bash
psql -U postgres <<EOF
ALTER SYSTEM SET wal_level = 'replica';
ALTER SYSTEM SET max_wal_senders = 3;
ALTER SYSTEM SET wal_keep_size = '1GB';
ALTER SYSTEM SET hot_standby = 'on';
EOF
```

Then restart the postgres service in Coolify UI or via:

```bash
docker restart postgres
```

**12.4 On Replica: Create base backup**

In Coolify UI on replica:

1. Stop postgres service if running
2. Delete postgres_data volume
3. Create new volume

Then execute via Coolify terminal or SSH:

```bash
# Run pg_basebackup
docker run --rm \
  -v aza-pg-stack_postgres_data:/var/lib/postgresql/data \
  --network aza-pg-network \
  ghcr.io/USERNAME/aza-pg:18.1-latest \
  pg_basebackup -h 10.0.0.2 -D /var/lib/postgresql/data -U replicator -v -P -W
# Enter replication password when prompted
```

**12.5 On Replica: Create standby.signal**

```bash
# Create standby configuration
docker run --rm \
  -v aza-pg-stack_postgres_data:/var/lib/postgresql/data \
  ghcr.io/USERNAME/aza-pg:18.1-latest \
  bash -c "touch /var/lib/postgresql/data/standby.signal"

# Configure primary connection
docker run --rm \
  -v aza-pg-stack_postgres_data:/var/lib/postgresql/data \
  ghcr.io/USERNAME/aza-pg:18.1-latest \
  bash -c "echo \"primary_conninfo = 'host=10.0.0.2 port=5432 user=replicator password=SECURE_REPLICATION_PASSWORD'\" >> /var/lib/postgresql/data/postgresql.auto.conf"
```

**12.6 On Replica: Start PostgreSQL**

In Coolify UI: Start postgres service

Verify replication started:

```bash
psql -U postgres -c "SELECT pg_is_in_recovery();"
# Expected: t (true)

# Check replication status
psql -U postgres -c "SELECT * FROM pg_stat_wal_receiver;"
```

**12.7 On Primary: Verify replica connected**

```bash
psql -U postgres -c "SELECT * FROM pg_stat_replication;"
```

**Expected output:**

```
 application_name | client_addr | state     | sync_state
------------------+-------------+-----------+------------
 walreceiver      | 10.0.0.3    | streaming | async
```

---

### Step 13: Configure Keepalived for VIP

Keepalived provides a Virtual IP (VIP) that automatically moves between primary and replica during failover.

**Option A: Run on Host VPS (Recommended for production)**

Both servers need Keepalived installed directly on the host OS (not in Docker).

**On Primary VPS:**

```bash
# SSH to VPS
ssh root@PRIMARY_VPS_IP

# Install Keepalived
apt install -y keepalived

# Create config
nano /etc/keepalived/keepalived.conf
```

**Content:**

```
vrrp_script chk_postgres {
    script "/usr/bin/docker exec postgres pg_isready"
    interval 2
    weight 2
}

vrrp_instance VI_1 {
    state MASTER
    interface eth0
    virtual_router_id 51
    priority 100
    advert_int 1

    authentication {
        auth_type PASS
        auth_pass CHANGE_ME_SECURE_PASSWORD
    }

    virtual_ipaddress {
        10.0.0.100/24 dev eth0
    }

    track_script {
        chk_postgres
    }
}
```

```bash
# Start Keepalived
systemctl enable keepalived
systemctl start keepalived

# Verify VIP assigned
ip addr show eth0 | grep 10.0.0.100
```

**On Replica VPS:**

Repeat the same steps, but change in `/etc/keepalived/keepalived.conf`:

- `state BACKUP`
- `priority 90`

```bash
systemctl enable keepalived
systemctl start keepalived
```

**Option B: Run Keepalived in Docker (Development/Testing only)**

Create a Docker service in Coolify with:

- Image: `osixia/keepalived:latest`
- Network mode: `host` (required for VRRP)
- Privileged mode: enabled
- Volume: Mount keepalived.conf

**Note:** This option is less reliable and should only be used for testing.

**13.2 Test VIP failover**

On Primary:

```bash
systemctl stop keepalived
```

On Replica:

```bash
# Check VIP migrated
ip addr show eth0 | grep 10.0.0.100
# VIP should now appear on Replica
```

On Primary:

```bash
# Restart Keepalived (VIP returns)
systemctl start keepalived
```

---

### Step 14: Failover Testing

**14.1 Test manual promotion**

Simulate Primary failure:

On Primary VPS:

```bash
docker stop postgres
systemctl stop keepalived
```

On Replica VPS:

```bash
# Verify VIP migrated
ping 10.0.0.100
# Should respond from Replica

# Promote to Primary (execute in postgres container)
pg_ctl promote -D /var/lib/postgresql/data

# Wait 10 seconds, verify promotion
psql -U postgres -c "SELECT pg_is_in_recovery();"
# Expected: f (false - now primary)

# Test write capability
psql -U postgres -c "INSERT INTO health_check (message) VALUES ('Failover test successful');"
```

**14.2 Rebuild old Primary as new Replica**

On old Primary (now to become Replica):

1. In Coolify UI: Stop and delete postgres service
2. Delete postgres_data volume
3. Repeat Step 12.4-12.6 but with:
   - primary_conninfo pointing to new Primary (10.0.0.3)
   - Keepalived priority set to 90

---

## Operational Runbooks

### Daily Health Check

Save this script on the VPS:

```bash
#!/bin/bash
# Save as: /opt/aza-pg-stack/health-check.sh

echo "=== PostgreSQL Health Check ==="
echo "Date: $(date)"
echo ""

echo "1. PostgreSQL Status"
docker exec postgres pg_isready
echo ""

echo "2. Connection Count"
docker exec postgres psql -U postgres -t -c "SELECT count(*) FROM pg_stat_activity;"
echo ""

echo "3. Database Size"
docker exec postgres psql -U postgres -t -c "SELECT pg_size_pretty(pg_database_size('main'));"
echo ""

echo "4. PgBouncer Pools"
docker exec pgbouncer psql -h localhost -p 6432 -U postgres -t -c "SHOW POOLS;"
echo ""

echo "5. Last Backup (check Postgresus UI)"
echo "   URL: http://VPS_IP:3002"
echo ""

echo "6. Replication Status (Phase 2 only)"
docker exec postgres psql -U postgres -t -c "SELECT application_name, state, sync_state FROM pg_stat_replication;" 2>/dev/null || echo "Not configured"
echo ""

echo "=== Health Check Complete ==="
```

Make executable and schedule:

**Bare VPS Alternative:**

```bash
chmod +x /opt/aza-pg-stack/health-check.sh

# Schedule daily via cron
crontab -e
# Add:
0 9 * * * /opt/aza-pg-stack/health-check.sh > /var/log/pg-health.log 2>&1
```

**Coolify Alternative:**
Create a scheduled task in Coolify to run this script.

---

### Backup Restoration Procedure

**Restore via Postgresus (Recommended):**

1. Access Postgresus UI: `http://VPS_IP:3002` or domain
2. Navigate to: Backups tab
3. Select backup by timestamp
4. Click: Restore
5. Choose target database (create new or overwrite existing)
6. Wait for completion
7. Verify data:
   ```bash
   psql -U postgres -d RESTORED_DB -c "SELECT count(*) FROM your_table;"
   ```

**Manual restore from S3 backup:**

```bash
# Download backup from S3 (via Hetzner Console or CLI)
# Assuming backup downloaded to /tmp/backup-TIMESTAMP.sql.gz

# Decompress
gunzip /tmp/backup-TIMESTAMP.sql.gz

# Restore
docker exec -i postgres psql -U postgres -d main < /tmp/backup-TIMESTAMP.sql

# Verify
docker exec postgres psql -U postgres -d main -c "SELECT count(*) FROM health_check;"
```

---

## Troubleshooting Guide

### Coolify-Specific Issues

#### Container Won't Start in Coolify

**Symptom:** Service shows "Exited" status immediately after deployment

**Diagnosis:**

In Coolify UI:

1. Go to service → Logs tab
2. Check deployment logs for errors
3. Check runtime logs for application errors

**Common Solutions:**

1. **Volume mount issues:**
   - Verify volumes are created in Storage tab
   - Check file permissions in volume
   - Ensure configuration files are properly uploaded

2. **Network issues:**
   - Verify `aza-pg-network` exists in Settings → Networks
   - Check service is connected to correct network
   - Verify network mode is `bridge` not `host`

3. **Environment variable issues:**
   - Check all required variables are set
   - Verify no typos in variable names
   - Check for special characters that need escaping

#### Services Can't Connect to Database

**Symptom:** Application shows "connection refused" or "host not found"

**Diagnosis:**

1. Verify both services are on `aza-pg-network`:
   - Service A → Network tab → should show `aza-pg-network`
   - Service B → Network tab → should show `aza-pg-network`

2. Test DNS resolution:
   ```bash
   # In application container
   ping postgres
   ping pgbouncer
   ```

**Solutions:**

1. **Add service to network:**
   - Go to service → Network tab
   - Enable "Connect to Predefined Network"
   - Select `aza-pg-network`
   - Redeploy service

2. **Use correct hostname:**
   - Use service name as hostname: `postgres`, `pgbouncer`
   - NOT IP addresses
   - NOT localhost

3. **Check firewall rules:**
   - Internal Docker networks should bypass firewall
   - If using host network mode, add firewall rules

#### Persistent Volume Data Loss

**Symptom:** Database resets after redeployment

**Diagnosis:**

In Coolify UI:

1. Go to service → Storage tab
2. Verify volumes are marked as "Persistent"
3. Check volume mount paths are correct

**Solutions:**

1. Ensure volumes are persistent (not ephemeral)
2. Don't delete volumes when redeploying
3. Use named volumes, not anonymous volumes
4. Backup before major changes

---

### General PostgreSQL Issues

#### Connection Refused

**Symptom:** `psql: error: connection to server at "pgbouncer" (172.20.0.4), port 6432 failed: Connection refused`

**Diagnosis:**

```bash
# Check PgBouncer running
docker ps | grep pgbouncer

# Check logs
docker logs pgbouncer --tail 50

# Check network
docker network inspect aza-pg-network
```

**Solutions:**

1. Restart PgBouncer via Coolify UI or: `docker restart pgbouncer`
2. Verify password in environment variables matches database
3. Check PgBouncer can reach PostgreSQL: `docker exec pgbouncer ping postgres`

---

#### High Replication Lag

**Symptom:** Replica is >10MB behind Primary

**Diagnosis:**

```bash
# Check lag on Replica
psql -U postgres -c "SELECT pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()) AS lag_bytes;"

# Check network between servers
ping 10.0.0.2  # From Replica
```

**Solutions:**

1. Check disk I/O (in Coolify: Resources tab or via `iostat -x 1`)
2. Verify network bandwidth sufficient
3. Check for long-running queries on Primary:
   ```bash
   psql -U postgres -c "SELECT pid, now() - query_start AS duration, query FROM pg_stat_activity WHERE state = 'active' ORDER BY duration DESC;"
   ```
4. Increase `wal_keep_size` on Primary if lag spikes during maintenance

---

#### Backup Failures

**Symptom:** Postgresus shows "Backup failed"

**Diagnosis:**

1. Check Postgresus logs in UI
2. Verify S3 credentials via Hetzner Console
3. Check disk space: In Coolify Resources tab or `df -h`

**Solutions:**

1. Verify S3 credentials in Postgresus UI
2. Check bucket name has NO DOTS
3. Ensure sufficient disk space (need 2x DB size for dump)
4. Verify PostgreSQL accessible from Postgresus container:
   ```bash
   docker exec postgresus pg_dump --version
   docker exec postgresus psql -h postgres -U postgres -c "SELECT 1;"
   ```

---

#### Performance Degradation

**Symptom:** Queries slower than baseline

**Diagnosis:**

```bash
# Check slow queries
psql -U postgres -c "SELECT query, calls, total_exec_time, mean_exec_time FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;"

# Check connection count
psql -U postgres -c "SELECT count(*) FROM pg_stat_activity;"

# Check PgBouncer wait queue
docker exec pgbouncer psql -h localhost -p 6432 -U postgres -c "SHOW POOLS;" | grep -v " 0 |" | grep -v "maxwait"

# Check cache hit ratio
psql -U postgres -c "SELECT sum(blks_hit)::float / (sum(blks_hit) + sum(blks_read)) AS cache_hit_ratio FROM pg_stat_database;"
```

**Solutions:**

1. If cache hit ratio <0.99: Increase `shared_buffers` or optimize queries
2. If PgBouncer maxwait >0: Increase `default_pool_size` or optimize queries
3. If connection count >100: Verify PgBouncer is being used (not direct connections)
4. Use auto_explain to identify slow query plans:
   ```bash
   docker logs postgres | grep "duration:"
   ```

---

## Security Hardening

### SSL/TLS for PostgreSQL

**Generate self-signed certificate:**

```bash
# Run locally in repo
bun run scripts/generate-ssl-certs.ts

# Or manually on VPS:
cd /opt/aza-pg-stack/ssl
openssl req -new -x509 -days 365 -nodes -text \
  -out server.crt \
  -keyout server.key \
  -subj "/CN=postgres.yourdomain.com"
chmod 600 server.key
chown 999:999 server.key server.crt  # PostgreSQL user inside container
```

**Mount in Coolify:**

1. Upload `server.crt` and `server.key` to persistent volume
2. In docker-compose, add volume mounts:
   ```yaml
   postgres:
     volumes:
       - ./ssl/server.crt:/var/lib/postgresql/data/server.crt:ro
       - ./ssl/server.key:/var/lib/postgresql/data/server.key:ro
   ```

**Enable SSL in PostgreSQL:**

```bash
psql -U postgres <<EOF
ALTER SYSTEM SET ssl = 'on';
ALTER SYSTEM SET ssl_cert_file = 'server.crt';
ALTER SYSTEM SET ssl_key_file = 'server.key';
EOF
```

Restart postgres service in Coolify UI.

**Update connection strings:**

```
postgresql://postgres:PASSWORD@pgbouncer:6432/main?sslmode=require
```

---

### Restrict pg_hba.conf

```bash
bash -c 'cat > /var/lib/postgresql/data/pg_hba.conf << EOF
# TYPE  DATABASE        USER            ADDRESS                 METHOD
local   all             postgres                                peer
host    all             all             127.0.0.1/32            scram-sha-256
host    all             all             ::1/128                 scram-sha-256
host    all             all             172.20.0.0/16           scram-sha-256
host    replication     replicator      10.0.0.0/24             scram-sha-256
EOF'

psql -U postgres -c "SELECT pg_reload_conf();"
```

---

### Application-Specific Database Users

```bash
# Create read-only user for reporting
psql -U postgres <<EOF
CREATE USER reporting WITH PASSWORD 'secure_password';
GRANT CONNECT ON DATABASE main TO reporting;
GRANT USAGE ON SCHEMA public TO reporting;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO reporting;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO reporting;
EOF

# Create read-write user for application
psql -U postgres <<EOF
CREATE USER app_user WITH PASSWORD 'secure_password';
GRANT CONNECT ON DATABASE main TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;
EOF
```

---

## Cost Monitoring

**Phase 1 (Single VPS):**

- CPX31 VPS: €11.90/month
- Object Storage (50GB): €0.25/month
- Traffic: €0 (20TB included)
- **Total: ~€12.15/month**

**Phase 2 (Dual VPS):**

- 2x CPX31 VPS: €23.80/month
- Object Storage: €0.25/month
- Private Network: €0 (included)
- **Total: ~€24.05/month**

**vs Managed PostgreSQL:**

- Supabase Pro: $25/month (~€23) + $0.125/GB (no pooling, no extensions)
- AWS RDS db.t4g.large: $146/month (~€135)
- **Savings: 87-91%**

---

## Next Steps After Phase 1

1. **Monitor for 30 days**
   - Track uptime, performance, backup success
   - Identify slow queries via Grafana
   - Tune configuration if needed

2. **Evaluate Phase 2 need**
   - If uptime >99.5%: Stay on Phase 1
   - If multiple outages: Move to Phase 2
   - If can't tolerate downtime: Move to Phase 2

3. **Consider Phase 3 hardening**
   - Database >100GB → pgBackRest
   - Need PITR → pgBackRest
   - Need <30s RTO → pg_auto_failover

---

## Appendix

### Useful Commands

**Check PostgreSQL version:**

```bash
docker exec postgres psql -U postgres -c "SELECT version();"
```

**List all databases:**

```bash
docker exec postgres psql -U postgres -c "\l"
```

**List all extensions:**

```bash
docker exec postgres psql -U postgres -d main -c "\dx"
```

**Check table sizes:**

```bash
docker exec postgres psql -U postgres -d main -c "SELECT schemaname, tablename, pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size FROM pg_tables ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC LIMIT 10;"
```

**Kill long-running query:**

```bash
# Get PID
docker exec postgres psql -U postgres -c "SELECT pid, now() - query_start AS duration, query FROM pg_stat_activity WHERE state = 'active' ORDER BY duration DESC;"

# Kill it
docker exec postgres psql -U postgres -c "SELECT pg_terminate_backend(PID);"
```

**Vacuum database:**

```bash
docker exec postgres psql -U postgres -d main -c "VACUUM ANALYZE;"
```

---

### Configuration Files Reference

All configuration files are in:

- `deployments/phase1-single-vps/` - Single VPS setup
- `deployments/phase2-dual-vps/` - Replication setup
- `scripts/` - Automation scripts

**Key files to copy to Coolify:**

- `docker-compose.yml` - Main stack definition
- `prometheus/prometheus.yml` - Metrics collection config
- `pgbouncer/pgbouncer.ini` - Connection pooler config
- `pgbackrest/pgbackrest.conf` - Backup tool config (if using)
- `grafana/` - Dashboard configurations
- `scripts/` - Helper scripts

---

### Support and Troubleshooting

**Documentation:**

- Project README: `/opt/apps/art/infra/aza-pg/README.md`
- Architecture: `/opt/apps/art/infra/aza-pg/ARCHITECTURE.md`
- This guide: `/opt/apps/art/infra/aza-pg/docs/DEPLOYMENT.md`

**Monitoring:**

- Grafana: `https://grafana.yourdomain.com` or `http://VPS_IP:3000`
- Prometheus: `http://VPS_IP:9090` (typically internal only)
- Postgresus: `https://postgresus.yourdomain.com` or `http://VPS_IP:3002`

**Logs:**

Via Coolify UI:

- Navigate to service → Logs tab
- View real-time logs
- Search historical logs

Via CLI (Bare VPS Alternative):

```bash
# PostgreSQL logs
docker logs postgres --tail 100 -f

# PgBouncer logs
docker logs pgbouncer --tail 100 -f

# All services
docker compose logs -f
```
