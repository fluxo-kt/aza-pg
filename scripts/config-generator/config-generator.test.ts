import { test, expect, describe } from "bun:test";
import { generateHealthcheckScript } from "./healthcheck-generator";
import { generateExtensionsInitScript } from "./sql-generator";
import type { ManifestEntry } from "../extensions/manifest-data";

// Test data fixtures
const mockExtensions: ManifestEntry[] = [
  {
    name: "postgis",
    displayName: "PostGIS",
    description: "PostGIS spatial and geographic objects for PostgreSQL",
    category: "geospatial",
    enabled: true,
    kind: "extension",
    source: { type: "builtin" },
    runtime: {
      defaultEnable: true,
      sharedPreload: false,
      preloadOnly: false,
    },
  },
  {
    name: "pg_stat_statements",
    displayName: "pg_stat_statements",
    description: "Track execution statistics of SQL statements",
    category: "monitoring",
    enabled: true,
    kind: "extension",
    source: { type: "builtin" },
    runtime: {
      defaultEnable: true,
      sharedPreload: true,
      preloadOnly: false,
    },
  },
  {
    name: "timescaledb",
    displayName: "TimescaleDB",
    description: "Time-series database extension",
    category: "timeseries",
    enabled: true,
    kind: "extension",
    source: { type: "builtin" },
    runtime: {
      defaultEnable: true,
      sharedPreload: true,
      preloadOnly: false,
    },
  },
];

const mockPreloadLibraries = "auto_explain,pg_cron,pg_stat_statements,timescaledb";

describe("SQL Generator", () => {
  test("generateExtensionsInitScript generates valid SQL", async () => {
    const result = await generateExtensionsInitScript(mockExtensions);

    // Basic structure validation
    expect(result).toContain("-- PostgreSQL initialization");
    expect(result).toContain("CREATE TABLE IF NOT EXISTS pg_aza_status");
    expect(result).toContain("DO $$");
    expect(result).toContain("END;");
    expect(result).toContain("$$;");

    // Status table fields
    expect(result).toContain("init_timestamp");
    expect(result).toContain("expected_extensions");
    expect(result).toContain("created_extensions");
    expect(result).toContain("failed_extensions");
    expect(result).toContain("status TEXT NOT NULL");

    // Index creation
    expect(result).toContain("CREATE INDEX IF NOT EXISTS idx_pg_aza_status_timestamp");
  });

  test("generateExtensionsInitScript includes all expected extensions", async () => {
    const result = await generateExtensionsInitScript(mockExtensions);

    // Check that all extension names appear in the expected list
    for (const ext of mockExtensions) {
      expect(result).toContain(`'${ext.name}'`);
    }

    // Verify CREATE EXTENSION statements
    expect(result).toContain('CREATE EXTENSION IF NOT EXISTS "postgis"');
    expect(result).toContain('CREATE EXTENSION IF NOT EXISTS "pg_stat_statements"');
    expect(result).toContain('CREATE EXTENSION IF NOT EXISTS "timescaledb"');
  });

  test("generateExtensionsInitScript includes error handling", async () => {
    const result = await generateExtensionsInitScript(mockExtensions);

    // Verify error handling structure
    expect(result).toContain("EXCEPTION WHEN OTHERS THEN");
    expect(result).toContain("v_failed_exts := array_append(v_failed_exts");
    expect(result).toContain("GET STACKED DIAGNOSTICS v_error_msg = MESSAGE_TEXT");
    expect(result).toContain("RAISE WARNING");
  });

  test("generateExtensionsInitScript includes status tracking", async () => {
    const result = await generateExtensionsInitScript(mockExtensions);

    // Verify initialization status recording
    expect(result).toContain("INSERT INTO pg_aza_status");
    expect(result).toContain("'in_progress'");
    expect(result).toContain("UPDATE pg_aza_status");

    // Verify status conditions
    expect(result).toContain("'completed'");
    expect(result).toContain("'partial'");
    expect(result).toContain("'failed'");
  });

  test("generateExtensionsInitScript handles empty extension list", async () => {
    const result = await generateExtensionsInitScript([]);

    // Should still create status table
    expect(result).toContain("CREATE TABLE IF NOT EXISTS pg_aza_status");

    // Should have appropriate message for no extensions
    expect(result).toContain("No baseline extensions enabled");
  });

  test("generateExtensionsInitScript includes display names in comments", async () => {
    const result = await generateExtensionsInitScript(mockExtensions);

    // Verify display names appear in comments
    expect(result).toContain("PostGIS");
    expect(result).toContain("TimescaleDB");
  });

  test("generateExtensionsInitScript includes category information", async () => {
    const result = await generateExtensionsInitScript(mockExtensions);

    // Verify categories appear
    expect(result).toContain("geospatial");
    expect(result).toContain("monitoring");
    expect(result).toContain("timeseries");
  });
});

