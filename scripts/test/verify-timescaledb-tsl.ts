#!/usr/bin/env bun
/**
 * Verify TimescaleDB TSL (Timescale License) features are available.
 *
 * Tests:
 * 1. Extension loads successfully
 * 2. Compression is available (TSL feature)
 * 3. Continuous aggregates are available (TSL feature)
 * 4. License information shows TSL is enabled
 *
 * Usage:
 *   bun scripts/test/verify-timescaledb-tsl.ts
 *   bun scripts/test/verify-timescaledb-tsl.ts --help
 */

import { $ } from "bun";

interface VerificationResult {
  success: boolean;
  message: string;
  details?: string;
}

/**
 * Execute a SQL query against PostgreSQL and return the output
 */
async function execSQL(query: string): Promise<string> {
  const result = await $`psql -U postgres -d postgres -tAc ${query}`.quiet();
  return result.stdout.toString().trim();
}

/**
 * Test 1: Verify TimescaleDB extension loads
 */
async function testExtensionLoads(): Promise<VerificationResult> {
  try {
    const result = await execSQL("CREATE EXTENSION IF NOT EXISTS timescaledb;");
    const version = await execSQL(
      "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb';"
    );

    if (version) {
      return {
        success: true,
        message: "TimescaleDB extension loaded successfully",
        details: `Version: ${version}`,
      };
    } else {
      return {
        success: false,
        message: "TimescaleDB extension not found in pg_extension",
      };
    }
  } catch (error) {
    return {
      success: false,
      message: "Failed to load TimescaleDB extension",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Test 2: Verify compression is available (TSL feature)
 */
async function testCompressionAvailable(): Promise<VerificationResult> {
  try {
    // Create a test hypertable
    await execSQL("DROP TABLE IF EXISTS test_compression CASCADE;");
    await execSQL(
      "CREATE TABLE test_compression (time TIMESTAMPTZ NOT NULL, device_id TEXT, value DOUBLE PRECISION);"
    );
    await execSQL("SELECT create_hypertable('test_compression', 'time');");

    // Try to enable compression (TSL feature)
    await execSQL(
      "ALTER TABLE test_compression SET (timescaledb.compress, timescaledb.compress_segmentby = 'device_id');"
    );

    // Verify compression settings
    const compressionEnabled = await execSQL(
      "SELECT compression_state FROM _timescaledb_catalog.hypertable WHERE table_name = 'test_compression';"
    );

    // Clean up
    await execSQL("DROP TABLE test_compression CASCADE;");

    if (compressionEnabled === "1" || compressionEnabled === "2") {
      return {
        success: true,
        message: "Compression is available (TSL feature enabled)",
        details: `Compression state: ${compressionEnabled}`,
      };
    } else {
      return {
        success: false,
        message: "Compression not available - TSL may not be enabled",
        details: `Compression state: ${compressionEnabled}`,
      };
    }
  } catch (error) {
    return {
      success: false,
      message: "Compression test failed",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Test 3: Verify continuous aggregates are available (TSL feature)
 */
async function testContinuousAggregatesAvailable(): Promise<VerificationResult> {
  try {
    // Create a test hypertable
    await execSQL("DROP TABLE IF EXISTS test_cagg_source CASCADE;");
    await execSQL("DROP MATERIALIZED VIEW IF EXISTS test_cagg CASCADE;");

    await execSQL(
      "CREATE TABLE test_cagg_source (time TIMESTAMPTZ NOT NULL, device_id TEXT, value DOUBLE PRECISION);"
    );
    await execSQL("SELECT create_hypertable('test_cagg_source', 'time');");

    // Try to create a continuous aggregate (TSL feature)
    await execSQL(`
      CREATE MATERIALIZED VIEW test_cagg
      WITH (timescaledb.continuous) AS
      SELECT time_bucket('1 hour', time) AS bucket,
             device_id,
             AVG(value) AS avg_value
      FROM test_cagg_source
      GROUP BY bucket, device_id;
    `);

    // Verify continuous aggregate was created
    const caggExists = await execSQL(
      "SELECT COUNT(*) FROM _timescaledb_catalog.continuous_agg WHERE user_view_name = 'test_cagg';"
    );

    // Clean up
    await execSQL("DROP MATERIALIZED VIEW IF EXISTS test_cagg CASCADE;");
    await execSQL("DROP TABLE IF EXISTS test_cagg_source CASCADE;");

    if (caggExists === "1") {
      return {
        success: true,
        message: "Continuous aggregates are available (TSL feature enabled)",
      };
    } else {
      return {
        success: false,
        message: "Continuous aggregates not available - TSL may not be enabled",
      };
    }
  } catch (error) {
    return {
      success: false,
      message: "Continuous aggregates test failed",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Test 4: Check license information
 */
async function testLicenseInfo(): Promise<VerificationResult> {
  try {
    // Try to get license information from timescaledb_information view
    const licenseInfo = await execSQL(
      "SELECT key, value FROM timescaledb_information.license WHERE key IN ('edition', 'license_type');"
    );

    return {
      success: true,
      message: "License information retrieved",
      details: licenseInfo || "No specific license info returned",
    };
  } catch (error) {
    // License info might not be available in all versions
    return {
      success: true,
      message: "License information not available (expected for some versions)",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Main test runner
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
TimescaleDB TSL Verification Script

Usage:
  bun scripts/test/verify-timescaledb-tsl.ts

Tests:
  1. Extension loads successfully
  2. Compression is available (TSL feature)
  3. Continuous aggregates are available (TSL feature)
  4. License information

Environment:
  Requires PostgreSQL server running and accessible via 'psql -U postgres'
`);
    process.exit(0);
  }

  console.log("TimescaleDB TSL Feature Verification\n");
  console.log("=====================================\n");

  const tests = [
    { name: "Extension Loading", fn: testExtensionLoads },
    { name: "Compression Support", fn: testCompressionAvailable },
    { name: "Continuous Aggregates", fn: testContinuousAggregatesAvailable },
    { name: "License Information", fn: testLicenseInfo },
  ];

  let allPassed = true;

  for (const test of tests) {
    console.log(`Testing: ${test.name}`);
    const result = await test.fn();

    console.log(`  ${result.success ? "✓" : "✗"} ${result.message}`);
    if (result.details) {
      console.log(`    ${result.details}`);
    }
    console.log();

    if (!result.success && test.name !== "License Information") {
      allPassed = false;
    }
  }

  console.log("=====================================\n");

  if (allPassed) {
    console.log("✓ All TSL features verified successfully!\n");
    console.log(
      "TimescaleDB is built with TSL enabled, providing compression and continuous aggregates."
    );
    process.exit(0);
  } else {
    console.log("✗ Some TSL features are not available\n");
    console.log("This may indicate TimescaleDB was built with APACHE_ONLY=ON (OSS-only mode).");
    console.log(
      "Rebuild with -DAPACHE_ONLY=OFF to enable TSL features (compression, continuous aggregates)."
    );
    process.exit(1);
  }
}

main();
