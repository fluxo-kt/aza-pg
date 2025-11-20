#!/usr/bin/env bun
/**
 * Functional Tests Group 3 - Docker Image
 *
 * This test suite covers comprehensive functional testing for the following extension categories:
 * - Operations: pg_cron (1 test)
 * - Performance: hypopg (1 test)
 * - Security: pgaudit, pgsodium (2 tests)
 * - Timeseries: timescaledb (1 test)
 * - Maintenance: pg_partman (1 test)
 *
 * Total: 6 tests
 *
 * Usage:
 *   bun scripts/docker/test-image-functional-3.ts [image-tag] [--no-cleanup]
 *   bun scripts/docker/test-image-functional-3.ts aza-pg:latest
 *   bun scripts/docker/test-image-functional-3.ts ghcr.io/fluxo-kt/aza-pg:18.1-202511142330-single-node
 *
 * Options:
 *   --no-cleanup  - Keep container running after tests
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
} from "../utils/logger";
import type { TestResult } from "../utils/logger";
import {
  readManifest,
  startContainer,
  waitForPostgres,
  cleanupTestData,
  testPgCronScheduling,
  testHypopgHypotheticalIndexes,
  testPgauditLogging,
  testPgsodiumEncryption,
  testTimescaledbHypertables,
  testPgPartmanPartitioning,
} from "./test-image-lib";

// Parse command line arguments
const args = Bun.argv.slice(2);
const imageTag = args.find((arg) => !arg.startsWith("--")) || "aza-pg-testing:latest";
const noCleanup = args.includes("--no-cleanup");

// Generate unique container name
const timestamp = Date.now();
const CONTAINER_NAME = `aza-pg-test-func3-${timestamp}`;

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

  section("Functional Tests Group 3 - Docker Image");
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

    section("Comprehensive Functional Tests - Group 3");

    info("Operations Extensions...");
    results.push(await testPgCronScheduling(CONTAINER_NAME));

    info("Performance Extensions...");
    results.push(await testHypopgHypotheticalIndexes(CONTAINER_NAME));

    info("Security Extensions...");
    results.push(await testPgauditLogging(CONTAINER_NAME));
    results.push(await testPgsodiumEncryption(CONTAINER_NAME));

    info("Timeseries Extensions...");
    results.push(await testTimescaledbHypertables(CONTAINER_NAME));

    info("Maintenance Extensions...");
    results.push(await testPgPartmanPartitioning(CONTAINER_NAME));

    console.log("");
    info("Functional tests group 3 completed");

    // Cleanup test data
    info("Cleaning up test data...");
    await cleanupTestData(CONTAINER_NAME);
    success("Test data cleaned up");

    console.log("");

    // Print summary
    section("Test Summary");
    testSummary(results);

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
