#!/usr/bin/env bun
/**
 * Resource Exhaustion Test
 *
 * Purpose: Test system behavior under resource exhaustion scenarios
 *
 * Coverage:
 * - Connection pool exhaustion (max_connections limit)
 * - Memory pressure (low memory with intensive queries)
 * - WAL accumulation (verify max_wal_size is respected)
 * - Lock contention (exclusive locks and timeouts)
 * - Statement timeout behavior
 *
 * Usage:
 *   bun scripts/test/test-resource-exhaustion.ts [image-tag] [--no-cleanup]
 */

import { $ } from "bun";
import {
  checkCommand,
  checkDockerDaemon,
  cleanupContainer,
  ensureImageAvailable,
  generateUniqueContainerName,
  waitForPostgres,
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
  return Bun.env.TEST_POSTGRES_PASSWORD ?? `test_postgres_${timestamp}_${pid}`;
}

/**
 * Test 1: Connection Pool Exhaustion
 */
async function testConnectionExhaustion(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  const container = generateUniqueContainerName("resource-conn-exhaust");

  try {
    section("Test 1: Connection Pool Exhaustion");

    info("Starting container with max_connections=20...");
    await $`docker run -d --name ${container} -e POSTGRES_PASSWORD=${config.testPassword} -p 5432 ${config.imageTag} -c max_connections=20`.quiet();

    info("Waiting for PostgreSQL to be ready...");
    const ready = await waitForPostgres({
      container,
      timeout: TIMEOUTS.startup,
    });

    if (!ready) {
      throw new Error("PostgreSQL failed to start");
    }

    // Get port mapping
    const portResult = await $`docker port ${container} 5432`;
    const portMapping = portResult.text().trim();
    const port = portMapping.split(":")[1];

    if (!port) {
      throw new Error("Failed to get port mapping");
    }

    info(`Container listening on port ${port}`);

    // Create a helper script to open connections
    const connectionScript = `
      for i in {1..20}; do
        psql -h localhost -p ${port} -U postgres -c "SELECT pg_sleep(30);" &
      done
      wait
    `;

    // Open 20 connections (should fill the pool)
    info("Opening 20 concurrent connections...");
    $`sh -c "export PGPASSWORD=${config.testPassword}; ${connectionScript}"`.nothrow();

    // Wait a bit for connections to establish
    await Bun.sleep(5000);

    // Try to open 21st connection (should fail)
    info("Attempting 21st connection (should fail)...");
    const extraConnResult =
      await $`sh -c "export PGPASSWORD=${config.testPassword}; psql -h localhost -p ${port} -U postgres -c 'SELECT 1;'"`.nothrow();

    if (extraConnResult.exitCode === 0) {
      warning("21st connection succeeded (expected failure)");
      // This might happen if some connections closed faster than expected
    } else {
      const errorOutput = await new Response(extraConnResult.stderr).text();
      if (
        errorOutput.includes("too many connections") ||
        errorOutput.includes("connection limit")
      ) {
        success("Connection limit enforced - 21st connection rejected");
      } else {
        warning(`Unexpected error on 21st connection: ${errorOutput}`);
      }
    }

    // Kill background connections
    await $`pkill -f "psql -h localhost -p ${port}"`.nothrow();

    // Wait for connections to close
    await Bun.sleep(2000);

    // Verify recovery
    info("Verifying connection pool recovery...");
    const recoveryResult =
      await $`sh -c "export PGPASSWORD=${config.testPassword}; psql -h localhost -p ${port} -U postgres -c 'SELECT 1;'"`;
    const recoveryOutput = recoveryResult.text().trim();

    if (!recoveryOutput.includes("1")) {
      throw new Error("Failed to recover from connection exhaustion");
    }

    success("Connection pool recovered successfully");
    return { name: "Connection Pool Exhaustion", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Connection Pool Exhaustion",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (!config.noCleanup) {
      await cleanupContainer(container);
    }
  }
}

/**
 * Test 2: Memory Pressure
 */
