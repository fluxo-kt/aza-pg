#!/usr/bin/env bun
/**
 * Test script: Validate hook-based extensions that load via shared_preload_libraries
 * Usage: bun run scripts/test/test-hook-extensions.ts [image-tag]
 *
 * Tests extensions that don't use CREATE EXTENSION:
 *   - pg_safeupdate (hook-based, session_preload_libraries)
 *
 * Note: pg_plan_filter removed (incompatible with PostgreSQL 18)
 * Note: supautils removed (disabled - compilation issues)
 *
 * Examples:
 *   bun run scripts/test/test-hook-extensions.ts                    # Use default tag 'aza-pg:pg18'
 *   bun run scripts/test/test-hook-extensions.ts my-custom:tag      # Use custom tag
 */

import { $ } from "bun";
import {
  checkCommand,
  checkDockerDaemon,
  dockerCleanup,
  ensureImageAvailable,
  waitForPostgres,
} from "../utils/docker";
import { error } from "../utils/logger.ts";

// Generate random test password at runtime
const TEST_POSTGRES_PASSWORD =
  Bun.env.TEST_POSTGRES_PASSWORD ?? `test_postgres_${Date.now()}_${process.pid}`;

/**
 * Assert SQL command succeeds
 */
async function assertSqlSuccess(container: string, sql: string, message: string): Promise<void> {
  try {
    await $`docker exec ${container} psql -U postgres -t -c ${sql}`.quiet();
    console.log(`✅ ${message}`);
  } catch {
    console.log(`❌ FAILED: ${message}`);
    console.log(`   SQL: ${sql}`);
    process.exit(1);
  }
}

/**
 * Assert SQL command fails with expected error
 */
async function assertSqlFails(
  container: string,
  sql: string,
  expectedError: string,
  message: string
): Promise<void> {
  try {
    await $`docker exec ${container} psql -U postgres -t -c ${sql}`.quiet();
    console.log(`❌ FAILED: ${message}`);
    console.log(`   Expected failure but command succeeded`);
    console.log(`   SQL: ${sql}`);
    process.exit(1);
  } catch (error: unknown) {
    const output = error instanceof Error ? error.message : String(error);
    if (output.toLowerCase().includes(expectedError.toLowerCase())) {
      console.log(`✅ ${message}`);
    } else {
      console.log(`❌ FAILED: ${message}`);
      console.log(`   Expected error pattern: ${expectedError}`);
      console.log(`   Actual output: ${output}`);
      process.exit(1);
    }
  }
}

/**
 * Test case runner interface
 */
type TestCallback = (container: string) => Promise<void>;

interface RunCaseOptions {
  memory?: string;
  env?: Record<string, string>;
}

/**
 * Run a test case with isolated container
 */
async function runCase(
  name: string,
  callback: TestCallback,
  imageTag: string,
  options: RunCaseOptions = {}
): Promise<void> {
  console.log(name);
  console.log("=".repeat(name.length));

  const container = `pg-hook-ext-${Math.floor(Math.random() * 10000)}-${process.pid}`;

  try {
    // Build docker run arguments
    const args = ["run", "-d", "--name", container];

    if (options.memory) {
      args.push("--memory", options.memory);
    }

    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        args.push("-e", `${key}=${value}`);
      }
    }

    args.push(imageTag);

    // Start container
    await $`docker ${args}`.quiet();

    // Wait for PostgreSQL to be ready
    try {
      await waitForPostgres({
        host: "localhost",
        port: 5432,
        user: "postgres",
        timeout: 60,
        container,
      });
    } catch {
      console.log(`❌ FAILED: PostgreSQL failed to start in time`);
      const logs = await $`docker logs ${container}`.text();
      console.log("Container logs:");
      console.log(logs);
      await dockerCleanup(container);
      process.exit(1);
    }

    // Run test callback
    await callback(container);

    // Cleanup
    await dockerCleanup(container);
  } catch (error) {
    console.log(`❌ ERROR: Failed to start container for '${name}'`);
    console.log(error);
    await dockerCleanup(container);
    process.exit(1);
  }

  console.log();
}

