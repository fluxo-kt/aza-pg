#!/usr/bin/env bun
/**
 * Unified validation script for aza-pg
 * Runs all linting, formatting, and type checking in one command
 *
 * Usage:
 *   bun scripts/validate.ts           # Fast validation (oxlint, prettier, tsc)
 *   bun scripts/validate.ts --fast    # Same as above (explicit)
 *   bun scripts/validate.ts --all     # Full validation (includes shellcheck, hadolint, yaml)
 */

import { error, info, section, success, warning } from "./utils/logger.ts";

/**
 * Validation check configuration
 */
type ValidationCheck = {
  name: string;
  command: string[];
  description: string;
  required: boolean; // If false, failure only warns but doesn't fail the whole validation
};

/**
 * Run a validation check
 * @returns true if check passed, false otherwise
 */
async function runCheck(check: ValidationCheck): Promise<boolean> {
  info(`Running: ${check.description}`);

  try {
    const proc = Bun.spawn(check.command, {
      stdout: "inherit",
      stderr: "inherit",
    });

    const exitCode = await proc.exited;

    if (exitCode === 0) {
      success(`${check.name} passed`);
      return true;
    } else {
      if (check.required) {
        error(`${check.name} failed (exit code ${exitCode})`);
      } else {
        warning(`${check.name} failed (exit code ${exitCode}) - non-critical`);
      }
      return false;
    }
  } catch (err) {
    if (check.required) {
      error(`${check.name} error: ${err}`);
    } else {
      warning(`${check.name} error: ${err} - non-critical`);
    }
    return false;
  }
}

/**
 * Main validation function
 */
async function validate(mode: "fast" | "all"): Promise<void> {
  const startTime = Date.now();

  section(`Validation Mode: ${mode === "fast" ? "FAST" : "FULL"}`);

  // Core checks (always run)
  const coreChecks: ValidationCheck[] = [
    {
      name: "Oxlint",
      command: ["bunx", "oxlint", "."],
      description: "JavaScript/TypeScript linting",
      required: true,
    },
    {
      name: "Prettier",
      command: ["bunx", "prettier", "--check", "."],
      description: "Code formatting check",
      required: true,
    },
    {
      name: "TypeScript",
      command: ["bunx", "tsc", "--noEmit"],
      description: "Type checking",
      required: true,
    },
  ];

  // Extended checks (only in --all mode)
  const extendedChecks: ValidationCheck[] = [
    {
      name: "ShellCheck",
      command: [
        "find",
        ".",
        "-name",
        "*.sh",
        "-not",
        "-path",
        "./node_modules/*",
        "-not",
        "-path",
        "./.git/*",
        "-not",
        "-path",
        "./.archived/*",
        "-exec",
        "shellcheck",
        "{}",
        "+",
      ],
      description: "Shell script linting",
      required: false, // Non-critical if shellcheck not installed
    },
    {
      name: "Hadolint",
      command: ["sh", "-c", "docker run --rm -i hadolint/hadolint < docker/postgres/Dockerfile"],
      description: "Dockerfile linting",
      required: false, // Non-critical if Docker not running
    },
    {
      name: "YAML Lint",
      command: ["bunx", "yaml-lint", "**/*.{yml,yaml}", "--ignore=node_modules/**"],
      description: "YAML file linting",
      required: true,
    },
  ];

  // Determine which checks to run
  const checks = mode === "all" ? [...coreChecks, ...extendedChecks] : coreChecks;

  // Run all checks
  const results: boolean[] = [];
  for (const check of checks) {
    const passed = await runCheck(check);
    results.push(passed);
    console.log(""); // Blank line between checks
  }

  // Summary
  const duration = Date.now() - startTime;
  section("Validation Summary");

  const passedCount = results.filter((r) => r).length;
  const failedCount = results.filter((r) => !r).length;
  const total = results.length;

  console.log(`Total checks: ${total}`);
  console.log(`Passed: ${passedCount}`);
  console.log(`Failed: ${failedCount}`);
  console.log(`Duration: ${(duration / 1000).toFixed(2)}s`);
  console.log("");

  // Determine if we should exit with error
  const criticalFailures = checks
    .map((check, idx) => ({ check, passed: results[idx] }))
    .filter(({ check, passed }) => check.required && !passed);

  if (criticalFailures.length > 0) {
    error(`${criticalFailures.length} critical check(s) failed`);
    process.exit(1);
  } else if (failedCount > 0) {
    warning(`${failedCount} non-critical check(s) failed`);
    success("All critical checks passed");
  } else {
    success("All checks passed!");
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const mode = args.includes("--all") ? "all" : "fast";

// Run validation
validate(mode);
