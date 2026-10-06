/**
 * Healthcheck Generator
 * Generates healthcheck script from manifest to eliminate duplication
 * and ensure version-specific validation
 */

import type { ManifestEntry } from "../extensions/manifest-data";
import { preloadLibraryName } from "./manifest-loader";

/**
 * Generate healthcheck script that verifies initialization state
 *
 * Design principles:
 * 1. Version-specific: Expected extensions baked into healthcheck
 * 2. Ground truth: Verifies actual extension state, not just init status
 * 3. Audit context: Uses status table for detailed error reporting when available
 * 4. Edge-case resilient: Works correctly for restores, replicas, upgrades
 *
 * @param extensionsToEnable - Array of manifest entries for auto-created extensions
 * @returns Healthcheck shell script content
 */
export function generateHealthcheckScript(extensionsToEnable: ManifestEntry[]): string {
  const lines: string[] = [];
  // Each extension with the library it needs preloaded: init cannot create it when the operator's
  // POSTGRES_SHARED_PRELOAD_LIBRARIES leaves that library out, so the check skips it then.
  const expected = extensionsToEnable.map(
    (e) => `${e.name}:${e.runtime?.sharedPreload ? preloadLibraryName(e) : ""}`
  );

  lines.push("#!/bin/bash");
  lines.push("# Enhanced PostgreSQL healthcheck with functional validation");
  lines.push("# AUTO-GENERATED from extensions manifest");
  lines.push("#");
  lines.push("# Design: Verifies actual database state matches THIS version's expectations");
  lines.push("# - Works correctly after database restores (verifies actual extensions)");
  lines.push("# - Works correctly on replicas (inherited state is validated)");
  lines.push("# - Uses status table for diagnostic context when available");
  lines.push("");
  lines.push("set -euo pipefail");
  lines.push("");
  lines.push(
    "# Check as the superuser, in the database initdb created and the init scripts filled, resolved like the official"
  );
  lines.push(
    "# entrypoint's file_env: each variable, else its *_FILE's content; POSTGRES_USER defaults to postgres, POSTGRES_DB to"
  );
  lines.push(
    "# the user. An operator's own PGUSER/PGDATABASE is overridden: the extensions live only in POSTGRES_DB, and"
  );
  lines.push("# shared_preload_libraries is superuser-only.");
  lines.push("env_or_file() {");
  lines.push('    local file_var="${1}_FILE"');
  lines.push(
    '    if [ -n "${!1:-}" ]; then printf \'%s\' "${!1}"; elif [ -n "${!file_var:-}" ]; then cat "${!file_var}"; fi'
  );
  lines.push("}");
  lines.push('PGUSER="$(env_or_file POSTGRES_USER)"');
  lines.push('export PGUSER="${PGUSER:-postgres}"');
  lines.push('PGDATABASE="$(env_or_file POSTGRES_DB)"');
  lines.push('export PGDATABASE="${PGDATABASE:-$PGUSER}"');
  lines.push("");

  // Version-specific expectations (baked in from manifest)
  lines.push(
    "# Extensions this aza-pg version precreates (from manifest), each as name:preload-library (empty: needs none)"
  );
  lines.push(`EXPECTED_EXTENSIONS=(${expected.map((e) => `"${e}"`).join(" ")})`);
  lines.push("");

  // Tier 0: the official entrypoint's temporary initdb server answers queries before the final server starts.
  lines.push("# Tier 0: Initialization Finished");
  lines.push(
    "# On a new data directory the official entrypoint runs initdb and the init scripts against a temporary server that"
  );
  lines.push(
    "# accepts socket connections and queries, then stops it and starts the final one by replacing itself with it (exec)."
  );
  lines.push(
    "# So while a process still runs docker-entrypoint.sh, the server answering is not one dependents can use yet. The"
  );
  lines.push("# bracket keeps the pattern from matching grep's own command line.");
  lines.push("if grep -qsa '/docker-entrypoint[.]sh' /proc/[0-9]*/cmdline; then");
  lines.push(
    '    echo "FAIL: initialization still running (docker-entrypoint.sh has not started the final server)" >&2'
  );
  lines.push("    exit 1");
  lines.push("fi");
  lines.push("");

  // Tier 1: Connection Test
  lines.push("# Tier 1: Connection Test");
  lines.push("if ! pg_isready --timeout=3 >/dev/null 2>&1; then");
  lines.push('    echo "FAIL: PostgreSQL not accepting connections" >&2');
  lines.push("    exit 1");
  lines.push("fi");
  lines.push("");

  // Tier 2: Query Execution
  lines.push("# Tier 2: Query Execution Test");
  lines.push("if ! psql -tAc 'SELECT 1' 2>/dev/null | grep -q '^1$'; then");
  lines.push('    echo "FAIL: Database query execution failed" >&2');
  lines.push("    exit 1");
  lines.push("fi");
  lines.push("");

  // Tier 3: Extension State Verification (Ground Truth)
  lines.push("# Tier 3: Extension State Verification (Ground Truth)");
  lines.push("# Verify all expected extensions actually exist in pg_extension, in one query");
  lines.push("# This works correctly for: fresh init, restores, replicas, upgrades");
  lines.push(
    "# An extension whose preload library is not loaded is skipped: the operator left it out of"
  );
  lines.push(
    "# POSTGRES_SHARED_PRELOAD_LIBRARIES, which is a supported choice, so init could not create it."
  );
  lines.push("ACTUAL_PRELOAD=$(psql -tAc 'SHOW shared_preload_libraries' 2>/dev/null) || {");
  lines.push('    echo "FAIL: cannot read shared_preload_libraries" >&2');
  lines.push("    exit 1");
  lines.push("}");
  lines.push("CHECKED=()");
  lines.push('for entry in "${EXPECTED_EXTENSIONS[@]}"; do');
  lines.push('    lib="${entry#*:}"');
  lines.push('    if [ -z "$lib" ] || [[ ",${ACTUAL_PRELOAD// /}," == *",$lib,"* ]]; then');
  lines.push('        CHECKED+=("${entry%%:*}")');
  lines.push("    fi");
  lines.push("done");
  lines.push("MISSING_EXTENSIONS=()");
  lines.push("if [ ${#CHECKED[@]} -gt 0 ]; then");
  lines.push("    MISSING=$(psql -tAc \\");
  lines.push(
    "        \"SELECT coalesce(string_agg(e, ' '), '') FROM unnest(string_to_array('${CHECKED[*]}', ' ')) e WHERE NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = e)\" \\"
  );
  lines.push("        2>/dev/null) || {");
  lines.push('        echo "FAIL: cannot read pg_extension" >&2');
  lines.push("        exit 1");
  lines.push("    }");
  lines.push('    read -ra MISSING_EXTENSIONS <<< "$MISSING"');
  lines.push("fi");
  lines.push("");
  lines.push("if [ ${#MISSING_EXTENSIONS[@]} -gt 0 ]; then");
  lines.push("    # Check status table for diagnostic context");
  lines.push('    STATUS_INFO=""');
  lines.push("    if psql -tAc \\");
  lines.push(
    "        \"SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'pg_aza_status')\" \\"
  );
  lines.push('        2>/dev/null | grep -q "^t$"; then');
  lines.push("        # Status table exists - get diagnostic info");
  lines.push("        STATUS_INFO=$(psql -tAc \\");
  lines.push(
    "            \"SELECT 'Init status: ' || status || ', Failed: ' || COALESCE(array_to_string(failed_extensions, ', '), 'none') FROM pg_aza_status ORDER BY init_timestamp DESC LIMIT 1\" \\"
  );
  lines.push('            2>/dev/null || echo "unknown")');
  lines.push("    fi");
  lines.push("");
  lines.push(
    '    echo "FAIL: Missing ${#MISSING_EXTENSIONS[@]}/${#CHECKED[@]} expected extensions: ${MISSING_EXTENSIONS[*]}" >&2'
  );
  lines.push('    [ -n "$STATUS_INFO" ] && echo "Diagnostic: $STATUS_INFO" >&2');
  lines.push(
    '    echo "Note: This could indicate incomplete initialization, failed restore, or version mismatch" >&2'
  );
  lines.push("    exit 1");
  lines.push("fi");
  lines.push("");

  // Tier 4: Initialization Status Check (Diagnostic Context)
  lines.push("# Tier 4: Initialization Status Check (Diagnostic Context)");
  lines.push("# If status table exists, verify initialization completed successfully");
  lines.push("# This provides rich error context but isn't the primary validation");
  lines.push("if psql -tAc \\");
  lines.push(
    "    \"SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'pg_aza_status')\" \\"
  );
  lines.push('    2>/dev/null | grep -q "^t$"; then');
  lines.push("");
  lines.push("    INIT_STATUS=$(psql -tAc \\");
  lines.push('        "SELECT status FROM pg_aza_status ORDER BY init_timestamp DESC LIMIT 1" \\');
  lines.push('        2>/dev/null || echo "unknown")');
  lines.push("");
  lines.push('    if [ "$INIT_STATUS" = "in_progress" ]; then');
  lines.push('        echo "FAIL: Initialization still in progress (not yet complete)" >&2');
  lines.push("        exit 1");
  lines.push('    elif [ "$INIT_STATUS" = "failed" ]; then');
  lines.push("        FAILED_EXTS=$(psql -tAc \\");
  lines.push(
    "            \"SELECT array_to_string(failed_extensions, ', ') FROM pg_aza_status ORDER BY init_timestamp DESC LIMIT 1\" \\"
  );
  lines.push('            2>/dev/null || echo "unknown")');
  lines.push('        echo "FAIL: Initialization failed. Failed extensions: $FAILED_EXTS" >&2');
  lines.push("        exit 1");
  lines.push('    elif [ "$INIT_STATUS" = "partial" ]; then');
  lines.push("        FAILED_EXTS=$(psql -tAc \\");
  lines.push(
    "            \"SELECT array_to_string(failed_extensions, ', ') FROM pg_aza_status ORDER BY init_timestamp DESC LIMIT 1\" \\"
  );
  lines.push('            2>/dev/null || echo "unknown")');
  lines.push(
    '        echo "WARNING: Initialization partially failed. Some extensions missing: $FAILED_EXTS" >&2'
  );
  lines.push("        # Note: This is already caught by Tier 3, but provides additional context");
  lines.push("    fi");
  lines.push("fi");
  lines.push("");

  // Tier 5: Database Role Verification
  lines.push("# Tier 5: Database Role Verification");
  lines.push('POSTGRES_ROLE="${POSTGRES_ROLE:-primary}"');
  lines.push('if [ "$POSTGRES_ROLE" != "replica" ]; then');
  lines.push("    IN_RECOVERY=$(psql -tAc \\");
  lines.push('        "SELECT pg_is_in_recovery()" \\');
  lines.push('        2>/dev/null || echo "t")');
  lines.push("");
  lines.push('    if [ "$IN_RECOVERY" = "t" ]; then');
  lines.push(
    '        echo "FAIL: Database in recovery mode but configured as primary/single-node" >&2'
  );
  lines.push("        exit 1");
  lines.push("    fi");
  lines.push("fi");
  lines.push("");

  lines.push("# All checks passed");
  lines.push("exit 0");

  return lines.join("\n");
}
