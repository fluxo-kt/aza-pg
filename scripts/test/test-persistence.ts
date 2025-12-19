#!/usr/bin/env bun
/**
 * Container Restart Persistence Test
 *
 * Purpose: Test that data survives container restarts and stack recreation
 *
 * Coverage:
 * - Data persists through docker restart (container restart without volume deletion)
 * - Data persists through docker compose down && up (full stack recreation)
 * - Data integrity verification (tables, indexes, data consistency)
 * - Volume management and cleanup
 *
 * Usage:
 *   bun scripts/test/test-persistence.ts [image-tag] [--no-cleanup]
 */

import { $ } from "bun";
import {
  checkCommand,
  checkDockerDaemon,
  cleanupContainer,
  ensureImageAvailable,
  generateUniqueContainerName,
  generateUniqueProjectName,
  waitForPostgresStable,
} from "../utils/docker";
import { error, info, section, success, testSummary, warning } from "../utils/logger";
import type { TestResult } from "../utils/logger";
import { TIMEOUTS } from "../config/test-timeouts";
import { join } from "node:path";

/**
 * Test configuration
 */
interface TestConfig {
  imageTag: string;
  noCleanup: boolean;
  containerName: string;
  volumeName: string;
  testPassword: string;
  useCompose: boolean;
  projectName: string;
  stackPath: string;
  envTestPath: string;
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
 * Execute SQL command and return result
 */
async function executeSQL(
  containerOrProject: string,
  sql: string,
  isCompose: boolean
): Promise<string> {
  if (isCompose) {
    const result =
      await $`docker exec ${containerOrProject}-postgres-single psql -U postgres -tAc ${sql}`;
    return result.text().trim();
  } else {
    const result = await $`docker exec ${containerOrProject} psql -U postgres -tAc ${sql}`;
    return result.text().trim();
  }
}

/**
 * Test 1: Start Container and Create Test Data
 * Creates a container with named volume and populates it with test data
 */
async function testCreateTestData(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 1: Start Container and Create Test Data");

    // Create named volume
    info("Creating named volume for persistence test...");
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
    await $`docker exec ${config.containerName} psql -U postgres -c "CREATE DATABASE persistence_test;"`;

    // Create test table with various data types
    info("Creating test table with sample data...");
    await $`docker exec ${config.containerName} psql -U postgres -d persistence_test -c "CREATE TABLE persistence_test (id SERIAL PRIMARY KEY, data TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW(), metadata JSONB);"`;

    // Create index
    await $`docker exec ${config.containerName} psql -U postgres -d persistence_test -c "CREATE INDEX idx_persistence_created_at ON persistence_test(created_at);"`;

    // Insert test rows
    info("Inserting test data...");
    await $`docker exec ${config.containerName} psql -U postgres -d persistence_test -c "INSERT INTO persistence_test (data, metadata) VALUES ('row1', '{\"version\": 1}'), ('row2', '{\"version\": 1}'), ('row3', '{\"version\": 1}');"`;

    // Verify initial data
    const initialCount = await executeSQL(
      config.containerName,
      "SELECT COUNT(*) FROM persistence_test.persistence_test;",
      false
    );

    if (initialCount !== "3") {
      throw new Error(`Expected 3 rows, got ${initialCount}`);
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
 * Test 2: Docker Restart - Container Restart Without Volume Deletion
 * Tests that data survives a simple container restart
 */
async function testDockerRestart(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 2: Docker Restart (container restart without volume deletion)");

    info("Restarting container...");
    await $`docker restart ${config.containerName}`;

    info("Waiting for PostgreSQL to be stable after restart...");
    const ready = await waitForPostgresStable({
      container: config.containerName,
      timeout: TIMEOUTS.startup,
      requiredSuccesses: 3,
    });

    if (!ready) {
      throw new Error("PostgreSQL failed to restart");
    }

    // Verify data still exists
    info("Verifying data after restart...");
    const count = await executeSQL(
      config.containerName,
      "SELECT COUNT(*) FROM persistence_test.persistence_test;",
      false
    );

    if (count !== "3") {
      throw new Error(`Expected 3 rows after restart, got ${count}`);
    }

    // Verify data content
    const firstRow = await executeSQL(
      config.containerName,
      "SELECT data FROM persistence_test.persistence_test WHERE id = 1;",
      false
    );

    if (firstRow !== "row1") {
      throw new Error(`Expected 'row1', got '${firstRow}'`);
    }

    // Verify index still exists
    const indexExists = await executeSQL(
      config.containerName,
      "SELECT COUNT(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_persistence_created_at';",
      false
    );

    if (indexExists !== "1") {
      throw new Error("Index not found after restart");
    }

    success("Data verified after docker restart");
    return { name: "Docker Restart Persistence", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Docker Restart Persistence",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 3: Add More Data Before Full Recreation
 * Adds additional data to test that compose down/up maintains all data
 */
async function testAddMoreData(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 3: Add More Data Before Full Recreation");

    info("Adding additional data...");
    await $`docker exec ${config.containerName} psql -U postgres -d persistence_test -c "INSERT INTO persistence_test (data, metadata) VALUES ('row4', '{\"version\": 2}'), ('row5', '{\"version\": 2}');"`;

    // Verify new data
    const count = await executeSQL(
      config.containerName,
      "SELECT COUNT(*) FROM persistence_test.persistence_test;",
      false
    );

    if (count !== "5") {
      throw new Error(`Expected 5 rows after adding data, got ${count}`);
    }

    success("Additional data added and verified");
    return { name: "Add More Data", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Add More Data",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 4: Setup Docker Compose Stack
 * Converts standalone container to compose-managed stack
 */
async function testSetupComposeStack(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 4: Setup Docker Compose Stack");

    // Stop and remove standalone container (keep volume)
    info("Stopping standalone container...");
    await $`docker stop ${config.containerName}`;
    await $`docker rm ${config.containerName}`;

    // Create test .env file for compose
    info("Creating compose environment configuration...");
    const envContent = `POSTGRES_PASSWORD=${config.testPassword}
POSTGRES_IMAGE=${config.imageTag}
POSTGRES_MEMORY_LIMIT=1g
COMPOSE_PROJECT_NAME=${config.projectName}
POSTGRES_NETWORK_NAME=postgres-persist-test-net-${Date.now()}-${process.pid}
POSTGRES_PORT=5432
POSTGRES_EXPORTER_PORT=9189
POSTGRES_DATA_VOLUME=${config.volumeName}
`;
    await Bun.write(config.envTestPath, envContent);

    // Start compose stack with existing volume
    info("Starting Docker Compose stack with existing volume...");
    await $`docker compose --env-file .env.test up -d postgres`
      .cwd(config.stackPath)
      .env({ COMPOSE_PROJECT_NAME: config.projectName });

    info("Waiting for PostgreSQL to be stable in compose stack...");
    const containerName = `${config.projectName}-postgres-single`;
    const ready = await waitForPostgresStable({
      container: containerName,
      timeout: TIMEOUTS.startup,
      requiredSuccesses: 3,
    });

    if (!ready) {
      throw new Error("PostgreSQL failed to start in compose stack");
    }

    success("Compose stack started with existing volume");
    return { name: "Setup Docker Compose Stack", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Setup Docker Compose Stack",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 5: Verify Data in Compose Stack
 * Verifies all data survived the standalone -> compose transition
 */
async function testVerifyDataInCompose(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 5: Verify Data in Compose Stack");

    info("Verifying all data exists in compose stack...");
    const count = await executeSQL(
      config.projectName,
      "SELECT COUNT(*) FROM persistence_test.persistence_test;",
      true
    );

    if (count !== "5") {
      throw new Error(`Expected 5 rows in compose stack, got ${count}`);
    }

    // Verify specific rows
    const row1 = await executeSQL(
      config.projectName,
      "SELECT data FROM persistence_test.persistence_test WHERE id = 1;",
      true
    );
    const row5 = await executeSQL(
      config.projectName,
      "SELECT data FROM persistence_test.persistence_test WHERE id = 5;",
      true
    );

    if (row1 !== "row1" || row5 !== "row5") {
      throw new Error(`Data integrity check failed: row1='${row1}', row5='${row5}'`);
    }

    // Verify metadata
    const metadataCount = await executeSQL(
      config.projectName,
      "SELECT COUNT(*) FROM persistence_test.persistence_test WHERE metadata->>'version' = '2';",
      true
    );

    if (metadataCount !== "2") {
      throw new Error(`Expected 2 rows with version 2, got ${metadataCount}`);
    }

    success("All data verified in compose stack");
    return { name: "Verify Data in Compose Stack", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Verify Data in Compose Stack",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 6: Full Stack Recreation (docker compose down && up)
 * Tests that data survives complete stack teardown and recreation
 */
async function testFullStackRecreation(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 6: Full Stack Recreation (docker compose down && up)");

    info("Stopping compose stack (keeping volumes)...");
    await $`docker compose --env-file .env.test down`
      .cwd(config.stackPath)
      .env({ COMPOSE_PROJECT_NAME: config.projectName });

    // Wait for cleanup
    await Bun.sleep(3000);

    info("Starting compose stack again...");
    await $`docker compose --env-file .env.test up -d postgres`
      .cwd(config.stackPath)
      .env({ COMPOSE_PROJECT_NAME: config.projectName });

    info("Waiting for PostgreSQL to be stable after recreation...");
    const containerName = `${config.projectName}-postgres-single`;
    const ready = await waitForPostgresStable({
      container: containerName,
      timeout: TIMEOUTS.startup,
      requiredSuccesses: 3,
    });

    if (!ready) {
      throw new Error("PostgreSQL failed to start after recreation");
    }

    success("Stack recreated successfully");
    return {
      name: "Full Stack Recreation",
      passed: true,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      name: "Full Stack Recreation",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 7: Final Data Integrity Check
 * Comprehensive verification after all restart operations
 */
async function testFinalDataIntegrity(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 7: Final Data Integrity Check");

    info("Performing comprehensive data integrity check...");

    // Verify row count
    const count = await executeSQL(
      config.projectName,
      "SELECT COUNT(*) FROM persistence_test.persistence_test;",
      true
    );

    if (count !== "5") {
      throw new Error(`Expected 5 rows after full recreation, got ${count}`);
    }

    // Verify all rows are accessible
    const allData = await executeSQL(
      config.projectName,
      "SELECT string_agg(data, ',' ORDER BY id) FROM persistence_test.persistence_test;",
      true
    );

    if (allData !== "row1,row2,row3,row4,row5") {
      throw new Error(`Data order/content mismatch: ${allData}`);
    }

    // Verify index still exists
    const indexExists = await executeSQL(
      config.projectName,
      "SELECT COUNT(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_persistence_created_at';",
      true
    );

    if (indexExists !== "1") {
      throw new Error("Index lost after recreation");
    }

    // Verify database exists
    const dbExists = await executeSQL(
      config.projectName,
      "SELECT COUNT(*) FROM pg_database WHERE datname = 'persistence_test';",
      true
    );

    if (dbExists !== "1") {
      throw new Error("Database lost after recreation");
    }

    // Verify JSONB metadata
    const jsonbCheck = await executeSQL(
      config.projectName,
      "SELECT COUNT(*) FROM persistence_test.persistence_test WHERE metadata ? 'version';",
      true
    );

    if (jsonbCheck !== "5") {
      throw new Error(`JSONB integrity check failed, got ${jsonbCheck} rows with version key`);
    }

    success("All data integrity checks passed");
    return {
      name: "Final Data Integrity Check",
      passed: true,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      name: "Final Data Integrity Check",
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
    info(`  Project: ${config.projectName}`);
    info(`  Volume: ${config.volumeName}`);
    return;
  }

  info("Cleaning up test environment...");

  // Cleanup compose stack
  try {
    await $`docker compose --env-file .env.test down -v --remove-orphans`
      .cwd(config.stackPath)
      .env({ COMPOSE_PROJECT_NAME: config.projectName })
      .nothrow()
      .quiet();
  } catch {
    // Ignore errors
  }

  // Cleanup standalone container
  await cleanupContainer(config.containerName);

  // Cleanup volume
  try {
    await $`docker volume rm ${config.volumeName}`.nothrow().quiet();
  } catch {
    // Ignore errors
  }

  // Cleanup env file
  try {
    await $`rm -f ${config.envTestPath}`.quiet();
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

  // Get script directory and stack path
  const scriptDir = import.meta.dir;
  const projectRoot = join(scriptDir, "../..");
  const stackPath = join(projectRoot, "stacks/single");

  const config: TestConfig = {
    ...args,
    containerName: generateUniqueContainerName("persist-test"),
    volumeName: `persist-test-vol-${timestamp}-${pid}`,
    testPassword: generateTestPassword(),
    useCompose: false,
    projectName: generateUniqueProjectName("persist-test"),
    stackPath,
    envTestPath: join(stackPath, ".env.test"),
  };

  console.log("========================================");
  console.log("Container Restart Persistence Test");
  console.log("========================================");
  console.log(`Image: ${config.imageTag}`);
  console.log(`Container: ${config.containerName}`);
  console.log(`Volume: ${config.volumeName}`);
  console.log(`Project: ${config.projectName}`);
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
    results.push(await testDockerRestart(config));
    results.push(await testAddMoreData(config));
    results.push(await testSetupComposeStack(config));
    results.push(await testVerifyDataInCompose(config));
    results.push(await testFullStackRecreation(config));
    results.push(await testFinalDataIntegrity(config));

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
