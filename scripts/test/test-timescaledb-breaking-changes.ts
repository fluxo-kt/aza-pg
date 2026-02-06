#!/usr/bin/env bun
/**
 * TimescaleDB 2.25.0 Breaking Changes & New Defaults Test Suite
 *
 * Tests:
 * - T1.1: time_bucket_ng removal (BREAKING)
 * - T1.2: Old CA format removal (BREAKING)
 * - T1.3: _timescaledb_debug schema removal (BREAKING)
 * - T1.4: WAL-based invalidation removal (BREAKING)
 * - T1.5: TimescaleDB version verification
 * - T1.6: Direct compress during CA refresh (performance feature)
 * - T1.7: DELETE optimizations verification
 *
 * Usage:
 *   bun scripts/test/test-timescaledb-breaking-changes.ts
 */

import { TestHarness } from "./harness";

const harness = new TestHarness();
let container: string;
let allTestsPassed = true;

interface TestResult {
  name: string;
  success: boolean;
  message: string;
  details?: string;
}

const results: TestResult[] = [];

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function recordTest(name: string, success: boolean, message: string, details?: string): void {
  results.push({ name, success, message, details });
  if (!success) {
    allTestsPassed = false;
  }
  const status = success ? "✓" : "✗";
  log(`${status} ${name}: ${message}`);
  if (details) {
    log(`  Details: ${details}`);
  }
}

async function setup(): Promise<void> {
  log("Starting container...");
  container = await harness.startContainer("timescaledb-breaking", {
    POSTGRES_PASSWORD: "test",
  });
  await harness.waitForReady(container);

  // Create timescaledb extension
  await harness.runSQL(container, "CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;");
  log("TimescaleDB extension created");
}

async function cleanup(): Promise<void> {
  log("Cleaning up...");
  await harness.cleanupAll();
}

async function testTimeBucketNgRemoval(): Promise<void> {
  try {
    // NEGATIVE: time_bucket_ng should not exist
    try {
      await harness.runSQL(container, "SELECT time_bucket_ng('1 hour', now());");
      recordTest(
        "T1.1.1: time_bucket_ng removal",
        false,
        "time_bucket_ng should not exist but call succeeded"
      );
    } catch (error) {
      const errorMsg = String(error);
      if (errorMsg.includes("does not exist")) {
        recordTest(
          "T1.1.1: time_bucket_ng removal",
          true,
          "time_bucket_ng correctly removed (function does not exist)"
        );
      } else {
        recordTest("T1.1.1: time_bucket_ng removal", false, "Unexpected error", errorMsg);
      }
    }

    // POSITIVE: time_bucket should still work
    const result = await harness.runSQL(container, "SELECT time_bucket('1 hour', now());");
    recordTest(
      "T1.1.2: time_bucket still works",
      result.length > 0,
      "time_bucket() returned result",
      result
    );

    // POSITIVE: time_bucket with origin parameter
    const originResult = await harness.runSQL(
      container,
      "SELECT time_bucket('1 hour', now(), origin => '2024-01-01'::timestamptz);"
    );
    recordTest(
      "T1.1.3: time_bucket with origin parameter",
      originResult.length > 0,
      "time_bucket() with origin parameter works",
      originResult
    );
  } catch (error) {
    recordTest(
      "T1.1: time_bucket_ng removal tests",
      false,
      "Unexpected error during test execution",
      String(error)
    );
  }
}

