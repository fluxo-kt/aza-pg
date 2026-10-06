#!/bin/bash
# Enhanced PostgreSQL healthcheck with functional validation
# AUTO-GENERATED from extensions manifest
#
# Design: Verifies actual database state matches THIS version's expectations
# - Works correctly after database restores (verifies actual extensions)
# - Works correctly on replicas (inherited state is validated)
# - Uses status table for diagnostic context when available

set -euo pipefail

# Check as the superuser, in the database initdb created and the init scripts filled, resolved like the official
# entrypoint's file_env: each variable, else its *_FILE's content; POSTGRES_USER defaults to postgres, POSTGRES_DB to
# the user. An operator's own PGUSER/PGDATABASE is overridden: the extensions live only in POSTGRES_DB, and
# shared_preload_libraries is superuser-only.
env_or_file() {
    local file_var="${1}_FILE"
    if [ -n "${!1:-}" ]; then printf '%s' "${!1}"; elif [ -n "${!file_var:-}" ]; then cat "${!file_var}"; fi
}
PGUSER="$(env_or_file POSTGRES_USER)"
export PGUSER="${PGUSER:-postgres}"
PGDATABASE="$(env_or_file POSTGRES_DB)"
export PGDATABASE="${PGDATABASE:-$PGUSER}"

# Extensions this aza-pg version precreates (from manifest), each as name:preload-library (empty: needs none)
EXPECTED_EXTENSIONS=("pg_cron:pg_cron" "pg_net:pg_net" "pg_stat_monitor:pg_stat_monitor" "pg_stat_statements:pg_stat_statements" "pg_trgm:" "pgaudit:pgaudit" "pgmq:" "pgsodium:pgsodium" "plpgsql:" "supabase_vault:supabase_vault" "timescaledb:timescaledb" "vector:" "vectorscale:")

# Tier 0: Initialization Finished
# On a new data directory the official entrypoint runs initdb and the init scripts against a temporary server that
# accepts socket connections and queries, then stops it and starts the final one by replacing itself with it (exec).
# So while a process still runs docker-entrypoint.sh, the server answering is not one dependents can use yet. The
# bracket keeps the pattern from matching grep's own command line.
if grep -qsa '/docker-entrypoint[.]sh' /proc/[0-9]*/cmdline; then
    echo "FAIL: initialization still running (docker-entrypoint.sh has not started the final server)" >&2
    exit 1
fi

# Tier 1: Connection Test
if ! pg_isready --timeout=3 >/dev/null 2>&1; then
    echo "FAIL: PostgreSQL not accepting connections" >&2
    exit 1
fi

# Tier 2: Query Execution Test
if ! psql -tAc 'SELECT 1' 2>/dev/null | grep -q '^1$'; then
    echo "FAIL: Database query execution failed" >&2
    exit 1
fi

# Tier 3: Extension State Verification (Ground Truth)
# Verify all expected extensions actually exist in pg_extension, in one query
# This works correctly for: fresh init, restores, replicas, upgrades
# An extension whose preload library is not loaded is skipped: the operator left it out of
# POSTGRES_SHARED_PRELOAD_LIBRARIES, which is a supported choice, so init could not create it.
ACTUAL_PRELOAD=$(psql -tAc 'SHOW shared_preload_libraries' 2>/dev/null) || {
    echo "FAIL: cannot read shared_preload_libraries" >&2
    exit 1
}
CHECKED=()
for entry in "${EXPECTED_EXTENSIONS[@]}"; do
    lib="${entry#*:}"
    if [ -z "$lib" ] || [[ ",${ACTUAL_PRELOAD// /}," == *",$lib,"* ]]; then
        CHECKED+=("${entry%%:*}")
    fi
done
MISSING_EXTENSIONS=()
if [ ${#CHECKED[@]} -gt 0 ]; then
    MISSING=$(psql -tAc \
        "SELECT coalesce(string_agg(e, ' '), '') FROM unnest(string_to_array('${CHECKED[*]}', ' ')) e WHERE NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = e)" \
        2>/dev/null) || {
        echo "FAIL: cannot read pg_extension" >&2
        exit 1
    }
    read -ra MISSING_EXTENSIONS <<< "$MISSING"
fi

if [ ${#MISSING_EXTENSIONS[@]} -gt 0 ]; then
    # Check status table for diagnostic context
    STATUS_INFO=""
    if psql -tAc \
        "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'pg_aza_status')" \
        2>/dev/null | grep -q "^t$"; then
        # Status table exists - get diagnostic info
        STATUS_INFO=$(psql -tAc \
            "SELECT 'Init status: ' || status || ', Failed: ' || COALESCE(array_to_string(failed_extensions, ', '), 'none') FROM pg_aza_status ORDER BY init_timestamp DESC LIMIT 1" \
            2>/dev/null || echo "unknown")
    fi

    echo "FAIL: Missing ${#MISSING_EXTENSIONS[@]}/${#CHECKED[@]} expected extensions: ${MISSING_EXTENSIONS[*]}" >&2
    [ -n "$STATUS_INFO" ] && echo "Diagnostic: $STATUS_INFO" >&2
    echo "Note: This could indicate incomplete initialization, failed restore, or version mismatch" >&2
    exit 1
fi

# Tier 4: Initialization Status Check (Diagnostic Context)
# If status table exists, verify initialization completed successfully
# This provides rich error context but isn't the primary validation
if psql -tAc \
    "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'pg_aza_status')" \
    2>/dev/null | grep -q "^t$"; then

    INIT_STATUS=$(psql -tAc \
        "SELECT status FROM pg_aza_status ORDER BY init_timestamp DESC LIMIT 1" \
        2>/dev/null || echo "unknown")

    if [ "$INIT_STATUS" = "in_progress" ]; then
        echo "FAIL: Initialization still in progress (not yet complete)" >&2
        exit 1
    elif [ "$INIT_STATUS" = "failed" ]; then
        FAILED_EXTS=$(psql -tAc \
            "SELECT array_to_string(failed_extensions, ', ') FROM pg_aza_status ORDER BY init_timestamp DESC LIMIT 1" \
            2>/dev/null || echo "unknown")
        echo "FAIL: Initialization failed. Failed extensions: $FAILED_EXTS" >&2
        exit 1
    elif [ "$INIT_STATUS" = "partial" ]; then
        FAILED_EXTS=$(psql -tAc \
            "SELECT array_to_string(failed_extensions, ', ') FROM pg_aza_status ORDER BY init_timestamp DESC LIMIT 1" \
            2>/dev/null || echo "unknown")
        echo "WARNING: Initialization partially failed. Some extensions missing: $FAILED_EXTS" >&2
        # Note: This is already caught by Tier 3, but provides additional context
    fi
fi

# Tier 5: Database Role Verification
POSTGRES_ROLE="${POSTGRES_ROLE:-primary}"
if [ "$POSTGRES_ROLE" != "replica" ]; then
    IN_RECOVERY=$(psql -tAc \
        "SELECT pg_is_in_recovery()" \
        2>/dev/null || echo "t")

    if [ "$IN_RECOVERY" = "t" ]; then
        echo "FAIL: Database in recovery mode but configured as primary/single-node" >&2
        exit 1
    fi
fi

# All checks passed
exit 0