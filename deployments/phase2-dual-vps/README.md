# Phase 2: Dual VPS with Streaming Replication + Keepalived

High availability setup with automatic VIP failover and manual database promotion.

## Architecture

```
Primary VPS (10.0.0.2)          Replica VPS (10.0.0.3)
├── PostgreSQL (Primary)        ├── PostgreSQL (Standby)
├── PgBouncer (Priority 100)    ├── PgBouncer (Priority 90)
├── Keepalived (MASTER)         ├── Keepalived (BACKUP)
└── Monitoring Stack            └── Monitoring Stack

           ↓ VIP ↓
        10.0.0.100
           ↓ ↓ ↓
      Microservices
```

## Prerequisites

1. Two Hetzner CPX31 VPS provisioned
2. Private network configured (10.0.0.0/24)
3. Phase 1 deployed and tested on primary
4. Both VPS on same Hetzner private network

## Setup Steps

### 1. Deploy Primary VPS

Copy configs from Phase 1 with modifications:

**Files to copy from `phase1-single-vps/`:**

- `docker-compose.yml` → Modify ports for private network access
- `.env.example` → Update with primary-specific values
- `pgbouncer/` directory
- `prometheus/` directory
- `grafana/` directory

**Required modifications to docker-compose.yml:**

```yaml
# Change port bindings for replication access
postgres:
  ports:
    - "10.0.0.2:5432:5432" # Bind to private IP, NOT 127.0.0.1
```

**Coolify Deployment:**

1. Create services via Coolify UI on primary VPS
2. Ensure PostgreSQL is accessible on private network IP
3. Test: `psql -h 10.0.0.2 -U postgres` from replica VPS

**Bare VPS Deployment:**

```bash
cd /opt/aza-pg-stack-primary
cp -r /path/to/phase1-single-vps/* .
# Edit docker-compose.yml to bind to private IP
docker compose up -d
```

### 2. Configure Replication User

**Coolify Method:**

1. Go to PostgreSQL service → Terminal tab
2. Execute:

```sql
CREATE USER replicator WITH REPLICATION ENCRYPTED PASSWORD 'SECURE_REPLICATION_PASSWORD';
```

3. Add to pg_hba.conf via terminal:

```bash
echo 'host replication replicator 10.0.0.3/32 scram-sha-256' >> /var/lib/postgresql/data/pg_hba.conf
psql -U postgres -c "SELECT pg_reload_conf();"
```

**Bare VPS Method:**

```bash
docker exec postgres psql -U postgres <<EOF
CREATE USER replicator WITH REPLICATION ENCRYPTED PASSWORD 'SECURE_REPLICATION_PASSWORD';
EOF

docker exec postgres bash -c "echo 'host replication replicator 10.0.0.3/32 scram-sha-256' >> /var/lib/postgresql/data/pg_hba.conf"
docker exec postgres psql -U postgres -c "SELECT pg_reload_conf();"
```

### 3. Enable WAL Settings

**Coolify Method:** Execute via PostgreSQL terminal tab:

```sql
ALTER SYSTEM SET wal_level = 'replica';
ALTER SYSTEM SET max_wal_senders = 3;
ALTER SYSTEM SET wal_keep_size = '1GB';
ALTER SYSTEM SET hot_standby = 'on';
```

Then restart PostgreSQL via Coolify UI (Service → Restart button).

**Bare VPS Method:**

```bash
docker exec postgres psql -U postgres <<EOF
ALTER SYSTEM SET wal_level = 'replica';
ALTER SYSTEM SET max_wal_senders = 3;
ALTER SYSTEM SET wal_keep_size = '1GB';
ALTER SYSTEM SET hot_standby = 'on';
EOF

docker restart postgres
```

### 4. Create Base Backup on Replica

Execute these commands on the **replica VPS**:

**Coolify Method:**

1. SSH to replica VPS host (not container)
2. Run the pg_basebackup commands below

**Bare VPS Method:**

```bash
cd /opt/aza-pg-stack-replica

# Stop postgres if running
docker stop postgres 2>/dev/null || true

# Remove old data
docker volume rm aza-pg-stack-replica_postgres_data || true

# Create volume
docker volume create aza-pg-stack-replica_postgres_data

# Run pg_basebackup (replace USERNAME with your GitHub username)
docker run --rm \
    -v aza-pg-stack-replica_postgres_data:/var/lib/postgresql/data \
    -e PGPASSWORD='SECURE_REPLICATION_PASSWORD' \
    ghcr.io/USERNAME/aza-pg:18.1-latest \
    pg_basebackup -h 10.0.0.2 -D /var/lib/postgresql/data -U replicator -v -P

# Create standby.signal
docker run --rm \
    -v aza-pg-stack-replica_postgres_data:/var/lib/postgresql/data \
    ghcr.io/USERNAME/aza-pg:18.1-latest \
    bash -c "touch /var/lib/postgresql/data/standby.signal"

# Configure primary_conninfo
docker run --rm \
    -v aza-pg-stack-replica_postgres_data:/var/lib/postgresql/data \
    ghcr.io/USERNAME/aza-pg:18.1-latest \
    bash -c "echo \"primary_conninfo = 'host=10.0.0.2 port=5432 user=replicator password=SECURE_REPLICATION_PASSWORD'\" >> /var/lib/postgresql/data/postgresql.auto.conf"
```

### 5. Start Replica

**Coolify Method:**
Deploy PostgreSQL service via Coolify UI, using the pre-configured volume.

**Bare VPS Method:**

```bash
docker compose up -d
```

**Verify replication (both methods):**

