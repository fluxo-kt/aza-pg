#!/bin/bash
# Enhanced PostgreSQL healthcheck with functional validation
# AUTO-GENERATED from extensions manifest
#
# Design: Verifies actual database state matches THIS version's expectations
# - Works correctly after database restores (verifies actual extensions)
# - Works correctly on replicas (inherited state is validated)
# - Uses status table for diagnostic context when available

set -euo pipefail

# Expected extensions for this aza-pg version (from manifest)
EXPECTED_EXTENSIONS=("pg_cron" "pg_stat_monitor" "pg_stat_statements" "pg_trgm" "pgaudit" "pgmq" "plpgsql" "timescaledb" "vector" "vectorscale")
EXPECTED_COUNT=10
EXPECTED_PRELOAD="auto_explain,pg_cron,pg_safeupdate,pg_stat_monitor,pg_stat_statements,pgaudit,timescaledb"

# Tier 1: Connection Test
if ! pg_isready -U postgres --timeout=3 >/dev/null 2>&1; then
    echo "FAIL: PostgreSQL not accepting connections" >&2
    exit 1
fi

# Tier 2: Query Execution Test
if ! psql -U postgres -d postgres -tAc 'SELECT 1' 2>/dev/null | grep -q '^1$'; then
    echo "FAIL: Database query execution failed" >&2
    exit 1
fi

# Tier 3: Extension State Verification (Ground Truth)
# Verify all expected extensions actually exist in pg_extension
# This works correctly for: fresh init, restores, replicas, upgrades
MISSING_EXTENSIONS=()
for ext in "${EXPECTED_EXTENSIONS[@]}"; do
    if ! psql -U postgres -d postgres -tAc \
        "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = '$ext')" \
        2>/dev/null | grep -q "^t$"; then
        MISSING_EXTENSIONS+=("$ext")
    fi
done

if [ ${#MISSING_EXTENSIONS[@]} -gt 0 ]; then
    # Check status table for diagnostic context
    STATUS_INFO=""
    if psql -U postgres -d postgres -tAc \
        "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'pg_aza_status')" \
        2>/dev/null | grep -q "^t$"; then
        # Status table exists - get diagnostic info
        STATUS_INFO=$(psql -U postgres -d postgres -tAc \
            "SELECT 'Init status: ' || status || ', Failed: ' || COALESCE(array_to_string(failed_extensions, ', '), 'none') FROM pg_aza_status ORDER BY init_timestamp DESC LIMIT 1" \
            2>/dev/null || echo "unknown")
    fi

    echo "FAIL: Missing ${#MISSING_EXTENSIONS[@]}/$EXPECTED_COUNT expected extensions: ${MISSING_EXTENSIONS[*]}" >&2
    [ -n "$STATUS_INFO" ] && echo "Diagnostic: $STATUS_INFO" >&2
    echo "Note: This could indicate incomplete initialization, failed restore, or version mismatch" >&2
    exit 1
fi

# Tier 4: Initialization Status Check (Diagnostic Context)
# If status table exists, verify initialization completed successfully
# This provides rich error context but isn't the primary validation
if psql -U postgres -d postgres -tAc \
    "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'pg_aza_status')" \
    2>/dev/null | grep -q "^t$"; then

    INIT_STATUS=$(psql -U postgres -d postgres -tAc \
        "SELECT status FROM pg_aza_status ORDER BY init_timestamp DESC LIMIT 1" \
        2>/dev/null || echo "unknown")

    if [ "$INIT_STATUS" = "in_progress" ]; then
        echo "FAIL: Initialization still in progress (not yet complete)" >&2
        exit 1
    elif [ "$INIT_STATUS" = "failed" ]; then
        FAILED_EXTS=$(psql -U postgres -d postgres -tAc \
            "SELECT array_to_string(failed_extensions, ', ') FROM pg_aza_status ORDER BY init_timestamp DESC LIMIT 1" \
            2>/dev/null || echo "unknown")
        echo "FAIL: Initialization failed. Failed extensions: $FAILED_EXTS" >&2
        exit 1
    elif [ "$INIT_STATUS" = "partial" ]; then
        FAILED_EXTS=$(psql -U postgres -d postgres -tAc \
            "SELECT array_to_string(failed_extensions, ', ') FROM pg_aza_status ORDER BY init_timestamp DESC LIMIT 1" \
            2>/dev/null || echo "unknown")
        echo "WARNING: Initialization partially failed. Some extensions missing: $FAILED_EXTS" >&2
        # Note: This is already caught by Tier 3, but provides additional context
    fi
fi

# Tier 5: Shared Preload Libraries Verification
ACTUAL_PRELOAD=$(psql -U postgres -d postgres -tAc \
    "SELECT setting FROM pg_settings WHERE name = 'shared_preload_libraries'" \
    2>/dev/null || echo "")

# Verify expected preload libraries are present (generated from manifest)
# Convert comma-separated EXPECTED_PRELOAD to array and check each
IFS=',' read -ra PRELOAD_LIBS <<< "$EXPECTED_PRELOAD"
for lib in "${PRELOAD_LIBS[@]}"; do
    if ! echo "$ACTUAL_PRELOAD" | grep -q "$lib"; then
        echo "FAIL: shared_preload_libraries missing expected library: $lib" >&2
        echo "Expected preload: $EXPECTED_PRELOAD" >&2
        echo "Actual preload: $ACTUAL_PRELOAD" >&2
        exit 1
    fi
done

# Tier 6: System Catalog Integrity
CATALOG_TABLES=$(psql -U postgres -d postgres -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'pg_catalog' AND table_type = 'BASE TABLE'" \
    2>/dev/null || echo "0")

if [ "$CATALOG_TABLES" -lt 60 ]; then
    echo "FAIL: pg_catalog appears corrupted (only $CATALOG_TABLES tables, expected 60+)" >&2
    exit 1
fi

# Tier 7: Database Role Verification
POSTGRES_ROLE="${POSTGRES_ROLE:-primary}"
if [ "$POSTGRES_ROLE" != "replica" ]; then
    IN_RECOVERY=$(psql -U postgres -d postgres -tAc \
        "SELECT pg_is_in_recovery()" \
        2>/dev/null || echo "t")

    if [ "$IN_RECOVERY" = "t" ]; then
        echo "FAIL: Database in recovery mode but configured as primary/single-node" >&2
        exit 1
    fi
fi

# All checks passed
exit 0