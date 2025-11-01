#!/bin/bash
#
# pg_partman Schema Initialization
# =================================
# Initializes pg_partman schema required for partition management.
# This script creates the partman schema used by pg_partman for configuration and metadata.
#
# Gating:
# - Always runs (pg_partman is in shared_preload_libraries and tests expect it to work)
# - pg_partman extension must be created first by 01-extensions.sql
#
# Prerequisites:
# - pg_partman extension must be in shared_preload_libraries
# - pg_partman extension must be created by 01-extensions.sql
#
# Note:
# - Creates partman schema for pg_partman metadata
# - Required for pg_partman.create_parent() and other partition management functions

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
