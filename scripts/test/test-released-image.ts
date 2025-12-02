#!/usr/bin/env bun
/**
 * Comprehensive Released Image Test Suite
 *
 * Single command to run ALL tests against a specific released Docker image.
 * Designed for validating production releases before deployment.
 *
 * Usage:
 *   bun run test:image ghcr.io/fluxo-kt/aza-pg:18.1-202512012323-single-node
 *   bun run test:image ghcr.io/fluxo-kt/aza-pg:18.1-202512012323-single-node --fast
 *
 * Requirements:
 *   - Image tag as first positional argument (REQUIRED)
 *   - Docker daemon running
 *   - Image must be pullable (or already present locally)
 *
 * Flags:
 *   --fast    Skip slow tests (regression, negative scenarios, comprehensive extension tests)
 *
 * Exit codes:
 *   0 - All tests passed
 *   1 - One or more tests failed
 *   2 - Invalid usage or missing arguments
 */

import { getErrorMessage } from "../utils/errors";
import { error, formatDuration, info, section, separator, success, warning } from "../utils/logger";
import { resolveImageTag, validateImageTag } from "./image-resolver";

/**
 * Phase result tracking
 */
interface PhaseResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
}

/**
 * Test suite statistics
 */
interface Stats {
  total: number;
  passed: number;
  failed: number;
  duration: number;
}

/**
 * Parse command line arguments
 */
function parseArgs(): { imageTag: string; fastMode: boolean } {
  const args = Bun.argv.slice(2);

  // Show help if requested
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  // Check for --fast flag
  const fastMode = args.includes("--fast");

  // Resolve image tag (positional argument)
  const imageTag = resolveImageTag({
    argv: Bun.argv,
    defaultImage: "", // No default - require explicit image
  });

  // Validate image tag was provided
  if (!imageTag || imageTag === "") {
    error("Image tag is required as first positional argument");
    console.log("");
    console.log("Usage:");
    console.log("  bun run test:image <image-tag> [--fast]");
    console.log("");
    console.log("Examples:");
    console.log("  bun run test:image ghcr.io/fluxo-kt/aza-pg:18.1-202512012323-single-node");
    console.log(
      "  bun run test:image ghcr.io/fluxo-kt/aza-pg:18.1-202512012323-single-node --fast"
    );
    process.exit(2);
  }

  // Validate image tag format
  try {
    validateImageTag(imageTag);
  } catch (err) {
    error(`Invalid image tag: ${getErrorMessage(err)}`);
    process.exit(2);
  }

  return { imageTag, fastMode };
}

/**
 * Print help message
 */
function printHelp(): void {
  console.log("Comprehensive Released Image Test Suite");
  console.log("");
  console.log("Usage:");
  console.log("  bun run test:image <image-tag> [--fast]");
  console.log("");
  console.log("Arguments:");
  console.log("  <image-tag>       Docker image tag to test (REQUIRED)");
  console.log("");
  console.log("Flags:");
  console.log("  --fast            Skip slow tests (regression, negative scenarios)");
  console.log("  -h, --help        Show this help message");
  console.log("");
  console.log("Examples:");
  console.log("  bun run test:image ghcr.io/fluxo-kt/aza-pg:18.1-202512012323-single-node");
  console.log("  bun run test:image ghcr.io/fluxo-kt/aza-pg:18.1-202512012323-single-node --fast");
  console.log("");
  console.log("Test Phases:");
  console.log("  1. Pre-flight validation (static checks + unit tests)");
  console.log("  2. Image pull & verify (docker pull, inspect, version check)");
  console.log("  3. Comprehensive image test (filesystem, runtime, tools)");
  console.log("  4. Auto-config tests (RAM/CPU detection, workload types)");
  console.log("  5. Extension tests (creation, functional, disabled, hooks)");
  console.log("  6. Stack deployment (single-node deployment test)");
  console.log("  7. Feature tests (PgBouncer, pgflow, pgmq, security)");
  console.log("  8. Regression tests (all regression test tiers)");
  console.log("  9. Negative scenarios (error handling, validation)");
}

/**
 * Run a command and return success/failure
 */
async function runCommand(command: string[]): Promise<{ success: boolean; output: string }> {
  try {
    const proc = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    const output = stdout + stderr;

    return {
      success: exitCode === 0,
      output,
    };
  } catch (err) {
    return {
      success: false,
      output: getErrorMessage(err),
    };
  }
}

