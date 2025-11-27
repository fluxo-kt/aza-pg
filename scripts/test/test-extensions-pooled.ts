#!/usr/bin/env bun
/**
 * Comprehensive extension test suite (POOLED VERSION - PROOF OF CONCEPT)
 * Tests extensions dynamically from manifest-data.ts
 *
 * This is a proof-of-concept migration demonstrating the ContainerPool pattern.
 * Instead of starting/stopping a dedicated container (~10-15s overhead), this test:
 * 1. Acquires a pre-warmed container from the global pool
 * 2. Uses schema isolation for test independence
 * 3. Releases the container back to the pool when done
 *
 * Key Benefits:
 * - Faster execution (no container startup/shutdown per test file)
 * - Container reuse across test files
 * - Schema isolation ensures test independence
 *
 * Usage: bun run scripts/test/test-extensions-pooled.ts [--image=aza-pg:phase1-fix]
 */

import { MANIFEST_ENTRIES as manifest } from "../extensions/manifest-data";
import { getGlobalPool, shutdownGlobalPool } from "./lib/container-pool";

interface ExtensionTest {
  name: string;
  category: string;
  createSQL: string;
  testSQL?: string; // Optional functional test
  expectError?: boolean; // Some extensions may not be creatable directly
}

// Generate test cases from manifest (only enabled extensions)
const EXTENSIONS: ExtensionTest[] = manifest
  .filter((ext) => ext.kind === "extension" || ext.kind === "builtin")
  .filter((ext) => ext.enabled !== false)
  .filter((ext) => ext.runtime?.preloadOnly !== true) // Exclude SQL-only schemas (pgflow)
  .filter((ext) => ext.runtime?.defaultEnable !== false) // Exclude opt-in extensions (timescaledb)
  .filter((ext) => ext.runtime?.excludeFromAutoTests !== true) // Exclude manifest-configured test exclusions
  .map((ext) => ({
    name: ext.name,
    category: ext.category,
    createSQL:
      ext.kind === "builtin" && !["btree_gin", "btree_gist", "pg_trgm"].includes(ext.name)
        ? "" // Builtin extensions that don't need CREATE EXTENSION
        : `CREATE EXTENSION IF NOT EXISTS ${ext.name} CASCADE`,
    testSQL: `SELECT * FROM pg_extension WHERE extname = '${ext.name}'`,
  }));

/**
 * Test a single extension using the pooled container
 *
 * Note: The container.execute() method automatically sets search_path to the test schema,
 * ensuring isolation from other concurrent tests. Extensions are created in the schema
 * and cleaned up automatically when the container is released.
 */
async function testExtension(
  container: Awaited<ReturnType<typeof getGlobalPool>> extends infer P
    ? P extends { acquire(): Promise<infer C> }
      ? C
      : never
    : never,
  ext: ExtensionTest,
  maxRetries = 3
): Promise<{ success: boolean; error?: string }> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Create extension if needed
      if (ext.createSQL) {
        await container.execute(ext.createSQL);
      }

      // Run functional test if provided
      if (ext.testSQL) {
        const results = await container.query(ext.testSQL);
        // Verify extension was created
        if (results.length === 0) {
          return { success: false, error: "Extension not found in pg_extension" };
        }
      }

      return { success: true };
    } catch (error) {
      const errorStr = String(error);
      // Retry on transient errors
      if (
        attempt < maxRetries &&
        (errorStr.includes("shutting down") ||
          errorStr.includes("starting up") ||
          errorStr.includes("No such file or directory") ||
          errorStr.includes("Connection refused"))
      ) {
        await Bun.sleep(2000 * attempt); // Exponential backoff
        continue;
      }
      return { success: false, error: errorStr };
    }
  }

  return { success: false, error: "Max retries exceeded" };
}

async function main() {
  // Parse image from command line args if provided
  const imageArg = Bun.argv.find((arg) => arg.startsWith("--image="))?.split("=")[1];
  const image =
    imageArg || process.env.POSTGRES_IMAGE || "ghcr.io/fluxo-kt/aza-pg-testing:testing-main";

  console.log(`Testing extensions in image: ${image}\n`);

  /**
   * CONTAINER POOL PATTERN:
   *
   * 1. Get the global pool (creates if first use, reuses if already initialized)
   * 2. Acquire a container (blocks if all containers busy)
   * 3. Run tests in isolated schema
   * 4. Release container back to pool (auto-cleans schema)
   * 5. Shutdown pool when done (only on last test file)
   *
   * The pool maintains pre-warmed containers, eliminating startup overhead.
   * Schema isolation ensures tests don't interfere with each other.
   */
  const pool = await getGlobalPool({ image, poolSize: 2 });
  const container = await pool.acquire();

  try {
    console.log(`Using pooled container: ${container.name}`);
    console.log(`Test schema: ${container.schema}\n`);

    const results: Map<string, { success: boolean; error?: string }> = new Map();
    let passed = 0;
    let failed = 0;

    for (const ext of EXTENSIONS) {
      process.stdout.write(`Testing ${ext.name.padEnd(25)} [${ext.category}]...`.padEnd(60));
      const result = await testExtension(container, ext);
      results.set(ext.name, result);

      if (result.success) {
        console.log("✅ PASS");
        passed++;
      } else {
        console.log("❌ FAIL");
        console.log(`  Error: ${result.error?.split("\n")[0]}`);
        failed++;
      }
    }

    console.log("\n" + "=".repeat(80));
    console.log(`SUMMARY: ${passed}/${EXTENSIONS.length} passed, ${failed} failed`);
    console.log("=".repeat(80));

    if (failed === 0) {
      console.log("\n🎉 All extensions working!");
      process.exit(0);
    } else {
      console.log("\n❌ Some extensions failed. Review output above.");
      process.exit(1);
    }
  } finally {
    /**
     * CRITICAL: Always release the container in a finally block
     * This ensures the container is returned to the pool even if tests fail.
     * The release() method automatically drops the test schema with CASCADE.
     */
    await pool.release(container);

    /**
     * Shutdown the global pool when done.
     * In a multi-file test suite, only the last test should call this.
     * Consider moving this to a global test teardown hook.
     */
    await shutdownGlobalPool();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