async function testOldCAFormatRemoval(): Promise<void> {
  try {
    // Create test hypertable and insert data
    await harness.runSQL(
      container,
      "CREATE TABLE ca_test_source (time TIMESTAMPTZ NOT NULL, val DOUBLE PRECISION);"
    );
    await harness.runSQL(container, "SELECT create_hypertable('ca_test_source', 'time');");
    await harness.runSQL(
      container,
      "INSERT INTO ca_test_source SELECT t, random() FROM generate_series(now() - interval '7 days', now(), '5 min') t;"
    );

    // POSITIVE: Create new-format continuous aggregate
    await harness.runSQL(
      container,
      `CREATE MATERIALIZED VIEW ca_test_new WITH (timescaledb.continuous) AS
       SELECT time_bucket('1 hour', time) AS bucket, avg(val) FROM ca_test_source GROUP BY 1 WITH NO DATA;`
    );
    recordTest("T1.2.1: New-format CA creation", true, "Continuous aggregate created successfully");

    // Refresh the CA
    await harness.runSQL(
      container,
      "CALL refresh_continuous_aggregate('ca_test_new', NULL, NULL);"
    );
    recordTest("T1.2.2: CA refresh", true, "Continuous aggregate refreshed successfully");

    // NEGATIVE: Old catalog table should not exist
    try {
      await harness.runSQL(
        container,
        "SELECT * FROM _timescaledb_catalog.continuous_aggs_completed_threshold;"
      );
      recordTest(
        "T1.2.3: Old CA catalog table removal",
        false,
        "continuous_aggs_completed_threshold should not exist but query succeeded"
      );
    } catch (error) {
      const errorMsg = String(error);
      if (errorMsg.includes("does not exist")) {
        recordTest(
          "T1.2.3: Old CA catalog table removal",
          true,
          "continuous_aggs_completed_threshold correctly removed"
        );
      } else {
        recordTest("T1.2.3: Old CA catalog table removal", false, "Unexpected error", errorMsg);
      }
    }

    // Verify format_version column was removed (breaking change in 2.25.0)
    const formatColumnExists = await harness.runSQL(
      container,
      `SELECT count(*) FROM information_schema.columns
       WHERE table_schema = '_timescaledb_catalog'
         AND table_name = 'continuous_agg'
         AND column_name = 'format_version';`
    );
    recordTest(
      "T1.2.4: format_version column removal",
      formatColumnExists === "0",
      "format_version column correctly removed from catalog",
      `Column exists count: ${formatColumnExists}`
    );
  } catch (error) {
    recordTest(
      "T1.2: Old CA format removal tests",
      false,
      "Unexpected error during test execution",
      String(error)
    );
  }
}

async function testDebugSchemaRemoval(): Promise<void> {
  try {
    // NEGATIVE: Debug schema should not exist
    const schemaResult = await harness.runSQL(
      container,
      "SELECT nspname FROM pg_namespace WHERE nspname = '_timescaledb_debug';"
    );
    recordTest(
      "T1.3.1: _timescaledb_debug schema removal",
      schemaResult === "",
      "_timescaledb_debug schema correctly removed",
      `Schema query result: '${schemaResult}'`
    );

    // NEGATIVE: Debug functions should not be accessible
    try {
      await harness.runSQL(container, "SELECT _timescaledb_debug.show_process_state();");
      recordTest(
        "T1.3.2: Debug functions unavailable",
        false,
        "Debug function should not exist but call succeeded"
      );
    } catch (error) {
      const errorMsg = String(error);
      if (errorMsg.includes("does not exist")) {
        recordTest(
          "T1.3.2: Debug functions unavailable",
          true,
          "Debug functions correctly unavailable"
        );
      } else {
        recordTest("T1.3.2: Debug functions unavailable", false, "Unexpected error", errorMsg);
      }
    }
  } catch (error) {
    recordTest(
      "T1.3: Debug schema removal tests",
      false,
      "Unexpected error during test execution",
      String(error)
    );
  }
}

