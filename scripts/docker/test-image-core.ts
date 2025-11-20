#!/usr/bin/env bun
/**
 * Core Infrastructure Tests for Docker Image
 *
 * This test suite covers the fundamental infrastructure aspects of the Docker image:
 * - Phase 1: Filesystem Verification (5 tests)
 *   - Extension directory structure
 *   - Manifest file presence
 *   - Version info files presence
 *   - Enabled PGDG extensions present
 *   - Disabled PGDG extensions not present
 *
 * - Phase 2: Runtime Verification (7 tests)
 *   - Version info txt contents
 *   - Version info json contents
 *   - Preloaded extensions
 *   - Pre-created extensions
 *   - Enabled extensions can be created
 *   - Disabled extensions cannot be created
 *   - PostgreSQL configuration valid
 *
 * - Phase 3: Tools Verification (3 tests)
 *   - Tools present
 *   - pgBackRest functional
 *   - pgBadger functional
 *
 * - Phase 4: Auto-Configuration Tests (1 test)
 *   - Auto-config applied
 *
 * Total: ~16 tests, fast execution (~30-60s)
 *
 * Usage:
 *   bun scripts/docker/test-image-core.ts [image-tag] [--no-cleanup] [--output-json <path>] [--output-junit <path>]
 *   bun scripts/docker/test-image-core.ts aza-pg:latest
 *   bun scripts/docker/test-image-core.ts ghcr.io/fluxo-kt/aza-pg:18.1-202511142330-single-node
 *
 * Options:
 *   --no-cleanup     - Keep container running after tests
 *   --output-json    - Export results in JSON Lines format
 *   --output-junit   - Export results in JUnit XML format
 */

import { getErrorMessage } from "../utils/errors";
import { checkDockerDaemon, dockerCleanup } from "../utils/docker";
import {
  error,
  formatDuration,
  info,
  section,
  success,
  testSummary,
  warning,
  exportJsonLines,
  exportJunitXml,
} from "../utils/logger";
import type { TestResult } from "../utils/logger";
import {
  readManifest,
  startContainer,
  waitForPostgres,
  testExtensionDirectoryStructure,
  testManifestPresent,
  testVersionInfoFilesPresent,
  testEnabledPgdgExtensionsPresent,
  testDisabledPgdgExtensionsNotPresent,
  testVersionInfoTxt,
  testVersionInfoJson,
  testPreloadedExtensions,
  testPrecreatedExtensions,
  testEnabledExtensions,
  testDisabledExtensions,
  testPostgresConfiguration,
  testToolsPresent,
  testPgBackRestFunctional,
  testPgBadgerFunctional,
  testAutoConfigApplied,
} from "./test-image-lib";

// Parse command line arguments
const args = Bun.argv.slice(2);
const imageTag = args.find((arg) => !arg.startsWith("--")) || "aza-pg-testing:latest";
const noCleanup = args.includes("--no-cleanup");

// Export flags
const outputJsonIdx = args.indexOf("--output-json");
const outputJson = outputJsonIdx !== -1 && args[outputJsonIdx + 1] ? args[outputJsonIdx + 1] : null;

const outputJunitIdx = args.indexOf("--output-junit");
const outputJunit =
  outputJunitIdx !== -1 && args[outputJunitIdx + 1] ? args[outputJunitIdx + 1] : null;

// Generate unique container name
const timestamp = Date.now();
const CONTAINER_NAME = `aza-pg-test-core-${timestamp}`;

/**
 * Cleanup test container
 */
async function cleanup(): Promise<void> {
  info("Cleaning up test container...");
  await dockerCleanup(CONTAINER_NAME);
  success("Test container removed");
}

// Signal handlers for graceful cleanup
process.on("SIGINT", async () => {
  warning("\nReceived SIGINT, cleaning up...");
  if (!noCleanup) {
    await cleanup();
  }
  process.exit(130);
});

process.on("SIGTERM", async () => {
  warning("\nReceived SIGTERM, cleaning up...");
  if (!noCleanup) {
    await cleanup();
  }
  process.exit(143);
});

