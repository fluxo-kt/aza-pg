#!/usr/bin/env bun
/**
 * Functional Tests Group 1 - Docker Image
 *
 * This test suite covers comprehensive functional testing for the following extension categories:
 * - AI/Vector: pgvector, vectorscale (2 tests)
 * - Analytics: hll (1 test)
 * - CDC: wal2json (1 test)
 * - Indexing: btree_gist (1 test)
 * - Language: plpgsql (1 test)
 * - Observability: pg_stat_statements (1 test)
 * - Utilities: pg_hashids (1 test)
 * - Validation: pg_jsonschema (1 test)
 *
 * Total: 9 tests
 *
 * Usage:
 *   bun scripts/docker/test-image-functional-1.ts [image-tag] [--no-cleanup] [--output-json <path>] [--output-junit <path>]
 *   bun scripts/docker/test-image-functional-1.ts aza-pg:latest
 *   bun scripts/docker/test-image-functional-1.ts ghcr.io/fluxo-kt/aza-pg:18.1-202511142330-single-node
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
  cleanupTestData,
  testPgvectorComprehensive,
  testVectorscaleDiskann,
  testHllCardinality,
  testWal2jsonReplication,
  testBtreeGistExclusion,
  testPlpgsqlTriggers,
  testPgStatStatements,
  testPgHashidsEncoding,
  testPgJsonschemaValidation,
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
const CONTAINER_NAME = `aza-pg-test-func1-${timestamp}`;

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

  section("Functional Tests Group 1 - Docker Image");
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

    section("Comprehensive Functional Tests - Group 1");

    info("AI/Vector Extensions...");
    results.push(await testPgvectorComprehensive(CONTAINER_NAME));
    results.push(await testVectorscaleDiskann(CONTAINER_NAME));

    info("Analytics Extensions...");
    results.push(await testHllCardinality(CONTAINER_NAME));

    info("CDC Extensions...");
    results.push(await testWal2jsonReplication(CONTAINER_NAME));

    info("Indexing Extensions...");
    results.push(await testBtreeGistExclusion(CONTAINER_NAME));

    info("Language Extensions...");
    results.push(await testPlpgsqlTriggers(CONTAINER_NAME));

    info("Observability Extensions...");
    results.push(await testPgStatStatements(CONTAINER_NAME));

    info("Utilities Extensions...");
    results.push(await testPgHashidsEncoding(CONTAINER_NAME));

    info("Validation Extensions...");
    results.push(await testPgJsonschemaValidation(CONTAINER_NAME));

    console.log("");
    info("Functional tests group 1 completed");

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
      await exportJsonLines(results, outputJson, "image-functional-1");
      success(`JSON Lines exported to ${outputJson}`);
    }

    if (outputJunit) {
      info(`Exporting JUnit XML to: ${outputJunit}`);
      await exportJunitXml(results, outputJunit, "image-functional-1");
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
