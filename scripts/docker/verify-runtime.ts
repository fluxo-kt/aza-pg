#!/usr/bin/env bun
/**
 * Runtime Verification Script
 *
 * Manifest-driven verification of Docker image runtime behavior:
 * - Verifies ALL enabled extensions can be created
 * - Verifies ALL disabled extensions cannot be created
 * - Verifies preloaded extensions are in shared_preload_libraries
 * - Verifies version-info.txt/json contains correct counts
 * - Verifies PostgreSQL configuration
 *
 * Usage:
 *   bun scripts/docker/verify-runtime.ts <image-tag>
 *   bun scripts/docker/verify-runtime.ts ghcr.io/fluxo-kt/aza-pg:pg18
 *
 * Options:
 *   --no-cleanup   - Keep container running after verification
 *   --timeout=N    - Set container startup timeout in seconds (default: 60)
 */

import { join } from "node:path";
import { getErrorMessage } from "../utils/errors";
import { checkDockerDaemon, dockerCleanup, dockerRun, dockerRunLive } from "../utils/docker";
import {
  error,
  formatDuration,
  info,
  section,
  success,
  testSummary,
  warning,
} from "../utils/logger";
import type { TestResult } from "../utils/logger";

const REPO_ROOT = join(import.meta.dir, "../..");
const MANIFEST_PATH = join(REPO_ROOT, "docker/postgres/extensions.manifest.json");
const CONTAINER_NAME = "aza-pg-verify-runtime";

// Parse command line arguments
const args = Bun.argv.slice(2);
const imageTag = args.find((arg) => !arg.startsWith("--"));
const noCleanup = args.includes("--no-cleanup");
const timeoutArg = args.find((arg) => arg.startsWith("--timeout="));
const timeout = timeoutArg ? parseInt(timeoutArg.split("=")[1]!, 10) : 60;

interface ManifestEntry {
  name: string;
  kind: "extension" | "tool" | "builtin";
  enabled?: boolean;
  runtime?: {
    sharedPreload?: boolean;
    defaultEnable?: boolean;
    preloadOnly?: boolean;
  };
}

interface Manifest {
  generatedAt: string;
  entries: ManifestEntry[];
}

/**
 * Read and parse manifest
 */
async function readManifest(): Promise<Manifest> {
  const content = await Bun.file(MANIFEST_PATH).json();
  return content as Manifest;
}

/**
 * Start container from image
 */
async function startContainer(image: string): Promise<boolean> {
  info(`Starting container: ${CONTAINER_NAME}`);
  info(`Image: ${image}`);

  // Clean up any existing container
  await dockerCleanup(CONTAINER_NAME);

  // Start container
  const exitCode = await dockerRunLive([
    "run",
    "-d",
    "--name",
    CONTAINER_NAME,
    "-e",
    "POSTGRES_PASSWORD=test123",
    "-e",
    "POSTGRES_DB=postgres",
    image,
  ]);

  if (exitCode !== 0) {
    error("Failed to start container");
    return false;
  }

  success("Container started");
  return true;
}

/**
 * Wait for PostgreSQL to be ready
 * Waits for Docker healthcheck (healthy status) which ensures init DB phase completes
 */
async function waitForPostgres(timeoutSeconds: number): Promise<boolean> {
  info(`Waiting for PostgreSQL to be ready (timeout: ${timeoutSeconds}s)...`);

  const startTime = Date.now();
  const timeoutMs = timeoutSeconds * 1000;

  while (Date.now() - startTime < timeoutMs) {
    // Check container health status (not just pg_isready)
    // The healthcheck waits for init DB completion before reporting healthy
    const healthResult = await dockerRun([
      "inspect",
      "--format",
      "{{.State.Health.Status}}",
      CONTAINER_NAME,
    ]);

    if (healthResult.success && healthResult.output === "healthy") {
      success(`PostgreSQL ready in ${formatDuration(Date.now() - startTime)}`);
      return true;
    }

    await Bun.sleep(2000);
  }

  error(`PostgreSQL not ready after ${timeoutSeconds}s`);
  return false;
}

/**
 * Execute SQL query in container
 */
async function execSQL(sql: string): Promise<{ success: boolean; output: string }> {
  return await dockerRun([
    "exec",
    CONTAINER_NAME,
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-t", // Tuples only (no headers)
    "-A", // Unaligned output
    "-c",
    sql,
  ]);
}

