#!/usr/bin/env bun
/**
 * Unified validation script for aza-pg
 * Runs all linting, formatting, and type checking in one command
 *
 * Usage:
 *   bun scripts/validate.ts                       # Fast validation (oxlint, prettier, tsc, unit tests)
 *   bun scripts/validate.ts --fast                # Same as above (explicit)
 *   bun scripts/validate.ts --all                 # Full validation (includes shellcheck, hadolint, yaml, secret scan)
 *   bun scripts/validate.ts --fix                 # Auto-fix: prettier --write, oxlint --fix, SQL formatting
 *   bun scripts/validate.ts --staged              # Run only on staged files (for pre-commit hooks)
 *   bun scripts/validate.ts --parallel            # Run checks in parallel (faster but less readable errors)
 *   bun scripts/validate.ts --runtime             # Include runtime verification (requires --image=<tag>)
 *   bun scripts/validate.ts --filesystem          # Include filesystem verification (requires --image=<tag>)
 *   bun scripts/validate.ts --image=<tag>         # Docker image tag for runtime/filesystem verification
 *
 * Environment variables:
 *   ALLOW_MISSING_SHELLCHECK=1           # Don't fail if shellcheck not installed
 *   ALLOW_MISSING_HADOLINT=1             # Don't fail if Docker/hadolint unavailable
 *   ALLOW_MISSING_YAMLLINT=1             # Don't fail if Docker/yamllint unavailable
 */

import { getErrorMessage } from "./utils/errors";
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
 * Validation result with optional output capture
 */
type ValidationResult = {
  passed: boolean;
  critical: boolean;
  name: string;
  stdout?: string;
  stderr?: string;
};

/**
 * Run a validation check
 * @param check - The validation check to run
 * @param bufferOutput - If true, capture stdout/stderr for later printing (parallel mode)
 * @returns object with passed status, critical flag, and optional captured output
 */
async function runCheck(
  check: ValidationCheck,
  bufferOutput: boolean = false
): Promise<ValidationResult> {
  if (!bufferOutput) {
    info(`Running: ${check.description}`);
  }

  // Check if this check can be skipped via environment variable
  const isOptional = check.envOverride && Bun.env[check.envOverride] === "1";
  const effectivelyRequired = check.required && !isOptional;

  // Check Docker availability if needed
  if (check.requiresDocker && !(await isDockerAvailable())) {
    const message = `${check.name} skipped - Docker not available. Install Docker or set ${check.envOverride}=1`;
    if (effectivelyRequired) {
      if (!bufferOutput) error(message);
      return { passed: false, critical: true, name: check.name };
    } else {
      if (!bufferOutput) warning(message);
      return { passed: false, critical: false, name: check.name };
    }
  }

  try {
    const proc = Bun.spawn(check.command, {
      stdout: bufferOutput ? "pipe" : "inherit",
      stderr: bufferOutput ? "pipe" : "inherit",
    });

    // Collect output if buffering
    let stdout: string | undefined;
    let stderr: string | undefined;
    if (bufferOutput) {
      [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
    }

    const exitCode = await proc.exited;

    if (exitCode === 0) {
      if (!bufferOutput) success(`${check.name} passed`);
      return { passed: true, critical: effectivelyRequired, name: check.name, stdout, stderr };
    } else {
      if (effectivelyRequired) {
        if (!bufferOutput) error(`${check.name} failed (exit code ${exitCode})`);
        return { passed: false, critical: true, name: check.name, stdout, stderr };
      } else {
        if (!bufferOutput) warning(`${check.name} failed (exit code ${exitCode}) - non-critical`);
        return { passed: false, critical: false, name: check.name, stdout, stderr };
      }
    }
  } catch (err) {
    const message = `${check.name} error: ${getErrorMessage(err)}`;
    if (effectivelyRequired) {
      if (!bufferOutput) error(message);
      return { passed: false, critical: true, name: check.name };
    } else {
      if (!bufferOutput) warning(`${message} - non-critical`);
      return { passed: false, critical: false, name: check.name };
    }
  }
}

/**
 * Run checks in parallel with buffered output to prevent mixing
 */
async function runChecksParallel(checks: ValidationCheck[]): Promise<ValidationResult[]> {
  info("Running checks in parallel...\n");

  // Run all checks in parallel, buffering their output
  const results = await Promise.all(checks.map((check) => runCheck(check, true)));

  // Print results sequentially to avoid mixed output
  for (const result of results) {
    info(`Check: ${result.name}`);

    // Print buffered stdout
    if (result.stdout?.trim()) {
      process.stdout.write(result.stdout);
      if (!result.stdout.endsWith("\n")) console.log("");
    }

    // Print buffered stderr
    if (result.stderr?.trim()) {
      process.stderr.write(result.stderr);
      if (!result.stderr.endsWith("\n")) console.log("");
    }

    // Print result status
    if (result.passed) {
      success(`${result.name} passed`);
    } else if (result.critical) {
      error(`${result.name} failed`);
    } else {
      warning(`${result.name} failed (non-critical)`);
    }
    console.log("");
  }

  return results;
}

/**
 * Run checks sequentially (real-time output, no buffering needed)
 */
async function runChecksSequential(checks: ValidationCheck[]): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  for (const check of checks) {
    const result = await runCheck(check, false);
    results.push(result);
    console.log(""); // Blank line between checks
  }
  return results;
}