describe("Healthcheck Generator", () => {
  test("generateHealthcheckScript generates valid bash script", () => {
    const result = generateHealthcheckScript(mockExtensions, mockPreloadLibraries);

    // Basic bash structure
    expect(result).toStartWith("#!/bin/bash");
    expect(result).toContain("set -euo pipefail");
    expect(result).toContain("exit 0");

    // Should not contain syntax errors
    expect(result).not.toContain("[[");
    expect(result).not.toContain("]]");
  });

  test("generateHealthcheckScript includes EXPECTED_EXTENSIONS array", () => {
    const result = generateHealthcheckScript(mockExtensions, mockPreloadLibraries);

    // Verify array declaration
    expect(result).toContain("EXPECTED_EXTENSIONS=(");
    expect(result).toContain("EXPECTED_COUNT=");

    // Check all extension names are in the array
    for (const ext of mockExtensions) {
      expect(result).toContain(`"${ext.name}"`);
    }

    // Verify count matches
    expect(result).toContain(`EXPECTED_COUNT=${mockExtensions.length}`);
  });

  test("generateHealthcheckScript includes EXPECTED_PRELOAD", () => {
    const result = generateHealthcheckScript(mockExtensions, mockPreloadLibraries);

    // Verify preload libraries declaration
    expect(result).toContain("EXPECTED_PRELOAD=");
    expect(result).toContain(`"${mockPreloadLibraries}"`);
  });

  test("generateHealthcheckScript contains all 7 tiers", () => {
    const result = generateHealthcheckScript(mockExtensions, mockPreloadLibraries);

    // Verify all 7 tiers are present
    expect(result).toContain("# Tier 1: Connection Test");
    expect(result).toContain("# Tier 2: Query Execution Test");
    expect(result).toContain("# Tier 3: Extension State Verification");
    expect(result).toContain("# Tier 4: Initialization Status Check");
    expect(result).toContain("# Tier 5: Shared Preload Libraries Verification");
    expect(result).toContain("# Tier 6: System Catalog Integrity");
    expect(result).toContain("# Tier 7: Database Role Verification");
  });

  test("generateHealthcheckScript tier 1 validates connection", () => {
    const result = generateHealthcheckScript(mockExtensions, mockPreloadLibraries);

    // Tier 1: Connection Test
    expect(result).toContain("pg_isready");
    expect(result).toContain("-U postgres");
    expect(result).toContain("--timeout=3");
    expect(result).toContain("PostgreSQL not accepting connections");
  });

  test("generateHealthcheckScript tier 2 validates query execution", () => {
    const result = generateHealthcheckScript(mockExtensions, mockPreloadLibraries);

    // Tier 2: Query Execution
    expect(result).toContain("psql -U postgres -d postgres -tAc 'SELECT 1'");
    expect(result).toContain("Database query execution failed");
  });

  test("generateHealthcheckScript tier 3 validates extension state", () => {
    const result = generateHealthcheckScript(mockExtensions, mockPreloadLibraries);

    // Tier 3: Extension State Verification
    expect(result).toContain("MISSING_EXTENSIONS=()");
    expect(result).toContain('for ext in "${EXPECTED_EXTENSIONS[@]}"; do');
    expect(result).toContain("SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = '$ext')");
    expect(result).toContain("MISSING_EXTENSIONS+=(");
  });

  test("generateHealthcheckScript tier 3 includes diagnostic context", () => {
    const result = generateHealthcheckScript(mockExtensions, mockPreloadLibraries);

    // Check status table query for diagnostics
    expect(result).toContain("pg_aza_status");
    expect(result).toContain("STATUS_INFO");
    expect(result).toContain("Init status:");
    expect(result).toContain("Failed:");
  });

  test("generateHealthcheckScript tier 4 validates initialization status", () => {
    const result = generateHealthcheckScript(mockExtensions, mockPreloadLibraries);

    // Tier 4: Initialization Status
    expect(result).toContain("INIT_STATUS=$(");
    expect(result).toContain("SELECT status FROM pg_aza_status");
    expect(result).toContain('"in_progress"');
    expect(result).toContain('"failed"');
    expect(result).toContain('"partial"');
  });

  test("generateHealthcheckScript tier 5 validates preload libraries", () => {
    const result = generateHealthcheckScript(mockExtensions, mockPreloadLibraries);

    // Tier 5: Shared Preload Libraries
    expect(result).toContain("ACTUAL_PRELOAD=$(");
    expect(result).toContain("shared_preload_libraries");
    expect(result).toContain("IFS=',' read -ra PRELOAD_LIBS");
    expect(result).toContain('for lib in "${PRELOAD_LIBS[@]}"; do');
    expect(result).toContain("missing expected library");
  });

  test("generateHealthcheckScript tier 6 validates catalog integrity", () => {
    const result = generateHealthcheckScript(mockExtensions, mockPreloadLibraries);

    // Tier 6: System Catalog Integrity
    expect(result).toContain("CATALOG_TABLES=$(");
    expect(result).toContain("table_schema = 'pg_catalog'");
    expect(result).toContain('if [ "$CATALOG_TABLES" -lt 60 ]; then');
    expect(result).toContain("pg_catalog appears corrupted");
  });

  test("generateHealthcheckScript tier 7 validates database role", () => {
    const result = generateHealthcheckScript(mockExtensions, mockPreloadLibraries);

    // Tier 7: Database Role Verification
    expect(result).toContain('POSTGRES_ROLE="${POSTGRES_ROLE:-primary}"');
    expect(result).toContain("pg_is_in_recovery()");
    expect(result).toContain('"replica"');
    expect(result).toContain("in recovery mode but configured as primary");
  });

  test("generateHealthcheckScript includes proper error messages", () => {
    const result = generateHealthcheckScript(mockExtensions, mockPreloadLibraries);

    // Check error output formatting
    expect(result).toContain(">&2"); // stderr redirect
    expect(result).toContain("FAIL:");
    expect(result).toContain("exit 1");
  });

  test("generateHealthcheckScript handles empty extension list", () => {
    const result = generateHealthcheckScript([], "auto_explain");

    // Should still have valid structure
    expect(result).toStartWith("#!/bin/bash");
    expect(result).toContain("EXPECTED_EXTENSIONS=()");
    expect(result).toContain("EXPECTED_COUNT=0");
    expect(result).toContain("EXPECTED_PRELOAD=");
  });

  test("generateHealthcheckScript is idempotent", () => {
    const result1 = generateHealthcheckScript(mockExtensions, mockPreloadLibraries);
    const result2 = generateHealthcheckScript(mockExtensions, mockPreloadLibraries);

    // Should produce identical output
    expect(result1).toBe(result2);
  });

  test("generateHealthcheckScript includes generation comment", () => {
    const result = generateHealthcheckScript(mockExtensions, mockPreloadLibraries);

    // Should indicate it's auto-generated
    expect(result).toContain("AUTO-GENERATED");
    expect(result).toContain("from extensions manifest");
  });

  test("generateHealthcheckScript validates with single extension", () => {
    const singleExt = mockExtensions.slice(0, 1);
    const result = generateHealthcheckScript(singleExt, "auto_explain");

    expect(result).toContain("EXPECTED_COUNT=1");
    expect(result).toContain(`"${singleExt[0]?.name}"`);
    expect(result).toContain('for ext in "${EXPECTED_EXTENSIONS[@]}"; do');
  });

  test("generateHealthcheckScript handles multiple preload libraries", () => {
    const preloadList = "lib1,lib2,lib3,lib4";
    const result = generateHealthcheckScript(mockExtensions, preloadList);

    expect(result).toContain(`EXPECTED_PRELOAD="${preloadList}"`);
    expect(result).toContain("IFS=',' read -ra PRELOAD_LIBS");
  });

  test("generateHealthcheckScript includes design documentation", () => {
    const result = generateHealthcheckScript(mockExtensions, mockPreloadLibraries);

    // Verify design comments are present
    expect(result).toContain("Design:");
    expect(result).toContain("Works correctly after database restores");
    expect(result).toContain("Works correctly on replicas");
    expect(result).toContain("Ground Truth");
  });
});

