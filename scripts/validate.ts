#!/usr/bin/env bun
/**
 * Unified validation script for aza-pg
 * Runs all linting, formatting, and type checking in one command
 *
 * Usage:
 *   bun scripts/validate.ts           # Fast validation (oxlint, prettier, tsc)
 *   bun scripts/validate.ts --fast    # Same as above (explicit)
 *   bun scripts/validate.ts --all     # Full validation (includes shellcheck, hadolint, yaml, secret scan)
 *
 * Environment variables:
 *   ALLOW_MISSING_SHELLCHECK=1        # Don't fail if shellcheck not installed
 *   ALLOW_MISSING_HADOLINT=1          # Don't fail if Docker/hadolint unavailable
 *   ALLOW_MISSING_YAMLLINT=1          # Don't fail if Docker/yamllint unavailable
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
  requiresDocker?: boolean; // If true, check if Docker is available
  envOverride?: string; // Environment variable to make check non-critical
};

/**
 * Check if Docker is available
 */
async function isDockerAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "info"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Run a validation check
 * @returns true if check passed, false otherwise
 */
async function runCheck(check: ValidationCheck): Promise<boolean> {
  info(`Running: ${check.description}`);

  // Check if this check can be skipped via environment variable
  const isOptional = check.envOverride && Bun.env[check.envOverride] === "1";
  const effectivelyRequired = check.required && !isOptional;

  // Check Docker availability if needed
  if (check.requiresDocker && !(await isDockerAvailable())) {
    const message = `${check.name} skipped - Docker not available. Install Docker or set ${check.envOverride}=1`;
    if (effectivelyRequired) {
      error(message);
      return false;
    } else {
      warning(message);
      return false;
    }
  }

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
      if (effectivelyRequired) {
        error(`${check.name} failed (exit code ${exitCode})`);
      } else {
        warning(`${check.name} failed (exit code ${exitCode}) - non-critical`);
      }
      return false;
    }
  } catch (err) {
    const message = `${check.name} error: ${err instanceof Error ? err.message : String(err)}`;
    if (effectivelyRequired) {
      error(message);
    } else {
      warning(`${message} - non-critical`);
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
      command: ["bun", "x", "oxlint", "."],
      description: "JavaScript/TypeScript linting",
      required: true,
    },
    {
      name: "Prettier",
      command: ["bun", "x", "prettier", "--check", "."],
      description: "Code formatting check",
      required: true,
    },
    {
      name: "TypeScript",
      command: ["bun", "x", "tsc", "--noEmit"],
      description: "Type checking",
      required: true,
    },
  ];

  // Extended checks (only in --all mode)
  const extendedChecks: ValidationCheck[] = [
    {
      name: "ShellCheck",
      command: [
        "sh",
        "-c",
        'find . -name "*.sh" -not -path "./node_modules/*" -not -path "./.git/*" -not -path "./.archived/*" -exec shellcheck {} +',
      ],
      description: "Shell script linting",
      required: true,
      envOverride: "ALLOW_MISSING_SHELLCHECK",
    },
    {
      name: "Hadolint",
      command: ["sh", "-c", "docker run --rm -i hadolint/hadolint < docker/postgres/Dockerfile"],
      description: "Dockerfile linting",
      required: true,
      requiresDocker: true,
      envOverride: "ALLOW_MISSING_HADOLINT",
    },
    {
      name: "YAML Lint",
      command: [
        "sh",
        "-c",
        'docker run --rm -v "$(pwd):/work:ro" cytopia/yamllint -c /work/.yamllint /work',
      ],
      description: "YAML file linting (yamllint)",
      required: true,
      requiresDocker: true,
      envOverride: "ALLOW_MISSING_YAMLLINT",
    },
    {
      name: "Secret Scan",
      command: [
        "sh",
        "-c",
        'git ls-files | grep -v -E "(\\.env\\.example|\\.archived/|docs/|\\.[^/]*rc$)" | xargs grep -nHiE "(password|secret|api[_-]?key|token)\\s*[:=]" || true',
      ],
      description: "Scan for potential secrets in tracked files (warn-only)",
      required: false,
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
    throw new Error("Validation failed");
  } else if (failedCount > 0) {
    warning(`${failedCount} non-critical check(s) failed`);
    success("All critical checks passed");
  } else {
    success("All checks passed!");
  }
}

// Parse command line arguments (Bun.argv includes the script path, so we skip the first 2 elements like Node)
const args = Bun.argv.slice(2);
const mode = args.includes("--all") ? "all" : "fast";

// Run validation
await validate(mode);
