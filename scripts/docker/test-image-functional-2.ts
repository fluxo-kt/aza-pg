#!/usr/bin/env bun
/**
 * Functional Tests Group 2 - Docker Image
 *
 * This test suite covers comprehensive functional testing for the following extension categories:
 * - GIS: postgis, pgrouting (2 tests)
 * - Search: pg_trgm, pgroonga, rum (3 tests)
 * - Integration: http (1 test)
 * - Queueing: pgmq (1 test)
 * - Safety: pg_safeupdate (1 test)
 *
 * Total: 8 tests
 *
 * Usage:
 *   bun scripts/docker/test-image-functional-2.ts [image-tag] [--no-cleanup] [--output-json <path>] [--output-junit <path>]
 *   bun scripts/docker/test-image-functional-2.ts aza-pg:latest
 *   bun scripts/docker/test-image-functional-2.ts ghcr.io/fluxo-kt/aza-pg:18.1-202511142330-single-node
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
  isExtensionEnabled,
  startContainer,
  waitForPostgres,
  cleanupTestData,
  testPostgisSpatialQuery,
  testPgroutingShortestPath,
  testPgTrgmSimilarity,
  testPgroongaFullText,
  testRumRankedSearch,
  testHttpRequests,
  testPgmqQueue,
  testPgSafeupdateProtection,
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
const CONTAINER_NAME = `aza-pg-test-func2-${timestamp}`;

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

  section("Functional Tests Group 2 - Docker Image");
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

    // Run all functional tests
    const results: TestResult[] = [];

    section("Comprehensive Functional Tests - Group 2");

    info("GIS Extensions...");
    if (isExtensionEnabled(manifest, "postgis")) {
      results.push(await testPostgisSpatialQuery(CONTAINER_NAME));
    }
    if (isExtensionEnabled(manifest, "pgrouting")) {
      results.push(await testPgroutingShortestPath(CONTAINER_NAME));
    }

    info("Search Extensions...");
    results.push(await testPgTrgmSimilarity(CONTAINER_NAME));
    results.push(await testPgroongaFullText(CONTAINER_NAME));
    results.push(await testRumRankedSearch(CONTAINER_NAME));

    info("Integration Extensions...");
    results.push(await testHttpRequests(CONTAINER_NAME));

    info("Queueing Extensions...");
    results.push(await testPgmqQueue(CONTAINER_NAME));

    info("Safety Extensions...");
    results.push(await testPgSafeupdateProtection(CONTAINER_NAME));

    console.log("");
    info("Functional tests group 2 completed");

    // Cleanup test data
    info("Cleaning up test data...");
    await cleanupTestData(CONTAINER_NAME);
    success("Test data cleaned up");

    console.log("");

    // Print summary
    section("Test Summary");
    testSummary(results);

    // Export results if requested
    if (outputJson) {
      info(`Exporting JSON Lines to: ${outputJson}`);
      await exportJsonLines(results, outputJson, "image-functional-2");
      success(`JSON Lines exported to ${outputJson}`);
    }

    if (outputJunit) {
      info(`Exporting JUnit XML to: ${outputJunit}`);
      await exportJunitXml(results, outputJunit, "image-functional-2");
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
