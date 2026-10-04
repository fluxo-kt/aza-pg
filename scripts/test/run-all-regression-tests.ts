#!/usr/bin/env bun
/**
 * Regression runner: Tier 2 (each extension's SQL file against its expected output) and Tier 3
 * (extension interaction tests).
 *
 * There is no Tier 1: PostgreSQL's own regression tests exercise the PGDG server binary this image
 * copies unchanged, so no image defect could fail them.
 *
 * Usage: bun scripts/test/run-all-regression-tests.ts [--mode=production|regression] [--tier=2|3]
 *          [--generate-expected] [--verbose]
 */

import { $ } from "bun";
import { detectTestMode, getTestModeSummary, type TestMode } from "./lib/test-mode";

interface Config {
  mode: TestMode;
  tier?: 2 | 3;
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
    generateExpected: false,
    verbose: false,
  };

  for (const arg of args) {
    if (arg.startsWith("--mode=")) {
      const mode = arg.split("=")[1] ?? "";
      if (mode !== "production" && mode !== "regression") {
        console.error(`Invalid mode: ${mode}. Must be 'production' or 'regression'`);
        process.exit(1);
      }
      config.mode = mode;
    } else if (arg.startsWith("--tier=")) {
      const tier = Number.parseInt(arg.split("=")[1] ?? "0", 10);
      if (tier !== 2 && tier !== 3) {
        console.error(`Invalid tier: ${tier}. Must be 2 or 3`);
        process.exit(1);
      }
      config.tier = tier;
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
  console.log(`Regression runner (Tier 2: extension SQL vs expected output; Tier 3: interactions)

Usage: bun scripts/test/run-all-regression-tests.ts [options]
  --mode=MODE           production (extensions shipped enabled) | regression (also comprehensive-only)
  --tier=TIER           2 or 3 (default: both)
  --generate-expected   Rewrite Tier 2 expected outputs from the image (review the diff)
  --verbose             Show detailed output`);
}

async function runTier2(config: Config): Promise<boolean> {
  console.log("\n============================================================");
  console.log("  Tier 2: Extension Regression Tests");
  console.log("============================================================\n");

  const args = ["scripts/test/test-extension-regression.ts", `--mode=${config.mode}`];

  if (config.generateExpected) {
    args.push("--generate-expected");
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
