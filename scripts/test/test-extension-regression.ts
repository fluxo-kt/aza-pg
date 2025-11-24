#!/usr/bin/env bun
/**
 * Extension Regression Test Runner (Tier 2)
 *
 * Runs deterministic regression tests for PostgreSQL extensions using
 * SQL + expected output comparison pattern (like pg_regress).
 *
 * Test Modes:
 * - production: Top 10 most critical extensions
 * - regression: All enabled extensions (24 production + 3 regression-only)
 *
 * Usage:
 *   bun scripts/test/test-extension-regression.ts [options] [image]
 *
 * Options:
 *   --mode=MODE              Test mode: production | regression (default: auto-detect)
 *   --extensions=ext1,ext2   Specific extensions to test (comma-separated)
 *   --generate-expected      Generate expected output files (.out) from actual results
 *   --verbose                Detailed output including diffs
 *   --container=NAME         Use existing container instead of starting new one
 *   --help                   Show this help message
 *
 * Examples:
 *   bun scripts/test/test-extension-regression.ts
 *   bun scripts/test/test-extension-regression.ts --mode=regression
 *   bun scripts/test/test-extension-regression.ts --extensions=pgvector,timescaledb
 *   bun scripts/test/test-extension-regression.ts --generate-expected
 */

import { $ } from "bun";
import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { detectTestMode, type TestMode } from "./lib/test-mode.ts";
import { resolveImageTag } from "./image-resolver.ts";
import {
  runRegressionTests,
  generateRegressionDiffs,
  type TestResult,
  type ConnectionConfig,
} from "./lib/regression-runner.ts";

/**
 * Top 10 most critical extensions for production mode.
 * Prioritized by usage frequency and business impact.
 */
const TOP_10_EXTENSIONS = [
  "vector", // pgvector - AI/ML workloads
  "timescaledb", // time-series data
  "pg_cron", // job scheduling
  "pgsodium", // encryption
  "pgaudit", // security auditing
  "pg_stat_monitor", // observability
  "hypopg", // index optimization
  "pg_trgm", // fuzzy search
  "pgmq", // message queuing
  "timescaledb_toolkit", // time-series analytics
];

/**
 * Comprehensive-only extensions (disabled in production, tested in regression mode).
 */
const COMPREHENSIVE_ONLY_EXTENSIONS = [
  "postgis", // spatial data (large, disabled by default)
  "pgrouting", // routing algorithms (depends on postgis)
  "pgq", // high-performance queue (disabled by default)
];

interface TestOptions {
  mode: TestMode;
  extensions: string[];
  generateExpected: boolean;
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

  // Parse extensions
  let extensions: string[] = [];
  const extensionsArg = args.find((arg) => arg.startsWith("--extensions="));
  if (extensionsArg) {
    const extList = extensionsArg.split("=")[1];
    if (extList) {
      extensions = extList.split(",").map((e) => e.trim());
    }
  }

