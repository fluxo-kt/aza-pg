/**
 * Healthcheck Generator
 * Generates healthcheck script from manifest to eliminate duplication
 * and ensure version-specific validation
 */

import type { ManifestEntry } from "../extensions/manifest-data";

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
 * @param preloadLibraries - Comma-separated list of preloaded libraries
 * @returns Healthcheck shell script content
 */
export function generateHealthcheckScript(
  extensionsToEnable: ManifestEntry[],
  preloadLibraries: string
): string {
  const lines: string[] = [];
  const extensionNames = extensionsToEnable.map((e) => e.name);
  const expectedCount = extensionNames.length;

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

  // Version-specific expectations (baked in from manifest)
  lines.push("# Expected extensions for this aza-pg version (from manifest)");
  lines.push(`EXPECTED_EXTENSIONS=(${extensionNames.map((n) => `"${n}"`).join(" ")})`);
  lines.push(`EXPECTED_COUNT=${expectedCount}`);
  lines.push(`EXPECTED_PRELOAD="${preloadLibraries}"`);
  lines.push("");

  // Tier 1: Connection Test
  lines.push("# Tier 1: Connection Test");
  lines.push("if ! pg_isready -U postgres --timeout=3 >/dev/null 2>&1; then");
  lines.push('    echo "FAIL: PostgreSQL not accepting connections" >&2');
  lines.push("    exit 1");
  lines.push("fi");
  lines.push("");

  // Tier 2: Query Execution
  lines.push("# Tier 2: Query Execution Test");
  lines.push("if ! psql -U postgres -d postgres -tAc 'SELECT 1' 2>/dev/null | grep -q '^1$'; then");
  lines.push('    echo "FAIL: Database query execution failed" >&2');
  lines.push("    exit 1");
  lines.push("fi");
  lines.push("");

  // Tier 3: Extension State Verification (Ground Truth)
  lines.push("# Tier 3: Extension State Verification (Ground Truth)");
  lines.push("# Verify all expected extensions actually exist in pg_extension");
  lines.push("# This works correctly for: fresh init, restores, replicas, upgrades");
  lines.push("MISSING_EXTENSIONS=()");
  lines.push('for ext in "${EXPECTED_EXTENSIONS[@]}"; do');
  lines.push("    if ! psql -U postgres -d postgres -tAc \\");
  lines.push("        \"SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = '$ext')\" \\");
  lines.push('        2>/dev/null | grep -q "^t$"; then');
  lines.push('        MISSING_EXTENSIONS+=("$ext")');
  lines.push("    fi");
  lines.push("done");
  lines.push("");
  lines.push("if [ ${#MISSING_EXTENSIONS[@]} -gt 0 ]; then");
  lines.push("    # Check status table for diagnostic context");
  lines.push('    STATUS_INFO=""');
  lines.push("    if psql -U postgres -d postgres -tAc \\");
  lines.push(
    "        \"SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'pg_aza_status')\" \\"
  );
  lines.push('        2>/dev/null | grep -q "^t$"; then');
  lines.push("        # Status table exists - get diagnostic info");
  lines.push("        STATUS_INFO=$(psql -U postgres -d postgres -tAc \\");
  lines.push(
    "            \"SELECT 'Init status: ' || status || ', Failed: ' || COALESCE(array_to_string(failed_extensions, ', '), 'none') FROM pg_aza_status ORDER BY init_timestamp DESC LIMIT 1\" \\"
  );
  lines.push('            2>/dev/null || echo "unknown")');
  lines.push("    fi");
  lines.push("");
  lines.push(
    '    echo "FAIL: Missing ${#MISSING_EXTENSIONS[@]}/$EXPECTED_COUNT expected extensions: ${MISSING_EXTENSIONS[*]}" >&2'
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
  lines.push("if psql -U postgres -d postgres -tAc \\");
  lines.push(
    "    \"SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'pg_aza_status')\" \\"
  );
  lines.push('    2>/dev/null | grep -q "^t$"; then');
  lines.push("");
  lines.push("    INIT_STATUS=$(psql -U postgres -d postgres -tAc \\");
  lines.push('        "SELECT status FROM pg_aza_status ORDER BY init_timestamp DESC LIMIT 1" \\');
  lines.push('        2>/dev/null || echo "unknown")');
  lines.push("");
  lines.push('    if [ "$INIT_STATUS" = "in_progress" ]; then');
  lines.push('        echo "FAIL: Initialization still in progress (not yet complete)" >&2');
  lines.push("        exit 1");
  lines.push('    elif [ "$INIT_STATUS" = "failed" ]; then');
  lines.push("        FAILED_EXTS=$(psql -U postgres -d postgres -tAc \\");
  lines.push(
    "            \"SELECT array_to_string(failed_extensions, ', ') FROM pg_aza_status ORDER BY init_timestamp DESC LIMIT 1\" \\"
  );
  lines.push('            2>/dev/null || echo "unknown")');
  lines.push('        echo "FAIL: Initialization failed. Failed extensions: $FAILED_EXTS" >&2');
  lines.push("        exit 1");
  lines.push('    elif [ "$INIT_STATUS" = "partial" ]; then');
  lines.push("        FAILED_EXTS=$(psql -U postgres -d postgres -tAc \\");
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

  // Tier 5: Shared Preload Libraries
  lines.push("# Tier 5: Shared Preload Libraries Verification");
  lines.push("ACTUAL_PRELOAD=$(psql -U postgres -d postgres -tAc \\");
  lines.push("    \"SELECT setting FROM pg_settings WHERE name = 'shared_preload_libraries'\" \\");
  lines.push('    2>/dev/null || echo "")');
  lines.push("");
  lines.push("# Verify expected preload libraries are present (generated from manifest)");
  lines.push("# Convert comma-separated EXPECTED_PRELOAD to array and check each");
  lines.push("IFS=',' read -ra PRELOAD_LIBS <<< \"$EXPECTED_PRELOAD\"");
  lines.push('for lib in "${PRELOAD_LIBS[@]}"; do');
  lines.push('    if ! echo "$ACTUAL_PRELOAD" | grep -q "$lib"; then');
  lines.push('        echo "FAIL: shared_preload_libraries missing expected library: $lib" >&2');
  lines.push('        echo "Expected preload: $EXPECTED_PRELOAD" >&2');
  lines.push('        echo "Actual preload: $ACTUAL_PRELOAD" >&2');
  lines.push("        exit 1");
  lines.push("    fi");
  lines.push("done");
  lines.push("");

  // Tier 6: System Catalog Integrity
  lines.push("# Tier 6: System Catalog Integrity");
  lines.push("CATALOG_TABLES=$(psql -U postgres -d postgres -tAc \\");
  lines.push(
    "    \"SELECT count(*) FROM information_schema.tables WHERE table_schema = 'pg_catalog' AND table_type = 'BASE TABLE'\" \\"
  );
  lines.push('    2>/dev/null || echo "0")');
  lines.push("");
  lines.push('if [ "$CATALOG_TABLES" -lt 60 ]; then');
  lines.push(
    '    echo "FAIL: pg_catalog appears corrupted (only $CATALOG_TABLES tables, expected 60+)" >&2'
  );
  lines.push("    exit 1");
  lines.push("fi");
  lines.push("");

  // Tier 7: Database Role Verification
  lines.push("# Tier 7: Database Role Verification");
  lines.push('POSTGRES_ROLE="${POSTGRES_ROLE:-primary}"');
  lines.push('if [ "$POSTGRES_ROLE" != "replica" ]; then');
  lines.push("    IN_RECOVERY=$(psql -U postgres -d postgres -tAc \\");
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