```sql
-- Should return 't' (true) - this is a standby
SELECT pg_is_in_recovery();

-- Should show connection to primary
SELECT * FROM pg_stat_wal_receiver;
```

### 6. Install Keepalived

> **IMPORTANT for Coolify Users:** Keepalived must run on the HOST VPS, not inside containers. Coolify containers don't have systemd or network control. Choose one of these options:

#### Option A: Keepalived on Host VPS (Recommended for Coolify)

SSH directly to both VPS hosts and install Keepalived at the OS level:

**On Primary VPS host:**

```bash
apt update && apt install -y keepalived

cat > /etc/keepalived/keepalived.conf << 'EOF'
vrrp_instance VI_1 {
    state MASTER
    interface eth0
    virtual_router_id 51
    priority 100
    advert_int 1
    authentication {
        auth_type PASS
        auth_pass your_secret_password
    }
    virtual_ipaddress {
        10.0.0.100/24
    }
}
EOF

systemctl enable keepalived
systemctl start keepalived
```

**On Replica VPS host:**

```bash
apt update && apt install -y keepalived

cat > /etc/keepalived/keepalived.conf << 'EOF'
vrrp_instance VI_1 {
    state BACKUP
    interface eth0
    virtual_router_id 51
    priority 90
    advert_int 1
    authentication {
        auth_type PASS
        auth_pass your_secret_password
    }
    virtual_ipaddress {
        10.0.0.100/24
    }
}
EOF

systemctl enable keepalived
systemctl start keepalived
```

**Verify VIP on primary:**

```bash
ip addr show eth0 | grep 10.0.0.100
# Should show the VIP
```

#### Option B: Dockerized Keepalived (Advanced)

Add to docker-compose.yml on both VPS:

```yaml
keepalived:
  image: osixia/keepalived:2.0.20
  container_name: keepalived
  restart: unless-stopped
  network_mode: host
  cap_add:
    - NET_ADMIN
    - NET_BROADCAST
  environment:
    KEEPALIVED_VIRTUAL_IPS: "10.0.0.100"
    KEEPALIVED_PRIORITY: "100" # 100 on primary, 90 on replica
    KEEPALIVED_INTERFACE: "eth0"
    KEEPALIVED_PASSWORD: "your_secret_password"
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock:ro
```

**Note:** Dockerized Keepalived requires `network_mode: host` and `CAP_NET_ADMIN` capability. This works on bare VPS but may have limitations on Coolify depending on configuration.

### 7. Test Failover

**Network failover test:**

```bash
# On primary: Simulate Keepalived failure
systemctl stop keepalived

# Verify VIP migrated to replica (from any machine)
ping 10.0.0.100  # Should respond from replica IP

# Restart primary Keepalived
systemctl start keepalived
```

**Database promotion (manual - for actual disaster):**

```bash
# On replica - promote to primary
docker exec postgres pg_ctl promote -D /var/lib/postgresql/data

# Verify promotion
docker exec postgres psql -U postgres -c "SELECT pg_is_in_recovery();"
# Should return 'f' (false) - no longer in recovery
```

## Files Required

Create these files in the phase2 directory structure:

```
phase2-dual-vps/
├── primary/
│   ├── docker-compose.yml    # Copy from phase1, modify ports
│   └── .env                  # Primary-specific values
├── replica/
│   ├── docker-compose.yml    # Copy from phase1, modify ports
│   └── .env                  # Replica-specific values
├── keepalived/
│   ├── primary.conf          # Priority 100, state MASTER
│   └── replica.conf          # Priority 90, state BACKUP
└── README.md                 # This file
```

**Key differences from Phase 1:**

- PostgreSQL ports bound to private IP (not 127.0.0.1)
- Replication user created
- WAL settings configured for streaming replication
- Keepalived for VIP management

## Monitoring

Configure Prometheus to scrape both VPS:

```yaml
scrape_configs:
  - job_name: "postgres-primary"
    static_configs:
      - targets: ["10.0.0.2:9187"]
        labels:
          instance: "primary"

  - job_name: "postgres-replica"
    static_configs:
      - targets: ["10.0.0.3:9187"]
        labels:
          instance: "replica"

  - job_name: "pgbouncer-primary"
    static_configs:
      - targets: ["10.0.0.2:9127"]
        labels:
          instance: "primary"

  - job_name: "pgbouncer-replica"
    static_configs:
      - targets: ["10.0.0.3:9127"]
        labels:
          instance: "replica"
```

## Troubleshooting

### Replication Not Working

```bash
# On primary - check replication status
docker exec postgres psql -U postgres -c "SELECT * FROM pg_stat_replication;"

# On replica - check receiver status
docker exec postgres psql -U postgres -c "SELECT * FROM pg_stat_wal_receiver;"

# Check logs
docker logs postgres --tail 100 | grep -i "replication\|standby"
```

### VIP Not Migrating

```bash
# Check Keepalived status
systemctl status keepalived

# Check VRRP messages
journalctl -u keepalived -f

# Verify network interface
ip addr show eth0

# Check if both have same virtual_router_id
grep virtual_router_id /etc/keepalived/keepalived.conf
```

### Promotion Issues

```bash
# After promotion, update DNS/VIP to point to new primary
# Then rebuild old primary as new replica:

1. Stop old primary PostgreSQL
2. Remove data volume
3. Run pg_basebackup from new primary
4. Create standby.signal
5. Configure primary_conninfo pointing to new primary
6. Start as replica
```

See `docs/RUNBOOKS.md` for detailed failover and recovery procedures.
