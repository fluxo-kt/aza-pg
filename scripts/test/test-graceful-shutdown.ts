#!/usr/bin/env bun
/**
 * Graceful Shutdown Test
 *
 * Purpose: Test that PostgreSQL handles SIGTERM gracefully during active transactions
 *
 * Coverage:
 * - PostgreSQL responds to SIGTERM (smart shutdown mode)
 * - Active transactions are allowed to complete or properly rolled back
 * - Container exits cleanly with code 0
 * - Committed data survives shutdown and restart
 * - No partial transaction state (data integrity)
 * - Volume persistence after forced signal
 *
 * Technical details:
 * - SIGTERM triggers "smart shutdown" - waits for sessions to end
 * - Uses pg_sleep to create long-running transaction
 * - Signal must arrive while transaction is active
 * - Verifies both exit code AND data integrity
 *
 * Usage:
 *   bun scripts/test/test-graceful-shutdown.ts [image-tag] [--no-cleanup]
 */

import { $ } from "bun";
import {
  checkCommand,
  checkDockerDaemon,
  cleanupContainer,
  ensureImageAvailable,
  generateUniqueContainerName,
  waitForPostgresStable,
} from "../utils/docker";
import { error, info, section, success, testSummary, warning } from "../utils/logger";
import type { TestResult } from "../utils/logger";
import { TIMEOUTS } from "../config/test-timeouts";

/**
 * Test configuration
 */
interface TestConfig {
  imageTag: string;
  noCleanup: boolean;
  containerName: string;
  volumeName: string;
  testPassword: string;
}

/**
 * Parse command line arguments
 */
function parseArgs(): Pick<TestConfig, "imageTag" | "noCleanup"> {
  const imageTag = Bun.argv[2] || Bun.env.POSTGRES_IMAGE || "ghcr.io/fluxo-kt/aza-pg:pg18";
  const noCleanup = Bun.argv.includes("--no-cleanup");

  return { imageTag, noCleanup };
}

/**
 * Generate test password
 */
function generateTestPassword(): string {
  const timestamp = Date.now();
  const pid = process.pid;
  return Bun.env.TEST_POSTGRES_PASSWORD ?? `test_shutdown_${timestamp}_${pid}`;
}

/**
 * Execute SQL command and return result
 */
async function executeSQL(containerName: string, sql: string): Promise<string> {
  const result = await $`docker exec ${containerName} psql -U postgres -tAc ${sql}`;
  return result.text().trim();
}

/**
 * Execute SQL command in background (for long-running transactions)
 */
function executeSQLBackground(containerName: string, sql: string): Promise<any> {
  return $`docker exec ${containerName} psql -U postgres -c ${sql}`.nothrow();
}

/**
 * Get container exit code
 */
async function getContainerExitCode(containerName: string): Promise<number | null> {
  try {
    const result = await $`docker inspect --format='{{.State.ExitCode}}' ${containerName}`;
    const exitCodeStr = result.text().trim();
    return parseInt(exitCodeStr, 10);
  } catch {
    return null;
  }
}

/**
 * Test 1: Start Container and Create Test Data
 * Creates a container with named volume and populates it with initial data
 */
