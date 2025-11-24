#!/usr/bin/env bun
/**
 * PostgreSQL Core Regression Test Runner
 *
 * Tier 1 regression testing: Runs official PostgreSQL regression tests to verify
 * that our custom-built image doesn't break core PostgreSQL functionality.
 *
 * Tests are executed via psql and outputs are compared against official expected results.
 *
 * Usage:
 *   bun scripts/test/test-postgres-core-regression.ts [options] [image]
 *
 * Options:
 *   --mode=MODE              Test mode: production | regression (default: auto-detect)
 *   --tests=test1,test2      Specific tests to run (comma-separated)
 *   --generate-diffs         Write regression.diffs file on failures
 *   --verbose                Detailed output
 *   --container=NAME         Use existing container instead of starting new one
 *   --help                   Show this help message
 *
 * Examples:
 *   bun scripts/test/test-postgres-core-regression.ts
 *   bun scripts/test/test-postgres-core-regression.ts --mode=production
 *   bun scripts/test/test-postgres-core-regression.ts --tests=boolean,int2,int4
 *   bun scripts/test/test-postgres-core-regression.ts --container=my-postgres
 */

import { $ } from "bun";
import { join } from "node:path";
import { detectTestMode, type TestMode } from "./lib/test-mode.ts";
import { resolveImageTag } from "./image-resolver.ts";
import {
  runRegressionTests,
  generateRegressionDiffs,
  type TestResult,
  type ConnectionConfig,
} from "./lib/regression-runner.ts";
import { CORE_TESTS, SQL_DIR, EXPECTED_DIR } from "../ci/fetch-pg-regression-tests.ts";

interface TestOptions {
  mode: TestMode;
  tests: string[];
  generateDiffs: boolean;
  verbose: boolean;
  container: string | null;
  image: string;
}

/**
 * Parse CLI arguments
 */
function parseArgs(): TestOptions | null {
  const args = Bun.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return null;
  }

  // Parse mode
  let mode: TestMode | null = null;
  const modeArg = args.find((arg) => arg.startsWith("--mode="));
  if (modeArg) {
    const modeValue = modeArg.split("=")[1];
    if (modeValue === "production" || modeValue === "regression") {
      mode = modeValue;
    }
  }

  // Parse tests
  let tests: string[] = [...CORE_TESTS];
  const testsArg = args.find((arg) => arg.startsWith("--tests="));
  if (testsArg) {
    const testList = testsArg.split("=")[1];
    if (testList) {
      tests = testList.split(",").map((t) => t.trim());
    }
  }

  // Parse flags
  const generateDiffs = args.includes("--generate-diffs");
  const verbose = args.includes("--verbose");

  // Parse container name
  let container: string | null = null;
  const containerArg = args.find((arg) => arg.startsWith("--container="));
  if (containerArg) {
    container = containerArg.split("=")[1] || null;
  }

  // Resolve image
  const image = resolveImageTag();

  return {
    mode: mode as TestMode, // Will be null if not specified, handled later
    tests,
    generateDiffs,
    verbose,
    container,
    image,
  };
}

/**
 * Print help message
 */
function printHelp(): void {
  console.log(
    `
PostgreSQL Core Regression Test Runner

Tier 1 regression testing: Runs official PostgreSQL regression tests to verify
that our custom-built image doesn't break core PostgreSQL functionality.

Usage:
  bun scripts/test/test-postgres-core-regression.ts [options] [image]

Options:
  --mode=MODE              Test mode: production | regression (default: auto-detect)
  --tests=test1,test2      Specific tests to run (comma-separated)
  --generate-diffs         Write regression.diffs file on failures
  --verbose                Detailed output
  --container=NAME         Use existing container instead of starting new one
  --help                   Show this help message

Test Modes:
  production               Test production image (enabled extensions only)
  regression            Test all extensions including disabled ones

Default Tests (${CORE_TESTS.length} total):
  ${CORE_TESTS.join(", ")}

Examples:
  bun scripts/test/test-postgres-core-regression.ts
  bun scripts/test/test-postgres-core-regression.ts --mode=production
  bun scripts/test/test-postgres-core-regression.ts --tests=boolean,int2,int4
  bun scripts/test/test-postgres-core-regression.ts --container=my-postgres
  `.trim()
  );
}

