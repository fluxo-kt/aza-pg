#!/bin/bash
#
# pg_partman initialization: creates the pg_partman extension in POSTGRES_DB, in the `partman` schema as upstream's
# docs install it, so its functions and part_config are called as partman.*. It needs no preload: only the optional
# background worker (pg_partman_bgw) does.

set -euo pipefail

echo "[04-pg_partman] Initializing pg_partman schema"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    DO \$\$
    BEGIN
        CREATE SCHEMA IF NOT EXISTS partman;
        CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;

        RAISE NOTICE 'pg_partman schema initialized successfully';
    END
    \$\$;
EOSQL

echo "[04-pg_partman] pg_partman initialization complete"
