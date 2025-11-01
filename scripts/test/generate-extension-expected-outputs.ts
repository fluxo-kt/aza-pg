#!/usr/bin/env bun
/**
 * Generate Expected Output Files for Extension Regression Tests
 *
 * This script generates expected output (.out) files for extension regression tests
 * by running the SQL test files against a PostgreSQL container and capturing the output.
 *
 * Usage:
 *   bun scripts/test/generate-extension-expected-outputs.ts [options]
 *
 * Options:
 *   --mode=MODE              Test mode: production | regression (default: regression)
 *   --extensions=ext1,ext2   Specific extensions to generate (comma-separated)
 *   --image=IMAGE            Docker image to use (default: auto-detect)
 *   --container=NAME         Use existing container instead of starting new one
 *   --verbose                Detailed output
 *   --help                   Show this help message
 *
 * Examples:
 *   bun scripts/test/generate-extension-expected-outputs.ts
 *   bun scripts/test/generate-extension-expected-outputs.ts --mode=production
 *   bun scripts/test/generate-extension-expected-outputs.ts --extensions=vector,timescaledb
 */

import { $ } from "bun";
import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { TestMode } from "./lib/test-mode.ts";
import { resolveImageTag } from "./image-resolver.ts";
import { cleanPsqlOutput } from "./lib/output-normalizer.ts";

/**
 * Top 10 most critical extensions for production mode.
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
 * Regression-only extensions.
 */
const REGRESSION_ONLY_EXTENSIONS = [
  "postgis", // spatial data (large, disabled by default)
  "pgrouting", // routing algorithms (depends on postgis)
  "pgq", // high-performance queue (disabled by default)
];

interface GenerateOptions {
  mode: TestMode;
  extensions: string[];
  image: string;
  container: string | null;
  verbose: boolean;
}

/**
 * Parse CLI arguments
 */
function parseArgs(): GenerateOptions | null {
  const args = Bun.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return null;
  }

  // Parse mode
  let mode: TestMode = "regression";
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

  // Parse image
  let image = resolveImageTag();
  const imageArg = args.find((arg) => arg.startsWith("--image="));
  if (imageArg) {
    image = imageArg.split("=")[1] || image;
  }

  // Parse container
  let container: string | null = null;
  const containerArg = args.find((arg) => arg.startsWith("--container="));
  if (containerArg) {
    container = containerArg.split("=")[1] || null;
  }

  // Parse flags
  const verbose = args.includes("--verbose");

  return {
    mode,
    extensions,
    image,
    container,
    verbose,
  };
}

/**
 * Print help message
 */
function printHelp(): void {
  console.log(
    `
Generate Expected Output Files for Extension Regression Tests

This script generates expected output (.out) files for extension regression tests
by running the SQL test files against a PostgreSQL container and capturing the output.

Usage:
  bun scripts/test/generate-extension-expected-outputs.ts [options]

Options:
  --mode=MODE              Test mode: production | regression (default: regression)
  --extensions=ext1,ext2   Specific extensions to generate (comma-separated)
  --image=IMAGE            Docker image to use (default: auto-detect)
  --container=NAME         Use existing container instead of starting new one
  --verbose                Detailed output
  --help                   Show this help message

Test Modes:
  production               Generate for top 10 most critical extensions
  regression               Generate for all extensions (production + regression-only)

Examples:
  bun scripts/test/generate-extension-expected-outputs.ts
  bun scripts/test/generate-extension-expected-outputs.ts --mode=production
  bun scripts/test/generate-extension-expected-outputs.ts --extensions=vector,timescaledb
  `.trim()
  );
}

/**
 * Get list of extensions based on mode
 */
