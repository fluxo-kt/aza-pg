#!/bin/bash
# pgflow v0.13.1 Schema Initialization
# Installs the pgflow workflow orchestration schema in POSTGRES_DB
#
# Prerequisites:
# - pg_net and pgsodium must be in shared_preload_libraries
# - pgmq, pg_net, supabase_vault, and pg_cron extensions must be available
#
# Note: pg_cron is created by 01b-pg_cron.sh in POSTGRES_DB (cron.database_name)
# pgflow schema is installed in the same database for pg_cron integration.

set -euo pipefail

TARGET_DB="${POSTGRES_DB:-postgres}"

echo "[05-pgflow] Checking pgflow prerequisites in database: $TARGET_DB"

# Check if pg_net is available (requires preload)
PG_NET_READY=$(psql -U postgres -d "$TARGET_DB" -t -c "SELECT count(*) FROM pg_available_extensions WHERE name = 'pg_net'" 2>/dev/null | tr -d ' ')
if [ "$PG_NET_READY" != "1" ]; then
    echo "[05-pgflow] WARNING: pg_net extension not available. Skipping pgflow initialization."
    echo "[05-pgflow] Add pg_net to POSTGRES_SHARED_PRELOAD_LIBRARIES to enable pgflow."
    exit 0
fi

# Check if supabase_vault is available (requires pgsodium preload)
VAULT_READY=$(psql -U postgres -d "$TARGET_DB" -t -c "SELECT count(*) FROM pg_available_extensions WHERE name = 'supabase_vault'" 2>/dev/null | tr -d ' ')
if [ "$VAULT_READY" != "1" ]; then
    echo "[05-pgflow] WARNING: supabase_vault extension not available. Skipping pgflow initialization."
    echo "[05-pgflow] Add pgsodium to POSTGRES_SHARED_PRELOAD_LIBRARIES to enable vault."
    exit 0
fi

# Check if pgmq is available
PGMQ_READY=$(psql -U postgres -d "$TARGET_DB" -t -c "SELECT count(*) FROM pg_available_extensions WHERE name = 'pgmq'" 2>/dev/null | tr -d ' ')
if [ "$PGMQ_READY" != "1" ]; then
    echo "[05-pgflow] WARNING: pgmq extension not available. Skipping pgflow initialization."
    exit 0
fi

echo "[05-pgflow] All prerequisites available. Installing pgflow schema..."

# Create required extensions if not already created
# Note: These may already exist from 01-extensions.sql / 01b-pg_cron.sh, but CREATE EXTENSION IF NOT EXISTS is idempotent
psql -v ON_ERROR_STOP=1 -U postgres -d "$TARGET_DB" -c "CREATE EXTENSION IF NOT EXISTS pgmq;"
psql -v ON_ERROR_STOP=1 -U postgres -d "$TARGET_DB" -c "CREATE EXTENSION IF NOT EXISTS pg_net;"

# supabase_vault is optional - only create if available in build
# Use DO block to avoid failure if extension not compiled/installed
psql -v ON_ERROR_STOP=1 -U postgres -d "$TARGET_DB" <<'EOSQL'
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS supabase_vault;
EXCEPTION
  WHEN undefined_file THEN
    RAISE NOTICE 'supabase_vault extension not available - skipping (optional)';
  WHEN OTHERS THEN
    RAISE NOTICE 'supabase_vault extension creation failed: % - skipping (optional)', SQLERRM;
END $$;
EOSQL
# NOTE: pg_cron is created by 01b-pg_cron.sh - verify it exists
PG_CRON_EXISTS=$(psql -U postgres -d "$TARGET_DB" -t -c "SELECT count(*) FROM pg_extension WHERE extname = 'pg_cron'" 2>/dev/null | tr -d ' ')
if [ "$PG_CRON_EXISTS" != "1" ]; then
    echo "[05-pgflow] ERROR: pg_cron extension not found in $TARGET_DB"
    echo "[05-pgflow] pg_cron should be created by 01b-pg_cron.sh before this script runs"
    exit 1
fi

# Install pgflow schema
# The schema file is copied from tests/fixtures/pgflow/ during build
if [ -f /opt/pgflow/schema.sql ]; then
    # Remove supabase_vault creation from upstream schema (made optional above)
    # Upstream schema has "CREATE EXTENSION if NOT EXISTS supabase_vault;" which fails if not available
    sed '/CREATE EXTENSION.*supabase_vault/d' /opt/pgflow/schema.sql | psql -v ON_ERROR_STOP=1 -U postgres -d "$TARGET_DB"
    echo "[05-pgflow] pgflow v0.13.1 schema installed successfully"

    # Apply security patches
    if [ -f /opt/pgflow/security-patches.sql ]; then
        echo "[05-pgflow] Applying security patches (AZA-PGFLOW-001, AZA-PGFLOW-002)..."
        psql -v ON_ERROR_STOP=1 -U postgres -d "$TARGET_DB" -f /opt/pgflow/security-patches.sql
        echo "[05-pgflow] Security patches applied successfully"
    else
        echo "[05-pgflow] WARNING: Security patch file not found - functions remain vulnerable"
    fi
else
    echo "[05-pgflow] ERROR: pgflow schema file not found at /opt/pgflow/schema.sql"
    echo "[05-pgflow] Ensure the schema file is copied during image build"
    exit 1
fi

# Verify installation
SCHEMA_EXISTS=$(psql -U postgres -d "$TARGET_DB" -t -c "SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'pgflow'" | tr -d ' ')
if [ "$SCHEMA_EXISTS" = "1" ]; then
    TABLE_COUNT=$(psql -U postgres -d "$TARGET_DB" -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'pgflow'" | tr -d ' ')
    echo "[05-pgflow] Verification: pgflow schema created with $TABLE_COUNT tables in $TARGET_DB"
else
    echo "[05-pgflow] ERROR: pgflow schema not found after installation"
    exit 1
fi

echo "[05-pgflow] pgflow initialization complete in $TARGET_DB"