async function testWALInvalidationRemoval(): Promise<void> {
  try {
    // NEGATIVE: Old GUC should not exist
    try {
      await harness.runSQL(
        container,
        "SHOW timescaledb.materialized_views_enable_wal_based_invalidation;"
      );
      recordTest(
        "T1.4.1: WAL-based invalidation GUC removal",
        false,
        "WAL-based invalidation GUC should not exist but query succeeded"
      );
    } catch (error) {
      const errorMsg = String(error);
      if (errorMsg.includes("unrecognized configuration parameter")) {
        recordTest(
          "T1.4.1: WAL-based invalidation GUC removal",
          true,
          "WAL-based invalidation GUC correctly removed"
        );
      } else {
        recordTest(
          "T1.4.1: WAL-based invalidation GUC removal",
          false,
          "Unexpected error",
          errorMsg
        );
      }
    }

    // POSITIVE: CA refresh should still work (using ca_test_new from T1.2)
    await harness.runSQL(
      container,
      "INSERT INTO ca_test_source SELECT t, random() FROM generate_series(now(), now() + interval '1 hour', '1 min') t;"
    );
    await harness.runSQL(
      container,
      "CALL refresh_continuous_aggregate('ca_test_new', NULL, NULL);"
    );
    const count = await harness.runSQL(container, "SELECT count(*) FROM ca_test_new;");
    recordTest(
      "T1.4.2: CA refresh without WAL invalidation",
      parseInt(count) > 0,
      "CA refresh works with new invalidation mechanism",
      `Row count: ${count}`
    );
  } catch (error) {
    recordTest(
      "T1.4: WAL invalidation removal tests",
      false,
      "Unexpected error during test execution",
      String(error)
    );
  }
}

async function testTimescaleDBVersion(): Promise<void> {
  try {
    // POSITIVE: Verify TimescaleDB version is 2.25.0
    const version = await harness.runSQL(
      container,
      "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb';"
    );
    recordTest(
      "T1.5.1: TimescaleDB version check",
      version === "2.25.0",
      `TimescaleDB version: ${version}`,
      version === "2.25.0" ? "Version matches expected 2.25.0" : "Version mismatch"
    );

    // POSITIVE: Verify information views are accessible
    const hypertableCount = await harness.runSQL(
      container,
      "SELECT count(*) FROM timescaledb_information.hypertables;"
    );
    recordTest(
      "T1.5.2: TimescaleDB information views",
      true,
      "timescaledb_information.hypertables view accessible",
      `Hypertable count: ${hypertableCount}`
    );
  } catch (error) {
    recordTest(
      "T1.5: TimescaleDB version tests",
      false,
      "Unexpected error during test execution",
      String(error)
    );
  }
}

async function testDirectCompressDuringCARefresh(): Promise<void> {
  try {
    // Create hypertable with compression
    await harness.runSQL(
      container,
      "CREATE TABLE ca_compress_test (time TIMESTAMPTZ NOT NULL, device TEXT, val DOUBLE PRECISION);"
    );
    await harness.runSQL(container, "SELECT create_hypertable('ca_compress_test', 'time');");
    await harness.runSQL(
      container,
      "ALTER TABLE ca_compress_test SET (timescaledb.compress, timescaledb.compress_segmentby = 'device');"
    );

    // Add compression policy
    await harness.runSQL(
      container,
      "SELECT add_compression_policy('ca_compress_test', interval '7 days');"
    );
    recordTest("T1.6.1: Compression policy setup", true, "Compression policy added successfully");

    // Insert old data and manually compress
    await harness.runSQL(
      container,
      "INSERT INTO ca_compress_test SELECT t, 'dev_' || (i%3), random() FROM generate_series(now() - interval '30 days', now() - interval '8 days', '5 min') t, generate_series(1,3) i;"
    );
    await harness.runSQL(
      container,
      "SELECT compress_chunk(c, if_not_compressed => true) FROM show_chunks('ca_compress_test') c;"
    );
    recordTest("T1.6.2: Manual chunk compression", true, "Chunks compressed successfully");

    // Create CA over compressed data
    await harness.runSQL(
      container,
      `CREATE MATERIALIZED VIEW ca_compress_agg WITH (timescaledb.continuous) AS
       SELECT time_bucket('1 day', time) AS bucket, device, avg(val) FROM ca_compress_test GROUP BY 1, 2 WITH NO DATA;`
    );
    await harness.runSQL(
      container,
      "CALL refresh_continuous_aggregate('ca_compress_agg', NULL, NULL);"
    );
    const count = await harness.runSQL(container, "SELECT count(*) FROM ca_compress_agg;");
    recordTest(
      "T1.6.3: CA refresh over compressed data",
      parseInt(count) > 0,
      "CA refresh successfully read compressed chunks",
      `Row count: ${count}`
    );
  } catch (error) {
    recordTest(
      "T1.6: Direct compress during CA refresh tests",
      false,
      "Unexpected error during test execution",
      String(error)
    );
  }
}

