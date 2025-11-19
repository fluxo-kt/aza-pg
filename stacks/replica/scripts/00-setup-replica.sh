#!/bin/bash
# Setup streaming replication from primary server
# Runs in docker-entrypoint-initdb.d - must clean PGDATA first since initdb already created it

set -euo pipefail

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

# Validate replication slot name (prevent SQL injection)
if [[ ! "$REPLICATION_SLOT_NAME" =~ ^[a-zA-Z0-9_]+$ ]]; then
  echo "[REPLICA] ERROR: Invalid replication slot name (alphanumeric and underscore only)"
  exit 1
fi

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

echo "[REPLICA] Verifying replication slot '$REPLICATION_SLOT_NAME' exists on primary..."
SLOT_EXISTS=$(PGPASSWORD="$PG_REPLICATION_PASSWORD" psql -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" -U "$PG_REPLICATION_USER" -d postgres -tA -c "SELECT COUNT(*) FROM pg_replication_slots WHERE slot_name = '$REPLICATION_SLOT_NAME'" 2>/dev/null || echo "0")
if [ "$SLOT_EXISTS" -eq 0 ]; then
  echo "[REPLICA] ERROR: Replication slot '$REPLICATION_SLOT_NAME' does not exist on primary"
  echo "[REPLICA] Create it on primary with: SELECT pg_create_physical_replication_slot(:'slot_name');"
  exit 1
fi
echo "[REPLICA] Replication slot verified"

# Clean PGDATA directory since initdb has already created it
# pg_basebackup requires an empty or non-existent target directory
echo "[REPLICA] Cleaning PGDATA to prepare for base backup..."

# Validate PGDATA path before rm -rf
if [[ ! "$PGDATA" =~ ^/var/lib/postgresql ]]; then
    echo "[REPLICA] ERROR: Invalid PGDATA path: $PGDATA" >&2
    exit 1
fi

rm -rf "${PGDATA:?}"/*

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
echo "[REPLICA] Standby mode enabled - replica will start in recovery mode"

# pg_basebackup -R creates standby.signal and postgresql.auto.conf automatically
# No need to manually create them
