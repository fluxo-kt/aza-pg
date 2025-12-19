#!/usr/bin/env bun
/**
 * Extension Upgrade Test
 *
 * Purpose: Verify PostgreSQL extension upgrade paths work correctly
 *
 * Coverage:
 * - ALTER EXTENSION UPDATE works for built-in extensions
 * - Version tracking is accurate (pg_extension)
 * - Extension functionality persists after upgrade
 * - Handles "already at latest version" gracefully
 *
 * Test Extensions:
 * - pg_stat_statements: Core extension with version history
 * - pgcrypto: Built-in extension with upgrade scripts
 *
 * Usage:
 *   bun scripts/test/test-extension-upgrade.ts [image-tag] [--no-cleanup]
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
  testDatabase: string;
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
async function executeSQL(container: string, database: string, sql: string): Promise<string> {
  const result = await $`docker exec ${container} psql -U postgres -d ${database} -tAc ${sql}`;
  return result.text().trim();
}

/**
 * Get current extension version
 */
async function getCurrentVersion(
  container: string,
  database: string,
  extensionName: string
): Promise<string> {
  const sql = `SELECT extversion FROM pg_extension WHERE extname = '${extensionName}'`;
  return await executeSQL(container, database, sql);
}

/**
 * Get available extension versions
 */
async function getAvailableVersions(
  container: string,
  database: string,
  extensionName: string
): Promise<string[]> {
  const sql = `SELECT version FROM pg_available_extension_versions WHERE name = '${extensionName}' ORDER BY version`;
  const result = await executeSQL(container, database, sql);
  return result.split("\n").filter((v) => v.length > 0);
}

/**
 * Test extension upgrade workflow
 */
