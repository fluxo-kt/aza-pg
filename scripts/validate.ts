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
 *   bun scripts/validate.ts --parallel            # Run checks concurrently, output buffered per check (default except --fix)
 *   bun scripts/validate.ts --sequential          # Run checks one by one with live output (default with --fix)
 *
 * Environment variables:
 *   ALLOW_MISSING_SHELLCHECK=1           # Don't fail if shellcheck not installed
 *   ALLOW_MISSING_HADOLINT=1             # Don't fail if Docker/hadolint unavailable
 *   ALLOW_MISSING_YAMLLINT=1             # Don't fail if Docker/yamllint unavailable
 */

import { getErrorMessage, isExecutableNotFoundError } from "./utils/errors";
import { error, info, section, success, warning } from "./utils/logger";
import { isDockerDaemonRunning } from "./utils/docker";
import { summarizeResults } from "./validate-summary";

// GHCR serves the same digest as Docker Hub without Hub's anonymous pull limit, which otherwise stops this gate from
// running at all on a busy machine. Before bumping, run the new version on the Dockerfile: releases add rules and
// false positives (2.15.1 forgot a stage's SHELL after ENV, hence ENV-before-SHELL in the template).
export const HADOLINT_IMAGE =
  "ghcr.io/hadolint/hadolint:v2.15.1@sha256:32dac94127fd60b7b7e3fbfc65e1383b9b5e25c9bfd7b8536de7a539fe68a12d";

/**
 * Validation check configuration
 */
export type ValidationCheck = {
  name: string;
  command: string[];
  description: string;
  required: boolean; // If false, failure only warns but doesn't fail the whole validation
  requiresDocker?: boolean; // If true, check if Docker is available
  envOverride?: string; // Environment variable to make check non-critical
  // Extended check cheap + safety-critical enough to ALSO run in default (fast) mode. Such a check
  // costs milliseconds and needs no Docker, so gating it behind --all/CI would let its defect land via
  // `bun run validate` (the documented pre-commit gate) and only fail later.
  fast?: boolean;
};

/**
 * Validation result with optional output capture
 */
type ValidationResult = {
  passed: boolean;
  // Sanctioned skip (requiresDocker + daemon absent + envOverride set) — counted separately from
  // failures so the summary count stays trustworthy. See summarizeResults in validate-summary.ts.
  skipped?: boolean;
  critical: boolean;
  name: string;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
};

/**
 * Run a validation check
 * @param check - The validation check to run
 * @param bufferOutput - If true, capture stdout/stderr for later printing (parallel mode)
 * @returns object with passed status, critical flag, and optional captured output
 */
export async function runCheck(
  check: ValidationCheck,
  bufferOutput: boolean = false
): Promise<ValidationResult> {
  const started = performance.now();
  const result = await runCheckUntimed(check, bufferOutput);
  return { ...result, durationMs: performance.now() - started };
}

