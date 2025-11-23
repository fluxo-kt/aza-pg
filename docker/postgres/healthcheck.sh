#!/bin/bash
# Enhanced PostgreSQL healthcheck with functional validation
# Provides multi-tier verification beyond simple connection testing

set -eu

# Tier 1: Connection Test
# Verify PostgreSQL is accepting connections on the network socket
if ! pg_isready -U postgres --timeout=3 >/dev/null 2>&1; then
    echo "FAIL: PostgreSQL not accepting connections" >&2
    exit 1
fi

# Tier 2: Query Execution Test
# Verify database can execute basic SQL queries (not just accept connections)
if ! psql -U postgres -d postgres -tAc 'SELECT 1' 2>/dev/null | grep -q '^1$'; then
    echo "FAIL: Database query execution failed" >&2
    exit 1
fi

# Tier 3: Initialization Complete Test
# Verify all auto-created extensions from 01-extensions.sql exist
# This ensures initialization completed successfully before marking container healthy
# Expected extensions: pg_cron, pg_stat_monitor, pg_stat_statements, pg_trgm, pgaudit, pgmq, plpgsql, timescaledb, vector, vectorscale
EXPECTED_EXTENSIONS=10
CREATED_EXTENSIONS=$(
    psql -U postgres -d postgres -tAc \
    "SELECT count(*) FROM pg_extension WHERE extname IN (
        'pg_cron', 'pg_stat_monitor', 'pg_stat_statements', 'pg_trgm', 'pgaudit',
        'pgmq', 'plpgsql', 'timescaledb', 'vector', 'vectorscale'
    )" \
    2>/dev/null || echo "0"
)

if [ "$CREATED_EXTENSIONS" -lt "$EXPECTED_EXTENSIONS" ]; then
    echo "FAIL: Initialization incomplete (only $CREATED_EXTENSIONS/$EXPECTED_EXTENSIONS auto-created extensions found)" >&2
    echo "Expected: pg_cron, pg_stat_monitor, pg_stat_statements, pg_trgm, pgaudit, pgmq, plpgsql, timescaledb, vector, vectorscale" >&2
    exit 1
fi

# Tier 4: Shared Preload Libraries Test
# Verify critical shared_preload_libraries are loaded
# These must be loaded at server start and cannot be loaded later
# Expected: auto_explain, pg_cron, pg_stat_monitor, pg_stat_statements, pgaudit, timescaledb
PRELOAD_LIBS=$(
    psql -U postgres -d postgres -tAc \
    "SELECT setting FROM pg_settings WHERE name = 'shared_preload_libraries'" \
    2>/dev/null || echo ""
)

# Check for critical preload libraries (at least pg_cron and timescaledb should be present)
if ! echo "$PRELOAD_LIBS" | grep -q "pg_cron"; then
    echo "FAIL: shared_preload_libraries missing pg_cron (misconfigured preload)" >&2
    exit 1
fi

if ! echo "$PRELOAD_LIBS" | grep -q "timescaledb"; then
    echo "FAIL: shared_preload_libraries missing timescaledb (misconfigured preload)" >&2
    exit 1
fi

# Tier 5: System Catalog Integrity
# Verify pg_catalog has expected number of tables (detects corruption/incomplete initialization)
# PostgreSQL 18 has 70+ system tables in pg_catalog
CATALOG_TABLES=$(
    psql -U postgres -d postgres -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'pg_catalog' AND table_type = 'BASE TABLE'" \
    2>/dev/null || echo "0"
)

if [ "$CATALOG_TABLES" -lt 60 ]; then
    echo "FAIL: pg_catalog appears corrupted or incomplete (only $CATALOG_TABLES tables found, expected 60+)" >&2
    exit 1
fi

# Tier 6: Database State Verification
# For single-node deployments, verify database is NOT in recovery mode
# (For replicas, recovery mode is expected and this check should be skipped)
# Check if POSTGRES_ROLE is set to 'replica' - if not, we're a primary/single node
POSTGRES_ROLE="${POSTGRES_ROLE:-primary}"
if [ "$POSTGRES_ROLE" != "replica" ]; then
    IN_RECOVERY=$(
        psql -U postgres -d postgres -tAc \
        "SELECT pg_is_in_recovery()" \
        2>/dev/null || echo "t"
    )

    if [ "$IN_RECOVERY" = "t" ]; then
        echo "FAIL: Database is in recovery mode but configured as primary/single-node" >&2
        exit 1
    fi
fi

# All checks passed
exit 0