function getExtensionsToGenerate(mode: TestMode, explicitExtensions: string[]): string[] {
  if (explicitExtensions.length > 0) {
    return explicitExtensions;
  }

  if (mode === "regression") {
    return [...TOP_10_EXTENSIONS, ...REGRESSION_ONLY_EXTENSIONS];
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
 * Check if SQL test file exists
 */
async function sqlTestExists(extensionName: string): Promise<boolean> {
  const { sqlFile } = getExtensionTestPaths(extensionName);
  return await Bun.file(sqlFile).exists();
}

/**
 * Start PostgreSQL container
 */
async function startPostgresContainer(image: string, mode: TestMode): Promise<string> {
  const containerName = `ext-expected-gen-${Date.now()}`;

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
 * Get connection string for container
 */
async function getConnectionString(containerName: string): Promise<string> {
  // Get container's mapped port
  const result = await $`docker port ${containerName} 5432`;
  const portLine = result.stdout.toString().trim();

  // Parse port from output like "5432/tcp -> 0.0.0.0:54321"
  const portMatch = portLine.match(/:(\d+)$/);
  const port = portMatch?.[1] ? parseInt(portMatch[1]) : 5432;

  return `postgresql://postgres:postgres@localhost:${port}/postgres`;
}

/**
 * Generate expected output for a single extension
 */
async function generateExpectedOutput(
  extensionName: string,
  connectionString: string,
  verbose: boolean
): Promise<{ success: boolean; error?: string }> {
  const { sqlFile, expectedFile } = getExtensionTestPaths(extensionName);

  try {
    if (verbose) {
      console.log(`  Running SQL: ${sqlFile}`);
    }

    // Execute SQL file via psql
    const result = await $`psql -X -a -q ${connectionString} -f ${sqlFile}`.nothrow();

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString();
      return {
        success: false,
        error: `psql failed with exit code ${result.exitCode}: ${stderr}`,
      };
    }

    // Clean and normalize output
    const actualOutput = result.stdout.toString();
    const cleanedOutput = cleanPsqlOutput(actualOutput);

    // Ensure directory exists
    const expectedDir = dirname(expectedFile);
    await mkdir(expectedDir, { recursive: true });

    // Write expected output
    await Bun.write(expectedFile, cleanedOutput);

    if (verbose) {
      console.log(`  Generated: ${expectedFile}`);
    }

    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMsg };
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

  console.log(`Generating Expected Outputs (${options.mode} mode)`);
  console.log("=".repeat(60));

  try {
    // Determine which extensions to generate
    const extensionsToGenerate = getExtensionsToGenerate(options.mode, options.extensions);

    console.log(`\nExtensions to process: ${extensionsToGenerate.length}`);
    console.log(`  ${extensionsToGenerate.join(", ")}\n`);

    // Check which tests have SQL files
    const existingTests: string[] = [];
    const missingTests: string[] = [];

    for (const ext of extensionsToGenerate) {
      if (await sqlTestExists(ext)) {
        existingTests.push(ext);
      } else {
        missingTests.push(ext);
      }
    }

    if (missingTests.length > 0) {
      console.log(`\n⚠️  Missing SQL test files for ${missingTests.length} extensions:`);
      console.log(`  ${missingTests.join(", ")}`);
      console.log(`\nCreate SQL files in: tests/regression/extensions/{ext}/sql/basic.sql\n`);
    }

    if (existingTests.length === 0) {
      console.error(`\nError: No SQL test files found`);
      console.error(`Create test files in: tests/regression/extensions/{extension}/sql/basic.sql`);
      return 1;
    }

    console.log(`Found ${existingTests.length} SQL test files\n`);

    // Start container or use existing one
    let containerName: string;
    let shouldCleanup = false;

    if (options.container) {
      containerName = options.container;
      console.log(`Using existing container: ${containerName}\n`);
    } else {
      containerName = await startPostgresContainer(options.image, options.mode);
      shouldCleanup = true;
    }

    try {
      // Get connection string
      const connectionString = await getConnectionString(containerName);

      // Generate expected outputs
      console.log(`Generating expected outputs for ${existingTests.length} extensions...\n`);

      const results: Array<{ extension: string; success: boolean; error?: string }> = [];

      for (const extName of existingTests) {
        if (!options.verbose) {
          process.stdout.write(`  ${extName} ... `);
        } else {
          console.log(`\nGenerating ${extName}:`);
        }

        const result = await generateExpectedOutput(extName, connectionString, options.verbose);

        results.push({
          extension: extName,
          success: result.success,
          error: result.error,
        });

        if (!options.verbose) {
          console.log(result.success ? "✓" : "✗");
        }

        if (!result.success && result.error) {
          console.error(`  Error: ${result.error}`);
        }
      }

      // Print summary
      console.log("\n" + "=".repeat(60));
      console.log("Summary:");
      console.log("=".repeat(60));

      const successful = results.filter((r) => r.success);
      const failed = results.filter((r) => !r.success);

      console.log(`  Successful: ${successful.length}/${results.length}`);
      console.log(`  Failed:     ${failed.length}/${results.length}`);

      if (successful.length > 0) {
        console.log(`\n✓ Generated expected outputs:`);
        for (const result of successful) {
          const { expectedFile } = getExtensionTestPaths(result.extension);
          console.log(`  ${result.extension}: ${expectedFile}`);
        }
      }

      if (failed.length > 0) {
        console.log(`\n✗ Failed to generate:`);
        for (const result of failed) {
          console.log(`  ${result.extension}: ${result.error}`);
        }
      }

      return failed.length > 0 ? 1 : 0;
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

export { main, parseArgs };
