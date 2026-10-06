# Phase 2: Dual VPS with Streaming Replication + Keepalived

High availability setup with automatic VIP failover and manual database promotion.

## Architecture

```
Primary VPS (10.0.0.2)          Replica VPS (10.0.0.3)
├── PostgreSQL (Primary)        ├── PostgreSQL (Standby)
├── PgBouncer (Priority 100)    ├── PgBouncer (Priority 90)
├── Keepalived (holds the VIP)  ├── Keepalived (no VIP while standby)
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
echo 'host replication replicator 10.0.0.3/32 scram-sha-256' >> "$PGDATA/pg_hba.conf"
psql -U postgres -c "SELECT pg_reload_conf();"
```

**Bare VPS Method:**

```bash
docker exec -i postgres psql -U postgres <<EOF
CREATE USER replicator WITH REPLICATION ENCRYPTED PASSWORD 'SECURE_REPLICATION_PASSWORD';
EOF

docker exec postgres bash -c 'echo "host replication replicator 10.0.0.3/32 scram-sha-256" >> "$PGDATA/pg_hba.conf"'
docker exec postgres psql -U postgres -c "SELECT pg_reload_conf();"
```

### 3. Keep WAL for the Replica

The image already ships `wal_level = logical` (a superset of `replica`), `max_wal_senders = 10` and `hot_standby = on`. Never lower `wal_level`: with a logical slot present PostgreSQL refuses to start. Only retain WAL so a briefly disconnected replica can catch up (reload, no restart):

**Coolify Method:** Execute via PostgreSQL terminal tab:

```sql
ALTER SYSTEM SET wal_keep_size = '1GB';
SELECT pg_reload_conf();
```

**Bare VPS Method:**

```bash
docker exec -i postgres psql -U postgres <<EOF
ALTER SYSTEM SET wal_keep_size = '1GB';
SELECT pg_reload_conf();
EOF
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

# Copy the primary into the image's PGDATA; -R also writes standby.signal and primary_conninfo
docker run --rm \
    -v aza-pg-stack-replica_postgres_data:/var/lib/postgresql \
    -e PGHOST=10.0.0.2 -e PGUSER=replicator -e PGPASSWORD='SECURE_REPLICATION_PASSWORD' \
    ghcr.io/fluxo-kt/aza-pg:18 \
    bash -c 'pg_basebackup -D "$PGDATA" -R -v -P'
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

Keepalived runs on each VPS host, not in a container: its check script runs `docker exec` against the `postgres` container, and moving a VIP needs the host's network. On Coolify this means SSH to the host.

```bash
apt update && apt install -y keepalived
cp keepalived/primary.conf /etc/keepalived/keepalived.conf   # on the replica host: keepalived/replica.conf
# Set auth_pass (the same on both hosts), interface and the VIP for your network
systemctl enable --now keepalived
```

Only a writable primary holds the VIP. The config's check fails on a standby and on a stopped server, and a node whose check fails gives the VIP up, so:

- While the primary is down and the standby is not promoted, no node holds the VIP. Clients fail to connect instead of writing to a read-only standby.
- Promoting the standby moves the VIP to it within a few seconds.
- Both nodes start as `BACKUP` with `nopreempt`: an old primary that comes back still writable does not take the VIP back. Rebuild it as a replica before starting its PostgreSQL again.

**Verify the VIP is on the primary:**

```bash
ip addr show eth0 | grep 10.0.0.100
# Shows the VIP on the primary only
```

### 7. Test Failover

**The VIP never moves to a standby:**

```bash
# On primary: stop Keepalived
systemctl stop keepalived

# On replica: no VIP, because it is a standby
ip addr show eth0 | grep 10.0.0.100   # prints nothing

# On primary: start Keepalived; the VIP comes back
systemctl start keepalived
```

**Database promotion (manual - for actual disaster):**

```bash
# On replica - promote to primary
docker exec postgres pg_ctl promote  # pg_ctl reads the container's $PGDATA

# Verify promotion
docker exec postgres psql -U postgres -c "SELECT pg_is_in_recovery();"
# Should return 'f' (false); the VIP moves to this host within a few seconds
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
│   ├── primary.conf          # Priority 100; holds the VIP only while its PostgreSQL is a writable primary
│   └── replica.conf          # Same check, priority 90
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
# The VIP follows the promotion. Then rebuild old primary as new replica:

1. Stop old primary PostgreSQL
2. Remove data volume
3. Run pg_basebackup -R from new primary (step 4; -R writes standby.signal and primary_conninfo)
4. Start as replica
```

See `docs/RUNBOOKS.md` for detailed failover and recovery procedures.