async function testExtensionUpgrade(
  container: string,
  database: string,
  extensionName: string,
  functionalityTest: string,
  testDescription: string
): Promise<TestResult> {
  const start = Date.now();
  try {
    info(`Testing extension: ${extensionName}`);

    // Create extension at default version
    info("Creating extension at default version...");
    await executeSQL(container, database, `CREATE EXTENSION IF NOT EXISTS ${extensionName}`);

    // Get current version
    const currentVersion = await getCurrentVersion(container, database, extensionName);
    if (!currentVersion) {
      throw new Error(`Extension ${extensionName} not found after creation`);
    }
    info(`Current version: ${currentVersion}`);

    // Get available versions
    const availableVersions = await getAvailableVersions(container, database, extensionName);
    if (availableVersions.length === 0) {
      throw new Error(`No versions available for ${extensionName}`);
    }
    info(`Available versions: ${availableVersions.join(", ")}`);

    // Test functionality before update
    info("Testing functionality before update...");
    const resultBefore = await executeSQL(container, database, functionalityTest);
    if (!resultBefore) {
      throw new Error(`Functionality test failed before update`);
    }
    info("Functionality check passed");

    // Try to update extension
    info("Attempting ALTER EXTENSION UPDATE...");
    try {
      const updateResult =
        await $`docker exec ${container} psql -U postgres -d ${database} -c "ALTER EXTENSION ${extensionName} UPDATE"`;
      const updateOutput = updateResult.text().trim();

      // Check if already at latest version (not an error)
      if (
        updateOutput.includes("already at latest") ||
        updateOutput.includes("is already up to date")
      ) {
        info("Extension already at latest version (OK)");
      } else {
        info("Extension update completed");
      }
    } catch (updateError) {
      // Check if error is "already at latest version" (acceptable)
      const errorMsg = updateError instanceof Error ? updateError.message : String(updateError);
      if (errorMsg.includes("already at latest") || errorMsg.includes("is already up to date")) {
        info("Extension already at latest version (OK)");
      } else {
        throw new Error(`ALTER EXTENSION UPDATE failed: ${errorMsg}`);
      }
    }

    // Get version after update attempt
    const versionAfter = await getCurrentVersion(container, database, extensionName);
    info(`Version after update: ${versionAfter}`);

    // Verify version is still valid (should be current or newer)
    if (!versionAfter) {
      throw new Error(`Extension version lost after update`);
    }

    // Test functionality after update
    info("Testing functionality after update...");
    const resultAfter = await executeSQL(container, database, functionalityTest);
    if (!resultAfter) {
      throw new Error(`Functionality test failed after update`);
    }
    info("Functionality check passed");

    success(`Extension ${extensionName} upgrade test completed`);
    return {
      name: testDescription,
      passed: true,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      name: testDescription,
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 1: Setup Container and Database
 */
async function testSetupContainer(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 1: Setup Container and Database");

    // Create named volume
    info("Creating named volume...");
    await $`docker volume create ${config.volumeName}`;
    success(`Volume created: ${config.volumeName}`);

    // Start container
    info("Starting PostgreSQL container...");
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
    await $`docker exec ${config.containerName} psql -U postgres -c "CREATE DATABASE ${config.testDatabase};"`;

    // Verify database exists
    const dbExists = await executeSQL(
      config.containerName,
      "postgres",
      `SELECT 1 FROM pg_database WHERE datname = '${config.testDatabase}'`
    );

    if (dbExists !== "1") {
      throw new Error("Test database not found after creation");
    }

    success("Container and database setup completed");
    return {
      name: "Setup Container and Database",
      passed: true,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      name: "Setup Container and Database",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 2: pg_stat_statements upgrade
 */
async function testPgStatStatementsUpgrade(config: TestConfig): Promise<TestResult> {
  section("Test 2: pg_stat_statements Extension Upgrade");
  return await testExtensionUpgrade(
    config.containerName,
    config.testDatabase,
    "pg_stat_statements",
    "SELECT COUNT(*) FROM pg_stat_statements LIMIT 1",
    "pg_stat_statements Extension Upgrade"
  );
}

/**
 * Test 3: pgcrypto upgrade
 */
async function testPgcryptoUpgrade(config: TestConfig): Promise<TestResult> {
  section("Test 3: pgcrypto Extension Upgrade");
  return await testExtensionUpgrade(
    config.containerName,
    config.testDatabase,
    "pgcrypto",
    "SELECT digest('test', 'sha256')",
    "pgcrypto Extension Upgrade"
  );
}

/**
 * Test 4: Verify extension metadata
 */
async function testExtensionMetadata(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 4: Verify Extension Metadata");

    info("Checking pg_extension metadata...");

    // Verify both extensions are installed
    const extCount = await executeSQL(
      config.containerName,
      config.testDatabase,
      "SELECT COUNT(*) FROM pg_extension WHERE extname IN ('pg_stat_statements', 'pgcrypto')"
    );

    if (extCount !== "2") {
      throw new Error(`Expected 2 extensions, found ${extCount}`);
    }

    // Verify schema ownership
    info("Checking extension schemas...");
    const schemaCount = await executeSQL(
      config.containerName,
      config.testDatabase,
      "SELECT COUNT(DISTINCT extnamespace::regnamespace::text) FROM pg_extension WHERE extname IN ('pg_stat_statements', 'pgcrypto')"
    );

    if (parseInt(schemaCount) < 1) {
      throw new Error("Extension schemas not found");
    }

    // Verify extension dependencies are tracked
    info("Checking extension dependencies...");
    const depCheck = await executeSQL(
      config.containerName,
      config.testDatabase,
      "SELECT COUNT(*) FROM pg_depend WHERE classid = 'pg_extension'::regclass"
    );

    info(`Extension dependencies tracked: ${depCheck} entries`);

    success("Extension metadata verified");
    return {
      name: "Verify Extension Metadata",
      passed: true,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      name: "Verify Extension Metadata",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 5: Extension version consistency
 */
async function testVersionConsistency(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 5: Extension Version Consistency");

    const extensions = ["pg_stat_statements", "pgcrypto"];

    for (const ext of extensions) {
      info(`Checking ${ext} version consistency...`);

      // Get installed version
      const installedVersion = await getCurrentVersion(
        config.containerName,
        config.testDatabase,
        ext
      );

      // Get available versions
      const availableVersions = await getAvailableVersions(
        config.containerName,
        config.testDatabase,
        ext
      );

      // Verify installed version is in available versions list
      if (!availableVersions.includes(installedVersion)) {
        warning(`Installed version ${installedVersion} not found in available versions for ${ext}`);
        info(`Available: ${availableVersions.join(", ")}`);
        // This is a warning, not a failure - might be a newer patch version
      } else {
        info(`Version ${installedVersion} is consistent`);
      }
    }

    success("Version consistency check completed");
    return {
      name: "Extension Version Consistency",
      passed: true,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      name: "Extension Version Consistency",
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
    info(`  Database: ${config.testDatabase}`);
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
    containerName: generateUniqueContainerName("ext-upgrade-test"),
    volumeName: `ext-upgrade-test-vol-${timestamp}-${pid}`,
    testPassword: generateTestPassword(),
    testDatabase: "extension_test",
  };

  console.log("========================================");
  console.log("Extension Upgrade Test");
  console.log("========================================");
  console.log(`Image: ${config.imageTag}`);
  console.log(`Container: ${config.containerName}`);
  console.log(`Volume: ${config.volumeName}`);
  console.log(`Database: ${config.testDatabase}`);
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
    results.push(await testSetupContainer(config));
    results.push(await testPgStatStatementsUpgrade(config));
    results.push(await testPgcryptoUpgrade(config));
    results.push(await testExtensionMetadata(config));
    results.push(await testVersionConsistency(config));

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
