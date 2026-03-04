#!/usr/bin/env bun
/**
 * Comprehensive Docker Image Test Harness
 *
 * Runs a full suite of tests against a Docker image:
 * - Filesystem verification (extensions, tools, manifest)
 * - Runtime verification (extension creation, preload, config)
 * - Extension functional tests
 * - Auto-configuration tests
 * - Disabled extensions tests
 * - Tools verification
 *
 * All test logic lives in test-image-lib.ts. This file is the CLI entry point:
 * it owns the container lifecycle (start/wait/cleanup) and orchestrates the suite.
 *
 * Usage:
 *   bun scripts/docker/test-image.ts [image-tag]
 *   bun scripts/docker/test-image.ts aza-pg:latest
 *   bun scripts/docker/test-image.ts ghcr.io/fluxo-kt/aza-pg:18.1-202511142330-single-node
 *
 * Options:
 *   --no-cleanup       - Keep container running after tests
 *   --fast             - Skip comprehensive functional tests (quick smoke test only)
 *   --functional-only  - Run ONLY comprehensive functional tests (skip other phases)
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
  cleanupTestData,
  isExtensionEnabled,
  readManifest,
  startContainer as libStartContainer,
  waitForPostgres as libWaitForPostgres,
  testAutoConfigApplied,
  testBtreeGistExclusion,
  testDisabledExtensions,
  testDisabledPgdgExtensionsNotPresent,
  testEnabledExtensions,
  testEnabledPgdgExtensionsPresent,
  testExtensionDirectoryStructure,
  testHllCardinality,
  testHttpRequests,
  testHypopgHypotheticalIndexes,
  testManifestPresent,
  testPgauditLogging,
  testPgBackRestFunctional,
  testPgBadgerFunctional,
  testPgCronScheduling,
  testPgHashidsEncoding,
  testPgJsonschemaValidation,
  testPgmqQueue,
  testPgPartmanPartitioning,
  testPgSafeupdateProtection,
  testPgStatStatements,
  testPgTrgmSimilarity,
  testPgvectorComprehensive,
  testPgsodiumEncryption,
  testPgroutingShortestPath,
  testPgroongaFullText,
  testPlpgsqlTriggers,
  testPostgresConfiguration,
  testPostgisSpatialQuery,
  testPrecreatedExtensions,
  testPreloadedExtensions,
  testRumRankedSearch,
  testTimescaledbHypertables,
  testToolsPresent,
  testVectorscaleDiskann,
  testVersionInfoFilesPresent,
  testVersionInfoJson,
  testVersionInfoTxt,
  testWal2jsonReplication,
} from "./test-image-lib";

// Parse command line arguments
const args = Bun.argv.slice(2);
const imageTag = args.find((arg) => !arg.startsWith("--")) || "aza-pg-testing:latest";
const noCleanup = args.includes("--no-cleanup");
const fastMode = args.includes("--fast");
const functionalOnly = args.includes("--functional-only");

// Generate unique container name
const timestamp = Date.now();
const CONTAINER_NAME = `aza-pg-test-${timestamp}`;

/**
 * Start test container with console logging
 */
async function startContainer(image: string): Promise<boolean> {
  info(`Starting test container: ${CONTAINER_NAME}`);
  info(`Image: ${image}`);
  const ok = await libStartContainer(image, CONTAINER_NAME);
  if (!ok) {
    error("Failed to start test container");
    return false;
  }
  success("Test container started");
  return true;
}

/**
 * Wait for PostgreSQL with console logging
 *
 * IMPORTANT: pg_isready returns true during initdb phase, but PostgreSQL restarts after
 * initdb completes. This causes a race condition where tests try to connect during shutdown.
 * The lib implementation requires multiple consecutive successful SQL queries for stability.
 */
async function waitForPostgres(timeoutSeconds: number = 90): Promise<boolean> {
  info(`Waiting for PostgreSQL to be ready (timeout: ${timeoutSeconds}s)...`);
  const startTime = Date.now();
  const ok = await libWaitForPostgres(CONTAINER_NAME, timeoutSeconds);
  if (!ok) {
    error(`PostgreSQL not stable after ${timeoutSeconds}s`);
    return false;
  }
  success(`PostgreSQL stable in ${formatDuration(Date.now() - startTime)}`);
  return true;
}

/**
 * Cleanup test container
 */
async function cleanup(): Promise<void> {
  info("Cleaning up test container...");
  await dockerCleanup(CONTAINER_NAME);
  success("Test container removed");
}

/**
 * Main test orchestration
 */
