#!/bin/bash
# pgflow v0.11.0 Schema Initialization
# Installs the pgflow workflow orchestration schema in the postgres database
#
# Prerequisites:
# - pg_net and pgsodium must be in shared_preload_libraries
# - pgmq, pg_net, supabase_vault, and pg_cron extensions must be available
#
# Note: pg_cron can only be installed in the postgres database (cron.database_name)
# For multi-database isolation, reinstall pgflow schema in each database
# but pg_cron schedules will only work from the postgres database.

set -euo pipefail

echo "[05-pgflow] Checking pgflow prerequisites..."

# Check if pg_net is available (requires preload)
PG_NET_READY=$(psql -U postgres -d postgres -t -c "SELECT count(*) FROM pg_available_extensions WHERE name = 'pg_net'" 2>/dev/null | tr -d ' ')
if [ "$PG_NET_READY" != "1" ]; then
    echo "[05-pgflow] WARNING: pg_net extension not available. Skipping pgflow initialization."
    echo "[05-pgflow] Add pg_net to POSTGRES_SHARED_PRELOAD_LIBRARIES to enable pgflow."
    exit 0
fi

# Check if supabase_vault is available (requires pgsodium preload)
VAULT_READY=$(psql -U postgres -d postgres -t -c "SELECT count(*) FROM pg_available_extensions WHERE name = 'supabase_vault'" 2>/dev/null | tr -d ' ')
if [ "$VAULT_READY" != "1" ]; then
    echo "[05-pgflow] WARNING: supabase_vault extension not available. Skipping pgflow initialization."
    echo "[05-pgflow] Add pgsodium to POSTGRES_SHARED_PRELOAD_LIBRARIES to enable vault."
    exit 0
fi

# Check if pgmq is available
PGMQ_READY=$(psql -U postgres -d postgres -t -c "SELECT count(*) FROM pg_available_extensions WHERE name = 'pgmq'" 2>/dev/null | tr -d ' ')
if [ "$PGMQ_READY" != "1" ]; then
    echo "[05-pgflow] WARNING: pgmq extension not available. Skipping pgflow initialization."
    exit 0
fi

echo "[05-pgflow] All prerequisites available. Installing pgflow schema..."

# Create required extensions if not already created
# Note: These may already exist from 01-extensions.sql, but CREATE EXTENSION IF NOT EXISTS is idempotent
psql -U postgres -d postgres -c "CREATE EXTENSION IF NOT EXISTS pgmq;"
psql -U postgres -d postgres -c "CREATE EXTENSION IF NOT EXISTS pg_net;"
psql -U postgres -d postgres -c "CREATE EXTENSION IF NOT EXISTS supabase_vault;"
psql -U postgres -d postgres -c "CREATE EXTENSION IF NOT EXISTS pg_cron;"

# Install pgflow schema
# The schema file is copied from tests/fixtures/pgflow/ during build
if [ -f /opt/pgflow/schema.sql ]; then
    psql -U postgres -d postgres -f /opt/pgflow/schema.sql
    echo "[05-pgflow] pgflow v0.11.0 schema installed successfully"
else
    echo "[05-pgflow] ERROR: pgflow schema file not found at /opt/pgflow/schema.sql"
    echo "[05-pgflow] Ensure the schema file is copied during image build"
    exit 1
fi

# Verify installation
SCHEMA_EXISTS=$(psql -U postgres -d postgres -t -c "SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'pgflow'" | tr -d ' ')
if [ "$SCHEMA_EXISTS" = "1" ]; then
    TABLE_COUNT=$(psql -U postgres -d postgres -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'pgflow'" | tr -d ' ')
    echo "[05-pgflow] Verification: pgflow schema created with $TABLE_COUNT tables"
else
    echo "[05-pgflow] ERROR: pgflow schema not found after installation"
    exit 1
fi

echo "[05-pgflow] pgflow initialization complete"