/**
 * Main test orchestration function
 */
async function main(): Promise<void> {
  const totalStartTime = Date.now();

  section("Core Infrastructure Tests - Docker Image");
  info(`Image: ${imageTag}`);
  info(`Container: ${CONTAINER_NAME}`);

  // Check Docker daemon
  info("Checking Docker daemon...");
  await checkDockerDaemon();
  success("Docker daemon is running");

  // Read manifest
  info("Reading manifest...");
  const manifest = await readManifest();
  success(`Manifest loaded: ${manifest.entries.length} total entries`);

  // Start test container
  info(`Starting test container: ${CONTAINER_NAME}`);
  info(`Image: ${imageTag}`);
  const started = await startContainer(imageTag, CONTAINER_NAME);
  if (!started) {
    error("Failed to start test container");
    process.exit(1);
  }
  success("Test container started");

  try {
    // Wait for PostgreSQL
    info(`Waiting for PostgreSQL to be ready (timeout: 60s)...`);
    const ready = await waitForPostgres(CONTAINER_NAME, 60);
    if (!ready) {
      error("PostgreSQL not ready after 60s");
      if (!noCleanup) {
        await cleanup();
      }
      process.exit(1);
    }
    success(`PostgreSQL ready in ${formatDuration(Date.now() - totalStartTime)}`);

    console.log("");

    // Run all test phases
    const results: TestResult[] = [];

    // Phase 1: Filesystem Verification
    section("Phase 1: Filesystem Verification");
    results.push(await testExtensionDirectoryStructure(CONTAINER_NAME));
    results.push(await testManifestPresent(CONTAINER_NAME));
    results.push(await testVersionInfoFilesPresent(CONTAINER_NAME));
    results.push(await testEnabledPgdgExtensionsPresent(manifest, CONTAINER_NAME));
    results.push(await testDisabledPgdgExtensionsNotPresent(manifest, CONTAINER_NAME));

    console.log("");

    // Phase 2: Runtime Verification
    section("Phase 2: Runtime Verification");
    results.push(await testVersionInfoTxt(manifest, CONTAINER_NAME));
    results.push(await testVersionInfoJson(manifest, CONTAINER_NAME));
    results.push(await testPreloadedExtensions(manifest, CONTAINER_NAME));
    results.push(await testPrecreatedExtensions(manifest, CONTAINER_NAME));
    results.push(await testEnabledExtensions(manifest, CONTAINER_NAME));
    results.push(await testDisabledExtensions(manifest, CONTAINER_NAME));
    results.push(await testPostgresConfiguration(CONTAINER_NAME));

    console.log("");

    // Phase 3: Tools Verification
    section("Phase 3: Tools Verification");
    results.push(await testToolsPresent(manifest, CONTAINER_NAME));
    results.push(await testPgBackRestFunctional(CONTAINER_NAME));
    results.push(await testPgBadgerFunctional(CONTAINER_NAME));

    console.log("");

    // Phase 4: Auto-Configuration Tests
    section("Phase 4: Auto-Configuration Tests");
    results.push(await testAutoConfigApplied(CONTAINER_NAME));

    console.log("");

    // Print summary
    section("Test Summary");
    testSummary(results);

    // Export results if requested
    if (outputJson) {
      info(`Exporting JSON Lines to: ${outputJson}`);
      await exportJsonLines(results, outputJson, "image-core");
      success(`JSON Lines exported to ${outputJson}`);
    }

    if (outputJunit) {
      info(`Exporting JUnit XML to: ${outputJunit}`);
      await exportJunitXml(results, outputJunit, "image-core");
      success(`JUnit XML exported to ${outputJunit}`);
    }

    const totalDuration = Date.now() - totalStartTime;
    console.log("");
    info(`Total test duration: ${formatDuration(totalDuration)}`);

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
    error(`Test harness failed: ${getErrorMessage(err)}`);
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
    error(`Fatal error: ${getErrorMessage(err)}`);
    if (!noCleanup) {
      await dockerCleanup(CONTAINER_NAME);
    }
    process.exit(1);
  }
}