  // Parse flags
  const generateExpected = args.includes("--generate-expected");
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
    extensions,
    generateExpected,
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
Extension Regression Test Runner (Tier 2)

Runs deterministic regression tests for PostgreSQL extensions using
SQL + expected output comparison pattern (like pg_regress).

Usage:
  bun scripts/test/test-extension-regression.ts [options] [image]

Options:
  --mode=MODE              Test mode: production | regression (default: auto-detect)
  --extensions=ext1,ext2   Specific extensions to test (comma-separated)
  --generate-expected      Generate expected output files (.out) from actual results
  --verbose                Detailed output including diffs
  --container=NAME         Use existing container instead of starting new one
  --help                   Show this help message

Test Modes:
  production               Test top 10 most critical extensions (${TOP_10_EXTENSIONS.length} total)
  regression            Test all enabled extensions (${TOP_10_EXTENSIONS.length + COMPREHENSIVE_ONLY_EXTENSIONS.length}+ total)

Top 10 Production Extensions:
  ${TOP_10_EXTENSIONS.join(", ")}

Comprehensive-Only Extensions:
  ${COMPREHENSIVE_ONLY_EXTENSIONS.join(", ")}

Examples:
  bun scripts/test/test-extension-regression.ts
  bun scripts/test/test-extension-regression.ts --mode=regression
  bun scripts/test/test-extension-regression.ts --extensions=pgvector,timescaledb
  bun scripts/test/test-extension-regression.ts --generate-expected
  `.trim()
  );
}

/**
 * Get list of extensions to test based on mode
 */
function getExtensionsToTest(mode: TestMode, explicitExtensions: string[]): string[] {
  if (explicitExtensions.length > 0) {
    return explicitExtensions;
  }

  if (mode === "regression") {
    return [...TOP_10_EXTENSIONS, ...COMPREHENSIVE_ONLY_EXTENSIONS];
  } else {
    return TOP_10_EXTENSIONS;
  }
}

/**
 * Get paths for extension test files
 */
function getExtensionTestPaths(extensionName: string) {
  const baseDir = join(import.meta.dir, "../../tests/regression/extensions", extensionName);
  const sqlFile = join(baseDir, "sql/basic.sql");
  const expectedFile = join(baseDir, "expected/basic.out");

  return { sqlFile, expectedFile, baseDir };
}

/**
 * Check if extension test files exist
 */
async function extensionTestExists(extensionName: string): Promise<boolean> {
  const { sqlFile, expectedFile } = getExtensionTestPaths(extensionName);

  const sqlExists = await Bun.file(sqlFile).exists();
  const expectedExists = await Bun.file(expectedFile).exists();

  return sqlExists && expectedExists;
}

/**
 * Start PostgreSQL container for testing
 */
async function startPostgresContainer(image: string, mode: TestMode): Promise<string> {
  const containerName = `ext-regression-test-${Date.now()}`;

  console.log(`Starting PostgreSQL container: ${containerName}`);
  console.log(`  Image: ${image}`);
  console.log(`  Mode:  ${mode}`);

  try {
    // Start container with appropriate shared_preload_libraries for mode
    const sharedPreload =
      mode === "regression"
        ? "auto_explain,pg_cron,pg_stat_monitor,pg_stat_statements,pgaudit,timescaledb,pgsodium,pg_partman,set_user"
        : "auto_explain,pg_cron,pg_stat_monitor,pg_stat_statements,pgaudit,timescaledb";

    await $`docker run -d --name ${containerName} \
      -e POSTGRES_PASSWORD=postgres \
      -e TEST_MODE=${mode} \
      -e POSTGRES_SHARED_PRELOAD_LIBRARIES=${sharedPreload} \
      -p 5432 \
      ${image}`.quiet();

    // Wait for PostgreSQL to be ready
    console.log("Waiting for PostgreSQL to be ready...");

    let ready = false;
    for (let i = 0; i < 60; i++) {
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
      throw new Error("PostgreSQL failed to start within 60 seconds");
    }

    // Additional wait for initialization
    await Bun.sleep(3000);

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
 *
 * Uses containerName to run psql via docker exec instead of host TCP connection.
 * This avoids network issues and matches how Tier 3 (interaction tests) works.
 */
async function getConnectionConfig(containerName: string): Promise<ConnectionConfig> {
  // Use docker exec to run psql inside the container (not host TCP connection)
  // This is more reliable and matches Tier 3 behavior
  return {
    containerName, // This tells regression-runner to use docker exec
    database: "postgres",
    user: "postgres",
    password: "postgres",
  };
}

/**
 * Generate expected output file from actual test result
 */
async function generateExpectedOutput(extensionName: string, actualOutput: string): Promise<void> {
  const { expectedFile } = getExtensionTestPaths(extensionName);

  // Ensure directory exists
  const expectedDir = dirname(expectedFile);
  await mkdir(expectedDir, { recursive: true });

  // Write actual output as expected
  await Bun.write(expectedFile, actualOutput);

  console.log(`  Generated expected output: ${expectedFile}`);
}

/**
 * Print test results summary
 */
function printTestResults(
  results: TestResult[],
  verbose: boolean,
  generateExpected: boolean
): void {
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
      const reason = result.error || "output mismatch";
      console.log(`  ${status} ${result.testName} (${duration}) - ${reason}`);

      if (verbose && result.diff) {
        console.log(`\n${result.diff}\n`);
      }
    }
  }

  console.log("=".repeat(60));
  console.log(`\nSummary:`);
  console.log(`  Passed: ${passed.length}/${results.length}`);
  console.log(`  Failed: ${failed.length}/${results.length}`);

  if (failed.length > 0 && !generateExpected) {
    console.log(`\nFailed tests: ${failed.map((r) => r.testName).join(", ")}`);
    console.log(
      `\nTip: Run with --generate-expected to create expected output files for new tests`
    );
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

  console.log(`Extension Regression Tests (${mode} mode)`);
  console.log("=".repeat(60));

  try {
    // Determine which extensions to test
    const extensionsToTest = getExtensionsToTest(mode, options.extensions);

    console.log(`\nExtensions to test: ${extensionsToTest.length}`);
    console.log(`  ${extensionsToTest.join(", ")}\n`);

    // Check which tests exist
    const existingTests: string[] = [];
    const missingTests: string[] = [];

    for (const ext of extensionsToTest) {
      if (await extensionTestExists(ext)) {
        existingTests.push(ext);
      } else {
        missingTests.push(ext);
      }
    }

    if (missingTests.length > 0) {
      console.log(`\n⚠️  Missing test files for ${missingTests.length} extensions:`);
      console.log(`  ${missingTests.join(", ")}`);

      if (!options.generateExpected) {
        console.log(
          `\nRun with --generate-expected to create tests for these extensions automatically`
        );
        console.log(`(requires SQL test files to exist in tests/regression/extensions/{ext}/sql/)`);
      }
    }

    if (existingTests.length === 0) {
      console.error(`\nError: No test files found for any extension`);
      console.error(`Create test files in: tests/regression/extensions/{extension}/sql/basic.sql`);
      return 1;
    }

    // Start container or use existing one
    let containerName: string;
    let shouldCleanup = false;

    if (options.container) {
      containerName = options.container;
      console.log(`\nUsing existing container: ${containerName}\n`);
    } else {
      containerName = await startPostgresContainer(options.image, mode);
      shouldCleanup = true;
    }

    try {
      // Get connection configuration
      const connection = await getConnectionConfig(containerName);

      // Build test list
      const testList = existingTests.map((extName) => {
        const paths = getExtensionTestPaths(extName);
        return {
          testName: extName,
          sqlFile: paths.sqlFile,
          expectedFile: paths.expectedFile,
        };
      });

      console.log(`Running ${testList.length} extension tests...\n`);

      // Run tests
      const results = await runRegressionTests(testList, connection, (testName, index, total) => {
        if (options.verbose) {
          console.log(`[${index}/${total}] Testing ${testName}...`);
        } else {
          // Simple progress indicator
          process.stdout.write(".");
        }
      });

      if (!options.verbose) {
        console.log(""); // Newline after progress dots
      }

      // Generate expected outputs if requested
      if (options.generateExpected) {
        console.log("\nGenerating expected output files...");
        for (const result of results) {
          await generateExpectedOutput(result.testName, result.actualOutput);
        }
      }

      // Print results
      printTestResults(results, options.verbose, options.generateExpected);

      // Generate regression.diffs for failures
      if (!options.generateExpected) {
        const diffsPath = join(import.meta.dir, "../../extension-regression.diffs");
        await generateRegressionDiffs(results, diffsPath);

        const failedCount = results.filter((r) => !r.passed).length;
        if (failedCount > 0) {
          console.log(`\nRegression diffs written to: ${diffsPath}`);
        }
      }

      // Determine exit code
      const failedCount = results.filter((r) => !r.passed).length;
      return failedCount > 0 && !options.generateExpected ? 1 : 0;
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

// Execute if run directly
if (import.meta.main) {
  const exitCode = await main();
  process.exit(exitCode);
}

export { main, parseArgs, TOP_10_EXTENSIONS, COMPREHENSIVE_ONLY_EXTENSIONS };
