#!/bin/bash
# pgflow Schema Initialization (version: the pgflow tag in scripts/extensions/manifest-data.ts)
# Installs the pgflow workflow orchestration schema in POSTGRES_DB
#
# Prerequisites: pgmq, pg_net and supabase_vault installed in the image.
#
# pg_cron is optional: 01b-pg_cron.sh creates it in POSTGRES_DB (cron.database_name) only when it is preloaded.
# Without it pgflow still installs and its cron setup functions report "skipped", as in any other database, so a
# POSTGRES_SHARED_PRELOAD_LIBRARIES that leaves pg_cron out does not stop the container's initialisation.

set -euo pipefail

TARGET_DB="${POSTGRES_DB:-postgres}"

echo "[05-pgflow] Checking pgflow prerequisites in database: $TARGET_DB"

# pg_available_extensions lists what the image installed, preloaded or not
PG_NET_READY=$(psql --username "$POSTGRES_USER" -d "$TARGET_DB" -t -c "SELECT count(*) FROM pg_available_extensions WHERE name = 'pg_net'" 2>/dev/null | tr -d ' ')
if [ "$PG_NET_READY" != "1" ]; then
    echo "[05-pgflow] WARNING: pg_net is not installed in this image. Skipping pgflow initialization."
    exit 0
fi

VAULT_READY=$(psql --username "$POSTGRES_USER" -d "$TARGET_DB" -t -c "SELECT count(*) FROM pg_available_extensions WHERE name = 'supabase_vault'" 2>/dev/null | tr -d ' ')
if [ "$VAULT_READY" != "1" ]; then
    echo "[05-pgflow] WARNING: supabase_vault is not installed in this image. Skipping pgflow initialization."
    exit 0
fi

PGMQ_READY=$(psql --username "$POSTGRES_USER" -d "$TARGET_DB" -t -c "SELECT count(*) FROM pg_available_extensions WHERE name = 'pgmq'" 2>/dev/null | tr -d ' ')
if [ "$PGMQ_READY" != "1" ]; then
    echo "[05-pgflow] WARNING: pgmq is not installed in this image. Skipping pgflow initialization."
    exit 0
fi

echo "[05-pgflow] All prerequisites available. Installing pgflow schema..."

# Install pgflow schema
# The schema file is copied from tests/fixtures/pgflow/ during build
if [ -f /opt/pgflow/schema.sql ]; then
    # schema.sql creates its own extensions; supabase_vault and pg_cron only where they can exist.
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -d "$TARGET_DB" -f /opt/pgflow/schema.sql
    echo "[05-pgflow] pgflow schema installed successfully"

    # Apply security patches
    if [ -f /opt/pgflow/security-patches.sql ]; then
        echo "[05-pgflow] Applying security patches (AZA-PGFLOW-001, AZA-PGFLOW-002)..."
        psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -d "$TARGET_DB" -f /opt/pgflow/security-patches.sql
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
SCHEMA_EXISTS=$(psql --username "$POSTGRES_USER" -d "$TARGET_DB" -t -c "SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'pgflow'" | tr -d ' ')
if [ "$SCHEMA_EXISTS" = "1" ]; then
    TABLE_COUNT=$(psql --username "$POSTGRES_USER" -d "$TARGET_DB" -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'pgflow'" | tr -d ' ')
    echo "[05-pgflow] Verification: pgflow schema created with $TABLE_COUNT tables in $TARGET_DB"
else
    echo "[05-pgflow] ERROR: pgflow schema not found after installation"
    exit 1
fi

echo "[05-pgflow] pgflow initialization complete in $TARGET_DB"
