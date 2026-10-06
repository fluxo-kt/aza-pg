#!/bin/bash
#
# pg_cron Extension Initialization
# =================================
# Creates pg_cron extension in POSTGRES_DB to match cron.database_name configuration.
#
# pg_cron can only be created in the database named by cron.database_name, which the auto-config entrypoint sets to
# POSTGRES_DB (defaulting, like the official entrypoint, to POSTGRES_USER). CREATE EXTENSION also fails unless pg_cron
# is preloaded, and an operator can drop it from POSTGRES_SHARED_PRELOAD_LIBRARIES, so this script checks the preload
# list and skips pg_cron when it is absent.

set -euo pipefail

TARGET_DB="${POSTGRES_DB:-postgres}"

# Check if pg_cron is in shared_preload_libraries
PRELOAD_LIBS=$(psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$TARGET_DB" -tAc "SHOW shared_preload_libraries;")

if echo "$PRELOAD_LIBS" | grep -qw "pg_cron"; then
    echo "[01b-pg_cron] pg_cron is preloaded, creating extension in database: $TARGET_DB"

    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$TARGET_DB" <<-EOSQL
        -- Create pg_cron extension
        -- NOTE: This must be created in the database specified by cron.database_name
        CREATE EXTENSION IF NOT EXISTS pg_cron;
EOSQL

    echo "[01b-pg_cron] pg_cron extension created successfully in $TARGET_DB"
else
    echo "[01b-pg_cron] SKIP: pg_cron not in shared_preload_libraries (found: $PRELOAD_LIBS)"
    echo "[01b-pg_cron] To enable pg_cron, add it to POSTGRES_SHARED_PRELOAD_LIBRARIES environment variable"
fi
