#!/bin/bash
# PostgreSQL replication setup
# Creates replication user for standby servers

set -e

echo "[02-replication] Configuring replication user..."

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    DO \$\$
    BEGIN
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'replicator') THEN
            CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '${PG_REPLICATION_PASSWORD}';
            RAISE NOTICE 'Replication user created: replicator';
        ELSE
            RAISE NOTICE 'Replication user already exists: replicator';
            ALTER ROLE replicator WITH PASSWORD '${PG_REPLICATION_PASSWORD}';
            RAISE NOTICE 'Replication user password updated';
        END IF;
    END
    \$\$;

    GRANT CONNECT ON DATABASE postgres TO replicator;

    SELECT pg_create_physical_replication_slot('replica_slot_1')
    WHERE NOT EXISTS (
        SELECT 1 FROM pg_replication_slots WHERE slot_name = 'replica_slot_1'
    );
EOSQL

echo "[02-replication] Replication configuration complete"
