#!/bin/bash
#
# pg_cron Extension Initialization
# =================================
# Creates pg_cron extension in POSTGRES_DB to match cron.database_name configuration.
#
# Why separate script:
# - pg_cron can ONLY be created in the database specified by cron.database_name
# - cron.database_name is set to ${POSTGRES_DB:-postgres} in entrypoint (configurable)
# - 01-extensions.sql runs in postgres database by default
# - This script ensures pg_cron is created in the correct database
#
# Execution order:
# - 01-extensions.sql creates other extensions in postgres database
# - 01b-pg_cron.sh (this script) creates pg_cron in POSTGRES_DB
# - Both run during first cluster initialization

set -euo pipefail

TARGET_DB="${POSTGRES_DB:-postgres}"

echo "[01b-pg_cron] Creating pg_cron extension in database: $TARGET_DB"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$TARGET_DB" <<-EOSQL
    -- Security: Use pg_catalog search_path to prevent schema injection attacks
    SET LOCAL search_path = pg_catalog;

    -- Create pg_cron extension
    -- NOTE: This must be created in the database specified by cron.database_name
    CREATE EXTENSION IF NOT EXISTS pg_cron;
EOSQL

echo "[01b-pg_cron] pg_cron extension created successfully in $TARGET_DB"
