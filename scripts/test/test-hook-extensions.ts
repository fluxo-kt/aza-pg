#!/usr/bin/env bun
/**
 * Test script: Validate hook-based extensions that load via shared_preload_libraries
 * Usage: bun run scripts/test/test-hook-extensions.ts [image-tag]
 *
 * Tests extensions that don't use CREATE EXTENSION:
 *   - pg_safeupdate (hook-based, default-enabled in shared_preload_libraries)
 *
 * Note: pg_plan_filter removed (incompatible with PostgreSQL 18)
 * Note: supautils removed (disabled - compilation issues)
 *
 * Examples:
 *   bun run scripts/test/test-hook-extensions.ts                    # Use default tag 'ghcr.io/fluxo-kt/aza-pg:pg18'
 *   bun run scripts/test/test-hook-extensions.ts my-custom:tag      # Use custom tag
 */

import { $ } from "bun";
import {
  checkCommand,
  checkDockerDaemon,
  dockerCleanup,
  ensureImageAvailable,
  waitForPostgresStable,
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
    await $`docker exec ${container} psql -U postgres -t -c ${sql}`;
    console.log(`✅ ${message}`);
  } catch (err) {
    console.log(`❌ FAILED: ${message}`);
    console.log(`   SQL: ${sql}`);
    console.log(`   Error: ${err}`);
    process.exit(1);
  }
}

/**
 * Assert SQL command fails with expected error pattern
 */
