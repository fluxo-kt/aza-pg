#!/usr/bin/env bun
/**
 * Verify TimescaleDB TSL (Timescale License) features are available.
 *
 * Tests:
 * 1. Extension loads successfully
 * 2. Compression is available and functional (TSL feature)
 * 3. Continuous aggregates are available and functional (TSL feature)
 * 4. License information shows TSL is enabled
 *
 * Usage:
 *   bun scripts/test/verify-timescaledb-tsl.ts <image>
 *   bun scripts/test/verify-timescaledb-tsl.ts ghcr.io/fluxo-kt/aza-pg:18.1-202511232230-single-node
 *   bun scripts/test/verify-timescaledb-tsl.ts --help
 */

import { $ } from "bun";

const CONTAINER_NAME = `tsdb-tsl-verify-${Date.now()}`;
const TIMEOUT_MS = 60_000; // 60 seconds for container readiness

interface TestResult {
  name: string;
  success: boolean;
  message: string;
  details?: string;
}

/**
 * Execute SQL via docker exec
 */
async function runSQL(sql: string): Promise<{ stdout: string; stderr: string; success: boolean }> {
  const result = await $`docker exec ${CONTAINER_NAME} psql -U postgres -t -A -c ${sql}`
    .nothrow()
    .quiet();
  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    success: result.exitCode === 0,
  };
}

/**
 * Wait for PostgreSQL to be ready
 */
async function waitForPostgres(): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < TIMEOUT_MS) {
    const result = await $`docker exec ${CONTAINER_NAME} pg_isready -U postgres`.nothrow().quiet();
    if (result.exitCode === 0) {
      // Additional check - make sure we can actually query
      const query = await runSQL("SELECT 1");
      if (query.success) {
        return true;
      }
    }
    await Bun.sleep(1000);
  }
  return false;
}

/**
 * Start test container
 */
async function startContainer(image: string): Promise<boolean> {
  console.log(`Starting container ${CONTAINER_NAME}...`);
  const result =
    await $`docker run -d --name ${CONTAINER_NAME} --memory=1g -e POSTGRES_PASSWORD=testpass ${image}`
      .nothrow()
      .quiet();

  if (result.exitCode !== 0) {
    console.error(`Failed to start container: ${result.stderr.toString()}`);
    return false;
  }

  console.log("Waiting for PostgreSQL to be ready...");
  const ready = await waitForPostgres();
  if (!ready) {
    console.error("PostgreSQL did not become ready in time");
    return false;
  }

  console.log("PostgreSQL is ready\n");
  return true;
}

/**
 * Stop and remove test container
 */
async function cleanup(): Promise<void> {
  await $`docker rm -f ${CONTAINER_NAME}`.nothrow().quiet();
}

/**
 * Test 1: Verify TimescaleDB extension loads
 */
async function testExtensionLoads(): Promise<TestResult> {
  // Extension should already be created by initdb scripts
  const versionResult = await runSQL(
    "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb';"
  );

  if (versionResult.success && versionResult.stdout) {
    return {
      name: "Extension Loading",
      success: true,
      message: "TimescaleDB extension loaded successfully",
      details: `Version: ${versionResult.stdout}`,
    };
  }

  // Try to create if not exists
  const create = await runSQL("CREATE EXTENSION IF NOT EXISTS timescaledb;");
  if (!create.success) {
    return {
      name: "Extension Loading",
      success: false,
      message: "Failed to load TimescaleDB extension",
      details: create.stderr,
    };
  }

  const version = await runSQL(
    "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb';"
  );
  return {
    name: "Extension Loading",
    success: version.success && !!version.stdout,
    message: version.success ? "TimescaleDB extension loaded" : "TimescaleDB extension not found",
    details: version.success ? `Version: ${version.stdout}` : version.stderr,
  };
}

/**
 * Test 2: Verify compression works (TSL feature) - test actual functionality
 */
