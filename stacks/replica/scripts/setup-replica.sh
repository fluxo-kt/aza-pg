#!/bin/bash
# Setup streaming replication from primary server
# This script runs during container initialization (docker-entrypoint-initdb.d)

set -e

echo "[REPLICA SETUP] Starting replication setup..."

# Check if data directory is already populated (existing replica)
if [ -f "$PGDATA/standby.signal" ]; then
  echo "[REPLICA SETUP] Replica already configured, skipping setup"
  exit 0
fi

# Validate required environment variables
if [ -z "$PRIMARY_HOST" ] || [ -z "$PG_REPLICATION_USER" ] || [ -z "$PG_REPLICATION_PASSWORD" ]; then
  echo "[REPLICA SETUP] ERROR: Missing required environment variables"
  echo "  PRIMARY_HOST: ${PRIMARY_HOST:-NOT SET}"
  echo "  PG_REPLICATION_USER: ${PG_REPLICATION_USER:-NOT SET}"
  echo "  PG_REPLICATION_PASSWORD: ${PG_REPLICATION_PASSWORD:+SET}"
  exit 1
fi

echo "[REPLICA SETUP] Waiting for primary server at $PRIMARY_HOST:${PRIMARY_PORT:-5432}..."
for i in $(seq 1 30); do
  if pg_isready -h "$PRIMARY_HOST" -p "${PRIMARY_PORT:-5432}" -U "$PG_REPLICATION_USER" 2>/dev/null; then
    echo "[REPLICA SETUP] Primary server is ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[REPLICA SETUP] ERROR: Primary server not reachable after 60 seconds"
    exit 1
  fi
  echo "[REPLICA SETUP] Waiting... attempt $i/30"
  sleep 2
done

# Stop Postgres before running pg_basebackup
echo "[REPLICA SETUP] Stopping Postgres for base backup..."
pg_ctl -D "$PGDATA" -m fast -w stop || true

# Backup existing data directory if it exists
if [ -d "$PGDATA" ] && [ "$(ls -A $PGDATA)" ]; then
  echo "[REPLICA SETUP] Backing up existing data directory..."
  mv "$PGDATA" "${PGDATA}_backup_$(date +%Y%m%d_%H%M%S)"
fi

# Create clean data directory
mkdir -p "$PGDATA"
chown -R postgres:postgres "$PGDATA"
chmod 0700 "$PGDATA"

# Perform base backup from primary
echo "[REPLICA SETUP] Starting pg_basebackup from primary..."
export PGPASSWORD="$PG_REPLICATION_PASSWORD"
pg_basebackup \
  -h "$PRIMARY_HOST" \
  -p "${PRIMARY_PORT:-5432}" \
  -U "$PG_REPLICATION_USER" \
  -D "$PGDATA" \
  -Fp \
  -Xs \
  -P \
  -R \
  -S replica_slot_1

# Create standby.signal file (indicates this is a replica)
touch "$PGDATA/standby.signal"

# Set permissions
chown -R postgres:postgres "$PGDATA"
chmod 0700 "$PGDATA"

echo "[REPLICA SETUP] Replication setup complete!"
echo "[REPLICA SETUP] Replica will connect to primary: $PRIMARY_HOST:${PRIMARY_PORT:-5432}"
echo "[REPLICA SETUP] Using replication slot: replica_slot_1"
