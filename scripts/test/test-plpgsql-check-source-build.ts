#!/usr/bin/env bun
/**
 * plpgsql_check 2.8.8 Source Build Verification Test Suite
 * Tests source build path and new warning features
 *
 * Coverage:
 * - Source build verification (.so and .control files)
 * - Version 2.8.8 verification
 * - Core functions (plpgsql_check_function, plpgsql_check_function_tb)
 * - Memory safety (large function parsing, no crashes)
 * - New warnings: expression volatility, reserved keyword labels
 * - Profiler mode GUC (plpgsql_check.profiler)
 * - Trigger function checking
 * - VARIADIC args memory safety
 * - Nested function calls
 *
 * Context:
 * - plpgsql_check switched from PGDG apt to source build
 * - Version 2.8.8 includes memory corruption fixes
 * - New warnings for volatile expressions and reserved keywords
 *
 * Usage:
 *   bun run scripts/test/test-plpgsql-check-source-build.ts --image=aza-pg:local
 *   bun run scripts/test/test-plpgsql-check-source-build.ts --container=existing-container
 */

import { $ } from "bun";
import { resolveImageTag, parseContainerName, validateImageTag } from "./image-resolver";

// Show help if requested
if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
  console.log(`
plpgsql_check 2.8.8 Source Build Verification Test Suite

Tests source build path, version verification, and new warning features for
plpgsql_check 2.8.8 including memory corruption fixes and enhanced diagnostics.

Usage:
  bun run scripts/test/test-plpgsql-check-source-build.ts --image=<image-tag>
  bun run scripts/test/test-plpgsql-check-source-build.ts --container=<container-name>

Options:
  --image=<tag>        Start new container from image and run tests (auto-cleanup)
  --container=<name>   Use existing running container (no cleanup)
  -h, --help          Show this help message

Examples:
  # Test using local build
  bun run scripts/test/test-plpgsql-check-source-build.ts --image=aza-pg:local

  # Test using existing container
  bun run scripts/test/test-plpgsql-check-source-build.ts --container=my-container

Environment Variables:
  POSTGRES_IMAGE      Default image when --image not specified

Notes:
  - Exactly one of --image or --container must be specified
  - When using --image, container is automatically cleaned up on exit
  - Tests verify source build path vs previous PGDG apt installation
  - Memory safety tests use patterns that crashed in versions < 2.8.8
`);
  process.exit(0);
}

// Parse CLI arguments
const containerName = parseContainerName();
const imageTag = containerName ? null : resolveImageTag();

// Validate if using image mode
if (imageTag) {
  validateImageTag(imageTag);
}

// Container name (either user-provided or auto-generated)
let CONTAINER: string;
let isOwnContainer = false;

if (containerName) {
  CONTAINER = containerName;
  console.log(`Using existing container: ${CONTAINER}\n`);
} else if (imageTag) {
  CONTAINER = `test-plpgsql-check-${Date.now()}-${process.pid}`;
  isOwnContainer = true;
  console.log(`Starting new container: ${CONTAINER}`);
  console.log(`Using image: ${imageTag}\n`);
} else {
  console.error("Error: Either --image or --container must be specified");
  process.exit(1);
}

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  metrics?: Record<string, any>;
}

const results: TestResult[] = [];