/**
 * Run a command with live output (inherit stdio)
 */
async function runCommandLive(command: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn(command, {
      stdout: "inherit",
      stderr: "inherit",
    });

    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Run a test phase
 */
async function runPhase(
  name: string,
  command: string[],
  description: string
): Promise<PhaseResult> {
  const startTime = Date.now();

  info(`Running: ${description}`);

  const passed = await runCommandLive(command);
  const duration = Date.now() - startTime;

  if (passed) {
    success(`${name} passed (${formatDuration(duration)})`);
  } else {
    error(`${name} failed`);
  }

  console.log(""); // Blank line between phases

  return {
    name,
    passed,
    duration,
    error: passed ? undefined : "Phase failed (see output above)",
  };
}

/**
 * Phase 1: Pre-flight validation
 */
async function phase1Validation(fastMode: boolean): Promise<PhaseResult[]> {
  section("Phase 1: Pre-Flight Validation");
  const results: PhaseResult[] = [];

  // Static validation (always run)
  results.push(
    await runPhase("Static validation", ["bun", "run", "validate"], "Static checks + unit tests")
  );

  // Full validation (skip in fast mode)
  if (!fastMode) {
    results.push(
      await runPhase(
        "Full validation",
        ["bun", "run", "validate:all"],
        "Full validation (shellcheck, hadolint, yamllint)"
      )
    );
  }

  return results;
}

/**
 * Phase 2: Image pull & verify
 */
async function phase2ImageVerify(imageTag: string): Promise<PhaseResult[]> {
  section("Phase 2: Image Pull & Verify");
  const results: PhaseResult[] = [];

  // Docker pull
  const pullStart = Date.now();
  info("Pulling Docker image...");
  const pullResult = await runCommand(["docker", "pull", imageTag]);
  const pullDuration = Date.now() - pullStart;

  if (pullResult.success) {
    success(`Image pulled (${formatDuration(pullDuration)})`);
  } else {
    error("Failed to pull image");
    warning("Image may already be present locally");
  }

  results.push({
    name: "Image pull",
    passed: pullResult.success,
    duration: pullDuration,
    error: pullResult.success ? undefined : "Failed to pull image",
  });

  // Docker inspect
  const inspectStart = Date.now();
  info("Inspecting Docker image...");
  const inspectResult = await runCommand(["docker", "inspect", imageTag]);
  const inspectDuration = Date.now() - inspectStart;

  if (inspectResult.success) {
    success(`Image inspection passed (${formatDuration(inspectDuration)})`);
  } else {
    error("Failed to inspect image");
  }

  results.push({
    name: "Image inspect",
    passed: inspectResult.success,
    duration: inspectDuration,
    error: inspectResult.success ? undefined : "Image not found locally",
  });

  // PostgreSQL version check
  const versionStart = Date.now();
  info("Checking PostgreSQL version...");
  const versionResult = await runCommand(["docker", "run", "--rm", imageTag, "psql", "--version"]);
  const versionDuration = Date.now() - versionStart;

  if (versionResult.success && versionResult.output.includes("PostgreSQL")) {
    success(
      `PostgreSQL version: ${versionResult.output.trim()} (${formatDuration(versionDuration)})`
    );
  } else {
    error("Failed to verify PostgreSQL version");
  }

  results.push({
    name: "PostgreSQL version check",
    passed: versionResult.success && versionResult.output.includes("PostgreSQL"),
    duration: versionDuration,
    error:
      versionResult.success && versionResult.output.includes("PostgreSQL")
        ? undefined
        : "PostgreSQL version not found",
  });

  console.log("");
  return results;
}

/**
 * Phase 3: Comprehensive image test
 */
async function phase3ImageTest(imageTag: string): Promise<PhaseResult[]> {
  section("Phase 3: Comprehensive Image Test");
  const results: PhaseResult[] = [];

  results.push(
    await runPhase(
      "Comprehensive image test",
      ["bun", "scripts/docker/test-image.ts", imageTag],
      "Filesystem, runtime, tools verification (~27 functional tests)"
    )
  );

  return results;
}

/**
 * Phase 4: Auto-config tests
 */
async function phase4AutoConfig(imageTag: string): Promise<PhaseResult[]> {
  section("Phase 4: Auto-Configuration Tests");
  const results: PhaseResult[] = [];

  results.push(
    await runPhase(
      "Auto-config tests",
      ["bun", "scripts/test/test-auto-config.ts", imageTag],
      "RAM/CPU detection and scaling across memory tiers"
    )
  );

  return results;
}

/**
 * Phase 5: Extension tests
 */
async function phase5Extensions(imageTag: string, fastMode: boolean): Promise<PhaseResult[]> {
  section("Phase 5: Extension Tests");
  const results: PhaseResult[] = [];

  // Always run basic extension tests
  results.push(
    await runPhase(
      "Extension tests",
      ["bun", "scripts/test/test-extensions.ts", imageTag],
      "Dynamically generated extension tests from manifest"
    )
  );

  // Skip comprehensive tests in fast mode
  if (!fastMode) {
    results.push(
      await runPhase(
        "Comprehensive extension functional tests",
        ["bun", "scripts/test/test-all-extensions-functional.ts", imageTag],
        "All enabled extensions functional tests"
      )
    );

    results.push(
      await runPhase(
        "Hook extensions tests",
        ["bun", "scripts/test/test-hook-extensions.ts", imageTag],
        "Extensions using shared_preload_libraries hooks"
      )
    );

    results.push(
      await runPhase(
        "Disabled extensions tests",
        ["bun", "scripts/test/test-disabled-extensions.ts", imageTag],
        "Verify disabled extensions are properly excluded"
      )
    );

    results.push(
      await runPhase(
        "Integration extension combinations",
        ["bun", "scripts/test/test-integration-extension-combinations.ts", imageTag],
        "Critical extension combinations (timescaledb+pgvector, postgis+pgroonga, etc.)"
      )
    );
  }

  return results;
}

/**
 * Phase 6: Stack deployment
 */
async function phase6StackDeployment(imageTag: string, fastMode: boolean): Promise<PhaseResult[]> {
  section("Phase 6: Stack Deployment Tests");
  const results: PhaseResult[] = [];

  // Skip in fast mode
  if (!fastMode) {
    results.push(
      await runPhase(
        "Single stack deployment",
        ["bun", "scripts/test/test-single-stack.ts", imageTag],
        "Single-node stack deployment test"
      )
    );
  }

  return results;
}

/**
 * Phase 7: Feature tests
 */
async function phase7Features(imageTag: string, fastMode: boolean): Promise<PhaseResult[]> {
  section("Phase 7: Feature Tests");
  const results: PhaseResult[] = [];

  // Skip in fast mode
  if (!fastMode) {
    results.push(
      await runPhase(
        "PgBouncer health check",
        ["bun", "scripts/test/test-pgbouncer-healthcheck.ts", imageTag],
        "PgBouncer healthcheck and authentication"
      )
    );

    results.push(
      await runPhase(
        "PgBouncer failure scenarios",
        ["bun", "scripts/test/test-pgbouncer-failures.ts", imageTag],
        "PgBouncer error handling (wrong password, missing .pgpass, etc.)"
      )
    );

    results.push(
      await runPhase(
        "pgflow schema tests",
        ["bun", "scripts/test/test-pgflow-schema.ts", imageTag],
        "pgflow schema verification (table/function/type counts)"
      )
    );

    results.push(
      await runPhase(
        "pgflow functional tests",
        ["bun", "scripts/test/test-pgflow-functional.ts", imageTag],
        "Comprehensive pgflow workflow orchestration"
      )
    );

    results.push(
      await runPhase(
        "pgmq functional tests",
        ["bun", "scripts/test/test-pgmq-functional.ts", imageTag],
        "PostgreSQL message queue functional tests"
      )
    );

    results.push(
      await runPhase(
        "Security tests",
        ["bun", "test", "./scripts/test/test-security.test.ts"],
        "SCRAM-SHA-256 auth, pgAudit, network binding"
      )
    );
  }

  return results;
}

/**
 * Phase 8: Regression tests
 */
async function phase8Regression(imageTag: string, fastMode: boolean): Promise<PhaseResult[]> {
  section("Phase 8: Regression Tests");
  const results: PhaseResult[] = [];

  // Skip in fast mode
  if (!fastMode) {
    results.push(
      await runPhase(
        "Regression tests",
        ["bun", "scripts/test/run-all-regression-tests.ts", imageTag],
        "All regression test tiers (Tier 1-3)"
      )
    );
  }

  return results;
}

/**
 * Phase 9: Negative scenarios
 */
async function phase9NegativeScenarios(fastMode: boolean): Promise<PhaseResult[]> {
  section("Phase 9: Negative Scenario Tests");
  const results: PhaseResult[] = [];

  // Skip in fast mode
  if (!fastMode) {
    results.push(
      await runPhase(
        "Negative scenarios",
        ["bun", "scripts/test/test-negative-scenarios.ts"],
        "Error handling and validation scenarios"
      )
    );
  }

  return results;
}

/**
 * Print summary statistics
 */
function printSummary(results: PhaseResult[], totalDuration: number): Stats {
  separator();
  console.log("TEST SUMMARY");
  separator();

  const stats: Stats = {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    duration: totalDuration,
  };

  // Print each phase result
  for (const result of results) {
    const symbol = result.passed ? "✅" : "❌";
    const timeStr = formatDuration(result.duration);
    console.log(`  ${symbol} ${result.name} (${timeStr})`);
    if (!result.passed && result.error) {
      console.log(`     Error: ${result.error}`);
    }
  }

  separator();
  console.log(`\nTotal: ${stats.total} phases | Passed: ${stats.passed} | Failed: ${stats.failed}`);
  console.log(`Duration: ${formatDuration(stats.duration)}`);
  separator();

  return stats;
}

/**
 * Main test orchestration
 */
async function main(): Promise<void> {
  const startTime = Date.now();

  // Parse arguments
  const { imageTag, fastMode } = parseArgs();

  // Print header
  separator("=");
  console.log("  Comprehensive Released Image Test Suite");
  separator("=");
  console.log(`Image: ${imageTag}`);
  console.log(`Mode: ${fastMode ? "fast (quick validation)" : "full (all tests)"}`);
  console.log("");

  // Collect all test results
  const allResults: PhaseResult[] = [];

  try {
    // Phase 1: Pre-flight validation
    allResults.push(...(await phase1Validation(fastMode)));

    // Check if validation failed
    const validationFailed = allResults.some((r) => !r.passed);
    if (validationFailed) {
      error("Pre-flight validation failed - fix issues before testing image");
      const totalDuration = Date.now() - startTime;
      printSummary(allResults, totalDuration);
      process.exit(1);
    }

    // Phase 2: Image pull & verify
    allResults.push(...(await phase2ImageVerify(imageTag)));

    // Check if image verification failed
    const imageVerifyFailed = allResults.some((r) => !r.passed);
    if (imageVerifyFailed) {
      error("Image verification failed - check image tag and Docker daemon");
      const totalDuration = Date.now() - startTime;
      printSummary(allResults, totalDuration);
      process.exit(1);
    }

    // Phase 3: Comprehensive image test
    allResults.push(...(await phase3ImageTest(imageTag)));

    // Phase 4: Auto-config tests
    allResults.push(...(await phase4AutoConfig(imageTag)));

    // Phase 5: Extension tests
    allResults.push(...(await phase5Extensions(imageTag, fastMode)));

    // Phase 6: Stack deployment
    allResults.push(...(await phase6StackDeployment(imageTag, fastMode)));

    // Phase 7: Feature tests
    allResults.push(...(await phase7Features(imageTag, fastMode)));

    // Phase 8: Regression tests
    allResults.push(...(await phase8Regression(imageTag, fastMode)));

    // Phase 9: Negative scenarios
    allResults.push(...(await phase9NegativeScenarios(fastMode)));

    // Print final summary
    const totalDuration = Date.now() - startTime;
    console.log("");
    section("Final Results");
    const stats = printSummary(allResults, totalDuration);

    console.log("");

    // Exit with appropriate code
    if (stats.failed > 0) {
      error(`❌ ${stats.failed} phase(s) failed`);
      error("Review errors above and fix issues");
      process.exit(1);
    } else {
      success("✅ All tests passed!");
      info(`Completed ${stats.total} phases in ${formatDuration(stats.duration)}`);
      process.exit(0);
    }
  } catch (err) {
    error(`Fatal error: ${getErrorMessage(err)}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    const totalDuration = Date.now() - startTime;
    printSummary(allResults, totalDuration);
    process.exit(1);
  }
}

// Run main
if (import.meta.main) {
  main();
}