async function assertSqlFails(
  container: string,
  sql: string,
  errorPatterns: string[],
  message: string
): Promise<void> {
  const result = await Bun.spawn(
    ["docker", "exec", container, "psql", "-U", "postgres", "-t", "-c", sql],
    { stdout: "pipe", stderr: "pipe" }
  );

  const stdout = await new Response(result.stdout).text();
  const stderr = await new Response(result.stderr).text();
  const exitCode = await result.exited;
  const output = (stdout + stderr).toLowerCase();

  if (exitCode === 0) {
    console.log(`❌ FAILED: ${message}`);
    console.log(`   Expected failure but command succeeded`);
    console.log(`   SQL: ${sql}`);
    process.exit(1);
  }

  const matchedPattern = errorPatterns.some((pattern) => output.includes(pattern.toLowerCase()));
  if (matchedPattern) {
    console.log(`✅ ${message}`);
  } else {
    console.log(`❌ FAILED: ${message}`);
    console.log(`   Expected error patterns: ${errorPatterns.join(" | ")}`);
    console.log(`   Actual output: ${stdout}${stderr}`);
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

    // Wait for PostgreSQL to be stable (handles initdb restart race condition)
    // NOTE: waitForPostgresStable includes basic readiness check + stability verification
    const isStable = await waitForPostgresStable({ container, timeout: 60 });
    if (!isStable) {
      console.log(`❌ FAILED: PostgreSQL not ready or not stable after init`);
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
  } catch (err) {
    console.log(`❌ ERROR: Failed to start container for '${name}'`);
    console.log(err);
    await dockerCleanup(container);
    process.exit(1);
  }

  console.log();
}

// ==============================================================================
// Test 1: pg_safeupdate default-enabled (blocks unsafe operations by default)
// ==============================================================================
async function testPgSafeupdateDefaultEnabled(container: string): Promise<void> {
  // Verify safeupdate.so exists (note: library name is "safeupdate", not "pg_safeupdate")
  const soPath = "/usr/lib/postgresql/18/lib/safeupdate.so";
  try {
    await $`docker exec ${container} test -f ${soPath}`.quiet();
    console.log(`✅ safeupdate.so exists at ${soPath}`);
  } catch {
    console.log(`❌ FAILED: safeupdate.so not found at ${soPath}`);
    process.exit(1);
  }

  // Verify safeupdate is in shared_preload_libraries
  const preloadLibs =
    await $`docker exec ${container} psql -U postgres -t -c "SHOW shared_preload_libraries;"`.text();
  if (preloadLibs.toLowerCase().includes("safeupdate")) {
    console.log(`✅ safeupdate is in shared_preload_libraries`);
  } else {
    console.log(`❌ FAILED: safeupdate not found in shared_preload_libraries`);
    console.log(`   Actual: ${preloadLibs.trim()}`);
    process.exit(1);
  }

  // Create test table and data
  await assertSqlSuccess(
    container,
    "CREATE TABLE IF NOT EXISTS safeupdate_test (id int)",
    "Create test table for pg_safeupdate"
  );

  await assertSqlSuccess(
    container,
    "INSERT INTO safeupdate_test VALUES (1), (2)",
    "Insert test data for pg_safeupdate"
  );

  // Test: UPDATE without WHERE should FAIL (safeupdate is default-enabled)
  await assertSqlFails(
    container,
    "UPDATE safeupdate_test SET id = 99;",
    ["update requires a where clause", "rejected by safeupdate"],
    "UPDATE without WHERE is blocked by default (safeupdate enabled)"
  );

  // Test: UPDATE with WHERE should succeed
  await assertSqlSuccess(
    container,
    "UPDATE safeupdate_test SET id = 99 WHERE id = 1;",
    "UPDATE with WHERE succeeds (safe operation)"
  );

  // Test: DELETE without WHERE should FAIL
  await assertSqlFails(
    container,
    "DELETE FROM safeupdate_test;",
    ["delete requires a where clause", "rejected by safeupdate"],
    "DELETE without WHERE is blocked by default (safeupdate enabled)"
  );

  // Test: DELETE with WHERE should succeed
  await assertSqlSuccess(
    container,
    "DELETE FROM safeupdate_test WHERE id = 99;",
    "DELETE with WHERE succeeds (safe operation)"
  );

  // Cleanup
  await assertSqlSuccess(container, "DROP TABLE safeupdate_test;", "Cleanup safeupdate test table");
}

// ==============================================================================
// Test 2: pg_safeupdate override (user can disable via POSTGRES_SHARED_PRELOAD_LIBRARIES)
// ==============================================================================
async function testPgSafeupdateOverride(container: string): Promise<void> {
  // Verify safeupdate is NOT in shared_preload_libraries (user override)
  const preloadLibs =
    await $`docker exec ${container} psql -U postgres -t -c "SHOW shared_preload_libraries;"`.text();
  if (preloadLibs.toLowerCase().includes("safeupdate")) {
    console.log(
      `❌ FAILED: safeupdate should NOT be in shared_preload_libraries (override active)`
    );
    console.log(`   Actual: ${preloadLibs.trim()}`);
    process.exit(1);
  } else {
    console.log(`✅ safeupdate is NOT in shared_preload_libraries (override active)`);
  }

  // Create test table and data
  await assertSqlSuccess(
    container,
    "CREATE TABLE IF NOT EXISTS safeupdate_test (id int)",
    "Create test table for pg_safeupdate override test"
  );

  await assertSqlSuccess(
    container,
    "INSERT INTO safeupdate_test VALUES (1), (2)",
    "Insert test data for pg_safeupdate override test"
  );

  // Test: UPDATE without WHERE should SUCCEED (safeupdate disabled via override)
  await assertSqlSuccess(
    container,
    "UPDATE safeupdate_test SET id = 99;",
    "UPDATE without WHERE succeeds (safeupdate disabled via override)"
  );

  // Reset table for DELETE test
  await assertSqlSuccess(
    container,
    "TRUNCATE safeupdate_test; INSERT INTO safeupdate_test VALUES (1), (2);",
    "Reset test table"
  );

  // Test: DELETE without WHERE should SUCCEED (safeupdate disabled via override)
  await assertSqlSuccess(
    container,
    "DELETE FROM safeupdate_test;",
    "DELETE without WHERE succeeds (safeupdate disabled via override)"
  );

  // Cleanup
  await assertSqlSuccess(
    container,
    "DROP TABLE safeupdate_test;",
    "Cleanup safeupdate override test table"
  );
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

  const imageTag = Bun.argv[2] ?? Bun.env.POSTGRES_IMAGE ?? "ghcr.io/fluxo-kt/aza-pg:pg18";

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

  // Test 1: pg_safeupdate default-enabled behavior
  await runCase(
    "Test 1: pg_safeupdate default-enabled (blocks unsafe operations)",
    testPgSafeupdateDefaultEnabled,
    imageTag,
    {
      memory: "2g",
      env: { POSTGRES_PASSWORD: TEST_POSTGRES_PASSWORD },
    }
  );

  // Test 2: pg_safeupdate override (user can disable)
  // Use explicit POSTGRES_SHARED_PRELOAD_LIBRARIES without safeupdate
  await runCase(
    "Test 2: pg_safeupdate override (user can disable via env)",
    testPgSafeupdateOverride,
    imageTag,
    {
      memory: "2g",
      env: {
        POSTGRES_PASSWORD: TEST_POSTGRES_PASSWORD,
        // Explicitly omit safeupdate from preload libraries
        POSTGRES_SHARED_PRELOAD_LIBRARIES:
          "auto_explain,pg_cron,pg_stat_monitor,pg_stat_statements,pgaudit,timescaledb",
      },
    }
  );

  console.log("========================================");
  console.log("✅ All hook extension tests passed!");
  console.log("✅ Total: 2 test cases");
  console.log("========================================");
  console.log();
  console.log("Summary:");
  console.log("  - pg_safeupdate: Default-enabled via shared_preload_libraries");
  console.log("  - Default behavior: Blocks UPDATE/DELETE without WHERE clause");
  console.log("  - Override: Users can disable via POSTGRES_SHARED_PRELOAD_LIBRARIES");
  console.log();
  console.log("Notes:");
  console.log("  - pg_plan_filter excluded (incompatible with PostgreSQL 18)");
  console.log("  - supautils excluded (disabled due to compilation issues)");
}

// Run main function
main().catch((err) => {
  error(`Unexpected error: ${err}`);
  process.exit(1);
});