async function main(): Promise<void> {
  const totalStartTime = Date.now();

  section("Comprehensive Docker Image Test Harness");
  info(`Image: ${imageTag}`);
  info(`Container: ${CONTAINER_NAME}`);

  if (functionalOnly) {
    info("Mode: Functional tests only");
  } else if (fastMode) {
    info("Mode: Fast (skipping comprehensive functional tests)");
  } else {
    info("Mode: Full (all tests including comprehensive functional tests)");
  }

  // Check Docker daemon
  info("Checking Docker daemon...");
  await checkDockerDaemon();
  success("Docker daemon is running");

  // Read manifest
  info("Reading manifest...");
  const manifest = await readManifest();
  success(`Manifest loaded: ${manifest.entries.length} total entries`);

  // Start test container
  const started = await startContainer(imageTag);
  if (!started) {
    process.exit(1);
  }

  try {
    // Wait for PostgreSQL — increased timeout to 120s to handle initdb phase restart
    const ready = await waitForPostgres(120);
    if (!ready) {
      if (!noCleanup) await cleanup();
      process.exit(1);
    }

    console.log("");

    const results: TestResult[] = [];
    // Alias for brevity — all lib functions take containerName as first arg
    const c = CONTAINER_NAME;

    if (!functionalOnly) {
      // Phase 1: Filesystem Verification
      section("Phase 1: Filesystem Verification");
      results.push(await testExtensionDirectoryStructure(c));
      results.push(await testManifestPresent(c));
      results.push(await testVersionInfoFilesPresent(c));
      results.push(await testEnabledPgdgExtensionsPresent(manifest, c));
      results.push(await testDisabledPgdgExtensionsNotPresent(manifest, c));

      console.log("");

      // Phase 2: Runtime Verification
      section("Phase 2: Runtime Verification");
      results.push(await testVersionInfoTxt(manifest, c));
      results.push(await testVersionInfoJson(manifest, c));
      results.push(await testPreloadedExtensions(manifest, c));
      results.push(await testPrecreatedExtensions(manifest, c));
      results.push(await testEnabledExtensions(manifest, c));
      results.push(await testDisabledExtensions(manifest, c));
      results.push(await testPostgresConfiguration(c));

      console.log("");

      // Phase 3: Tools Verification
      section("Phase 3: Tools Verification");
      results.push(await testToolsPresent(manifest, c));
      results.push(await testPgBackRestFunctional(c));
      results.push(await testPgBadgerFunctional(c));

      console.log("");

      // Phase 4: Auto-Configuration Tests
      section("Phase 4: Auto-Configuration Tests");
      results.push(await testAutoConfigApplied(c));

      console.log("");
    }

    // Phase 5: Comprehensive Functional Tests
    if (functionalOnly || !fastMode) {
      section("Phase 5: Comprehensive Functional Tests");

      info("AI/Vector Extensions...");
      results.push(await testPgvectorComprehensive(c));
      results.push(await testVectorscaleDiskann(c));

      info("Analytics Extensions...");
      results.push(await testHllCardinality(c));

      info("CDC Extensions...");
      results.push(await testWal2jsonReplication(c));

      info("GIS Extensions...");
      if (isExtensionEnabled(manifest, "postgis")) {
        results.push(await testPostgisSpatialQuery(c));
      }
      if (isExtensionEnabled(manifest, "pgrouting")) {
        results.push(await testPgroutingShortestPath(c));
      }

      info("Graph Extensions...");
      results.push(await testBtreeGistExclusion(c));

      info("Integration Extensions...");
      results.push(await testHttpRequests(c));

      info("Language Extensions...");
      results.push(await testPlpgsqlTriggers(c));

      info("Maintenance Extensions...");
      results.push(await testPgPartmanPartitioning(c));

      info("Observability Extensions...");
      results.push(await testPgStatStatements(c));

      info("Operations Extensions...");
      results.push(await testPgCronScheduling(c));

      info("Performance Extensions...");
      results.push(await testHypopgHypotheticalIndexes(c));

      info("Queueing Extensions...");
      results.push(await testPgmqQueue(c));

      info("Safety Extensions...");
      results.push(await testPgSafeupdateProtection(c));

      info("Search Extensions...");
      results.push(await testPgTrgmSimilarity(c));
      results.push(await testPgroongaFullText(c));
      results.push(await testRumRankedSearch(c));

      info("Security Extensions...");
      results.push(await testPgauditLogging(c));
      results.push(await testPgsodiumEncryption(c));

      info("Timeseries Extensions...");
      results.push(await testTimescaledbHypertables(c));

      info("Utilities Extensions...");
      results.push(await testPgHashidsEncoding(c));

      info("Validation Extensions...");
      results.push(await testPgJsonschemaValidation(c));

      console.log("");
      info("Comprehensive functional tests completed");

      await cleanupTestData(c);
      console.log("");
    } else {
      info("Skipping comprehensive functional tests (--fast mode)");
      info("Use without --fast flag to run all ~27 functional tests");
      console.log("");
    }

    // Print summary
    section("Test Summary");
    testSummary(results);

    const totalDuration = Date.now() - totalStartTime;
    console.log("");
    info(`Total test duration: ${formatDuration(totalDuration)}`);

    const failed = results.filter((r) => !r.passed);
    if (failed.length > 0) {
      if (!noCleanup) {
        await cleanup();
      } else {
        warning(`Container ${CONTAINER_NAME} kept running (--no-cleanup flag)`);
      }
      process.exit(1);
    }

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