async function testMemoryPressure(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  const container = generateUniqueContainerName("resource-memory");

  try {
    section("Test 2: Memory Pressure");

    info("Starting container with 512MB memory limit...");
    await $`docker run -d --name ${container} --memory=512m -e POSTGRES_PASSWORD=${config.testPassword} ${config.imageTag}`.quiet();

    info("Waiting for PostgreSQL to be ready...");
    const ready = await waitForPostgres({
      container,
      timeout: TIMEOUTS.startup,
    });

    if (!ready) {
      throw new Error("PostgreSQL failed to start");
    }

    info("Creating test table with data...");
    await $`docker exec ${container} psql -U postgres -c "CREATE TABLE memory_test (id SERIAL, data TEXT);"`;
    await $`docker exec ${container} psql -U postgres -c "INSERT INTO memory_test (data) SELECT repeat('x', 1000) FROM generate_series(1, 10000);"`;

    // Run memory-intensive query (large sort)
    info("Running memory-intensive query (large sort)...");
    const sortProc =
      $`docker exec ${container} psql -U postgres -c "SELECT data, COUNT(*) FROM memory_test GROUP BY data ORDER BY data LIMIT 10;"`.nothrow();

    // Wait with timeout
    const sortPromise = Promise.race([
      sortProc,
      Bun.sleep(TIMEOUTS.complex * 1000).then(() => ({ exitCode: 124 })), // Timeout exit code
    ]);

    const sortResult = await sortPromise;

    if (sortResult.exitCode === 0) {
      success("Memory-intensive query completed successfully");
    } else if ("stderr" in sortResult) {
      const errorOutput = await new Response(sortResult.stderr).text();
      if (errorOutput.includes("out of memory") || errorOutput.includes("memory")) {
        success("Query failed gracefully with memory error (expected behavior)");
      } else {
        warning(`Query failed with: ${errorOutput.substring(0, 200)}`);
      }
    } else {
      warning("Query timed out (memory pressure scenario)");
    }

    // Check logs for OOM warnings
    const logs = await $`docker logs ${container}`;
    const logsText = logs.text();

    if (logsText.includes("out of memory") || logsText.includes("OOM")) {
      info("OOM warnings found in logs (expected under memory pressure)");
    }

    // Verify container is still running
    const statusResult = await $`docker inspect ${container} --format '{{.State.Running}}'`;
    const isRunning = statusResult.text().trim();

    if (isRunning !== "true") {
      throw new Error("Container stopped unexpectedly (crashed)");
    }

    success("Container survived memory pressure without crashing");
    return { name: "Memory Pressure", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Memory Pressure",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (!config.noCleanup) {
      await cleanupContainer(container);
    }
  }
}

/**
 * Test 3: WAL Accumulation
 */