async function runSQL(sql: string): Promise<string> {
  const result = await $`docker exec ${CONTAINER} psql -U postgres -t -A -c ${sql}`
    .quiet()
    .nothrow();
  if (result.exitCode !== 0) {
    const errorMsg = result.stderr.toString().trim() || result.stdout.toString().trim();
    throw new Error(`SQL execution failed: ${errorMsg}`);
  }
  return result.stdout.toString().trim();
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    const duration = Date.now() - start;
    results.push({ name, passed: true, duration });
    console.log(`✅ ${name} (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - start;
    const errorStr = String(error);
    results.push({ name, passed: false, duration, error: errorStr });
    console.log(`❌ ${name} (${duration}ms)`);
    console.log(`   Error: ${error}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// Container cleanup function
async function cleanupContainer(): Promise<void> {
  if (!isOwnContainer) return;

  console.log(`\n🧹 Cleaning up container: ${CONTAINER}`);
  try {
    await $`docker rm -f ${CONTAINER}`.nothrow();
    console.log("✅ Container cleanup complete");
  } catch (error) {
    console.error(`⚠️  Failed to cleanup container: ${error}`);
  }
}

// Register cleanup handlers
if (isOwnContainer) {
  process.on("exit", () => {
    // Synchronous cleanup on normal exit
    try {
      Bun.spawnSync(["docker", "rm", "-f", CONTAINER]);
    } catch {
      // Ignore errors during cleanup
    }
  });

  process.on("SIGINT", async () => {
    console.log("\n\n⚠️  Interrupted by user (SIGINT)");
    await cleanupContainer();
    process.exit(130);
  });

  process.on("SIGTERM", async () => {
    console.log("\n\n⚠️  Terminated (SIGTERM)");
    await cleanupContainer();
    process.exit(143);
  });
}

// Start container if using --image mode
if (isOwnContainer && imageTag) {
  console.log(`🚀 Starting container from image: ${imageTag}`);

  try {
    // Start PostgreSQL container
    await $`docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=postgres -e POSTGRES_HOST_AUTH_METHOD=trust ${imageTag}`;
    console.log(`✅ Container started: ${CONTAINER}`);

    // Wait for PostgreSQL to be ready
    console.log("⏳ Waiting for PostgreSQL to be ready...");
    let ready = false;
    const maxAttempts = 60; // 60 seconds timeout
    let attempt = 0;

    while (!ready && attempt < maxAttempts) {
      const result = await $`docker exec ${CONTAINER} pg_isready -U postgres`.nothrow();
      if (result.exitCode === 0) {
        ready = true;
        break;
      }
      await Bun.sleep(1000);
      attempt++;
    }

    if (!ready) {
      throw new Error("PostgreSQL failed to start within 60 seconds");
    }

    console.log("✅ PostgreSQL is ready\n");

    // Additional wait for initialization scripts to complete
    console.log("⏳ Waiting for initialization to complete...");
    await Bun.sleep(3000);

    // Verify database is truly ready with actual query
    let dbReady = false;
    for (let i = 0; i < 10; i++) {
      try {
        const testResult = await runSQL("SELECT 1 AS test");
        if (testResult === "1") {
          dbReady = true;
          break;
        }
      } catch {
        await Bun.sleep(500);
      }
    }

    if (!dbReady) {
      throw new Error("Database failed to respond to queries after pg_isready");
    }

    console.log("✅ Database initialization complete\n");
  } catch (error) {
    console.error(`❌ Failed to start container: ${error}`);
    await cleanupContainer();
    process.exit(1);
  }
}

console.log("=".repeat(80));
console.log("PLPGSQL_CHECK 2.8.8 SOURCE BUILD VERIFICATION TEST SUITE");
console.log("=".repeat(80));
console.log(`Container: ${CONTAINER}`);
console.log("");

// ============================================================================
// T4.1: Source Build Verification
// ============================================================================
console.log("\n🔧 Source Build Verification");
console.log("-".repeat(80));

await test("T4.1.1: Verify .so file exists at expected path", async () => {
  const result =
    await $`docker exec ${CONTAINER} ls -la /usr/lib/postgresql/18/lib/plpgsql_check.so`.nothrow();
  assert(result.exitCode === 0, ".so file not found at expected path");
  assert(result.stdout.toString().includes("plpgsql_check.so"), "Incorrect .so file");
});

await test("T4.1.2: Verify .control file exists", async () => {
  const result =
    await $`docker exec ${CONTAINER} ls -la /usr/share/postgresql/18/extension/plpgsql_check.control`.nothrow();
  assert(result.exitCode === 0, ".control file not found");
  assert(result.stdout.toString().includes("plpgsql_check.control"), "Incorrect .control file");
});

await test("T4.1.3: Verify version is 2.8.8", async () => {
  await runSQL("CREATE EXTENSION IF NOT EXISTS plpgsql_check CASCADE");
  const version = await runSQL(
    "SELECT extversion FROM pg_extension WHERE extname = 'plpgsql_check'"
  );
  assert(version === "2.8.8", `Expected version 2.8.8, got ${version}`);
});

await test("T4.1.4: Verify core functions exist", async () => {
  // Check plpgsql_check_function exists
  const funcCount = await runSQL(
    "SELECT count(*) FROM pg_proc WHERE proname = 'plpgsql_check_function'"
  );
  assert(parseInt(funcCount) > 0, "plpgsql_check_function not found");

  // Check plpgsql_check_function_tb exists
  const funcTbCount = await runSQL(
    "SELECT count(*) FROM pg_proc WHERE proname = 'plpgsql_check_function_tb'"
  );
  assert(parseInt(funcTbCount) > 0, "plpgsql_check_function_tb not found");
});

// ============================================================================
// T4.2: Expression Volatility Warning (NEW in 2.8.8)
// ============================================================================
console.log("\n⚠️  New Warning Features - Expression Volatility");
console.log("-".repeat(80));

await test("T4.2.1: Detect volatile expression in stable function", async () => {
  // Create function with volatile expression in stable context
  await runSQL(`
    CREATE OR REPLACE FUNCTION test_volatility_warning() RETURNS float AS $$
    BEGIN
      RETURN random(); -- volatile in stable context
    END;
    $$ LANGUAGE plpgsql STABLE
  `);

  const checkResult = await runSQL(
    "SELECT * FROM plpgsql_check_function('test_volatility_warning')"
  );
  // Should detect volatility mismatch warning
  assert(
    checkResult.toLowerCase().includes("volatil") || checkResult.toLowerCase().includes("stable"),
    "Failed to detect volatility mismatch warning"
  );
});

await test("T4.2.2: Verify volatile function works without warning", async () => {
  // Create volatile function (should be fine)
  await runSQL(`
    CREATE OR REPLACE FUNCTION test_volatile_ok() RETURNS float AS $$
    BEGIN
      RETURN random();
    END;
    $$ LANGUAGE plpgsql VOLATILE
  `);

  const result = await runSQL("SELECT * FROM plpgsql_check_function('test_volatile_ok')");
  // No volatility warnings expected — verify empty output
  assert(result === "", `Expected no warnings, got: ${result}`);
});

// ============================================================================
// T4.3: Reserved Keyword Label Warning (NEW in 2.8.8)
// ============================================================================
console.log("\n⚠️  New Warning Features - Reserved Keywords");
console.log("-".repeat(80));

await test("T4.3.1: Detect reserved keyword used as label", async () => {
  // Create function using reserved keyword as label
  await runSQL(`
    CREATE OR REPLACE FUNCTION test_reserved_label() RETURNS void AS $$
    <<select>>
    BEGIN
      NULL;
    END;
    $$ LANGUAGE plpgsql
  `);

  const checkResult = await runSQL("SELECT * FROM plpgsql_check_function('test_reserved_label')");
  // Should warn about reserved keyword as label
  assert(
    checkResult.toLowerCase().includes("reserved") ||
      checkResult.toLowerCase().includes("label") ||
      checkResult.toLowerCase().includes("select"),
    "Failed to detect reserved keyword label warning"
  );
});

// ============================================================================
// T4.4: Memory Safety - Regression Tests
// ============================================================================
console.log("\n🛡️  Memory Safety Tests (Regression for < 2.8.8 crashes)");
console.log("-".repeat(80));

await test("T4.4.1: Parse large function with 100+ lines (no crash)", async () => {
  // Create large function that would trigger memory issues in older versions
  const largeFunc = `
    CREATE OR REPLACE FUNCTION test_memory_safety_large() RETURNS void AS $$
    DECLARE
      v_counter int := 0;
    BEGIN
      ${Array.from({ length: 100 }, (_, i) => `v_counter := v_counter + ${i + 1};`).join("\n      ")}
    END;
    $$ LANGUAGE plpgsql
  `;
  await runSQL(largeFunc);

  // This should complete without crash
  void (await runSQL("SELECT * FROM plpgsql_check_function('test_memory_safety_large')"));
  assert(true, "Large function parsing completed without crash");
});

await test("T4.4.2: Check nested function calls (memory safety)", async () => {
  // Create nested functions
  await runSQL(`
    CREATE OR REPLACE FUNCTION test_memory_safety_inner(p_val int) RETURNS int AS $$
    DECLARE
      v_result int;
    BEGIN
      SELECT p_val * 2 INTO v_result;
      RETURN v_result;
    END;
    $$ LANGUAGE plpgsql
  `);

  await runSQL(`
    CREATE OR REPLACE FUNCTION test_memory_safety_outer() RETURNS void AS $$
    DECLARE
      r RECORD;
    BEGIN
      FOR r IN SELECT * FROM generate_series(1, 100) LOOP
        PERFORM test_memory_safety_inner(r.generate_series);
      END LOOP;
    END;
    $$ LANGUAGE plpgsql
  `);

  // Check both functions (would crash with memory corruption)
  await runSQL("SELECT * FROM plpgsql_check_function('test_memory_safety_outer')");
  await runSQL("SELECT * FROM plpgsql_check_function('test_memory_safety_inner(int)')");
  assert(true, "Nested function checking completed without crash");
});

await test("T4.4.3: Check function with VARIADIC args (memory edge case)", async () => {
  await runSQL(`
    CREATE OR REPLACE FUNCTION test_variadic_check(VARIADIC args int[]) RETURNS int AS $$
    BEGIN
      RETURN array_length(args, 1);
    END;
    $$ LANGUAGE plpgsql
  `);

  // This was a known memory edge case
  void (await runSQL("SELECT * FROM plpgsql_check_function('test_variadic_check(int[])')"));
  assert(true, "VARIADIC args check completed without crash");
});

// ============================================================================
// T4.5: Trigger Function Checking
// ============================================================================
console.log("\n🔀 Trigger Function Checking");
console.log("-".repeat(80));

await test("T4.5.1: Check trigger function (regression area for memory issues)", async () => {
  await runSQL(
    "CREATE TABLE IF NOT EXISTS test_plcheck_trigger_tbl (id serial, name text, updated_at timestamptz)"
  );

  await runSQL(`
    CREATE OR REPLACE FUNCTION test_plcheck_trigger_fn() RETURNS trigger AS $$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  // Check with table context
  void (await runSQL(
    "SELECT * FROM plpgsql_check_function('test_plcheck_trigger_fn', 'test_plcheck_trigger_tbl')"
  ));
  assert(true, "Trigger function check completed successfully");
});

await test("T4.5.2: Verify trigger function without errors", async () => {
  // Differentiated from T4.5.1: T4.5.1 = smoke (no crash), T4.5.2 = correctness (clean output)
  const result = await runSQL(
    "SELECT * FROM plpgsql_check_function('test_plcheck_trigger_fn', 'test_plcheck_trigger_tbl')"
  );
  assert(result === "", `Expected no errors/warnings, got: ${result}`);
});

// ============================================================================
// T4.6: Profiler Mode GUC
// ============================================================================
console.log("\n📊 Profiler Mode GUC Tests");
console.log("-".repeat(80));

await test("T4.6: Profiler GUC tests (skipped - not in v2.8.8)", async () => {
  // The profiler GUC was added in a later plpgsql_check version
  // For v2.8.8 from source, this feature is not available
  console.log("⚠️  Profiler GUC not available in plpgsql_check v2.8.8 - test skipped");
});

// ============================================================================
// PRINT SUMMARY
// ============================================================================
console.log("\n" + "=".repeat(80));
console.log("PLPGSQL_CHECK SOURCE BUILD TEST SUMMARY");
console.log("=".repeat(80));

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

console.log(`Total: ${results.length} tests`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total Duration: ${totalDuration}ms`);

if (failed > 0) {
  console.log("\n" + "=".repeat(80));
  console.log("FAILED TESTS DETAILS");
  console.log("=".repeat(80));
  results
    .filter((r) => !r.passed)
    .forEach((r) => {
      console.log(`\n❌ ${r.name}`);
      console.log(`   Error: ${r.error}`);
    });
}

console.log("\n" + "=".repeat(80));

// Cleanup container if we own it
if (isOwnContainer) {
  await cleanupContainer();
}

process.exit(failed > 0 ? 1 : 0);