/**
 * Ensure regression tests are fetched
 */
async function ensureTestsAreFetched(tests: string[]): Promise<void> {
  // Check if all required tests exist
  let missingTests: string[] = [];

  for (const testName of tests) {
    const sqlPath = join(SQL_DIR, `${testName}.sql`);
    const expectedPath = join(EXPECTED_DIR, `${testName}.out`);

    const sqlExists = await Bun.file(sqlPath).exists();
    const expectedExists = await Bun.file(expectedPath).exists();

    if (!sqlExists || !expectedExists) {
      missingTests.push(testName);
    }
  }

  if (missingTests.length === 0) {
    return; // All tests available
  }

  console.log(`Fetching ${missingTests.length} missing tests...`);

  // Run fetch script
  const fetchScript = join(import.meta.dir, "../ci/fetch-pg-regression-tests.ts");
  const testList = missingTests.join(",");

  try {
    await $`bun ${fetchScript} --tests=${testList}`.quiet();
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch regression tests: ${errorMsg}`);
  }
}

/**
 * Start PostgreSQL container for testing
 */
async function startPostgresContainer(image: string, mode: TestMode): Promise<string> {
  const containerName = `pg-regression-test-${Date.now()}`;

  console.log(`Starting PostgreSQL container: ${containerName}`);
  console.log(`  Image: ${image}`);
  console.log(`  Mode:  ${mode}`);

  try {
    // Start container
    await $`docker run -d --name ${containerName} \
      -e POSTGRES_PASSWORD=postgres \
      -e TEST_MODE=${mode} \
      -p 5432 \
      ${image}`.quiet();

    // Wait for PostgreSQL to be ready
    console.log("Waiting for PostgreSQL to be ready...");

    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const result = await $`docker exec ${containerName} pg_isready -U postgres`.nothrow();
        if (result.exitCode === 0) {
          ready = true;
          break;
        }
      } catch {
        // Container not ready yet
      }
      await Bun.sleep(1000);
    }

    if (!ready) {
      throw new Error("PostgreSQL failed to start within 30 seconds");
    }

    console.log("PostgreSQL is ready\n");
    return containerName;
  } catch (error) {
    // Clean up container on failure
    try {
      await $`docker rm -f ${containerName}`.quiet();
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Stop and remove PostgreSQL container
 */
async function stopPostgresContainer(containerName: string): Promise<void> {
  try {
    await $`docker rm -f ${containerName}`.quiet();
  } catch (error) {
    console.warn(`Warning: Failed to stop container ${containerName}: ${error}`);
  }
}

/**
 * Get connection configuration for container
 */
async function getConnectionConfig(containerName: string): Promise<ConnectionConfig> {
  // Get container's mapped port
  const result = await $`docker port ${containerName} 5432`;
  const portLine = result.stdout.toString().trim();

  // Parse port from output like "5432/tcp -> 0.0.0.0:54321"
  const portMatch = portLine.match(/:(\d+)$/);
  const port = portMatch?.[1] ? parseInt(portMatch[1]) : 5432;

  return {
    host: "localhost",
    port,
    database: "postgres",
    user: "postgres",
    password: "postgres",
  };
}

/**
 * Print test results summary
 */
function printTestResults(results: TestResult[], verbose: boolean): void {
  console.log("\nTest Results:");
  console.log("=".repeat(60));

  const passed = results.filter((r) => r.passed);
  const failed = results.filter((r) => !r.passed);

  for (const result of results) {
    const status = result.passed ? "✓" : "✗";
    const duration = `${Math.round(result.duration)}ms`;

    if (result.passed) {
      console.log(`  ${status} ${result.testName} (${duration})`);
    } else {
      console.log(
        `  ${status} ${result.testName} (${duration}) - ${result.error || "output mismatch"}`
      );

      if (verbose && result.diff) {
        console.log(`\n${result.diff}\n`);
      }
    }
  }

  console.log("=".repeat(60));
  console.log(`\nSummary:`);
  console.log(`  Passed: ${passed.length}/${results.length}`);
  console.log(`  Failed: ${failed.length}/${results.length}`);

  if (failed.length > 0) {
    console.log(`\nFailed tests: ${failed.map((r) => r.testName).join(", ")}`);
  }
}

/**
 * Main execution
 */
async function main(): Promise<number> {
  const options = parseArgs();
  if (!options) {
    return 0; // Help was shown
  }

  // Detect test mode if not specified
  const mode = options.mode || (await detectTestMode());

  console.log(`PostgreSQL Core Regression Tests (${mode} mode)`);
  console.log("=".repeat(60));

  try {
    // Ensure tests are fetched
    await ensureTestsAreFetched(options.tests);

    // Start container or use existing one
    let containerName: string;
    let shouldCleanup = false;

    if (options.container) {
      containerName = options.container;
      console.log(`Using existing container: ${containerName}\n`);
    } else {
      containerName = await startPostgresContainer(options.image, mode);
      shouldCleanup = true;
    }

    // Track container for signal handler cleanup
    containerToCleanup = containerName;

    try {
      // Get connection configuration
      const connection = await getConnectionConfig(containerName);

      // Add container name to connection config for docker exec support
      connection.containerName = containerName;

      // Build test list
      const testList = options.tests.map((testName) => ({
        testName,
        sqlFile: join(SQL_DIR, `${testName}.sql`),
        expectedFile: join(EXPECTED_DIR, `${testName}.out`),
      }));

      console.log(`Running ${testList.length} tests...\n`);

      // Run tests
      const results = await runRegressionTests(testList, connection, (testName, index, total) => {
        if (options.verbose) {
          console.log(`[${index}/${total}] Running ${testName}...`);
        }
      });

      // Print results
      printTestResults(results, options.verbose);

      // Generate regression.diffs if requested
      if (options.generateDiffs) {
        const diffsPath = join(import.meta.dir, "../../regression.diffs");
        await generateRegressionDiffs(results, diffsPath);

        const failedCount = results.filter((r) => !r.passed).length;
        if (failedCount > 0) {
          console.log(`\nRegression diffs written to: ${diffsPath}`);
        }
      }

      // Determine exit code
      const failedCount = results.filter((r) => !r.passed).length;
      return failedCount > 0 ? 1 : 0;
    } finally {
      // Clean up container if we started it
      if (shouldCleanup) {
        console.log(`\nCleaning up container: ${containerName}`);
        await stopPostgresContainer(containerName);
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`\nError: ${errorMsg}`);
    return 1;
  }
}

// Track container for cleanup on signal
let containerToCleanup: string | null = null;

// Graceful cleanup on job cancellation/interruption
process.on("SIGINT", async () => {
  console.log("\n\n⚠️  Received SIGINT, cleaning up...");
  if (containerToCleanup) {
    try {
      await stopPostgresContainer(containerToCleanup);
      console.log("✅ Container cleaned up successfully");
    } catch (error) {
      console.error("❌ Failed to cleanup container:", error);
    }
  }
  process.exit(130); // Standard exit code for SIGINT
});

process.on("SIGTERM", async () => {
  console.log("\n\n⚠️  Received SIGTERM, cleaning up...");
  if (containerToCleanup) {
    try {
      await stopPostgresContainer(containerToCleanup);
      console.log("✅ Container cleaned up successfully");
    } catch (error) {
      console.error("❌ Failed to cleanup container:", error);
    }
  }
  process.exit(143); // Standard exit code for SIGTERM
});

// Execute if run directly
if (import.meta.main) {
  const exitCode = await main();
  process.exit(exitCode);
}

export { main, parseArgs, containerToCleanup };
