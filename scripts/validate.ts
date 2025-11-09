#!/usr/bin/env bun
/**
 * Unified validation script for aza-pg
 * Runs all linting, formatting, and type checking in one command
 *
 * Usage:
 *   bun scripts/validate.ts              # Fast validation (oxlint, prettier, tsc)
 *   bun scripts/validate.ts --fast       # Same as above (explicit)
 *   bun scripts/validate.ts --all        # Full validation (includes shellcheck, hadolint, yaml, secret scan)
 *   bun scripts/validate.ts --parallel   # Run checks in parallel (faster but less readable errors)
 *
 * Environment variables:
 *   ALLOW_MISSING_SHELLCHECK=1           # Don't fail if shellcheck not installed
 *   ALLOW_MISSING_HADOLINT=1             # Don't fail if Docker/hadolint unavailable
 *   ALLOW_MISSING_YAMLLINT=1             # Don't fail if Docker/yamllint unavailable
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
  } catch (err) {
    console.debug(`Docker availability check failed: ${String(err)}`);
    return false;
  }
}

/**
 * Run a validation check
 * @returns object with passed status and whether it's critical
 */
async function runCheck(check: ValidationCheck): Promise<{ passed: boolean; critical: boolean }> {
  info(`Running: ${check.description}`);

  // Check if this check can be skipped via environment variable
  const isOptional = check.envOverride && Bun.env[check.envOverride] === "1";
  const effectivelyRequired = check.required && !isOptional;

  // Check Docker availability if needed
  if (check.requiresDocker && !(await isDockerAvailable())) {
    const message = `${check.name} skipped - Docker not available. Install Docker or set ${check.envOverride}=1`;
    if (effectivelyRequired) {
      error(message);
      return { passed: false, critical: true };
    } else {
      warning(message);
      return { passed: false, critical: false };
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
      return { passed: true, critical: effectivelyRequired };
    } else {
      if (effectivelyRequired) {
        error(`${check.name} failed (exit code ${exitCode})`);
        return { passed: false, critical: true };
      } else {
        warning(`${check.name} failed (exit code ${exitCode}) - non-critical`);
        return { passed: false, critical: false };
      }
    }
  } catch (err) {
    const message = `${check.name} error: ${err instanceof Error ? err.message : String(err)}`;
    if (effectivelyRequired) {
      error(message);
      return { passed: false, critical: true };
    } else {
      warning(`${message} - non-critical`);
      return { passed: false, critical: false };
    }
  }
}

/**
 * Run checks in parallel
 */
async function runChecksParallel(
  checks: ValidationCheck[]
): Promise<{ passed: boolean; critical: boolean }[]> {
  info("Running checks in parallel...");

  const promises = checks.map(async (check) => {
    return await runCheck(check);
  });

  return await Promise.all(promises);
}

/**
 * Run checks sequentially
 */
async function runChecksSequential(
  checks: ValidationCheck[]
): Promise<{ passed: boolean; critical: boolean }[]> {
  const results: { passed: boolean; critical: boolean }[] = [];
  for (const check of checks) {
    const result = await runCheck(check);
    results.push(result);
    console.log(""); // Blank line between checks
  }
  return results;
}

/**
 * Main validation function
 */
async function validate(mode: "fast" | "all", parallel: boolean = false): Promise<void> {
  const startTime = Date.now();

  const modeLabel = mode === "fast" ? "FAST" : "FULL";
  const parallelLabel = parallel ? " (PARALLEL)" : "";
  section(`Validation Mode: ${modeLabel}${parallelLabel}`);

  // Core checks (always run)
  const coreChecks: ValidationCheck[] = [
    {
      name: "Manifest Validation",
      command: ["bun", "scripts/validate-manifest.ts"],
      description: "Extension manifest validation",
      required: true,
    },
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
      name: "Documentation Consistency",
      command: ["bun", "scripts/check-docs-consistency.ts"],
      description: "Documentation consistency check",
      required: true,
    },
    {
      name: "Smoke Tests",
      command: ["bun", "scripts/test-smoke.ts"],
      description: "Quick smoke tests (YAML lint, script refs, generated data)",
      required: false,
    },
    {
      name: "ShellCheck",
      command: Bun.env.CI
        ? [
            "sh",
            "-c",
            'find . -name "*.sh" -not -path "./node_modules/*" -not -path "./.git/*" -not -path "./.archived/*" -print0 | xargs -0 shellcheck --format=json > shellcheck-results.json || true; cat shellcheck-results.json; test ! -s shellcheck-results.json',
          ]
        : [
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
      command: Bun.env.CI
        ? [
            "sh",
            "-c",
            'docker run --rm -i -v "$(pwd):/work:ro" hadolint/hadolint hadolint --format sarif /work/docker/postgres/Dockerfile > hadolint-results.sarif 2>&1 || true; cat hadolint-results.sarif; test -s hadolint-results.sarif && ! grep -q \'"level":"error"\' hadolint-results.sarif',
          ]
        : ["sh", "-c", "docker run --rm -i hadolint/hadolint < docker/postgres/Dockerfile"],
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
    {
      name: "Extension Size Regression",
      command: ["bun", "scripts/check-size-regression.ts"],
      description: "Check for unexpected extension binary size increases (warn-only)",
      required: false,
    },
  ];

  // Determine which checks to run
  const checks = mode === "all" ? [...coreChecks, ...extendedChecks] : coreChecks;

  // Run all checks (parallel or sequential)
  const results = parallel ? await runChecksParallel(checks) : await runChecksSequential(checks);

  // Summary
  const duration = Date.now() - startTime;
  section("Validation Summary");

  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = results.filter((r) => !r.passed).length;
  const criticalFailures = results.filter((r) => !r.passed && r.critical).length;
  const total = results.length;

  console.log(`Total checks: ${total}`);
  console.log(`Passed: ${passedCount}`);
  console.log(`Failed: ${failedCount}`);
  console.log(`Critical failures: ${criticalFailures}`);
  console.log(`Duration: ${(duration / 1000).toFixed(2)}s`);
  console.log("");

  // Determine if we should exit with error
  if (criticalFailures > 0) {
    error(`${criticalFailures} critical check(s) failed`);
    throw new Error("Validation failed");
  } else if (failedCount > 0) {
    warning(`${failedCount} non-critical check(s) failed`);
    success("All critical checks passed");
  } else {
    success("All checks passed!");
  }
}

// Parse command line arguments (Bun.argv includes the script path, so we skip the first 2 elements like Node)
const args = new Set(Bun.argv.slice(2));
const mode = args.has("--all") ? "all" : "fast";
const parallel = args.has("--parallel");

// Run validation
await validate(mode, parallel);