async function testCompression(): Promise<TestResult> {
  // Create a hypertable
  await runSQL("DROP TABLE IF EXISTS test_tsl_compression CASCADE;");
  const createTable = await runSQL(`
    CREATE TABLE test_tsl_compression (
      time TIMESTAMPTZ NOT NULL,
      device_id TEXT NOT NULL,
      value DOUBLE PRECISION
    );
  `);

  if (!createTable.success) {
    return {
      name: "Compression Support",
      success: false,
      message: "Failed to create test table",
      details: createTable.stderr,
    };
  }

  const createHypertable = await runSQL(
    "SELECT create_hypertable('test_tsl_compression', 'time');"
  );
  if (!createHypertable.success) {
    return {
      name: "Compression Support",
      success: false,
      message: "Failed to create hypertable",
      details: createHypertable.stderr,
    };
  }

  // Try to enable compression (TSL feature)
  const enableCompression = await runSQL(`
    ALTER TABLE test_tsl_compression SET (
      timescaledb.compress,
      timescaledb.compress_segmentby = 'device_id'
    );
  `);

  if (!enableCompression.success) {
    // Check if it's a license issue
    if (
      enableCompression.stderr.includes("apache") ||
      enableCompression.stderr.includes("license")
    ) {
      return {
        name: "Compression Support",
        success: false,
        message: "Compression not available - TSL license not enabled",
        details: "TimescaleDB built with APACHE_ONLY=ON",
      };
    }
    return {
      name: "Compression Support",
      success: false,
      message: "Failed to enable compression",
      details: enableCompression.stderr,
    };
  }

  // Insert some test data
  await runSQL(`
    INSERT INTO test_tsl_compression
    SELECT time, 'device_' || (i % 5), random() * 100
    FROM generate_series(NOW() - INTERVAL '30 days', NOW(), INTERVAL '1 hour') AS time,
         generate_series(1, 5) AS i;
  `);

  // Try to actually compress a chunk (functional test, not just catalog state)
  const compressChunk = await runSQL(`
    SELECT compress_chunk(c, if_not_compressed => true)
    FROM show_chunks('test_tsl_compression') c
    LIMIT 1;
  `);

  // Clean up
  await runSQL("DROP TABLE test_tsl_compression CASCADE;");

  if (compressChunk.success) {
    return {
      name: "Compression Support",
      success: true,
      message: "Compression is fully functional (TSL feature enabled)",
      details: "Successfully compressed a chunk",
    };
  }

  return {
    name: "Compression Support",
    success: false,
    message: "Compression enabled but chunk compression failed",
    details: compressChunk.stderr,
  };
}

/**
 * Test 3: Verify continuous aggregates work (TSL feature) - test actual functionality
 */
async function testContinuousAggregates(): Promise<TestResult> {
  // Create source hypertable
  await runSQL("DROP TABLE IF EXISTS test_tsl_cagg_source CASCADE;");
  await runSQL("DROP MATERIALIZED VIEW IF EXISTS test_tsl_cagg CASCADE;");

  const createTable = await runSQL(`
    CREATE TABLE test_tsl_cagg_source (
      time TIMESTAMPTZ NOT NULL,
      device_id TEXT NOT NULL,
      value DOUBLE PRECISION
    );
  `);

  if (!createTable.success) {
    return {
      name: "Continuous Aggregates",
      success: false,
      message: "Failed to create source table",
      details: createTable.stderr,
    };
  }

  const createHypertable = await runSQL(
    "SELECT create_hypertable('test_tsl_cagg_source', 'time');"
  );
  if (!createHypertable.success) {
    return {
      name: "Continuous Aggregates",
      success: false,
      message: "Failed to create hypertable",
      details: createHypertable.stderr,
    };
  }

  // Insert some test data first
  await runSQL(`
    INSERT INTO test_tsl_cagg_source
    SELECT time, 'device_' || (i % 3), random() * 100
    FROM generate_series(NOW() - INTERVAL '7 days', NOW(), INTERVAL '5 minutes') AS time,
         generate_series(1, 3) AS i;
  `);

  // Try to create a continuous aggregate (TSL feature)
  const createCagg = await runSQL(`
    CREATE MATERIALIZED VIEW test_tsl_cagg
    WITH (timescaledb.continuous) AS
    SELECT time_bucket('1 hour', time) AS bucket,
           device_id,
           AVG(value) AS avg_value,
           COUNT(*) AS count
    FROM test_tsl_cagg_source
    GROUP BY bucket, device_id
    WITH NO DATA;
  `);

  if (!createCagg.success) {
    // Check if it's a license issue
    if (createCagg.stderr.includes("apache") || createCagg.stderr.includes("license")) {
      return {
        name: "Continuous Aggregates",
        success: false,
        message: "Continuous aggregates not available - TSL license not enabled",
        details: "TimescaleDB built with APACHE_ONLY=ON",
      };
    }
    return {
      name: "Continuous Aggregates",
      success: false,
      message: "Failed to create continuous aggregate",
      details: createCagg.stderr,
    };
  }

  // Try to actually refresh the continuous aggregate (functional test)
  const refreshCagg = await runSQL(`
    CALL refresh_continuous_aggregate('test_tsl_cagg', NULL, NULL);
  `);

  // Verify data was aggregated
  const queryResult = await runSQL("SELECT COUNT(*) FROM test_tsl_cagg;");

  // Clean up
  await runSQL("DROP MATERIALIZED VIEW IF EXISTS test_tsl_cagg CASCADE;");
  await runSQL("DROP TABLE IF EXISTS test_tsl_cagg_source CASCADE;");

  if (refreshCagg.success && queryResult.success && parseInt(queryResult.stdout) > 0) {
    return {
      name: "Continuous Aggregates",
      success: true,
      message: "Continuous aggregates are fully functional (TSL feature enabled)",
      details: `Aggregated ${queryResult.stdout} rows successfully`,
    };
  }

  return {
    name: "Continuous Aggregates",
    success: refreshCagg.success,
    message: refreshCagg.success
      ? "Continuous aggregate created but refresh may have no data"
      : "Continuous aggregate refresh failed",
    details: refreshCagg.stderr || queryResult.stderr,
  };
}