async function testCreateTestData(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 1: Start Container and Create Test Data");

    // Create named volume
    info("Creating named volume for graceful shutdown test...");
    await $`docker volume create ${config.volumeName}`;
    success(`Volume created: ${config.volumeName}`);

    // Start container with named volume
    info("Starting PostgreSQL container with named volume...");
    await $`docker run -d --name ${config.containerName} \
      -e POSTGRES_PASSWORD=${config.testPassword} \
      -e POSTGRES_MEMORY=1024 \
      -v ${config.volumeName}:/var/lib/postgresql \
      ${config.imageTag}`.quiet();

    info("Waiting for PostgreSQL to be stable...");
    const ready = await waitForPostgresStable({
      container: config.containerName,
      timeout: TIMEOUTS.startup,
      requiredSuccesses: 3,
    });

    if (!ready) {
      throw new Error("PostgreSQL failed to start");
    }

    // Create test database
    info("Creating test database...");
    await $`docker exec ${config.containerName} psql -U postgres -c "CREATE DATABASE shutdown_test;"`;

    // Create test table
    info("Creating test table with sample data...");
    await $`docker exec ${config.containerName} psql -U postgres -d shutdown_test -c "CREATE TABLE shutdown_test (id SERIAL PRIMARY KEY, data TEXT NOT NULL, status TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW());"`;

    // Insert initial committed data (these should survive shutdown)
    info("Inserting committed test data...");
    await $`docker exec ${config.containerName} psql -U postgres -d shutdown_test -c "INSERT INTO shutdown_test (data, status) VALUES ('committed-1', 'committed'), ('committed-2', 'committed'), ('committed-3', 'committed');"`;

    // Verify initial data
    const initialCount = await executeSQL(
      config.containerName,
      "SELECT COUNT(*) FROM shutdown_test.shutdown_test WHERE status = 'committed';"
    );

    if (initialCount !== "3") {
      throw new Error(`Expected 3 committed rows, got ${initialCount}`);
    }

    success("Test data created and verified");
    return {
      name: "Start Container and Create Test Data",
      passed: true,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      name: "Start Container and Create Test Data",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 2: SIGTERM During Active Transaction
 * Sends SIGTERM while a long-running transaction is active
 * Verifies graceful shutdown behavior
 */
async function testSIGTERMDuringTransaction(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 2: SIGTERM During Active Transaction");

    info("Starting long-running transaction in background...");
    // This transaction will:
    // 1. Insert a row marked as 'in-flight'
    // 2. Sleep for 30 seconds (simulating long operation)
    // 3. Update the row to 'completed' (if allowed to finish)
    const longTxn = executeSQLBackground(
      config.containerName,
      `
      BEGIN;
      INSERT INTO shutdown_test.shutdown_test (data, status) VALUES ('in-flight-1', 'in-flight');
      SELECT pg_sleep(30);
      UPDATE shutdown_test.shutdown_test SET status = 'completed' WHERE data = 'in-flight-1';
      COMMIT;
      `
    );

    // Wait a moment to ensure transaction has started
    info("Waiting for transaction to start...");
    await Bun.sleep(3000);

    // Verify transaction is active by checking for 'in-flight' row
    // Note: This might fail if transaction hasn't committed the INSERT yet, which is fine
    try {
      const activeCount = await executeSQL(
        config.containerName,
        "SELECT COUNT(*) FROM shutdown_test.shutdown_test WHERE status = 'in-flight';"
      );
      if (activeCount === "1") {
        success("Transaction is active (in-flight row detected)");
      } else {
        warning("Transaction may not have started yet (no in-flight row)");
      }
    } catch {
      warning("Could not verify transaction state (expected during shutdown)");
    }

    // Send SIGTERM to container
    info("Sending SIGTERM to container (graceful shutdown)...");
    await $`docker kill --signal=SIGTERM ${config.containerName}`;
    success("SIGTERM sent successfully");

    // Wait for container to stop (with timeout)
    info("Waiting for container to stop gracefully...");
    const maxWait = 60000; // 60 seconds
    const waitStart = Date.now();
    let containerStopped = false;

    while (Date.now() - waitStart < maxWait) {
      try {
        const result =
          await $`docker inspect --format='{{.State.Running}}' ${config.containerName}`;
        const isRunning = result.text().trim() === "true";

        if (!isRunning) {
          containerStopped = true;
          break;
        }
      } catch {
        // Container might be removed or inspect failed
        containerStopped = true;
        break;
      }

      await Bun.sleep(2000);
    }

    if (!containerStopped) {
      throw new Error("Container did not stop within timeout period");
    }

    const shutdownDuration = Date.now() - waitStart;
    success(`Container stopped gracefully in ${(shutdownDuration / 1000).toFixed(2)}s`);

    // Check exit code
    const exitCode = await getContainerExitCode(config.containerName);
    info(`Container exit code: ${exitCode}`);

    if (exitCode !== 0) {
      throw new Error(`Expected exit code 0 (graceful shutdown), got ${exitCode}`);
    }

    success("Container exited cleanly with code 0");

    // Wait for background transaction process to complete
    try {
      await longTxn;
    } catch {
      // Expected to fail since container was stopped
      info("Background transaction process terminated (expected)");
    }

    return {
      name: "SIGTERM During Active Transaction",
      passed: true,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      name: "SIGTERM During Active Transaction",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 3: Verify Data Integrity After Restart
 * Restarts container and verifies committed data survived, in-flight transaction was handled properly
 */
async function testDataIntegrityAfterRestart(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 3: Verify Data Integrity After Restart");

    info("Restarting container...");
    await $`docker start ${config.containerName}`;

    info("Waiting for PostgreSQL to be stable after restart...");
    const ready = await waitForPostgresStable({
      container: config.containerName,
      timeout: TIMEOUTS.startup,
      requiredSuccesses: 3,
    });

    if (!ready) {
      throw new Error("PostgreSQL failed to restart");
    }

    // Verify committed data still exists
    info("Verifying committed data survived shutdown...");
    const committedCount = await executeSQL(
      config.containerName,
      "SELECT COUNT(*) FROM shutdown_test.shutdown_test WHERE status = 'committed';"
    );

    if (committedCount !== "3") {
      throw new Error(`Expected 3 committed rows after restart, got ${committedCount}`);
    }
    success("All committed data survived shutdown");

    // Check in-flight transaction state
    info("Checking in-flight transaction state...");
    const inFlightCount = await executeSQL(
      config.containerName,
      "SELECT COUNT(*) FROM shutdown_test.shutdown_test WHERE status = 'in-flight';"
    );
    const completedCount = await executeSQL(
      config.containerName,
      "SELECT COUNT(*) FROM shutdown_test.shutdown_test WHERE status = 'completed';"
    );

    info(`In-flight rows: ${inFlightCount}, Completed rows: ${completedCount}`);

    // Transaction should be either:
    // 1. Rolled back entirely (0 in-flight, 0 completed) - most likely
    // 2. Completed (0 in-flight, 1 completed) - if shutdown waited
    // But NOT partially committed (1 in-flight, 0 completed)
    const totalInFlightRelated = parseInt(inFlightCount) + parseInt(completedCount);

    if (inFlightCount === "0" && completedCount === "0") {
      success("In-flight transaction was properly rolled back (expected)");
    } else if (inFlightCount === "0" && completedCount === "1") {
      success("In-flight transaction completed before shutdown (graceful)");
    } else {
      throw new Error(
        `Unexpected transaction state - in-flight: ${inFlightCount}, completed: ${completedCount}`
      );
    }

    // Verify no partial state exists
    if (parseInt(inFlightCount) > 0) {
      throw new Error("Partial transaction state detected (should be rolled back)");
    }

    // Verify total row count makes sense
    const totalRows = await executeSQL(
      config.containerName,
      "SELECT COUNT(*) FROM shutdown_test.shutdown_test;"
    );
    const expectedTotal = 3 + totalInFlightRelated; // 3 committed + (0 or 1 completed)

    if (parseInt(totalRows) !== expectedTotal) {
      throw new Error(`Expected ${expectedTotal} total rows, got ${totalRows}`);
    }

    success("Data integrity verified - no partial transaction state");

    // Verify specific committed rows
    const row1 = await executeSQL(
      config.containerName,
      "SELECT data FROM shutdown_test.shutdown_test WHERE data = 'committed-1';"
    );
    const row2 = await executeSQL(
      config.containerName,
      "SELECT data FROM shutdown_test.shutdown_test WHERE data = 'committed-2';"
    );
    const row3 = await executeSQL(
      config.containerName,
      "SELECT data FROM shutdown_test.shutdown_test WHERE data = 'committed-3';"
    );

    if (row1 !== "committed-1" || row2 !== "committed-2" || row3 !== "committed-3") {
      throw new Error("Committed data content verification failed");
    }

    success("Committed data content verified");

    return {
      name: "Data Integrity After Restart",
      passed: true,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      name: "Data Integrity After Restart",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 4: Verify Database and Table Still Accessible
 * Ensures shutdown didn't corrupt database or table structure
 */
async function testDatabaseAccessibility(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 4: Verify Database and Table Still Accessible");

    info("Verifying database accessibility...");

    // Verify database exists
    const dbExists = await executeSQL(
      config.containerName,
      "SELECT COUNT(*) FROM pg_database WHERE datname = 'shutdown_test';"
    );

    if (dbExists !== "1") {
      throw new Error("Database lost after shutdown");
    }
    success("Database accessible");

    // Verify table structure
    const tableExists = await executeSQL(
      config.containerName,
      "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'shutdown_test';"
    );

    if (tableExists !== "1") {
      throw new Error("Table lost after shutdown");
    }
    success("Table structure intact");

    // Verify we can still write data
    info("Testing write operations after shutdown...");
    await $`docker exec ${config.containerName} psql -U postgres -d shutdown_test -c "INSERT INTO shutdown_test (data, status) VALUES ('post-shutdown', 'committed');"`;

    const newCount = await executeSQL(
      config.containerName,
      "SELECT COUNT(*) FROM shutdown_test.shutdown_test WHERE data = 'post-shutdown';"
    );

    if (newCount !== "1") {
      throw new Error("Failed to write data after shutdown");
    }
    success("Write operations work after shutdown");

    // Verify we can read the new data
    const newData = await executeSQL(
      config.containerName,
      "SELECT data FROM shutdown_test.shutdown_test WHERE data = 'post-shutdown';"
    );

    if (newData !== "post-shutdown") {
      throw new Error("Failed to read newly written data");
    }
    success("Read operations work after shutdown");

    return {
      name: "Database Accessibility After Shutdown",
      passed: true,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      name: "Database Accessibility After Shutdown",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Cleanup test environment
 */
async function cleanup(config: TestConfig): Promise<void> {
  if (config.noCleanup) {
    warning("Skipping cleanup (--no-cleanup flag set)");
    info(`Resources preserved for inspection:`);
    info(`  Container: ${config.containerName}`);
    info(`  Volume: ${config.volumeName}`);
    return;
  }

  info("Cleaning up test environment...");

  // Cleanup container
  await cleanupContainer(config.containerName);

  // Cleanup volume
  try {
    await $`docker volume rm ${config.volumeName}`.nothrow().quiet();
  } catch {
    // Ignore errors
  }

  success("Cleanup completed");
}

/**
 * Main test execution
 */
async function main(): Promise<void> {
  // Check prerequisites
  try {
    await checkCommand("docker");
    await checkDockerDaemon();
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const args = parseArgs();
  const timestamp = Date.now();
  const pid = process.pid;

  const config: TestConfig = {
    ...args,
    containerName: generateUniqueContainerName("shutdown-test"),
    volumeName: `shutdown-test-vol-${timestamp}-${pid}`,
    testPassword: generateTestPassword(),
  };

  console.log("========================================");
  console.log("Graceful Shutdown Test");
  console.log("========================================");
  console.log(`Image: ${config.imageTag}`);
  console.log(`Container: ${config.containerName}`);
  console.log(`Volume: ${config.volumeName}`);
  console.log("");

  // Setup cleanup handlers
  process.on("SIGINT", async () => {
    console.log("\n\nCaught interrupt signal, cleaning up...");
    await cleanup(config);
    process.exit(130);
  });

  process.on("SIGTERM", async () => {
    console.log("\n\nCaught termination signal, cleaning up...");
    await cleanup(config);
    process.exit(143);
  });

  // Ensure image is available
  try {
    await ensureImageAvailable(config.imageTag);
  } catch (err) {
    error(
      `Failed to ensure image availability: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }

  const results: TestResult[] = [];

  try {
    // Run tests in sequence
    results.push(await testCreateTestData(config));
    results.push(await testSIGTERMDuringTransaction(config));
    results.push(await testDataIntegrityAfterRestart(config));
    results.push(await testDatabaseAccessibility(config));

    // Print summary
    console.log("");
    testSummary(results);

    // Check if all tests passed
    const failed = results.filter((r) => !r.passed).length;
    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    error("Test execution failed");
    console.error(err);
    process.exit(1);
  } finally {
    await cleanup(config);
  }
}

// Run main function
main();
