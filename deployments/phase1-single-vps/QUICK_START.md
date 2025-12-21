# Quick Start: Single-Node PostgreSQL with Coolify

Deploy production-ready PostgreSQL 18.1 with auto-tuning, connection pooling, and monitoring via Coolify UI.

## Prerequisites

- Coolify instance running
- GitHub account with access to `ghcr.io/YOUR_USERNAME/aza-pg:18.1-latest`
- `.env` file prepared (copy from `.env.example` and set secure passwords)

## Step 1: Create Network

In Coolify UI:

1. Navigate to **Resources** → **Networks**
2. Click **Create Network**
3. Name: `aza-pg-network`
4. Driver: `bridge`
5. Click **Create**

## Step 2: Deploy PostgreSQL

In Coolify UI:

1. Navigate to your project
2. Click **+ New Resource** → **Docker Compose**
3. Name: `aza-pg-postgres`
4. Paste service definition for `postgres` from `docker-compose.yml`
5. Set environment variables:
   - `POSTGRES_PASSWORD` (from your `.env`)
   - `POSTGRES_DB=main`
   - `POSTGRES_USER=postgres`
   - `POSTGRES_MEMORY=5GB`
   - `POSTGRES_WORKLOAD_TYPE=web`
   - `POSTGRES_STORAGE_TYPE=ssd`
   - `GITHUB_USERNAME` (your GitHub username)
6. Configure volumes:
   - `postgres_data:/var/lib/postgresql/data`
7. Configure network: `aza-pg-network`
8. Configure port binding: `127.0.0.1:5432:5432`
9. Set resource limits:
   - CPU limit: 3.0
   - Memory limit: 5GB
   - CPU reservation: 2.0
   - Memory reservation: 4GB
10. Click **Deploy**

Verify:

```bash
docker exec postgres psql -U postgres -c "SELECT version();"
```

## Step 3: Deploy PgBouncer

In Coolify UI:

1. Click **+ New Resource** → **Docker Compose**
2. Name: `aza-pg-pgbouncer`
3. Paste service definition for `pgbouncer` from `docker-compose.yml`
4. Set environment variables:
   - `DATABASES_HOST=postgres`
   - `DATABASES_PORT=5432`
   - `DATABASES_DBNAME=main`
   - `DATABASES_USER=postgres`
   - `DATABASES_PASSWORD` (same as POSTGRES_PASSWORD)
   - `PGBOUNCER_POOL_MODE=transaction`
   - `PGBOUNCER_DEFAULT_POOL_SIZE=25`
   - `PGBOUNCER_MAX_CLIENT_CONN=2000`
   - `PGBOUNCER_AUTH_TYPE=scram-sha-256`
   - `PGBOUNCER_AUTH_FILE=/etc/pgbouncer/userlist.txt`
   - `PGBOUNCER_STATS_USERS=postgres`
   - `PGBOUNCER_IGNORE_STARTUP_PARAMETERS=extra_float_digits`
5. Configure volumes:
   - Mount `./pgbouncer/userlist.txt:/etc/pgbouncer/userlist.txt:ro`
6. Configure network: `aza-pg-network`
7. Configure port binding: `127.0.0.1:6432:6432`
8. Set resource limits:
   - CPU limit: 0.5
   - Memory limit: 512MB
9. Click **Deploy**

Verify:

```bash
docker exec pgbouncer psql -h localhost -p 6432 -U postgres -d main -c "SHOW POOLS;"
```

## Step 4: Deploy Monitoring Stack

In Coolify UI, create three separate services:

### A. PostgreSQL Exporter

1. **+ New Resource** → **Docker Compose**
2. Name: `aza-pg-postgres-exporter`
3. Image: `quay.io/prometheuscommunity/postgres-exporter:v0.18.1`
4. Environment:
   - `DATA_SOURCE_NAME=postgresql://monitoring:MONITORING_PASSWORD@postgres:5432/main?sslmode=disable`
   - `PG_EXPORTER_AUTO_DISCOVER_DATABASES=true`
   - `PG_EXPORTER_EXTEND_QUERY_PATH=/etc/postgres_exporter/queries.yaml`
5. Volume: `./prometheus/postgres_exporter_queries.yaml:/etc/postgres_exporter/queries.yaml:ro`
6. Network: `aza-pg-network`
7. Port: `127.0.0.1:9187:9187`
8. Deploy

### B. PgBouncer Exporter

