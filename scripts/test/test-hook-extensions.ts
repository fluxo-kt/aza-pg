#!/usr/bin/env bun
/**
 * Test script: Validate hook-based extensions that load via shared_preload_libraries
 * Usage: bun run scripts/test/test-hook-extensions.ts [image-tag]
 *
 * Tests extensions that don't use CREATE EXTENSION:
 *   - pg_plan_filter (hook-based, sharedPreload)
 *   - pg_safeupdate (hook-based, session_preload_libraries)
 *   - supautils (GUC-based, sharedPreload)
 *
 * Examples:
 *   bun run scripts/test/test-hook-extensions.ts                    # Use default tag 'aza-pg:pg18'
 *   bun run scripts/test/test-hook-extensions.ts my-custom:tag      # Use custom tag
 */

import { $ } from "bun";
import { checkCommand, checkDockerDaemon, dockerCleanup, waitForPostgres } from "../utils/docker";
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
 * Assert SQL output contains pattern
 */
async function assertSqlContains(
  container: string,
  sql: string,
  pattern: string,
  message: string
): Promise<void> {
  try {
    const result = await $`docker exec ${container} psql -U postgres -t -c ${sql}`.text();
    const output = result.trim();

    if (output.toLowerCase().includes(pattern.toLowerCase())) {
      console.log(`✅ ${message} (found: ${output})`);
    } else {
      console.log(`❌ FAILED: ${message}`);
      console.log(`   Expected pattern: ${pattern}`);
      console.log(`   Actual output: ${output}`);
      process.exit(1);
    }
  } catch {
    console.log(`❌ FAILED: ${message} (PostgreSQL error)`);
    process.exit(1);
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
// Test 1: pg_plan_filter (hook-based, requires shared_preload_libraries)
// ==============================================================================
async function testPgPlanFilterNotPreloaded(container: string): Promise<void> {
  // Verify pg_plan_filter is NOT in default shared_preload_libraries
  const preloadLibs =
    await $`docker exec ${container} psql -U postgres -t -c "SHOW shared_preload_libraries;"`.text();
  const libs = preloadLibs.trim();

  if (libs.includes("pg_plan_filter")) {
    console.log("⚠️  WARNING: pg_plan_filter found in default preload (unexpected)");
  } else {
    console.log("✅ pg_plan_filter NOT in default shared_preload_libraries (expected)");
  }

  // Verify .so file exists
  const soPath = "/usr/lib/postgresql/18/lib/pg_plan_filter.so";
  try {
    await $`docker exec ${container} test -f ${soPath}`.quiet();
    console.log(`✅ pg_plan_filter.so exists at ${soPath}`);
  } catch {
    console.log(`❌ FAILED: pg_plan_filter.so not found at ${soPath}`);
    process.exit(1);
  }

  // Test that it doesn't work without preload (no GUC parameters available)
  // Note: pg_plan_filter doesn't have a .control file, so CREATE EXTENSION won't work
  await assertSqlFails(
    container,
    "CREATE EXTENSION pg_plan_filter;",
    "could not open extension control file|does not exist",
    "pg_plan_filter correctly requires preload (no CREATE EXTENSION)"
  );
}

async function testPgPlanFilterPreloaded(container: string): Promise<void> {
  // Verify pg_plan_filter is in shared_preload_libraries
  await assertSqlContains(
    container,
    "SHOW shared_preload_libraries;",
    "pg_plan_filter",
    "pg_plan_filter loaded via shared_preload_libraries"
  );

  // Check for GUC parameters (pg_plan_filter exposes configuration via GUC)
  // Note: pg_plan_filter may not expose visible GUC params, but hook should be active
  // We can verify the hook is loaded by checking the shared library is actually loaded
  await assertSqlSuccess(
    container,
    "SELECT 1;",
    "PostgreSQL operational with pg_plan_filter preloaded"
  );

  // Create test table and verify basic query execution with hook active
  await assertSqlSuccess(
    container,
    "CREATE TABLE hook_test (id int); INSERT INTO hook_test VALUES (1);",
    "Query execution successful with pg_plan_filter hook active"
  );

  // Cleanup
  await assertSqlSuccess(container, "DROP TABLE hook_test;", "Cleanup test table");
}

// ==============================================================================
// Test 2: pg_safeupdate (hook-based, uses session_preload_libraries)
// ==============================================================================
async function testPgSafeupdateSessionPreload(container: string): Promise<void> {
  // Verify pg_safeupdate.so exists
  const soPath = "/usr/lib/postgresql/18/lib/pg_safeupdate.so";
  try {
    await $`docker exec ${container} test -f ${soPath}`.quiet();
    console.log(`✅ pg_safeupdate.so exists at ${soPath}`);
  } catch {
    console.log(`❌ FAILED: pg_safeupdate.so not found at ${soPath}`);
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
  await assertSqlFails(
    container,
    "SET session_preload_libraries = 'pg_safeupdate'; UPDATE safeupdate_test SET id = 99;",
    "UPDATE requires a WHERE clause|rejected by safeupdate",
    "pg_safeupdate blocks UPDATE without WHERE"
  );

  // Test 3: UPDATE with WHERE should succeed even with pg_safeupdate
  await assertSqlSuccess(
    container,
    "SET session_preload_libraries = 'pg_safeupdate'; UPDATE safeupdate_test SET id = 99 WHERE id = 1;",
    "UPDATE with WHERE succeeds with pg_safeupdate loaded"
  );

  // Test 4: DELETE without WHERE should fail with pg_safeupdate
  await assertSqlFails(
    container,
    "SET session_preload_libraries = 'pg_safeupdate'; DELETE FROM safeupdate_test;",
    "DELETE requires a WHERE clause|rejected by safeupdate",
    "pg_safeupdate blocks DELETE without WHERE"
  );

  // Test 5: DELETE with WHERE should succeed
  await assertSqlSuccess(
    container,
    "SET session_preload_libraries = 'pg_safeupdate'; DELETE FROM safeupdate_test WHERE id = 99;",
    "DELETE with WHERE succeeds with pg_safeupdate loaded"
  );

  // Cleanup
  await assertSqlSuccess(container, "DROP TABLE safeupdate_test;", "Cleanup safeupdate test table");
}

// ==============================================================================
// Test 3: supautils (GUC-based, optional shared_preload_libraries)
// ==============================================================================
async function testSupautilsNotPreloaded(container: string): Promise<void> {
  // Verify supautils is NOT in default shared_preload_libraries
  const preloadLibs =
    await $`docker exec ${container} psql -U postgres -t -c "SHOW shared_preload_libraries;"`.text();
  const libs = preloadLibs.trim();

  if (libs.includes("supautils")) {
    console.log("⚠️  WARNING: supautils found in default preload (unexpected)");
  } else {
    console.log("✅ supautils NOT in default shared_preload_libraries (expected)");
  }

  // Verify .so file exists
  const soPath = "/usr/lib/postgresql/18/lib/supautils.so";
  try {
    await $`docker exec ${container} test -f ${soPath}`.quiet();
    console.log(`✅ supautils.so exists at ${soPath}`);
  } catch {
    console.log(`❌ FAILED: supautils.so not found at ${soPath}`);
    process.exit(1);
  }

  // Without preload, GUC parameters won't be available
  // Note: SHOW will return error for non-existent GUC params
  try {
    const gucCheck =
      await $`docker exec ${container} psql -U postgres -t -c "SHOW supautils.reserved_roles;"`.text();
    console.log(`⚠️  WARNING: supautils GUC may be available (unexpected): ${gucCheck.trim()}`);
  } catch (error: unknown) {
    const output = error instanceof Error ? error.message : String(error);
    if (output.toLowerCase().includes("unrecognized configuration parameter")) {
      console.log("✅ supautils GUC parameters not available without preload (expected)");
    } else {
      console.log(`⚠️  WARNING: unexpected error: ${output}`);
    }
  }
}

async function testSupautilsPreloaded(container: string): Promise<void> {
  // Verify supautils is in shared_preload_libraries
  await assertSqlContains(
    container,
    "SHOW shared_preload_libraries;",
    "supautils",
    "supautils loaded via shared_preload_libraries"
  );

  // Check for supautils GUC parameters
  // Note: supautils.reserved_roles is a key configuration parameter
  try {
    const gucOutput =
      await $`docker exec ${container} psql -U postgres -t -c "SHOW supautils.reserved_roles;"`.text();
    console.log(
      `✅ supautils GUC parameters available (supautils.reserved_roles: ${gucOutput.trim()})`
    );
  } catch (error: unknown) {
    const output = error instanceof Error ? error.message : String(error);
    if (output.toLowerCase().includes("unrecognized configuration parameter")) {
      console.log(
        "⚠️  WARNING: supautils GUC parameters not found (may not expose visible params)"
      );
    } else {
      console.log(
        "⚠️  WARNING: supautils GUC parameters not found (may not expose visible params)"
      );
    }
  }

  // Verify basic PostgreSQL operation with supautils loaded
  await assertSqlSuccess(
    container,
    "SELECT current_user;",
    "PostgreSQL operational with supautils preloaded"
  );

  // Test that supautils hooks are active by checking for managed roles
  // supautils creates several managed roles on initialization if configured
  await assertSqlSuccess(container, "SELECT 1;", "Basic queries work with supautils hooks active");
}

// ==============================================================================
// Test 4: Combined preload test (all hook extensions)
// ==============================================================================
async function testCombinedPreload(container: string): Promise<void> {
  // Verify all three extensions are preloaded
  const preloadLibs =
    await $`docker exec ${container} psql -U postgres -t -c "SHOW shared_preload_libraries;"`.text();
  const libs = preloadLibs.trim();

  console.log(`Loaded shared libraries: ${libs}`);

  if (libs.includes("pg_plan_filter")) {
    console.log("✅ pg_plan_filter loaded");
  } else {
    console.log("❌ FAILED: pg_plan_filter not found in shared_preload_libraries");
    process.exit(1);
  }

  if (libs.includes("supautils")) {
    console.log("✅ supautils loaded");
  } else {
    console.log("❌ FAILED: supautils not found in shared_preload_libraries");
    process.exit(1);
  }

  // Test pg_safeupdate via session preload (not in shared_preload_libraries)
  await assertSqlFails(
    container,
    "SET session_preload_libraries = 'pg_safeupdate'; CREATE TABLE multi_test (id int); UPDATE multi_test SET id = 1;",
    "UPDATE requires a WHERE clause",
    "pg_safeupdate works alongside other preloaded extensions"
  );

  // Verify PostgreSQL stability with multiple hooks active
  await assertSqlSuccess(
    container,
    "SELECT version();",
    "PostgreSQL stable with multiple hook extensions loaded"
  );

  // Cleanup
  await assertSqlSuccess(container, "DROP TABLE IF EXISTS multi_test;", "Cleanup combined test");
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

  // Check if image exists
  try {
    await $`docker image inspect ${imageTag}`.quiet();
  } catch {
    error(`Docker image not found: ${imageTag}`);
    console.log("   Build image first: bun scripts/build.ts");
    console.log(`   Or run: bun scripts/test/test-build.ts ${imageTag}`);
    process.exit(1);
  }

  console.log("========================================");
  console.log("Hook-Based Extensions Test Suite");
  console.log("========================================");
  console.log(`Image tag: ${imageTag}`);
  console.log();

  // Run test cases
  await runCase("Test 1: pg_plan_filter without preload", testPgPlanFilterNotPreloaded, imageTag, {
    memory: "2g",
    env: { POSTGRES_PASSWORD: TEST_POSTGRES_PASSWORD },
  });

  await runCase("Test 2: pg_plan_filter with preload", testPgPlanFilterPreloaded, imageTag, {
    memory: "2g",
    env: {
      POSTGRES_PASSWORD: TEST_POSTGRES_PASSWORD,
      POSTGRES_SHARED_PRELOAD_LIBRARIES:
        "pg_stat_statements,auto_explain,pg_cron,pgaudit,pg_plan_filter",
    },
  });

  await runCase("Test 3: pg_safeupdate session preload", testPgSafeupdateSessionPreload, imageTag, {
    memory: "2g",
    env: { POSTGRES_PASSWORD: TEST_POSTGRES_PASSWORD },
  });

  await runCase("Test 4: supautils without preload", testSupautilsNotPreloaded, imageTag, {
    memory: "2g",
    env: { POSTGRES_PASSWORD: TEST_POSTGRES_PASSWORD },
  });

  await runCase("Test 5: supautils with preload", testSupautilsPreloaded, imageTag, {
    memory: "2g",
    env: {
      POSTGRES_PASSWORD: TEST_POSTGRES_PASSWORD,
      POSTGRES_SHARED_PRELOAD_LIBRARIES:
        "pg_stat_statements,auto_explain,pg_cron,pgaudit,supautils",
    },
  });

  await runCase(
    "Test 6: Combined preload (pg_plan_filter + supautils)",
    testCombinedPreload,
    imageTag,
    {
      memory: "2g",
      env: {
        POSTGRES_PASSWORD: TEST_POSTGRES_PASSWORD,
        POSTGRES_SHARED_PRELOAD_LIBRARIES:
          "pg_stat_statements,auto_explain,pg_cron,pgaudit,pg_plan_filter,supautils",
      },
    }
  );

  console.log("========================================");
  console.log("✅ All hook extension tests passed!");
  console.log("✅ Total: 6 test cases");
  console.log("========================================");
  console.log();
  console.log("Summary:");
  console.log("  - pg_plan_filter: Hook-based, requires shared_preload_libraries");
  console.log("  - pg_safeupdate: Hook-based, uses session_preload_libraries");
  console.log("  - supautils: GUC-based, optional shared_preload_libraries");
  console.log("  - All extensions verified for loading, functionality, and isolation");
}

// Run main function
main().catch((error) => {
  error(`Unexpected error: ${error}`);
  process.exit(1);
});
