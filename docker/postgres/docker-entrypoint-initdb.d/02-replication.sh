#!/bin/bash
# PostgreSQL replication setup
# Creates replication user for standby servers

set -euo pipefail

if [ -z "$PG_REPLICATION_PASSWORD" ]; then
  echo "[02-replication] INFO: PG_REPLICATION_PASSWORD not set - skipping replication setup (single-stack mode)"
  exit 0
fi

echo "[02-replication] Configuring replication user..."

REPLICATION_SLOT_NAME="${REPLICATION_SLOT_NAME:-replica_slot_1}"

psql -v ON_ERROR_STOP=1 -v repl_password="$PG_REPLICATION_PASSWORD" -v slot_name="$REPLICATION_SLOT_NAME" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE OR REPLACE FUNCTION pg_temp.setup_replication(p_password TEXT, p_slot_name TEXT)
    RETURNS void AS \$func\$
    BEGIN
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'replicator') THEN
            EXECUTE format('CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD %L NOINHERIT', p_password);
            RAISE NOTICE 'Replication user created: replicator';
        ELSE
            RAISE NOTICE 'Replication user already exists: replicator';
            EXECUTE format('ALTER ROLE replicator WITH PASSWORD %L', p_password);
            RAISE NOTICE 'Replication user password updated';
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = p_slot_name) THEN
            PERFORM pg_create_physical_replication_slot(p_slot_name);
            RAISE NOTICE 'Replication slot created: %', p_slot_name;
        ELSE
            RAISE NOTICE 'Replication slot already exists: %', p_slot_name;
        END IF;
    END
    \$func\$ LANGUAGE plpgsql;

    SELECT pg_temp.setup_replication(:'repl_password', :'slot_name');

    -- Security: Limit connections per user
    ALTER ROLE postgres CONNECTION LIMIT 50;
    ALTER ROLE replicator CONNECTION LIMIT 5;

    GRANT CONNECT ON DATABASE postgres TO replicator;
EOSQL

echo "[02-replication] Replication configuration complete (slot: $REPLICATION_SLOT_NAME)"
