#!/bin/bash
# PostgreSQL replication setup
# Creates replication user for standby servers

set -e

if [ -z "$PG_REPLICATION_PASSWORD" ]; then
  echo "[02-replication] INFO: PG_REPLICATION_PASSWORD not set - skipping replication setup (single-stack mode)"
  exit 0
fi

echo "[02-replication] Configuring replication user..."

REPLICATION_SLOT_NAME="${REPLICATION_SLOT_NAME:-replica_slot_1}"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    DO \$BODY\$
    BEGIN
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'replicator') THEN
            CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '$PG_REPLICATION_PASSWORD';
            RAISE NOTICE 'Replication user created: replicator';
        ELSE
            RAISE NOTICE 'Replication user already exists: replicator';
            ALTER ROLE replicator WITH PASSWORD '$PG_REPLICATION_PASSWORD';
            RAISE NOTICE 'Replication user password updated';
        END IF;
    END \$BODY\$;

    GRANT CONNECT ON DATABASE postgres TO replicator;

    SELECT pg_create_physical_replication_slot("$REPLICATION_SLOT_NAME")
    WHERE NOT EXISTS (
        SELECT 1 FROM pg_replication_slots WHERE slot_name = '$REPLICATION_SLOT_NAME'
    );
EOSQL

echo "[02-replication] Replication configuration complete (slot: $REPLICATION_SLOT_NAME)"