describe("Integration Tests", () => {
  test("SQL and healthcheck scripts use consistent extension lists", async () => {
    const sqlScript = await generateExtensionsInitScript(mockExtensions);
    const healthcheckScript = generateHealthcheckScript(mockExtensions, mockPreloadLibraries);

    // Both scripts should reference the same extensions
    for (const ext of mockExtensions) {
      expect(sqlScript).toContain(ext.name);
      expect(healthcheckScript).toContain(ext.name);
    }
  });

  test("Extension count matches between SQL and healthcheck", async () => {
    const sqlScript = await generateExtensionsInitScript(mockExtensions);
    const healthcheckScript = generateHealthcheckScript(mockExtensions, mockPreloadLibraries);

    // SQL script should mention the count
    const sqlCountMatch = sqlScript.match(/All (\d+) baseline extensions/);
    if (sqlCountMatch) {
      expect(sqlCountMatch[1]).toBe(String(mockExtensions.length));
    }

    // Healthcheck should have exact count
    expect(healthcheckScript).toContain(`EXPECTED_COUNT=${mockExtensions.length}`);
  });

  test("Status table contract is consistent", async () => {
    const sqlScript = await generateExtensionsInitScript(mockExtensions);
    const healthcheckScript = generateHealthcheckScript(mockExtensions, mockPreloadLibraries);

    // Both should reference pg_aza_status
    expect(sqlScript).toContain("pg_aza_status");
    expect(healthcheckScript).toContain("pg_aza_status");

    // Both should use the same status values
    const statusValues = ["in_progress", "completed", "failed", "partial"];
    for (const status of statusValues) {
      expect(sqlScript).toContain(status);
      expect(healthcheckScript).toContain(status);
    }
  });
});
