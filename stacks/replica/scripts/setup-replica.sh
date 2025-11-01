#!/bin/bash
# Setup streaming replication from primary server
# Runs in docker-entrypoint-initdb.d when PGDATA is empty

set -e

echo "[REPLICA] Starting replication setup..."

# Validate required environment variables
if [ -z "$PRIMARY_HOST" ]; then
  echo "[REPLICA] ERROR: PRIMARY_HOST not set"
  exit 1
fi

if [ -z "$PG_REPLICATION_USER" ] || [ -z "$PG_REPLICATION_PASSWORD" ]; then
  echo "[REPLICA] ERROR: PG_REPLICATION_USER or PG_REPLICATION_PASSWORD not set"
  exit 1
fi

REPLICATION_SLOT_NAME="${REPLICATION_SLOT_NAME:-replica_slot_1}"
PRIMARY_PORT="${PRIMARY_PORT:-5432}"

echo "[REPLICA] Waiting for primary at $PRIMARY_HOST:$PRIMARY_PORT..."
for i in $(seq 1 30); do
  if PGPASSWORD="$PG_REPLICATION_PASSWORD" pg_isready -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" -U "$PG_REPLICATION_USER" 2>/dev/null; then
    echo "[REPLICA] Primary is ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[REPLICA] ERROR: Primary not reachable after 60 seconds"
    exit 1
  fi
  sleep 2
done

# Run pg_basebackup to clone primary
# -R flag automatically creates standby.signal and writes primary_conninfo
echo "[REPLICA] Cloning primary database..."
PGPASSWORD="$PG_REPLICATION_PASSWORD" pg_basebackup \
  -h "$PRIMARY_HOST" \
  -p "$PRIMARY_PORT" \
  -U "$PG_REPLICATION_USER" \
  -D "$PGDATA" \
  -Fp \
  -Xs \
  -P \
  -R \
  -S "$REPLICATION_SLOT_NAME" \
  -c fast

echo "[REPLICA] Base backup complete"
echo "[REPLICA] Connected to: $PRIMARY_HOST:$PRIMARY_PORT"
echo "[REPLICA] Replication slot: $REPLICATION_SLOT_NAME"

# pg_basebackup -R creates standby.signal and postgresql.auto.conf automatically
# No need to manually create them
