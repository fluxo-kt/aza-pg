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

# Tier 3: Extension Infrastructure Test
# Verify extensions can be loaded (tests shared library loading and dependencies)
# Use pg_trgm as a test since it's lightweight and auto-created by initdb script
if ! psql -U postgres -d postgres -tAc \
    "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm')" \
    2>/dev/null | grep -q '^t$'; then
    echo "FAIL: Expected extension pg_trgm not found (extension infrastructure may be broken)" >&2
    exit 1
fi

# Tier 4: System Catalog Integrity
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

# All checks passed
exit 0
