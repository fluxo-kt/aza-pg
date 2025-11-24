#!/usr/bin/env bun
/**
 * Master regression test runner
 *
 * Orchestrates all regression test tiers (Tier 1-3) and provides
 * flexible execution modes for different CI/CD scenarios.
 *
 * Usage:
 *   bun scripts/test/run-all-regression-tests.ts [options]
 *
 * Options:
 *   --mode=MODE           Test mode: production or regression (default: production)
 *   --tier=TIER           Run specific tier only: 1, 2, or 3
 *   --fast                Skip slow tests (use minimal test sets)
 *   --no-cleanup          Don't cleanup containers after tests
 *   --generate-expected   Generate expected outputs for extension tests
 *   --verbose             Show detailed output
 *   --help                Show this help message
 *
 * Examples:
 *   bun scripts/test/run-all-regression-tests.ts
 *   bun scripts/test/run-all-regression-tests.ts --mode=regression
 *   bun scripts/test/run-all-regression-tests.ts --tier=1 --fast
 *   TEST_MODE=regression bun scripts/test/run-all-regression-tests.ts
 */

import { $ } from "bun";
import { detectTestMode, getTestModeSummary, type TestMode } from "./lib/test-mode.ts";

interface Config {
  mode: TestMode;
  tier?: 1 | 2 | 3;
  fast: boolean;
  noCleanup: boolean;
  generateExpected: boolean;
  verbose: boolean;
}

function parseArgs(): Config {
  const args = Bun.argv.slice(2);

  if (args.includes("--help")) {
    printHelp();
    process.exit(0);
  }

  const config: Config = {
    mode: "production",
    tier: undefined,
    fast: false,
    noCleanup: false,
    generateExpected: false,
    verbose: false,
  };

  for (const arg of args) {
    if (arg.startsWith("--mode=")) {
      const mode = arg.split("=")[1];
      if (mode !== "production" && mode !== "regression") {
        console.error(`Invalid mode: ${mode}. Must be 'production' or 'regression'`);
        process.exit(1);
      }
      config.mode = mode;
    } else if (arg.startsWith("--tier=")) {
      const tier = Number.parseInt(arg.split("=")[1], 10);
      if (tier !== 1 && tier !== 2 && tier !== 3) {
        console.error(`Invalid tier: ${tier}. Must be 1, 2, or 3`);
        process.exit(1);
      }
      config.tier = tier as 1 | 2 | 3;
    } else if (arg === "--fast") {
      config.fast = true;
    } else if (arg === "--no-cleanup") {
      config.noCleanup = true;
    } else if (arg === "--generate-expected") {
      config.generateExpected = true;
    } else if (arg === "--verbose") {
      config.verbose = true;
    } else {
      console.error(`Unknown option: ${arg}`);
      console.error("Run with --help for usage");
      process.exit(1);
    }
  }

  return config;
}

function printHelp(): void {
  const helpText = `
Master regression test runner

Orchestrates all regression test tiers (Tier 1-3) and provides
flexible execution modes for different CI/CD scenarios.

Usage:
  bun scripts/test/run-all-regression-tests.ts [options]

Options:
  --mode=MODE           Test mode: production or regression (default: production)
  --tier=TIER           Run specific tier only: 1, 2, or 3
  --fast                Skip slow tests (use minimal test sets)
  --no-cleanup          Don't cleanup containers after tests
  --generate-expected   Generate expected outputs for extension tests
  --verbose             Show detailed output
  --help                Show this help message

Test Modes:
  production            Test exact release image behavior (enabled extensions only)
  regression            Test all extensions including disabled ones (comprehensive)

Test Tiers:
  Tier 1                Core PostgreSQL regression tests (30 official tests)
  Tier 2                Extension-specific regression tests (10-13 extensions)
  Tier 3                Extension interaction tests (4-14 tests)

Examples:
  # Run all tiers in production mode
  bun scripts/test/run-all-regression-tests.ts

  # Run all tiers in regression mode
  bun scripts/test/run-all-regression-tests.ts --mode=regression
  TEST_MODE=regression bun scripts/test/run-all-regression-tests.ts

  # Run Tier 1 only (fast PR validation)
  bun scripts/test/run-all-regression-tests.ts --tier=1 --fast

  # Generate expected outputs for Tier 2
  bun scripts/test/run-all-regression-tests.ts --tier=2 --generate-expected
`.trim();
  console.log(helpText);
}