async function runCheckUntimed(
  check: ValidationCheck,
  bufferOutput: boolean
): Promise<ValidationResult> {
  if (!bufferOutput) {
    info(`Running: ${check.description}`);
  }

  // Check if this check can be skipped via environment variable
  const isOptional = check.envOverride && Bun.env[check.envOverride] === "1";
  const effectivelyRequired = check.required && !isOptional;

  // Check Docker availability if needed
  if (check.requiresDocker && !(await isDockerDaemonRunning())) {
    const message = `${check.name} skipped - Docker not available. Install Docker or set ${check.envOverride}=1`;
    if (effectivelyRequired) {
      if (!bufferOutput) error(message);
      return { passed: false, critical: true, name: check.name };
    } else {
      if (!bufferOutput) warning(message);
      // Sanctioned skip, not a failure: the check is optional (envOverride set) and Docker is absent.
      return { passed: false, skipped: true, critical: false, name: check.name };
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
    // A missing executable (ENOENT) means the check could not run at all — the same situation as the
    // Docker pre-check above, so it is classified the same way: a sanctioned absence (optional) is a
    // skip, a required tool is a hard failure. Any OTHER error is a genuine failure, never a skip.
    const unavailable = isExecutableNotFoundError(err);
    if (effectivelyRequired) {
      if (!bufferOutput) error(`${check.name} error: ${getErrorMessage(err)}`);
      return { passed: false, critical: true, name: check.name };
    } else if (unavailable) {
      if (!bufferOutput) warning(`${check.name} skipped - not installed (${getErrorMessage(err)})`);
      return { passed: false, skipped: true, critical: false, name: check.name };
    } else {
      if (!bufferOutput) warning(`${check.name} error: ${getErrorMessage(err)} - non-critical`);
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

    // Print result status (skip is distinct from failure — see summarizeResults)
    if (result.passed) {
      success(`${result.name} passed`);
    } else if (result.skipped) {
      warning(`${result.name} skipped`);
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
  parallel?: boolean,
  stagedOnly: boolean = false,
  fixMode: boolean = false
): Promise<void> {
  const startTime = Date.now();

  const modeLabel = fixMode ? "FIX" : mode === "fast" ? "FAST" : "FULL";
  const concurrent = parallel ?? !fixMode;
  const parallelLabel = concurrent ? " (PARALLEL)" : "";
  const stagedLabel = stagedOnly ? " (STAGED FILES)" : "";
  section(`Validation Mode: ${modeLabel}${parallelLabel}${stagedLabel}`);

  // Core checks (always run)
  const coreChecks: ValidationCheck[] = [
    {
      name: "Environment File Check",
      command: [
        "sh",
        "-c",
        "! git ls-files | grep -E '(^|/)\\.env(\\.[^/]*)?$' | grep -v '\\.env\\.example$'",
      ],
      description: "Verify no .env files are tracked (only .env.example allowed)",
      required: true,
    },
    {
      name: "Manifest Validation",
      command: ["bun", "scripts/extensions/validate-manifest.ts"],
      description: "Extension manifest validation",
      required: true,
    },
    {
      name: "PGDG Version Validation",
      // Fast mode reuses a passing result while the PGDG pins are unchanged (sha256 cache under
      // node_modules/.cache/aza-pg); --all always asks PGDG, so upstream revision drift still fails CI.
      command:
        mode === "all"
          ? ["bun", "scripts/validate/pgdg-versions-cached.ts", "--no-cache"]
          : ["bun", "scripts/validate/pgdg-versions-cached.ts"],
      // Scoped to PGDG: it is preinstalled in the base image, so madison is cheap, and the
      // exact-match-latest rule uniquely catches pgdg packaging-revision drift that git-tag
      // check-updates misses. Percona/Timescale versions are exact-pinned in the Dockerfile and
      // enforced by the build's `apt-get install =version` (fails loud on removal) — see the
      // header note in validate-pgdg-versions.ts for why no pre-build apt check is added here.
      description: "PGDG apt-version availability (Percona/Timescale enforced by the build)",
      required: true,
      requiresDocker: true,
      envOverride: "ALLOW_MISSING_DOCKER",
    },
    {
      name: "Generated Files Verification",
      command: ["bun", "scripts/verify-generated.ts"],
      description: "Fail when `bun run generate` would change any generated file",
      required: true,
    },
    {
      name: "PostgreSQL Config Validation",
      command: ["bun", "scripts/config-generator/validate-configs.ts"],
      description:
        "Shipped postgresql.conf files: valid GUC names, no setting the entrypoint auto-tunes",
      required: true,
    },
    {
      name: "Local Action Metadata",
      command: ["bun", "scripts/ci/validate-local-actions.ts"],
      description: "Validate local GitHub Action metadata and local action references",
      required: true,
    },
    {
      name: "Script References",
      command: ["bun", "scripts/ci/check-script-references.ts"],
      description: "package.json script targets and documented `bun run <script>` names exist",
      required: true,
    },
    {
      name: "Companion Image Pins",
      command: ["bun", "scripts/validate/companion-image-pins.ts"],
      description: "Every mention of a stack's pgbouncer/exporter image carries the compose pin",
      required: true,
    },
    {
      name: "Image Runtime Contract",
      command: ["bun", "scripts/validate/image-runtime-contract.ts"],
      description:
        "Compose files and documented commands match the PG18 image: data volume, bind IP, integer memory, no pre-18 data path",
      required: true,
    },
    {
      name: "Suite Registry",
      command: ["bun", "scripts/validate/check-suite-registry.ts"],
      description:
        "Every Docker suite is in scripts/test-all.ts SUITES; workflows run suites only by group",
      required: true,
    },
    {
      name: "Subprocess Calls",
      command: ["bun", "scripts/validate/subprocess-calls.ts"],
      description:
        "Container removal passes -v; subprocess env objects spread Bun.env; stdin-fed docker exec passes -i",
      required: true,
    },
    {
      name: "Release Process Contracts",
      command: ["bun", "scripts/ci/validate-release-process.ts"],
      description: "Validate release command, publish workflow, and release harness contracts",
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
    // Unit tests: no Docker, catch logic bugs before CI.
    // Test files are auto-discovered via glob — no manual registration needed.
    // Docker-dependent integration tests are excluded explicitly below.
    // Skipped in fix mode since fix mode is for auto-formatting, not running tests.
    ...(fixMode
      ? []
      : [
          (() => {
            // All *.test.ts files are safe to run without Docker — Docker-dependent
            // tests use test-*.ts naming (not *.test.ts) and are NOT auto-discovered.
            const testFiles = Array.from(new Bun.Glob("scripts/**/*.test.ts").scanSync("."))
              .map((f) => `./${f}`)
              .sort();
            return {
              name: "Unit Tests",
              command: ["bun", "test", ...testFiles],
              description: `Unit tests (${testFiles.length} files, auto-discovered via glob)`,
              required: true,
            };
          })(),
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
      // Static and ~0.1 s: a heading removed from a doc breaks its table of contents, caught before CI
      fast: true,
    },
    {
      name: "Base Image SHA",
      command: ["bun", "scripts/validate-base-image-sha.ts", "--check", "--require-latest-minor"],
      // Blocking: an unresolvable digest or a PostgreSQL minor behind the floating major tag fails (a stale same-tag
      // digest only warns, --check). CI's validate job runs it here, once.
      description: "Base image digest resolvable and on the latest PostgreSQL minor",
      required: true,
      requiresDocker: true,
      envOverride: "ALLOW_MISSING_DOCKER",
    },
    {
      name: "ShellCheck",
      // One command in CI and locally: no workflow uploads a shellcheck result file, and plain findings read better in a CI log.
      command: [
        "sh",
        "-c",
        'git ls-files \'*.sh\' | grep -v -E "^(node_modules/|\\.git/|\\.archived/)" | while IFS= read -r file; do [ -f "$file" ] && printf "%s\\n" "$file"; done | xargs -r shellcheck',
      ],
      description: "Shell script linting",
      required: true,
      envOverride: "ALLOW_MISSING_SHELLCHECK",
    },
    {
      name: "Hadolint",
      // One command in CI and locally (CI once failed only on error-level findings, so it passed what the local gate rejects).
      command: [
        "sh",
        "-c",
        `docker run --rm -i -v "$(pwd):/work:ro" ${HADOLINT_IMAGE} hadolint --config /work/.hadolint.yaml /work/docker/postgres/Dockerfile`,
      ],
      description: "Dockerfile linting",
      required: true,
      requiresDocker: true,
      envOverride: "ALLOW_MISSING_HADOLINT",
    },
    {
      name: "YAML Lint",
      command: ["bun", "scripts/ci/lint-yaml-tracked.ts"],
      description: "YAML file linting for all tracked YAML files",
      required: true,
      requiresDocker: true,
      envOverride: "ALLOW_MISSING_YAMLLINT",
    },
    {
      name: "Workflow Expressions",
      // One definition (pinned image, shellcheck on) shared with the CI lint-workflows job.
      command: ["bun", "scripts/ci/lint-workflows.ts"],
      description:
        "GitHub Actions workflow syntax, expressions and run: shell (actionlint + shellcheck)",
      required: true,
      requiresDocker: true,
      envOverride: "ALLOW_MISSING_ACTIONLINT",
    },
    {
      name: "Secret Scan",
      command: ["bun", "scripts/security/secret-scan.ts"],
      description: "No hard-coded credential in tracked files",
      required: true,
    },
    {
      name: "Bun OSV Ignore Audit",
      command: ["bun", "scripts/security/validate-bun-osv.ts"],
      // Static guard over the install-time CVE gate: enforces canonical/justified/expiring ignores,
      // pins the scanner, requires SHOW_IGNORED wiring at every bun install site, and forbids env-based
      // ignore bypasses. fast: true so it runs in `bun run validate`, not only --all/CI.
      description: "Audit bun OSV install gate (ignore schema, scanner pin, wiring, env bypass)",
      required: true,
      fast: true,
    },
    {
      name: "Extension Size Regression",
      command: ["bun", "scripts/check-size-regression.ts"],
      description: "Check for unexpected extension binary size increases (warn-only)",
      required: false,
    },
  ];

  // Determine which checks to run
  const checks =
    mode === "all"
      ? [...coreChecks, ...extendedChecks]
      : // Default (fast) mode still runs the cheap extended checks (fast: true) so the defects
        // they catch are blocked at the pre-commit gate, not just in --all/CI.
        [...coreChecks, ...extendedChecks.filter((c) => c.fast)];

  // Checks run concurrently by default: they are independent, and one by one they sum to more than the time
  // budget (--all is dominated by two network lookups that overlap everything else). No check writes the tree
  // (verify-generated regenerates in a temporary copy), so none races Prettier reading it. --fix stays sequential
  // because every fixer writes. A new check that writes into the tree must go after Prettier or outside the tree.
  const results = concurrent ? await runChecksParallel(checks) : await runChecksSequential(checks);

  // Summary
  const duration = Date.now() - startTime;
  section("Validation Summary");

  const {
    total,
    passed: passedCount,
    skipped: skippedCount,
    failed: failedCount,
    critical: criticalFailures,
  } = summarizeResults(results);

  console.log(`Total checks: ${total}`);
  console.log(`Passed: ${passedCount}`);
  console.log(`Skipped: ${skippedCount}`);
  console.log(`Failed: ${failedCount}`);
  console.log(`Critical failures: ${criticalFailures}`);
  console.log(`Duration: ${(duration / 1000).toFixed(2)}s`);
  // Per-check wall time, slowest first: the fast lane has a time budget, and the total alone does
  // not say which check broke it.
  for (const result of [...results].sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))) {
    console.log(`  ${((result.durationMs ?? 0) / 1000).toFixed(2).padStart(6)}s  ${result.name}`);
  }
  console.log("");

  // Determine if we should exit with error
  if (criticalFailures > 0) {
    error(`${criticalFailures} critical check(s) failed`);
    throw new Error("Validation failed");
  } else if (failedCount > 0) {
    warning(`${failedCount} non-critical check(s) failed`);
    success(
      skippedCount > 0
        ? `All critical checks passed (${skippedCount} skipped)`
        : "All critical checks passed"
    );
  } else if (skippedCount > 0) {
    success(`All checks passed (${skippedCount} skipped)`);
  } else {
    success("All checks passed!");
  }
}

// Only parse argv and run when invoked directly — not when imported (e.g. by runCheck unit tests).
if (import.meta.main) {
  // Bun.argv includes the script path, so we skip the first 2 elements like Node.
  const args = Bun.argv.slice(2);
  const argsSet = new Set(args);
  const mode = argsSet.has("--all") ? "all" : "fast";
  const parallel = argsSet.has("--parallel")
    ? true
    : argsSet.has("--sequential")
      ? false
      : undefined;
  const stagedOnly = argsSet.has("--staged");
  const fixMode = argsSet.has("--fix");

  await validate(mode, parallel, stagedOnly, fixMode);
}