/**
 * Test: Verify enabled extensions can be created
 */
async function testEnabledExtensions(manifest: Manifest): Promise<TestResult> {
  const startTime = Date.now();

  try {
    // Get enabled extensions (excluding tools, preload-only modules, and optional preload extensions)
    const enabledExtensions = manifest.entries.filter((entry) => {
      const isEnabled = entry.enabled !== false;
      const isNotTool = entry.kind !== "tool";
      const isNotPreloadOnly = entry.runtime?.preloadOnly !== true;
      // Exclude optional preload extensions (require preloading but not preloaded by default)
      // These need POSTGRES_SHARED_PRELOAD_LIBRARIES env var to work
      const isNotOptionalPreload = !(
        entry.runtime?.sharedPreload === true && entry.runtime?.defaultEnable === false
      );
      return isEnabled && isNotTool && isNotPreloadOnly && isNotOptionalPreload;
    });

    info(`Testing ${enabledExtensions.length} enabled extensions...`);

    const failed: string[] = [];

    for (const ext of enabledExtensions) {
      // Try to create extension
      const result = await execSQL(`CREATE EXTENSION IF NOT EXISTS ${ext.name};`);

      if (!result.success) {
        failed.push(`${ext.name}: ${result.output}`);
      }
    }

    if (failed.length > 0) {
      return {
        name: "Enabled extensions can be created",
        passed: false,
        duration: Date.now() - startTime,
        error: `${failed.length} extension(s) failed:\n  ${failed.join("\n  ")}`,
      };
    }

    return {
      name: `Enabled extensions can be created (${enabledExtensions.length} tested)`,
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "Enabled extensions can be created",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Verify disabled extensions cannot be created
 */
async function testDisabledExtensions(manifest: Manifest): Promise<TestResult> {
  const startTime = Date.now();

  try {
    // Get disabled extensions (excluding tools)
    const disabledExtensions = manifest.entries.filter(
      (entry) => entry.enabled === false && entry.kind !== "tool"
    );

    if (disabledExtensions.length === 0) {
      return {
        name: "Disabled extensions cannot be created (0 to test)",
        passed: true,
        duration: Date.now() - startTime,
      };
    }

    info(`Testing ${disabledExtensions.length} disabled extensions...`);

    const unexpectedlyAvailable: string[] = [];

    for (const ext of disabledExtensions) {
      // Try to create extension (should fail)
      const result = await execSQL(`CREATE EXTENSION IF NOT EXISTS ${ext.name};`);

      // If it succeeds, the extension is unexpectedly available
      if (result.success) {
        unexpectedlyAvailable.push(ext.name);
      }
    }

    if (unexpectedlyAvailable.length > 0) {
      return {
        name: "Disabled extensions cannot be created",
        passed: false,
        duration: Date.now() - startTime,
        error: `${unexpectedlyAvailable.length} disabled extension(s) unexpectedly available: ${unexpectedlyAvailable.join(", ")}`,
      };
    }

    return {
      name: `Disabled extensions cannot be created (${disabledExtensions.length} verified)`,
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "Disabled extensions cannot be created",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Verify preloaded extensions are in shared_preload_libraries
 */
async function testPreloadedExtensions(manifest: Manifest): Promise<TestResult> {
  const startTime = Date.now();

  try {
    // Get preloaded extensions (sharedPreload=true AND defaultEnable=true)
    // This matches the logic in scripts/generate-docs-data.ts
    const preloadedExtensions = manifest.entries
      .filter(
        (entry) =>
          entry.enabled !== false &&
          entry.runtime?.sharedPreload === true &&
          entry.runtime?.defaultEnable === true
      )
      .map((entry) => entry.name);

    if (preloadedExtensions.length === 0) {
      return {
        name: "Preloaded extensions in shared_preload_libraries (0 expected)",
        passed: true,
        duration: Date.now() - startTime,
      };
    }

    info(`Verifying ${preloadedExtensions.length} preloaded extensions...`);

    // Get shared_preload_libraries value
    const result = await execSQL("SHOW shared_preload_libraries;");

    if (!result.success) {
      return {
        name: "Preloaded extensions in shared_preload_libraries",
        passed: false,
        duration: Date.now() - startTime,
        error: `Failed to read shared_preload_libraries: ${result.output}`,
      };
    }

    const preloadedLibs = result.output
      .split(",")
      .map((lib) => lib.trim())
      .filter((lib) => lib.length > 0);

    const missing: string[] = [];

    for (const ext of preloadedExtensions) {
      if (!preloadedLibs.includes(ext)) {
        missing.push(ext);
      }
    }

    if (missing.length > 0) {
      return {
        name: "Preloaded extensions in shared_preload_libraries",
        passed: false,
        duration: Date.now() - startTime,
        error: `${missing.length} extension(s) missing from shared_preload_libraries: ${missing.join(", ")}`,
      };
    }

    return {
      name: `Preloaded extensions in shared_preload_libraries (${preloadedExtensions.length} verified)`,
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "Preloaded extensions in shared_preload_libraries",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Verify version-info.txt exists and contains correct counts
 */
async function testVersionInfoTxt(manifest: Manifest): Promise<TestResult> {
  const startTime = Date.now();

  try {
    info("Verifying version-info.txt...");

    // Read version-info.txt from container
    const result = await dockerRun([
      "exec",
      CONTAINER_NAME,
      "cat",
      "/etc/postgresql/version-info.txt",
    ]);

    if (!result.success) {
      return {
        name: "Version info (version-info.txt)",
        passed: false,
        duration: Date.now() - startTime,
        error: "version-info.txt not found or not readable",
      };
    }

    const content = result.output;

    // Calculate expected counts
    const totalCount = manifest.entries.length;
    const enabledCount = manifest.entries.filter((e) => e.enabled !== false).length;
    const disabledCount = manifest.entries.filter((e) => e.enabled === false).length;
    const preloadedCount = manifest.entries.filter(
      (e) => e.enabled !== false && e.runtime?.sharedPreload === true
    ).length;

    // Verify counts in content
    const errors: string[] = [];

    if (!content.includes(`Total Catalog: ${totalCount}`)) {
      errors.push(`Total count mismatch (expected: ${totalCount})`);
    }

    if (!content.includes(`Enabled: ${enabledCount}`)) {
      errors.push(`Enabled count mismatch (expected: ${enabledCount})`);
    }

    if (!content.includes(`Disabled: ${disabledCount}`)) {
      errors.push(`Disabled count mismatch (expected: ${disabledCount})`);
    }

    if (!content.includes(`Preloaded: ${preloadedCount}`)) {
      errors.push(`Preloaded count mismatch (expected: ${preloadedCount})`);
    }

    if (errors.length > 0) {
      return {
        name: "Version info (version-info.txt)",
        passed: false,
        duration: Date.now() - startTime,
        error: errors.join(", "),
      };
    }

    return {
      name: "Version info (version-info.txt)",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "Version info (version-info.txt)",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Verify version-info.json exists and contains correct counts
 */
async function testVersionInfoJson(manifest: Manifest): Promise<TestResult> {
  const startTime = Date.now();

  try {
    info("Verifying version-info.json...");

    // Read version-info.json from container
    const result = await dockerRun([
      "exec",
      CONTAINER_NAME,
      "cat",
      "/etc/postgresql/version-info.json",
    ]);

    if (!result.success) {
      return {
        name: "Version info (version-info.json)",
        passed: false,
        duration: Date.now() - startTime,
        error: "version-info.json not found or not readable",
      };
    }

    const versionInfo = JSON.parse(result.output);

    // Calculate expected counts
    const expectedCounts = {
      total: manifest.entries.length,
      enabled: manifest.entries.filter((e) => e.enabled !== false).length,
      disabled: manifest.entries.filter((e) => e.enabled === false).length,
      preloaded: manifest.entries.filter(
        (e) => e.enabled !== false && e.runtime?.sharedPreload === true
      ).length,
    };

    // Verify structure and counts
    const errors: string[] = [];

    if (!versionInfo.extensions) {
      errors.push("Missing 'extensions' object");
    } else {
      if (versionInfo.extensions.total !== expectedCounts.total) {
        errors.push(
          `Total count mismatch (expected: ${expectedCounts.total}, got: ${versionInfo.extensions.total})`
        );
      }

      if (versionInfo.extensions.enabled !== expectedCounts.enabled) {
        errors.push(
          `Enabled count mismatch (expected: ${expectedCounts.enabled}, got: ${versionInfo.extensions.enabled})`
        );
      }

      if (versionInfo.extensions.disabled !== expectedCounts.disabled) {
        errors.push(
          `Disabled count mismatch (expected: ${expectedCounts.disabled}, got: ${versionInfo.extensions.disabled})`
        );
      }

      if (versionInfo.extensions.preloaded !== expectedCounts.preloaded) {
        errors.push(
          `Preloaded count mismatch (expected: ${expectedCounts.preloaded}, got: ${versionInfo.extensions.preloaded})`
        );
      }
    }

    if (errors.length > 0) {
      return {
        name: "Version info (version-info.json)",
        passed: false,
        duration: Date.now() - startTime,
        error: errors.join(", "),
      };
    }

    return {
      name: "Version info (version-info.json)",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "Version info (version-info.json)",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Verify PostgreSQL configuration
 */
async function testPostgresConfiguration(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    info("Verifying PostgreSQL configuration...");

    // Test key configuration parameters
    const configs = [
      { name: "shared_buffers", check: (val: string) => val.length > 0 },
      { name: "max_connections", check: (val: string) => parseInt(val, 10) > 0 },
      { name: "work_mem", check: (val: string) => val.length > 0 },
    ];

    const errors: string[] = [];

    for (const config of configs) {
      const result = await execSQL(`SHOW ${config.name};`);

      if (!result.success) {
        errors.push(`Failed to read ${config.name}`);
        continue;
      }

      if (!config.check(result.output.trim())) {
        errors.push(`Invalid ${config.name}: ${result.output}`);
      }
    }

    if (errors.length > 0) {
      return {
        name: "PostgreSQL configuration",
        passed: false,
        duration: Date.now() - startTime,
        error: errors.join(", "),
      };
    }

    return {
      name: "PostgreSQL configuration",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "PostgreSQL configuration",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Cleanup container
 */
async function cleanup(): Promise<void> {
  info("Cleaning up container...");
  await dockerCleanup(CONTAINER_NAME);
  success("Container removed");
}

/**
 * Main verification function
 */
async function main(): Promise<void> {
  section("Docker Image Runtime Verification");

  // Validate arguments
  if (!imageTag) {
    error("Usage: bun scripts/docker/verify-runtime.ts <image-tag>");
    error("Example: bun scripts/docker/verify-runtime.ts ghcr.io/fluxo-kt/aza-pg:pg18");
    process.exit(1);
  }

  // Check Docker daemon
  info("Checking Docker daemon...");
  await checkDockerDaemon();
  success("Docker daemon is running");

  // Read manifest
  info("Reading manifest...");
  const manifest = await readManifest();
  success(`Manifest loaded: ${manifest.entries.length} total entries`);

  // Start container
  const started = await startContainer(imageTag);
  if (!started) {
    process.exit(1);
  }

  try {
    // Wait for PostgreSQL
    const ready = await waitForPostgres(timeout);
    if (!ready) {
      process.exit(1);
    }

    // Run all tests
    console.log("");
    section("Running Verification Tests");

    const results: TestResult[] = [];

    results.push(await testVersionInfoTxt(manifest));
    results.push(await testVersionInfoJson(manifest));
    results.push(await testPreloadedExtensions(manifest));
    results.push(await testEnabledExtensions(manifest));
    results.push(await testDisabledExtensions(manifest));
    results.push(await testPostgresConfiguration());

    // Print summary
    console.log("");
    testSummary(results);

    // Exit with error if any tests failed
    const failed = results.filter((r) => !r.passed);
    if (failed.length > 0) {
      if (!noCleanup) {
        await cleanup();
      } else {
        warning(`Container ${CONTAINER_NAME} kept running (--no-cleanup flag)`);
      }
      process.exit(1);
    }

    // Success
    if (!noCleanup) {
      await cleanup();
    } else {
      warning(`Container ${CONTAINER_NAME} kept running (--no-cleanup flag)`);
    }
  } catch (err) {
    error(`Verification failed: ${getErrorMessage(err)}`);
    if (!noCleanup) {
      await cleanup();
    }
    process.exit(1);
  }
}

// Main execution
if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    error(`Runtime verification error: ${getErrorMessage(err)}`);
    if (!noCleanup) {
      await dockerCleanup(CONTAINER_NAME);
    }
    process.exit(1);
  }
}