1. **+ New Resource** → **Docker Compose**
2. Name: `aza-pg-pgbouncer-exporter`
3. Image: `prometheuscommunity/pgbouncer-exporter:v0.9.0`
4. Environment:
   - `PGBOUNCER_EXPORTER_HOST=pgbouncer`
   - `PGBOUNCER_EXPORTER_PORT=6432`
   - `PGBOUNCER_EXPORTER_USER=postgres`
   - `PGBOUNCER_EXPORTER_PASSWORD` (same as POSTGRES_PASSWORD)
   - `PGBOUNCER_EXPORTER_DATABASE=pgbouncer`
5. Network: `aza-pg-network`
6. Port: `127.0.0.1:9127:9127`
7. Deploy

### C. Prometheus

1. **+ New Resource** → **Docker Compose**
2. Name: `aza-pg-prometheus`
3. Image: `prom/prometheus:v3.1.0`
4. Command args:
   - `--config.file=/etc/prometheus/prometheus.yml`
   - `--storage.tsdb.path=/prometheus`
   - `--storage.tsdb.retention.time=30d`
   - `--web.enable-lifecycle`
5. Volumes:
   - `./prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro`
   - `prometheus_data:/prometheus`
6. Network: `aza-pg-network`
7. Port: `127.0.0.1:9090:9090`
8. Deploy

### D. Grafana

1. **+ New Resource** → **Docker Compose**
2. Name: `aza-pg-grafana`
3. Image: `grafana/grafana:11.4.0`
4. Environment:
   - `GF_SECURITY_ADMIN_USER=admin`
   - `GF_SECURITY_ADMIN_PASSWORD` (from .env)
   - `GF_SERVER_ROOT_URL=http://grafana.yourdomain.com`
   - `GF_AUTH_ANONYMOUS_ENABLED=false`
   - `GF_USERS_ALLOW_SIGN_UP=false`
5. Volumes:
   - `grafana_data:/var/lib/grafana`
   - `./grafana/provisioning:/etc/grafana/provisioning:ro`
6. Network: `aza-pg-network`
7. Port: `127.0.0.1:3000:3000` (or expose via Coolify reverse proxy)
8. Deploy

## Step 5: Verify Deployment

```bash
# Check all containers running
docker ps --filter "name=postgres|pgbouncer|exporter|prometheus|grafana"

# Test PostgreSQL direct connection
docker exec postgres psql -U postgres -c "SELECT current_database(), current_user, version();"

# Test PgBouncer connection
docker exec pgbouncer psql -h localhost -p 6432 -U postgres -d main -c "SHOW STATS;"

# Check metrics endpoints
curl http://localhost:9187/metrics | grep pg_up
curl http://localhost:9127/metrics | grep pgbouncer_up
curl http://localhost:9090/-/healthy

# Access Grafana
# Open http://localhost:3000 (or your configured domain)
# Login: admin / GRAFANA_ADMIN_PASSWORD
```

## Next Steps

1. Configure application connection strings to use PgBouncer (`postgres:6432`)
2. Set up automated backups (see `docs/BACKUPS.md`)
3. Import Grafana dashboards from `grafana/provisioning/dashboards/`
4. Review security settings (firewall rules, SSL/TLS)
5. Configure alerting in Prometheus

## Troubleshooting

**Container won't start:**

- Check Coolify logs for the specific service
- Verify all environment variables are set
- Ensure `aza-pg-network` exists: `docker network ls | grep aza-pg`

**Can't connect to PostgreSQL:**

- Verify container is healthy: `docker exec postgres pg_isready -U postgres`
- Check logs: `docker logs postgres`
- Ensure port binding is correct: `127.0.0.1:5432:5432`

**PgBouncer connection fails:**

- Verify `userlist.txt` contains postgres user with correct password hash
- Check PgBouncer logs: `docker logs pgbouncer`
- Test direct PostgreSQL connection first

**Metrics not appearing:**

- Ensure monitoring user exists in PostgreSQL: `CREATE USER monitoring WITH PASSWORD 'xxx';`
- Grant permissions: `GRANT pg_monitor TO monitoring;`
- Check exporter logs: `docker logs postgres-exporter`

---

## Bare VPS Alternative (No Coolify)

If deploying on bare VPS without Coolify:

### 1. SSH into VPS

```bash
ssh root@YOUR_VPS_IP
```

### 2. Clone and Prepare

```bash
cd /opt
git clone https://github.com/YOUR_USERNAME/aza-pg.git
cd aza-pg/deployments/phase1-single-vps
cp .env.example .env
nano .env  # Edit with secure passwords
```

### 3. Create Network

```bash
docker network create aza-pg-network
```

### 4. Deploy Stack

```bash
docker compose up -d
```

### 5. Verify

```bash
docker compose ps
docker compose logs -f postgres
```

All verification commands from Step 5 above apply.
