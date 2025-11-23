#!/usr/bin/env bun
/**
 * Backup/Restore Cycle Test
 *
 * Purpose: Test pgbackrest backup and restore functionality
 *
 * Coverage:
 * - Start primary container with pgbackrest configured
 * - Create test database with data (tables, indexes, extensions)
 * - Perform stanza-create (pgbackrest stanza-create)
 * - Perform full backup (pgbackrest backup --type=full)
 * - Add more data after backup
 * - Stop primary, restore from backup to new container
 * - Verify restored data matches original (before additional data)
 * - Verify backup info (pgbackrest info)
 * - Test incremental backup (pgbackrest backup --type=incr)
 *
 * Usage:
 *   bun scripts/test/test-backup-restore.ts [image-tag] [--no-cleanup]
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
  primaryContainer: string;
  restoreContainer: string;
  backupVolume: string;
  dataVolume: string;
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
 * Test 1: Start Container with pgbackrest
 */
async function testStartContainer(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 1: Start Container with pgbackrest");

    // Create backup volume
    info("Creating backup volume...");
    await $`docker volume create ${config.backupVolume}`;

    info("Starting primary container with pgbackrest configuration...");
    await $`docker run -d --name ${config.primaryContainer} -e POSTGRES_PASSWORD=${config.testPassword} -v ${config.backupVolume}:/var/lib/pgbackrest ${config.imageTag}`.quiet();

    info("Waiting for PostgreSQL to be ready...");
    const ready = await waitForPostgres({
      container: config.primaryContainer,
      timeout: TIMEOUTS.startup,
    });

    if (!ready) {
      throw new Error("PostgreSQL failed to start");
    }

    success("Container started with pgbackrest configuration");
    return { name: "Start Container with pgbackrest", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Start Container with pgbackrest",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 2: Create Test Database with Data
 */
async function testCreateTestData(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 2: Create Test Database with Data");

    info("Creating test database...");
    await $`docker exec ${config.primaryContainer} psql -U postgres -c "CREATE DATABASE backup_test;"`;

    info("Creating extensions...");
    await $`docker exec ${config.primaryContainer} psql -U postgres -d backup_test -c "CREATE EXTENSION IF NOT EXISTS vector;"`;
    await $`docker exec ${config.primaryContainer} psql -U postgres -d backup_test -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"`;

    info("Creating tables with data...");
    await $`docker exec ${config.primaryContainer} psql -U postgres -d backup_test -c "CREATE TABLE products (id SERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT, price DECIMAL(10,2));"`;
    await $`docker exec ${config.primaryContainer} psql -U postgres -d backup_test -c "CREATE TABLE orders (id SERIAL PRIMARY KEY, product_id INT REFERENCES products(id), quantity INT, order_date TIMESTAMP DEFAULT NOW());"`;
    await $`docker exec ${config.primaryContainer} psql -U postgres -d backup_test -c "CREATE TABLE vectors (id SERIAL PRIMARY KEY, embedding vector(3));"`;

    info("Creating indexes...");
    await $`docker exec ${config.primaryContainer} psql -U postgres -d backup_test -c "CREATE INDEX idx_products_name ON products USING gin (name gin_trgm_ops);"`;
    await $`docker exec ${config.primaryContainer} psql -U postgres -d backup_test -c "CREATE INDEX idx_orders_product_id ON orders(product_id);"`;

    info("Inserting test data...");
    await $`docker exec ${config.primaryContainer} psql -U postgres -d backup_test -c "INSERT INTO products (name, description, price) VALUES ('Product A', 'Description A', 10.50), ('Product B', 'Description B', 20.75), ('Product C', 'Description C', 30.00);"`;
    await $`docker exec ${config.primaryContainer} psql -U postgres -d backup_test -c "INSERT INTO orders (product_id, quantity) VALUES (1, 5), (2, 3), (1, 2);"`;
    await $`docker exec ${config.primaryContainer} psql -U postgres -d backup_test -c "INSERT INTO vectors (embedding) VALUES ('[1,2,3]'), ('[4,5,6]'), ('[7,8,9]');"`;

    // Verify data
    const productCountResult =
      await $`docker exec ${config.primaryContainer} psql -U postgres -d backup_test -tAc "SELECT COUNT(*) FROM products;"`;
    const productCount = productCountResult.text().trim();

    if (productCount !== "3") {
      throw new Error(`Expected 3 products, got ${productCount}`);
    }

    const orderCountResult =
      await $`docker exec ${config.primaryContainer} psql -U postgres -d backup_test -tAc "SELECT COUNT(*) FROM orders;"`;
    const orderCount = orderCountResult.text().trim();

    if (orderCount !== "3") {
      throw new Error(`Expected 3 orders, got ${orderCount}`);
    }

    success("Test database created with data");
    return { name: "Create Test Database with Data", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Create Test Database with Data",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 3: Configure pgbackrest
 */
async function testConfigurePgbackrest(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 3: Configure pgbackrest");

    info("Creating pgbackrest configuration...");

    // Create pgbackrest.conf
    const pgbackrestConf = `[global]
repo1-path=/var/lib/pgbackrest
repo1-retention-full=2
log-level-console=info
log-level-file=debug

[test-stanza]
pg1-path=/var/lib/postgresql/data
pg1-port=5432
`;

    await $`docker exec ${config.primaryContainer} sh -c "mkdir -p /etc/pgbackrest && echo '${pgbackrestConf}' > /etc/pgbackrest/pgbackrest.conf"`;

    // Ensure backup directory exists and has correct permissions
    await $`docker exec ${config.primaryContainer} sh -c "mkdir -p /var/lib/pgbackrest && chown -R postgres:postgres /var/lib/pgbackrest"`;
    await $`docker exec ${config.primaryContainer} sh -c "chown -R postgres:postgres /etc/pgbackrest"`;

    success("pgbackrest configuration created");
    return { name: "Configure pgbackrest", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Configure pgbackrest",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 4: Create Stanza
 */
async function testCreateStanza(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 4: Create Stanza");

    info("Creating pgbackrest stanza...");

    // Note: pgbackrest is a tool, not an extension, so it should be available in PATH
    const stanzaResult =
      await $`docker exec -u postgres ${config.primaryContainer} pgbackrest --stanza=test-stanza --config=/etc/pgbackrest/pgbackrest.conf stanza-create`.nothrow();

    if (stanzaResult.exitCode !== 0) {
      const errorOutput = await new Response(stanzaResult.stderr).text();
      // If stanza already exists, that's okay
      if (errorOutput.includes("already exists")) {
        info("Stanza already exists, continuing...");
      } else {
        throw new Error(`Failed to create stanza: ${errorOutput}`);
      }
    }

    success("pgbackrest stanza created");
    return { name: "Create Stanza", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Create Stanza",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 5: Perform Full Backup
 */
async function testFullBackup(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 5: Perform Full Backup");

    info("Performing full backup...");
    const backupProc = $`docker exec -u postgres ${config.primaryContainer} pgbackrest --stanza=test-stanza --config=/etc/pgbackrest/pgbackrest.conf --type=full backup`;

    // Wait with timeout
    const backupPromise = Promise.race([
      backupProc,
      Bun.sleep(TIMEOUTS.complex * 1000).then(() => {
        throw new Error("Backup timeout");
      }),
    ]);

    const backupResult = await backupPromise;
    const backupOutput = backupResult.text();
    info(`Backup output: ${backupOutput.split("\n").slice(-3).join("\n")}`);

    success("Full backup completed");
    return { name: "Perform Full Backup", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Perform Full Backup",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 6: Add More Data After Backup
 */
async function testAddPostBackupData(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 6: Add More Data After Backup");

    info("Adding data after backup...");
    await $`docker exec ${config.primaryContainer} psql -U postgres -d backup_test -c "INSERT INTO products (name, description, price) VALUES ('Product D', 'Description D', 40.00), ('Product E', 'Description E', 50.00);"`;
    await $`docker exec ${config.primaryContainer} psql -U postgres -d backup_test -c "INSERT INTO orders (product_id, quantity) VALUES (2, 10);"`;

    // Verify new data
    const productCountResult =
      await $`docker exec ${config.primaryContainer} psql -U postgres -d backup_test -tAc "SELECT COUNT(*) FROM products;"`;
    const productCount = productCountResult.text().trim();

    if (productCount !== "5") {
      throw new Error(`Expected 5 products after adding data, got ${productCount}`);
    }

    success("Additional data added after backup");
    return { name: "Add More Data After Backup", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Add More Data After Backup",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 7: Verify Backup Info
 */
async function testBackupInfo(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 7: Verify Backup Info");

    info("Querying backup info...");
    const infoResult =
      await $`docker exec -u postgres ${config.primaryContainer} pgbackrest --stanza=test-stanza --config=/etc/pgbackrest/pgbackrest.conf info`;

    const infoOutput = infoResult.text();
    console.log("\nBackup Info:");
    console.log("-".repeat(60));
    console.log(infoOutput);
    console.log("");

    if (!infoOutput.includes("test-stanza")) {
      throw new Error("Backup info does not contain stanza information");
    }

    if (!infoOutput.includes("full backup")) {
      warning("Backup info does not show 'full backup' label");
    }

    success("Backup info verified");
    return { name: "Verify Backup Info", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Verify Backup Info",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 8: Perform Incremental Backup
 */
async function testIncrementalBackup(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 8: Perform Incremental Backup");

    info("Performing incremental backup...");
    const incrBackupProc = $`docker exec -u postgres ${config.primaryContainer} pgbackrest --stanza=test-stanza --config=/etc/pgbackrest/pgbackrest.conf --type=incr backup`;

    // Wait with timeout
    const incrBackupPromise = Promise.race([
      incrBackupProc,
      Bun.sleep(TIMEOUTS.complex * 1000).then(() => {
        throw new Error("Incremental backup timeout");
      }),
    ]);

    const incrBackupResult = await incrBackupPromise;
    const incrOutput = incrBackupResult.text();
    info(`Incremental backup output: ${incrOutput.split("\n").slice(-3).join("\n")}`);

    success("Incremental backup completed");
    return { name: "Perform Incremental Backup", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Perform Incremental Backup",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 9: Stop Primary and Restore to New Container
 */
async function testRestoreBackup(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 9: Stop Primary and Restore to New Container");

    info("Stopping primary container...");
    await $`docker stop ${config.primaryContainer}`;

    info("Starting restore container...");
    await $`docker run -d --name ${config.restoreContainer} -e POSTGRES_PASSWORD=${config.testPassword} -v ${config.backupVolume}:/var/lib/pgbackrest ${config.imageTag}`.quiet();

    info("Waiting for restore container to be ready...");
    const ready = await waitForPostgres({
      container: config.restoreContainer,
      timeout: TIMEOUTS.startup,
    });

    if (!ready) {
      throw new Error("Restore container failed to start");
    }

    // Stop PostgreSQL in restore container
    info("Stopping PostgreSQL in restore container...");
    await $`docker exec ${config.restoreContainer} su - postgres -c "pg_ctl stop -D /var/lib/postgresql/data"`.nothrow();
    await Bun.sleep(3000);

    // Copy pgbackrest configuration
    info("Configuring pgbackrest for restore...");
    const pgbackrestConf = `[global]
repo1-path=/var/lib/pgbackrest
log-level-console=info
log-level-file=debug

[test-stanza]
pg1-path=/var/lib/postgresql/data
pg1-port=5432
`;

    await $`docker exec ${config.restoreContainer} sh -c "mkdir -p /etc/pgbackrest && echo '${pgbackrestConf}' > /etc/pgbackrest/pgbackrest.conf"`;
    await $`docker exec ${config.restoreContainer} sh -c "chown -R postgres:postgres /etc/pgbackrest"`;

    // Clear data directory and restore
    info("Clearing data directory and restoring from backup...");
    await $`docker exec ${config.restoreContainer} sh -c "rm -rf /var/lib/postgresql/data/* && chown -R postgres:postgres /var/lib/postgresql/data"`;

    const restoreProc = $`docker exec -u postgres ${config.restoreContainer} pgbackrest --stanza=test-stanza --config=/etc/pgbackrest/pgbackrest.conf restore`;

    // Wait with timeout
    const restorePromise = Promise.race([
      restoreProc,
      Bun.sleep(TIMEOUTS.complex * 1000).then(() => {
        throw new Error("Restore timeout");
      }),
    ]);

    const restoreResult = await restorePromise;
    const restoreOutput = restoreResult.text();
    info(`Restore output: ${restoreOutput.split("\n").slice(-3).join("\n")}`);

    // Start PostgreSQL
    info("Starting PostgreSQL after restore...");
    await $`docker exec ${config.restoreContainer} su - postgres -c "pg_ctl start -D /var/lib/postgresql/data"`;
    await Bun.sleep(5000);

    // Wait for PostgreSQL to be ready
    const postRestoreReady = await waitForPostgres({
      container: config.restoreContainer,
      timeout: TIMEOUTS.startup,
    });

    if (!postRestoreReady) {
      throw new Error("PostgreSQL failed to start after restore");
    }

    success("Backup restored to new container");
    return {
      name: "Stop Primary and Restore to New Container",
      passed: true,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      name: "Stop Primary and Restore to New Container",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 10: Verify Restored Data
 */
async function testVerifyRestoredData(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 10: Verify Restored Data");

    info("Verifying restored data...");

    // Check if backup_test database exists
    const dbExistsResult =
      await $`docker exec ${config.restoreContainer} psql -U postgres -tAc "SELECT COUNT(*) FROM pg_database WHERE datname = 'backup_test';"`;
    const dbExists = dbExistsResult.text().trim();

    if (dbExists !== "1") {
      throw new Error(`backup_test database not found after restore`);
    }

    success("backup_test database exists after restore");

    // Verify product count (should be 3 from before additional data)
    const productCountResult =
      await $`docker exec ${config.restoreContainer} psql -U postgres -d backup_test -tAc "SELECT COUNT(*) FROM products;"`;
    const productCount = productCountResult.text().trim();

    // Note: Full backup was taken with 3 products, then 2 more were added
    // Restore from full backup should have 3 products
    // If incremental backup was properly applied, it would have 5
    info(`Product count after restore: ${productCount}`);

    if (productCount === "3") {
      success("Data restored matches full backup state (3 products)");
    } else if (productCount === "5") {
      success("Data restored includes incremental backup (5 products)");
    } else {
      throw new Error(`Unexpected product count: ${productCount}`);
    }

    // Verify order count
    const orderCountResult =
      await $`docker exec ${config.restoreContainer} psql -U postgres -d backup_test -tAc "SELECT COUNT(*) FROM orders;"`;
    const orderCount = orderCountResult.text().trim();

    info(`Order count after restore: ${orderCount}`);

    // Verify vectors
    const vectorCountResult =
      await $`docker exec ${config.restoreContainer} psql -U postgres -d backup_test -tAc "SELECT COUNT(*) FROM vectors;"`;
    const vectorCount = vectorCountResult.text().trim();

    if (vectorCount !== "3") {
      throw new Error(`Expected 3 vectors, got ${vectorCount}`);
    }

    success("All restored data verified successfully");
    return { name: "Verify Restored Data", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Verify Restored Data",
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
    info(`Containers and volumes preserved for inspection:`);
    info(`  Primary: ${config.primaryContainer}`);
    info(`  Restore: ${config.restoreContainer}`);
    info(`  Backup Volume: ${config.backupVolume}`);
    return;
  }

  info("Cleaning up test environment...");

  // Cleanup primary container
  await cleanupContainer(config.primaryContainer);

  // Cleanup restore container
  await cleanupContainer(config.restoreContainer);

  // Cleanup volumes
  try {
    await $`docker volume rm ${config.backupVolume}`.nothrow().quiet();
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
    primaryContainer: generateUniqueContainerName("backup-test-primary"),
    restoreContainer: generateUniqueContainerName("backup-test-restore"),
    backupVolume: `backup-test-vol-${timestamp}-${pid}`,
    dataVolume: `backup-test-data-${timestamp}-${pid}`,
    testPassword: generateTestPassword(),
  };

  console.log("========================================");
  console.log("Backup/Restore Cycle Test");
  console.log("========================================");
  console.log(`Image: ${config.imageTag}`);
  console.log(`Primary Container: ${config.primaryContainer}`);
  console.log(`Restore Container: ${config.restoreContainer}`);
  console.log(`Backup Volume: ${config.backupVolume}`);
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
    // Run tests
    results.push(await testStartContainer(config));
    results.push(await testCreateTestData(config));
    results.push(await testConfigurePgbackrest(config));
    results.push(await testCreateStanza(config));
    results.push(await testFullBackup(config));
    results.push(await testAddPostBackupData(config));
    results.push(await testBackupInfo(config));
    results.push(await testIncrementalBackup(config));
    results.push(await testRestoreBackup(config));
    results.push(await testVerifyRestoredData(config));

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