// ==============================================================================
// Test 1: pg_safeupdate (hook-based, uses session_preload_libraries)
// ==============================================================================
async function testPgSafeupdateSessionPreload(container: string): Promise<void> {
  // Verify safeupdate.so exists (note: library name is "safeupdate", not "pg_safeupdate")
  const soPath = "/usr/lib/postgresql/18/lib/safeupdate.so";
  try {
    await $`docker exec ${container} test -f ${soPath}`.quiet();
    console.log(`✅ safeupdate.so exists at ${soPath}`);
  } catch {
    console.log(`❌ FAILED: safeupdate.so not found at ${soPath}`);
    process.exit(1);
  }

  // Test 1: Without preload, UPDATE without WHERE should succeed
  await assertSqlSuccess(
    container,
    "CREATE TABLE safeupdate_test (id int); INSERT INTO safeupdate_test VALUES (1), (2);",
    "Create test table for pg_safeupdate"
  );

  await assertSqlSuccess(
    container,
    "UPDATE safeupdate_test SET id = 99;",
    "UPDATE without WHERE succeeds (pg_safeupdate not loaded)"
  );

  // Reset table
  await assertSqlSuccess(
    container,
    "TRUNCATE safeupdate_test; INSERT INTO safeupdate_test VALUES (1), (2);",
    "Reset test table"
  );

  // Test 2: With session_preload_libraries, UPDATE without WHERE should FAIL
  // Note: Library name is "safeupdate", not "pg_safeupdate"
  await assertSqlFails(
    container,
    "SET session_preload_libraries = 'safeupdate'; UPDATE safeupdate_test SET id = 99;",
    "UPDATE requires a WHERE clause|rejected by safeupdate",
    "pg_safeupdate blocks UPDATE without WHERE"
  );

  // Test 3: UPDATE with WHERE should succeed even with pg_safeupdate
  await assertSqlSuccess(
    container,
    "SET session_preload_libraries = 'safeupdate'; UPDATE safeupdate_test SET id = 99 WHERE id = 1;",
    "UPDATE with WHERE succeeds with pg_safeupdate loaded"
  );

  // Test 4: DELETE without WHERE should fail with pg_safeupdate
  await assertSqlFails(
    container,
    "SET session_preload_libraries = 'safeupdate'; DELETE FROM safeupdate_test;",
    "DELETE requires a WHERE clause|rejected by safeupdate",
    "pg_safeupdate blocks DELETE without WHERE"
  );

  // Test 5: DELETE with WHERE should succeed
  await assertSqlSuccess(
    container,
    "SET session_preload_libraries = 'safeupdate'; DELETE FROM safeupdate_test WHERE id = 99;",
    "DELETE with WHERE succeeds with pg_safeupdate loaded"
  );

  // Cleanup
  await assertSqlSuccess(container, "DROP TABLE safeupdate_test;", "Cleanup safeupdate test table");
}

// ==============================================================================
// Main execution
// ==============================================================================
async function main(): Promise<void> {
  // Check prerequisites
  try {
    await checkCommand("docker");
  } catch {
    error("Docker not found");
    console.log("   Install Docker: https://docs.docker.com/get-docker/");
    process.exit(1);
  }

  try {
    await checkDockerDaemon();
  } catch {
    error("Docker daemon not running");
    console.log("   Start Docker: open -a Docker (macOS) or sudo systemctl start docker (Linux)");
    process.exit(1);
  }

  const imageTag = Bun.argv[2] ?? Bun.env.POSTGRES_IMAGE ?? "aza-pg:pg18";

  // Ensure image is available (will auto-pull from registry if needed)
  try {
    await ensureImageAvailable(imageTag);
  } catch (err) {
    error(
      `Failed to ensure image availability: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }

  console.log("========================================");
  console.log("Hook-Based Extensions Test Suite");
  console.log("========================================");
  console.log(`Image tag: ${imageTag}`);
  console.log();

  // Run test cases
  await runCase("Test 1: pg_safeupdate session preload", testPgSafeupdateSessionPreload, imageTag, {
    memory: "2g",
    env: { POSTGRES_PASSWORD: TEST_POSTGRES_PASSWORD },
  });

  console.log("========================================");
  console.log("✅ All hook extension tests passed!");
  console.log("✅ Total: 1 test case");
  console.log("========================================");
  console.log();
  console.log("Summary:");
  console.log("  - pg_safeupdate: Hook-based, uses session_preload_libraries");
  console.log("  - Extension verified for loading, functionality, and isolation");
  console.log();
  console.log("Notes:");
  console.log("  - pg_plan_filter excluded (incompatible with PostgreSQL 18)");
  console.log("  - supautils excluded (disabled due to compilation issues)");
}

// Run main function
main().catch((error) => {
  error(`Unexpected error: ${error}`);
  process.exit(1);
});