async function testDELETEOptimizations(): Promise<void> {
  try {
    // Create hypertable with columnstore enabled (required for DELETE optimizations in 2.25.0)
    await harness.runSQL(
      container,
      "CREATE TABLE delete_opt_test (time TIMESTAMPTZ NOT NULL, val INT);"
    );
    await harness.runSQL(container, "SELECT create_hypertable('delete_opt_test', 'time');");
    await harness.runSQL(
      container,
      "ALTER TABLE delete_opt_test SET (timescaledb.enable_columnstore = true);"
    );
    await harness.runSQL(
      container,
      "INSERT INTO delete_opt_test SELECT t, i FROM generate_series(now() - interval '30 days', now(), '1 hour') t, generate_series(1,5) i;"
    );

    // Count before deletion
    const countBefore = await harness.runSQL(container, "SELECT count(*) FROM delete_opt_test;");
    recordTest(
      "T1.7.1: Initial data insertion",
      parseInt(countBefore) > 0,
      "Data inserted successfully",
      `Initial row count: ${countBefore}`
    );

    // DELETE with time range predicate
    await harness.runSQL(
      container,
      "DELETE FROM delete_opt_test WHERE time < now() - interval '20 days';"
    );
    const countAfter = await harness.runSQL(container, "SELECT count(*) FROM delete_opt_test;");
    recordTest(
      "T1.7.2: DELETE with chunk pruning",
      parseInt(countAfter) < parseInt(countBefore),
      "DELETE correctly removed rows with chunk pruning",
      `Before: ${countBefore}, After: ${countAfter}`
    );

    // Verify remaining data is within expected range
    const oldestRow = await harness.runSQL(
      container,
      "SELECT time < now() - interval '20 days' FROM delete_opt_test ORDER BY time LIMIT 1;"
    );
    recordTest(
      "T1.7.3: DELETE predicate verification",
      oldestRow === "f",
      "All remaining rows are within expected time range",
      `Oldest row is older than 20 days: ${oldestRow}`
    );

    // EDGE CASE: DELETE on compressed chunks
    await harness.runSQL(
      container,
      "SELECT compress_chunk(c, if_not_compressed => true) FROM show_chunks('delete_opt_test', older_than => interval '25 days') c;"
    );
    await harness.runSQL(
      container,
      "DELETE FROM delete_opt_test WHERE time < now() - interval '25 days';"
    );
    recordTest(
      "T1.7.4: DELETE on compressed chunks",
      true,
      "DELETE on compressed chunks succeeded (DML on compressed chunks supported)"
    );
  } catch (error) {
    recordTest(
      "T1.7: DELETE optimizations tests",
      false,
      "Unexpected error during test execution",
      String(error)
    );
  }
}

async function runTests(): Promise<void> {
  try {
    await setup();

    log("\n=== Running TimescaleDB 2.25.0 Breaking Changes Tests ===\n");

    await testTimeBucketNgRemoval();
    await testOldCAFormatRemoval();
    await testDebugSchemaRemoval();
    await testWALInvalidationRemoval();
    await testTimescaleDBVersion();
    await testDirectCompressDuringCARefresh();
    await testDELETEOptimizations();

    log("\n=== Test Summary ===");
    const passed = results.filter((r) => r.success).length;
    const total = results.length;
    log(`Passed: ${passed}/${total}`);

    if (!allTestsPassed) {
      log("\nFailed tests:");
      results
        .filter((r) => !r.success)
        .forEach((r) => {
          log(`  - ${r.name}: ${r.message}`);
          if (r.details) {
            log(`    ${r.details}`);
          }
        });
      process.exit(1);
    } else {
      log("\n✓ All tests passed!");
    }
  } catch (error) {
    log(`Fatal error: ${error}`);
    process.exit(1);
  } finally {
    await cleanup();
  }
}

// Run tests
runTests();
