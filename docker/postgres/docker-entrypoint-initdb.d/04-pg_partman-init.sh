#!/bin/bash
#
# pg_partman initialization: creates the pg_partman extension in POSTGRES_DB (in the search_path's first schema,
# public) and an empty `partman` schema. It needs no preload: only the optional background worker
# (pg_partman_bgw) does.

set -euo pipefail

echo "[04-pg_partman] Initializing pg_partman schema"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    -- Security: Use pg_catalog search_path to prevent malicious schema injection attacks
    SET LOCAL search_path = pg_catalog;

    DO \$\$
    BEGIN
        -- Create pg_partman extension if it doesn't exist
        CREATE EXTENSION IF NOT EXISTS pg_partman;

        -- Create partman schema if it doesn't exist
        -- This schema is required by pg_partman for metadata tables
        CREATE SCHEMA IF NOT EXISTS partman;

        RAISE NOTICE 'pg_partman schema initialized successfully';
    END
    \$\$;
EOSQL

echo "[04-pg_partman] pg_partman initialization complete"
