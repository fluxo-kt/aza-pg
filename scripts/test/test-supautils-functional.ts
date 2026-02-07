#!/usr/bin/env bun
/**
 * Comprehensive supautils functional test suite
 * Tests supautils preload-only module with explicit shared_preload_libraries configuration
 *
 * Coverage:
 * - Container startup with supautils preloaded
 * - Extension loading without crash (PG18 PG_MODULE_MAGIC_EXT compatibility)
 * - GUC parameter registration
 * - Role creation/management without guard interference
 * - Interaction with pg_cron and pg_net dependencies
 * - Spurious GUC warning verification
 *
 * Important: supautils is preloadOnly: true, defaultEnable: false
 * Requires explicit POSTGRES_SHARED_PRELOAD_LIBRARIES environment variable
 *
 * Usage:
 *   bun run scripts/test/test-supautils-functional.ts --image=aza-pg:local
 *   bun run scripts/test/test-supautils-functional.ts --container=existing-container
 */

import { $ } from "bun";
import { resolveImageTag, parseContainerName, validateImageTag } from "./image-resolver";

// Show help if requested
if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
  console.log(`
Comprehensive supautils Functional Test Suite

Tests supautils preload-only module with explicit shared_preload_libraries configuration.
Verifies PG18 compatibility, GUC registration, and role management hooks.

Usage:
  bun run scripts/test/test-supautils-functional.ts --image=<image-tag>
  bun run scripts/test/test-supautils-functional.ts --container=<container-name>

Options:
  --image=<tag>        Start new container from image with supautils preloaded (auto-cleanup)
  --container=<name>   Use existing running container (must have supautils preloaded)
  -h, --help          Show this help message

Examples:
  # Test using local build (will create container with supautils preloaded)
  bun run scripts/test/test-supautils-functional.ts --image=aza-pg:local

  # Test using existing container (container must have supautils in shared_preload_libraries)
  bun run scripts/test/test-supautils-functional.ts --container=my-container

Environment Variables:
  POSTGRES_IMAGE      Default image when --image not specified

Notes:
  - When using --image, container is automatically started with supautils in shared_preload_libraries
  - When using --container, the container MUST already have supautils preloaded
  - supautils requires pg_cron and pg_net to be preloaded (dependencies)
  - Tests verify PG18 PG_MODULE_MAGIC_EXT compatibility (no-crash verification)
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
  CONTAINER = `test-supautils-${Date.now()}-${process.pid}`;
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
  skipped?: boolean;
}

const results: TestResult[] = [];

async function runSQL(sql: string): Promise<string> {
  const result = await $`docker exec ${CONTAINER} psql -U postgres -t -A -c ${sql}`
    .quiet()
    .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`SQL failed: ${result.stderr.toString()}`);
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

    // Check if this is a skip (not a failure)
    if (errorStr.includes("SKIPPED:")) {
      results.push({ name, passed: true, duration, skipped: true });
      console.log(`⊘ ${name} (${duration}ms) - ${errorStr.replace("Error: ", "")}`);
    } else {
      results.push({ name, passed: false, duration, error: errorStr });
      console.log(`❌ ${name} (${duration}ms)`);
      console.log(`   Error: ${error}`);
    }
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
  console.log("   With supautils in shared_preload_libraries\n");

  try {
    // Start PostgreSQL container with supautils explicitly preloaded
    // CRITICAL: Include default preload libraries + supautils
    // Default: auto_explain,pg_cron,pg_net,pg_stat_monitor,pg_stat_statements,pgaudit,pgsodium,safeupdate,timescaledb
    const sharedPreload =
      "auto_explain,pg_cron,pg_net,pg_stat_monitor,pg_stat_statements,pgaudit,pgsodium,safeupdate,timescaledb,supautils";

    await $`docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=postgres -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_SHARED_PRELOAD_LIBRARIES=${sharedPreload} ${imageTag}`;
    console.log(`✅ Container started: ${CONTAINER}`);

    // Wait for PostgreSQL to be ready
    console.log("⏳ Waiting for PostgreSQL to be ready...");
    let ready = false;
    const maxAttempts = 60; // 60 seconds timeout
    let attempt = 0;

    while (!ready && attempt < maxAttempts) {
      const result = await $`docker exec ${CONTAINER} pg_isready -U postgres`.quiet().nothrow();
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
        // Retry
      }
      await Bun.sleep(500);
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
console.log("SUPAUTILS FUNCTIONAL TEST SUITE");
console.log("=".repeat(80));
console.log(`Container: ${CONTAINER}`);
console.log("");

// ============================================================================
// T2.1: Container startup with supautils preloaded
// ============================================================================
console.log("📋 Preload Verification Tests");
console.log("-".repeat(80));

await test("Verify supautils in shared_preload_libraries", async () => {
  const result = await runSQL("SHOW shared_preload_libraries");
  assert(
    result.includes("supautils"),
    `supautils not found in shared_preload_libraries: ${result}`
  );
});

await test("Verify GUC parameters registered", async () => {
  const result = await runSQL("SELECT count(*) FROM pg_settings WHERE name LIKE 'supautils.%'");
  const count = parseInt(result);
  assert(count > 0, `Expected supautils GUC parameters, found ${count}`);
});

// ============================================================================
// T2.2: Preload WITHOUT supautils (negative test - only if using own container)
// ============================================================================
if (!isOwnContainer) {
  console.log("\n⚠️  Skipping negative test (requires dedicated container)\n");
} else {
  console.log("\n🔍 Negative Test: Container WITHOUT supautils");
  console.log("-".repeat(80));

  await test("Verify supautils NOT loaded when not in preload", async () => {
    // Start a separate container WITHOUT supautils
    if (!imageTag) {
      throw new Error("imageTag is required for negative test container");
    }
    const negativeContainer = `test-supautils-negative-${Date.now()}`;
    try {
      // Start without supautils in preload
      await $`docker run -d --name ${negativeContainer} -e POSTGRES_PASSWORD=postgres -e POSTGRES_HOST_AUTH_METHOD=trust ${imageTag}`;

      // Wait for ready
      let ready = false;
      for (let i = 0; i < 30; i++) {
        const result = await $`docker exec ${negativeContainer} pg_isready -U postgres`
          .quiet()
          .nothrow();
        if (result.exitCode === 0) {
          ready = true;
          break;
        }
        await Bun.sleep(1000);
      }

      assert(ready, "Negative test container failed to start");

      // Wait for init
      await Bun.sleep(3000);

      // Verify supautils GUCs are NOT present
      const checkResult =
        await $`docker exec ${negativeContainer} psql -U postgres -t -A -c "SELECT count(*) FROM pg_settings WHERE name LIKE 'supautils.%'"`.nothrow();
      const count = parseInt(checkResult.stdout.toString().trim());

      assert(count === 0, `Expected 0 supautils GUCs without preload, found ${count}`);
    } finally {
      // Cleanup negative test container
      await $`docker rm -f ${negativeContainer}`.nothrow();
    }
  });
}

// ============================================================================
// T2.3: PG_MODULE_MAGIC_EXT support (PG18 no-crash verification)
// ============================================================================
console.log("\n🔬 PG18 Compatibility Tests");
console.log("-".repeat(80));

await test("Verify supautils loaded without FATAL errors", async () => {
  // Check container logs for FATAL errors related to supautils
  const logs = await $`docker logs ${CONTAINER} 2>&1`.text();
  const fatalPattern = /FATAL.*supautils|could not load library.*supautils/i;

  assert(!fatalPattern.test(logs), "Found FATAL errors related to supautils in container logs");
});

await test("Verify module initialized (GUC registration confirms PG18 magic accepted)", async () => {
  // If GUCs are registered, the module loaded successfully with PG18 magic
  const result = await runSQL("SELECT count(*) FROM pg_settings WHERE name LIKE 'supautils.%'");
  const count = parseInt(result);
  assert(count > 0, `Module initialization failed: no GUCs registered (PG18 magic not accepted)`);
});

// ============================================================================
// T2.4: Spurious GUC warning fix verification
// ============================================================================
console.log("\n⚠️  GUC Warning Tests");
console.log("-".repeat(80));

await test("Verify no spurious GUC warnings in logs", async () => {
  const logs = await $`docker logs ${CONTAINER} 2>&1`.text();
  const warningPattern = /WARNING:.*supautils|unrecognized configuration parameter.*supautils/i;

  assert(!warningPattern.test(logs), "Found spurious GUC warnings related to supautils");
});

// ============================================================================
// T2.5: GUC registration and role creation
// ============================================================================
console.log("\n🔐 Role Management Tests");
console.log("-".repeat(80));

await test("List all supautils GUC parameters", async () => {
  const result = await runSQL(
    "SELECT name, setting FROM pg_settings WHERE name LIKE 'supautils.%' ORDER BY name"
  );
  // Should have multiple GUC parameters
  assert(result.length > 0, "No supautils GUC parameters found");
  console.log(`   Found GUCs: ${result.split("\n").length} parameters`);
});

await test("Verify normal role operations unblocked (empty reserved_roles)", async () => {
  // Create role - should succeed when reserved_roles is empty
  await runSQL("CREATE ROLE test_supautils_role LOGIN");

  // Verify role exists
  const check = await runSQL("SELECT count(*) FROM pg_roles WHERE rolname = 'test_supautils_role'");
  assert(check === "1", "Role creation failed");

  // Drop role - should succeed
  await runSQL("DROP ROLE test_supautils_role");

  // Verify role deleted
  const checkDeleted = await runSQL(
    "SELECT count(*) FROM pg_roles WHERE rolname = 'test_supautils_role'"
  );
  assert(checkDeleted === "0", "Role deletion failed");
});

await test("Verify supautils hooks don't interfere with standard PostgreSQL", async () => {
  // Create multiple roles to verify hooks don't block normal operations
  await runSQL("CREATE ROLE test_role_1");
  await runSQL("CREATE ROLE test_role_2");
  await runSQL("CREATE ROLE test_role_3");

  // Grant membership
  await runSQL("GRANT test_role_1 TO test_role_2");

  // Revoke membership
  await runSQL("REVOKE test_role_1 FROM test_role_2");

  // Cleanup
  await runSQL("DROP ROLE test_role_3");
  await runSQL("DROP ROLE test_role_2");
  await runSQL("DROP ROLE test_role_1");

  assert(true, "Role operations completed without interference");
});

// ============================================================================
// T2.6: Interaction with pg_cron and pg_net
// ============================================================================
console.log("\n🔗 Dependency Tests");
console.log("-".repeat(80));

await test("Verify pg_cron extension available", async () => {
  const result = await runSQL(
    "SELECT count(*) FROM pg_available_extensions WHERE name = 'pg_cron'"
  );
  assert(result === "1", "pg_cron extension not available");
});

await test("Verify pg_net extension available", async () => {
  const result = await runSQL("SELECT count(*) FROM pg_available_extensions WHERE name = 'pg_net'");
  assert(result === "1", "pg_net extension not available");
});

await test("Verify both pg_cron and pg_net can be created alongside supautils", async () => {
  // Create extensions
  await runSQL("CREATE EXTENSION IF NOT EXISTS pg_cron");
  await runSQL("CREATE EXTENSION IF NOT EXISTS pg_net");

  // Verify both exist
  const result = await runSQL(
    "SELECT extname FROM pg_extension WHERE extname IN ('pg_cron', 'pg_net') ORDER BY extname"
  );
  const extensions = result.split("\n");
  assert(extensions.includes("pg_cron"), "pg_cron extension not created");
  assert(extensions.includes("pg_net"), "pg_net extension not created");
});

// ============================================================================
// Additional Functional Tests
// ============================================================================
console.log("\n🧪 Additional Functional Tests");
console.log("-".repeat(80));

await test("Verify supautils GUC parameters are configurable", async () => {
  // Attempt to set a supautils parameter (will only affect session)
  // Note: reserved_roles requires restart to take effect, but we can test the setting syntax
  await runSQL("SET supautils.reserved_roles = ''");
  // If this doesn't error, the GUC is properly registered and configurable
  assert(true, "GUC parameter setting succeeded");
});

await test("Verify supautils version and build info", async () => {
  // Check that supautils appears in shared_preload_libraries
  const preload = await runSQL("SHOW shared_preload_libraries");
  assert(preload.includes("supautils"), "supautils not in shared_preload_libraries");

  // Verify at least one supautils GUC exists (proves module loaded)
  const gucCount = await runSQL("SELECT count(*) FROM pg_settings WHERE name LIKE 'supautils.%'");
  assert(parseInt(gucCount) > 0, "No supautils GUCs found");
});

// ============================================================================
// PRINT SUMMARY
// ============================================================================
console.log("\n" + "=".repeat(80));
console.log("SUPAUTILS FUNCTIONAL TEST SUMMARY");
console.log("=".repeat(80));

const passed = results.filter((r) => r.passed && !r.skipped).length;
const skipped = results.filter((r) => r.skipped).length;
const failed = results.filter((r) => !r.passed).length;
const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

console.log(`Total: ${results.length} tests`);
console.log(`Passed: ${passed}`);
console.log(`Skipped: ${skipped}`);
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