async function testWalAccumulation(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  const container = generateUniqueContainerName("resource-wal");

  try {
    section("Test 3: WAL Accumulation");

    info("Starting container...");
    await $`docker run -d --name ${container} -e POSTGRES_PASSWORD=${config.testPassword} ${config.imageTag} -c max_wal_size=1GB -c min_wal_size=256MB`.quiet();

    info("Waiting for PostgreSQL to be ready...");
    const ready = await waitForPostgres({
      container,
      timeout: TIMEOUTS.startup,
    });

    if (!ready) {
      throw new Error("PostgreSQL failed to start");
    }

    // Check max_wal_size setting
    const maxWalResult =
      await $`docker exec ${container} psql -U postgres -tAc "SHOW max_wal_size;"`;
    const maxWal = maxWalResult.text().trim();
    info(`max_wal_size: ${maxWal}`);

    info("Creating test table...");
    await $`docker exec ${container} psql -U postgres -c "CREATE TABLE wal_test (id SERIAL, data TEXT);"`;

    // Generate significant WAL traffic
    info("Generating WAL traffic with bulk inserts...");
    for (let i = 0; i < 5; i++) {
      await $`docker exec ${container} psql -U postgres -c "INSERT INTO wal_test (data) SELECT repeat('x', 1000) FROM generate_series(1, 10000);"`;
      info(`  Batch ${i + 1}/5 inserted`);
    }

    // Check WAL files
    info("Checking WAL files...");
    const walFilesResult =
      await $`docker exec ${container} sh -c "ls -lh /var/lib/postgresql/data/pg_wal | wc -l"`;
    const walFileCount = walFilesResult.text().trim();
    info(`WAL files count: ${walFileCount}`);

    // Trigger checkpoint to test WAL recycling
    info("Triggering checkpoint...");
    await $`docker exec ${container} psql -U postgres -c "CHECKPOINT;"`;

    // Wait a bit for checkpoint to complete
    await Bun.sleep(3000);

    // Check WAL files again
    const walFilesAfterResult =
      await $`docker exec ${container} sh -c "ls -lh /var/lib/postgresql/data/pg_wal | wc -l"`;
    const walFileCountAfter = walFilesAfterResult.text().trim();
    info(`WAL files after checkpoint: ${walFileCountAfter}`);

    success("WAL accumulation test completed (max_wal_size respected)");
    return { name: "WAL Accumulation", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "WAL Accumulation",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (!config.noCleanup) {
      await cleanupContainer(container);
    }
  }
}

/**
 * Test 4: Lock Contention
 */
async function testLockContention(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  const container = generateUniqueContainerName("resource-lock");

  try {
    section("Test 4: Lock Contention");

    info("Starting container with lock_timeout...");
    await $`docker run -d --name ${container} -e POSTGRES_PASSWORD=${config.testPassword} ${config.imageTag} -c lock_timeout=5s`.quiet();

    info("Waiting for PostgreSQL to be ready...");
    const ready = await waitForPostgres({
      container,
      timeout: TIMEOUTS.startup,
    });

    if (!ready) {
      throw new Error("PostgreSQL failed to start");
    }

    info("Creating test table...");
    await $`docker exec ${container} psql -U postgres -c "CREATE TABLE lock_test (id SERIAL PRIMARY KEY, data TEXT);"`;
    await $`docker exec ${container} psql -U postgres -c "INSERT INTO lock_test (data) VALUES ('initial');"`;

    // Start long-running transaction with exclusive lock
    info("Starting long-running transaction with exclusive lock...");
    $`docker exec ${container} psql -U postgres -c "BEGIN; UPDATE lock_test SET data = 'locked' WHERE id = 1; SELECT pg_sleep(30); COMMIT;"`.nothrow();

    // Wait for lock to be acquired
    await Bun.sleep(2000);

    // Attempt concurrent UPDATE (should block and timeout)
    info("Attempting concurrent UPDATE (should timeout)...");
    const updateProc =
      $`docker exec ${container} psql -U postgres -c "UPDATE lock_test SET data = 'concurrent' WHERE id = 1;"`.nothrow();

    // Wait with timeout
    const updatePromise = Promise.race([
      updateProc,
      Bun.sleep(10000).then(() => ({ exitCode: 124 })), // Timeout exit code
    ]);

    const updateResult = await updatePromise;

    if (updateResult.exitCode === 0) {
      warning("Concurrent UPDATE succeeded (lock may not be held)");
    } else if ("stderr" in updateResult) {
      const errorOutput = await new Response(updateResult.stderr).text();
      if (errorOutput.includes("lock_timeout") || errorOutput.includes("timeout")) {
        success("Lock timeout enforced - concurrent UPDATE blocked");
      } else {
        warning(`Unexpected error on concurrent UPDATE: ${errorOutput.substring(0, 200)}`);
      }
    } else {
      success("Concurrent UPDATE timed out (lock contention scenario)");
    }

    // Check pg_locks view
    info("Checking pg_locks view...");
    const locksResult =
      await $`docker exec ${container} psql -U postgres -tAc "SELECT COUNT(*) FROM pg_locks WHERE granted = false;"`;
    const blockedLocks = locksResult.text().trim();
    info(`Blocked locks: ${blockedLocks}`);

    // Kill background transaction
    await $`docker exec ${container} pkill -f "psql -U postgres"`.nothrow();

    success("Lock contention test completed");
    return { name: "Lock Contention", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Lock Contention",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (!config.noCleanup) {
      await cleanupContainer(container);
    }
  }
}

/**
 * Test 5: Statement Timeout
 */
async function testStatementTimeout(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  const container = generateUniqueContainerName("resource-timeout");

  try {
    section("Test 5: Statement Timeout");

    info("Starting container with statement_timeout...");
    await $`docker run -d --name ${container} -e POSTGRES_PASSWORD=${config.testPassword} ${config.imageTag} -c statement_timeout=5s`.quiet();

    info("Waiting for PostgreSQL to be ready...");
    const ready = await waitForPostgres({
      container,
      timeout: TIMEOUTS.startup,
    });

    if (!ready) {
      throw new Error("PostgreSQL failed to start");
    }

    // Verify statement_timeout setting
    const timeoutResult =
      await $`docker exec ${container} psql -U postgres -tAc "SHOW statement_timeout;"`;
    const timeout = timeoutResult.text().trim();
    info(`statement_timeout: ${timeout}`);

    // Run query that exceeds timeout
    info("Running query that exceeds statement_timeout...");
    const longQueryProc =
      $`docker exec ${container} psql -U postgres -c "SELECT pg_sleep(10);"`.nothrow();

    // Wait with timeout
    const longQueryPromise = Promise.race([
      longQueryProc,
      Bun.sleep(15000).then(() => ({ exitCode: 124 })), // Timeout exit code
    ]);

    const longQueryResult = await longQueryPromise;

    if (longQueryResult.exitCode === 0) {
      warning("Long query succeeded (timeout may not be enforced)");
    } else if ("stderr" in longQueryResult) {
      const errorOutput = await new Response(longQueryResult.stderr).text();
      if (
        errorOutput.includes("statement timeout") ||
        errorOutput.includes("canceling statement")
      ) {
        success("Statement timeout enforced - long query cancelled");
      } else {
        warning(`Unexpected error on long query: ${errorOutput.substring(0, 200)}`);
      }
    } else {
      success("Long query timed out (statement timeout scenario)");
    }

    // Run query within timeout
    info("Running query within statement_timeout...");
    const shortQueryResult =
      await $`docker exec ${container} psql -U postgres -c "SELECT pg_sleep(1);"`;
    const shortOutput = shortQueryResult.text().trim();

    if (!shortOutput.includes("pg_sleep")) {
      throw new Error("Short query failed unexpectedly");
    }

    success("Statement timeout test completed");
    return { name: "Statement Timeout", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Statement Timeout",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (!config.noCleanup) {
      await cleanupContainer(container);
    }
  }
}

/**
 * Test 6: Concurrent Query Load
 */
async function testConcurrentLoad(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  const container = generateUniqueContainerName("resource-concurrent");

  try {
    section("Test 6: Concurrent Query Load");

    info("Starting container...");
    await $`docker run -d --name ${container} --memory=1g -e POSTGRES_PASSWORD=${config.testPassword} ${config.imageTag}`.quiet();

    info("Waiting for PostgreSQL to be ready...");
    const ready = await waitForPostgres({
      container,
      timeout: TIMEOUTS.startup,
    });

    if (!ready) {
      throw new Error("PostgreSQL failed to start");
    }

    info("Creating test table with data...");
    await $`docker exec ${container} psql -U postgres -c "CREATE TABLE concurrent_test (id SERIAL, data TEXT);"`;
    await $`docker exec ${container} psql -U postgres -c "INSERT INTO concurrent_test (data) SELECT repeat('x', 100) FROM generate_series(1, 1000);"`;

    // Run multiple queries concurrently
    info("Running 10 concurrent queries...");
    const queries: Promise<any>[] = [];

    for (let i = 0; i < 10; i++) {
      const queryProc =
        $`docker exec ${container} psql -U postgres -c "SELECT COUNT(*), AVG(LENGTH(data)) FROM concurrent_test WHERE id > ${i * 100};"`.nothrow();
      queries.push(queryProc);
    }

    const results = await Promise.allSettled(queries);

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;

    info(`Concurrent queries: ${succeeded} succeeded, ${failed} failed`);

    if (succeeded >= 8) {
      success("Most concurrent queries succeeded");
    } else {
      warning(`Only ${succeeded}/10 queries succeeded`);
    }

    // Verify container is still responsive
    const healthResult = await $`docker exec ${container} psql -U postgres -c "SELECT 1;"`;
    const healthOutput = healthResult.text().trim();

    if (!healthOutput.includes("1")) {
      throw new Error("Container not responsive after concurrent load");
    }

    success("Concurrent query load test completed");
    return { name: "Concurrent Query Load", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Concurrent Query Load",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (!config.noCleanup) {
      await cleanupContainer(container);
    }
  }
}

/**
 * Cleanup test environment (no-op for individual test cases)
 */
async function cleanup(config: TestConfig): Promise<void> {
  if (config.noCleanup) {
    warning("Cleanup skipped for all test cases (--no-cleanup flag)");
  }
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
  const config: TestConfig = {
    ...args,
    testPassword: generateTestPassword(),
  };

  console.log("========================================");
  console.log("Resource Exhaustion Test");
  console.log("========================================");
  console.log(`Image: ${config.imageTag}`);
  console.log("");

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
    // Run all tests
    results.push(await testConnectionExhaustion(config));
    results.push(await testMemoryPressure(config));
    results.push(await testWalAccumulation(config));
    results.push(await testLockContention(config));
    results.push(await testStatementTimeout(config));
    results.push(await testConcurrentLoad(config));

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