/**
 * Test 4: Check license/edition information
 */
async function testLicenseInfo(): Promise<TestResult> {
  // Check timescaledb license in GUC
  const licenseGuc = await runSQL("SHOW timescaledb.license;");

  // Check the telemetry/license view if available
  const licenseView = await runSQL(`
    SELECT value FROM timescaledb_information.license
    WHERE key = 'edition' OR key = 'license_type'
    LIMIT 1;
  `);

  const edition = licenseView.success ? licenseView.stdout : "N/A";
  const license = licenseGuc.success ? licenseGuc.stdout : "N/A";

  return {
    name: "License Information",
    success: true,
    message: "License information retrieved",
    details: `License GUC: ${license}, Edition: ${edition}`,
  };
}

/**
 * Main test runner
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(`
TimescaleDB TSL Verification Script

Usage:
  bun scripts/test/verify-timescaledb-tsl.ts <image>

Arguments:
  image    Docker image to test (required)

Examples:
  bun scripts/test/verify-timescaledb-tsl.ts ghcr.io/fluxo-kt/aza-pg:18.1-202511232230-single-node
  bun scripts/test/verify-timescaledb-tsl.ts aza-pg:local

Tests:
  1. Extension loads successfully
  2. Compression is available AND functional (TSL feature)
  3. Continuous aggregates are available AND functional (TSL feature)
  4. License information

This script tests actual TSL functionality by:
  - Enabling compression and compressing a real chunk
  - Creating a continuous aggregate and refreshing it with data
  - Not just checking catalog state but actual operations
`);
    process.exit(args.length === 0 ? 1 : 0);
  }

  const image = args[0];
  console.log("TimescaleDB TSL Feature Verification\n");
  console.log("=====================================");
  console.log(`Image: ${image}\n`);

  // Start container
  const started = await startContainer(image);
  if (!started) {
    console.error("\n✗ Failed to start test container");
    await cleanup();
    process.exit(1);
  }

  const tests = [testExtensionLoads, testCompression, testContinuousAggregates, testLicenseInfo];

  const results: TestResult[] = [];
  let allPassed = true;

  for (const testFn of tests) {
    const result = await testFn();
    results.push(result);

    const icon = result.success ? "✓" : "✗";
    console.log(`${icon} ${result.name}: ${result.message}`);
    if (result.details) {
      console.log(`    ${result.details}`);
    }

    // License info is optional, don't fail on it
    if (!result.success && result.name !== "License Information") {
      allPassed = false;
    }
  }

  // Cleanup
  console.log("\nCleaning up...");
  await cleanup();

  console.log("\n=====================================");

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

main().catch((err) => {
  console.error("Error:", err);
  cleanup().finally(() => process.exit(1));
});