/**
 * Main validation function
 */
async function validate(
  mode: "fast" | "all",
  parallel: boolean = false,
  stagedOnly: boolean = false,
  includeRuntime: boolean = false,
  includeFilesystem: boolean = false,
  imageTag?: string,
  fixMode: boolean = false
): Promise<void> {
  const startTime = Date.now();

  const modeLabel = fixMode ? "FIX" : mode === "fast" ? "FAST" : "FULL";
  const parallelLabel = parallel ? " (PARALLEL)" : "";
  const stagedLabel = stagedOnly ? " (STAGED FILES)" : "";
  const runtimeLabel = includeRuntime ? " + RUNTIME" : "";
  const filesystemLabel = includeFilesystem ? " + FILESYSTEM" : "";
  section(
    `Validation Mode: ${modeLabel}${parallelLabel}${stagedLabel}${runtimeLabel}${filesystemLabel}`
  );

  // Core checks (always run)
  const coreChecks: ValidationCheck[] = [
    {
      name: "Environment File Check",
      command: ["sh", "-c", "! git ls-files | grep -E '/\\.env$' | grep -v '\\.env\\.example'"],
      description: "Verify no .env files are tracked (only .env.example allowed)",
      required: true,
    },
    {
      name: "Manifest Validation",
      command: ["bun", "scripts/validate-manifest.ts"],
      description: "Extension manifest validation",
      required: true,
    },
    {
      name: "Vendor Version Validation",
      command: ["bun", "scripts/extensions/validate-pgdg-versions.ts"],
      description:
        "Vendor version consistency (PGDG, Percona, Timescale versions match source.tag)",
      required: true,
    },
    {
      name: "Manifest Integrity",
      command: ["bun", "scripts/ci/validate-manifest-integrity.ts"],
      description: "NAME_TO_KEY and PGDG_MAPPINGS completeness",
      required: true,
    },
    {
      name: "Dockerfile Validation",
      command: ["bun", "scripts/docker/validate-dockerfile.ts"],
      description: "Verify Dockerfile is up-to-date with template and manifest",
      required: true,
    },
    {
      name: "Local Action Metadata",
      command: ["bun", "scripts/ci/validate-local-actions.ts"],
      description: "Validate local GitHub Action metadata and local action references",
      required: true,
    },
    {
      name: "Oxlint",
      command: fixMode
        ? stagedOnly
          ? [
              "sh",
              "-c",
              "git diff --cached --name-only -z --diff-filter=d | grep -z '\\.tsx\\?$' | xargs -0 -r bun run oxlint --fix",
            ]
          : ["bun", "run", "oxlint:fix", "."]
        : stagedOnly
          ? [
              "sh",
              "-c",
              "git diff --cached --name-only -z --diff-filter=d | grep -z '\\.tsx\\?$' | xargs -0 -r bun run oxlint",
            ]
          : ["bun", "run", "oxlint", "."],
      description: fixMode
        ? stagedOnly
          ? "Auto-fixing linting issues (staged files)"
          : "Auto-fixing linting issues"
        : stagedOnly
          ? "JavaScript/TypeScript linting (staged files only)"
          : "JavaScript/TypeScript linting",
      required: true,
    },
    {
      name: "Prettier",
      command: fixMode
        ? stagedOnly
          ? [
              "sh",
              "-c",
              "git diff --cached --name-only -z --diff-filter=d | xargs -0 -r bun run prettier:write --ignore-unknown",
            ]
          : ["bun", "run", "prettier:write", "."]
        : stagedOnly
          ? [
              "sh",
              "-c",
              "git diff --cached --name-only -z --diff-filter=d | xargs -0 -r bun run prettier:check --ignore-unknown",
            ]
          : ["bun", "run", "prettier:check", "."],
      description: fixMode
        ? stagedOnly
          ? "Auto-formatting code (staged files)"
          : "Auto-formatting code"
        : stagedOnly
          ? "Code formatting check (staged files only)"
          : "Code formatting check",
      required: true,
    },
    {
      name: "TypeScript",
      command: ["bun", "run", "tsc", "--noEmit"],
      description: "Type checking (requires full project context)",
      required: true,
    },
    {
      name: "SQL Validation",
      command: fixMode
        ? ["bun", "scripts/format-sql.ts", "--write"]
        : ["bun", "scripts/check-sql.ts"],
      description: fixMode ? "Auto-formatting SQL files" : "SQL formatting and syntax validation",
      required: true,
    },
    // Unit tests: fast (~50ms), no Docker, catches logic bugs before CI
    // Skipped in fix mode since fix mode is for auto-formatting, not running tests
    ...(fixMode
      ? []
      : [
          {
            name: "Unit Tests",
            command: [
              "bun",
              "test",
              "./scripts/config-generator/manifest-generator.test.ts",
              "./scripts/test/test-auto-config-units.ts",
              "./scripts/test/test-utils.test.ts",
              "./scripts/docker/test-image-lib.test.ts",
            ],
            description: "Unit tests (auto-config, manifest validation, utilities, tool paths)",
            required: true,
          },
        ]),
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
      name: "Documentation Links",
      command: ["bun", "scripts/ci/validate-doc-links.ts"],
      description: "Documentation internal link validation",
      required: true,
    },
    {
      name: "Base Image SHA",
      command: ["bun", "scripts/validate-base-image-sha.ts", "--check"],
      description: "Base image SHA validation (warn if stale)",
      required: false,
      requiresDocker: true,
      envOverride: "ALLOW_MISSING_DOCKER",
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
            // CI mode: JSON output for SARIF upload. Use jq to check for empty array ([] = no errors)
            // because shellcheck outputs [] even with no errors, which is 2 bytes, not 0
            "git ls-files '*.sh' | grep -v -E \"^(node_modules/|\\.git/|\\.archived/)\" | xargs -r shellcheck --format=json > shellcheck-results.json || true; cat shellcheck-results.json; jq -e 'length == 0' shellcheck-results.json > /dev/null",
          ]
        : [
            "sh",
            "-c",
            "git ls-files '*.sh' | grep -v -E \"^(node_modules/|\\.git/|\\.archived/)\" | xargs -r shellcheck",
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
            'docker run --rm -i -v "$(pwd):/work:ro" hadolint/hadolint hadolint --config /work/.hadolint.yaml --format sarif /work/docker/postgres/Dockerfile > hadolint-results.sarif 2>&1 || true; cat hadolint-results.sarif; test -s hadolint-results.sarif && ! grep -q \'"level":"error"\' hadolint-results.sarif',
          ]
        : [
            "sh",
            "-c",
            'docker run --rm -i -v "$(pwd):/work:ro" hadolint/hadolint hadolint --config /work/.hadolint.yaml /work/docker/postgres/Dockerfile',
          ],
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
        'docker run --rm -v "$(pwd):/work:ro" cytopia/yamllint -c /work/.yamllint /work/.github /work/stacks /work/docker /work/examples /work/scripts',
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
        'git ls-files | grep -v -E "(\\.env\\.example|\\.archived/|\\.github/|docs/|deployments/|\\.[^/]*rc$|test.*\\.ts$)" | xargs grep -nHiE "(password|secret|api[_-]?key|token)\\s*[:=]" | grep -v -E "(\\$\\{\\{|id-token:|password.*test|PASSWORD.*test)" || true',
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

  // Docker verification checks (optional, require image tag)
  const dockerVerificationChecks: ValidationCheck[] = [];

  if (includeRuntime && imageTag) {
    dockerVerificationChecks.push({
      name: "Runtime Verification",
      command: ["bun", "scripts/docker/verify-runtime.ts", imageTag],
      description: `Docker image runtime verification (${imageTag})`,
      required: true,
      requiresDocker: true,
    });
  }

  if (includeFilesystem && imageTag) {
    dockerVerificationChecks.push({
      name: "Filesystem Verification",
      command: ["bun", "scripts/docker/verify-filesystem.ts", imageTag],
      description: `Docker image filesystem verification (${imageTag})`,
      required: true,
      requiresDocker: true,
    });
    dockerVerificationChecks.push({
      name: "Image Artifacts Validation",
      command: ["bun", "scripts/docker/validate-published-image-artifacts.ts", imageTag],
      description: `Docker image artifacts validation (${imageTag})`,
      required: true,
      requiresDocker: true,
    });
  }

  // Validate image tag requirement
  if ((includeRuntime || includeFilesystem) && !imageTag) {
    error("Runtime and filesystem verification require --image=<tag> parameter");
    throw new Error("Missing required --image parameter");
  }

  // Determine which checks to run
  const checks =
    mode === "all"
      ? [...coreChecks, ...extendedChecks, ...dockerVerificationChecks]
      : [...coreChecks, ...dockerVerificationChecks];

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
const args = Bun.argv.slice(2);
const argsSet = new Set(args);
const mode = argsSet.has("--all") ? "all" : "fast";
const parallel = argsSet.has("--parallel");
const stagedOnly = argsSet.has("--staged");
const includeRuntime = argsSet.has("--runtime");
const includeFilesystem = argsSet.has("--filesystem");
const fixMode = argsSet.has("--fix");
const imageArg = args.find((arg) => arg.startsWith("--image="));
const imageTag = imageArg ? imageArg.split("=")[1] : undefined;

// Run validation
await validate(mode, parallel, stagedOnly, includeRuntime, includeFilesystem, imageTag, fixMode);