async function runTier1(config: Config): Promise<boolean> {
  console.log("\n============================================================");
  console.log("  Tier 1: Core PostgreSQL Regression Tests");
  console.log("============================================================\n");

  const args = ["scripts/test/test-postgres-core-regression.ts", `--mode=${config.mode}`];

  if (config.fast) {
    args.push("--tests=boolean,int2,int4,select");
  }
  if (config.noCleanup) {
    args.push("--no-cleanup");
  }
  if (config.verbose) {
    args.push("--verbose");
  }

  try {
    await $`bun ${args}`;
    return true;
  } catch (error) {
    console.error("❌ Tier 1 failed:", error);
    return false;
  }
}

async function runTier2(config: Config): Promise<boolean> {
  console.log("\n============================================================");
  console.log("  Tier 2: Extension Regression Tests");
  console.log("============================================================\n");

  const args = ["scripts/test/test-extension-regression.ts", `--mode=${config.mode}`];

  if (config.generateExpected) {
    args.push("--generate-expected");
  }
  if (config.fast) {
    args.push("--extensions=vector,timescaledb,pg_cron");
  }
  if (config.noCleanup) {
    args.push("--no-cleanup");
  }
  if (config.verbose) {
    args.push("--verbose");
  }

  try {
    await $`bun ${args}`;
    return true;
  } catch (error) {
    console.error("❌ Tier 2 failed:", error);
    return false;
  }
}

async function runTier3(config: Config): Promise<boolean> {
  console.log("\n============================================================");
  console.log("  Tier 3: Extension Interaction Tests");
  console.log("============================================================\n");

  const args = ["scripts/test/test-extension-interactions.ts", `--mode=${config.mode}`];

  if (config.noCleanup) {
    args.push("--no-cleanup");
  }
  if (config.verbose) {
    args.push("--verbose");
  }

  try {
    await $`bun ${args}`;
    return true;
  } catch (error) {
    console.error("❌ Tier 3 failed:", error);
    return false;
  }
}

async function main(): Promise<void> {
  const config = parseArgs();

  const testMode = Bun.env.TEST_MODE || config.mode;
  if (testMode !== config.mode) {
    console.log(`\n⚠️  TEST_MODE environment variable (${testMode}) overrides --mode flag\n`);
    config.mode = testMode as TestMode;
  }

  const detectedMode = await detectTestMode();
  console.log(getTestModeSummary(detectedMode));
  console.log("");

  if (config.mode !== detectedMode) {
    console.log(
      `ℹ️  Note: Detected mode (${detectedMode}) differs from requested mode (${config.mode})`
    );
    console.log(`    Using requested mode: ${config.mode}\n`);
  }

  const startTime = Date.now();
  const results: { tier: string; passed: boolean; duration: number }[] = [];

  if (config.tier === 1 || !config.tier) {
    const tierStart = Date.now();
    const passed = await runTier1(config);
    results.push({ tier: "Tier 1", passed, duration: Date.now() - tierStart });
  }

  if (config.tier === 2 || !config.tier) {
    const tierStart = Date.now();
    const passed = await runTier2(config);
    results.push({ tier: "Tier 2", passed, duration: Date.now() - tierStart });
  }

  if (config.tier === 3 || !config.tier) {
    const tierStart = Date.now();
    const passed = await runTier3(config);
    results.push({ tier: "Tier 3", passed, duration: Date.now() - tierStart });
  }

  const totalDuration = Math.round((Date.now() - startTime) / 1000);

  console.log("\n============================================================");
  console.log("  Regression Test Summary");
  console.log("============================================================\n");

  console.log(`Mode: ${config.mode.toUpperCase()}`);
  console.log(`Duration: ${totalDuration}s\n`);

  for (const result of results) {
    const status = result.passed ? "✅ PASSED" : "❌ FAILED";
    const duration = Math.round(result.duration / 1000);
    console.log(`${result.tier}: ${status} (${duration}s)`);
  }

  const allPassed = results.every((r) => r.passed);

  console.log("\n============================================================");
  if (allPassed) {
    console.log("✅ All regression tests passed!");
  } else {
    console.log("❌ Some regression tests failed");
  }
  console.log("============================================================\n");

  process.exit(allPassed ? 0 : 1);
}

main().catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});
