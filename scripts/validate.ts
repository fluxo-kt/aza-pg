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

import { getErrorMessage, isExecutableNotFoundError } from "./utils/errors";
import { error, info, section, success, warning } from "./utils/logger";
import { isDockerDaemonRunning } from "./utils/docker";
import { summarizeResults } from "./validate-summary";

const HADOLINT_IMAGE =
  "hadolint/hadolint@sha256:27086352fd5e1907ea2b934eb1023f217c5ae087992eb59fde121dce9c9ff21e";
const ACTIONLINT_IMAGE =
  "rhysd/actionlint:1.7.10@sha256:ef8299f97635c4c30e2298f48f30763ab782a4ad2c95b744649439a039421e36";

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
  // Extended check cheap + safety-critical enough to ALSO run in default (fast) mode — e.g. the
  // static grep guards. They cost milliseconds and need no Docker, so gating them behind --all/CI
  // would let a leak land via `bun run validate` (the documented pre-commit gate) and only fail later.
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
      name: "PGDG Version Validation",
      command: ["bun", "scripts/extensions/validate-pgdg-versions.ts"],
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
    // Unit tests: fast (~50ms), no Docker, catches logic bugs before CI.
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
    },
    {
      name: "Base Image SHA",
      command: ["bun", "scripts/validate-base-image-sha.ts", "--check", "--require-latest-minor"],
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
            'git ls-files \'*.sh\' | grep -v -E "^(node_modules/|\\.git/|\\.archived/)" | while IFS= read -r file; do [ -f "$file" ] && printf "%s\\n" "$file"; done | xargs -r shellcheck --format=json > shellcheck-results.json || true; cat shellcheck-results.json; jq -e \'length == 0\' shellcheck-results.json > /dev/null',
          ]
        : [
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
      command: Bun.env.CI
        ? [
            "sh",
            "-c",
            `docker run --rm -i -v "$(pwd):/work:ro" ${HADOLINT_IMAGE} hadolint --config /work/.hadolint.yaml --format sarif /work/docker/postgres/Dockerfile > hadolint-results.sarif 2>&1 || true; cat hadolint-results.sarif; test -s hadolint-results.sarif && ! grep -q '"level":"error"' hadolint-results.sarif`,
          ]
        : [
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
      command: [
        "sh",
        "-c",
        `docker run --rm -v "$(pwd):/work" -w /work ${ACTIONLINT_IMAGE} -shellcheck= -pyflakes= .github/workflows/*.yml`,
      ],
      description: "GitHub Actions workflow syntax and expression validation",
      required: true,
      requiresDocker: true,
      envOverride: "ALLOW_MISSING_ACTIONLINT",
    },
    {
      name: "Secret Scan",
      command: ["bun", "scripts/security/secret-scan.ts", "--warn-only", "--profile", "validate"],
      description: "Scan for potential secrets in tracked files (warn-only)",
      required: false,
    },
    {
      name: "Bun OSV Ignore Audit",
      command: ["bun", "scripts/security/validate-bun-osv.ts"],
      // Static guard over the install-time CVE gate: enforces canonical/justified/expiring ignores,
      // pins the scanner, and (once checks 3-4 land) requires SHOW_IGNORED wiring + forbids env-based
      // ignore bypasses. fast: true so it runs in `bun run validate`, not only --all/CI.
      description: "Audit .bun-osv.json ignore schema + scanner pin (bun OSV install gate)",
      required: true,
      fast: true,
    },
    {
      name: "Subprocess Env Safety",
      command: [
        "sh",
        "-c",
        // $.env({ KEY: val }) replaces the ENTIRE subprocess env, stripping PATH/HOME/DOCKER_CONFIG
        // and breaking docker-credential helpers and build tools (cargo, etc.). All .env() calls
        // must spread Bun.env: .env({ ...Bun.env, KEY: val }). Covers scripts/ AND docker/postgres/
        // (build-extensions.ts uses cargo subprocess that also needs HOME/CARGO_HOME/RUSTUP_HOME).
        // Uses -F (fixed string) for the spread filters — avoids BSD/GNU grep regex-escaping differences.
        // validate.ts excluded — its description string contains ".env({" as a literal example.
        // Comment lines excluded — grep output format is "file:line:content"; pattern ":[0-9]+:[[:space:]]*//'"
        // catches lines whose content starts with // (allowing leading whitespace), preventing false-positives
        // on comments that explain the anti-pattern (e.g. "// bare .env({ PATH }) would strip…").
        'result=$(git ls-files scripts/ docker/postgres/ | grep -E "\\.ts$" | grep -v "^scripts/validate.ts$" | xargs grep -nE "\\.env\\(\\{" 2>/dev/null | grep -Fv "...Bun.env" | grep -Fv "...process.env" | grep -Ev ":[0-9]+:[[:space:]]*//" || true); if [ -n "$result" ]; then printf "Bare .env({}) strips PATH — use .env({ ...Bun.env, KEY: val }):\\n%s\\n" "$result" >&2; exit 1; fi',
      ],
      description:
        "Detect bare subprocess .env() calls in scripts/ and docker/postgres/ that strip PATH (must spread Bun.env)",
      required: true,
      fast: true,
    },
    {
      name: "Docker Volume Leak Guard",
      command: [
        "sh",
        "-c",
        // A container `docker rm` MUST pass `-v` so the container's anonymous PGDATA volume is
        // dropped with it. Without `-v`, PG18's anonymous /var/lib/postgresql volume is orphaned on
        // every test teardown — this silently accumulated hundreds of dangling volumes (tens of GB).
        // `-v` never removes NAMED volumes, so it is always safe (persistence/replica stacks keep
        // their data). Covers scripts/*.ts AND .github/workflows/*.yml (CI also runs containers).
        // Matching notes: the pattern covers BOTH "docker rm " and its alias "docker container rm "
        // (a clueless future edit could reach for either). The trailing space excludes "docker rmi";
        // the substring does not occur in "docker volume rm". The exclusion requires the canonical
        // separate " -v" form (not the combined "-fv") — intentional, to keep one obvious idiom.
        // Scope is `docker rm` ONLY — deliberately NOT `docker compose down/rm`. For a raw container
        // `rm`, `-v` is always safe: it drops the anonymous volume but never a NAMED one. For compose,
        // `-v` ALSO destroys NAMED volumes declared in the stack, so there it encodes intent, not
        // correctness (e.g. test-persistence.ts runs a bare `compose down` on purpose to prove data
        // survives teardown). A blanket -v rule on compose would mandate data loss — do NOT add it.
        // Comment lines (TS // and YAML #) are excluded (grep output is file:line:content), as in the
        // Subprocess Env Safety check above.
        'result=$(git ls-files scripts/ .github/workflows/ | grep -E "\\.(ts|ya?ml)$" | xargs grep -nE "docker( container)? rm " 2>/dev/null | grep -v " -v" | grep -Ev ":[0-9]+:[[:space:]]*(//|#)" || true); if [ -n "$result" ]; then printf "Container docker rm without -v leaks anonymous PGDATA volumes (use docker rm -f -v):\\n%s\\n" "$result" >&2; exit 1; fi',
      ],
      description:
        "Ensure container `docker rm` always passes -v (prevents anonymous PGDATA volume leaks)",
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
      : // Default (fast) mode still runs the cheap static safety guards (fast: true) so the leak
        // classes they catch are blocked at the pre-commit gate, not just in --all/CI.
        [...coreChecks, ...extendedChecks.filter((c) => c.fast), ...dockerVerificationChecks];

  // Run all checks (parallel or sequential)
  const results = parallel ? await runChecksParallel(checks) : await runChecksSequential(checks);

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
  const parallel = argsSet.has("--parallel");
  const stagedOnly = argsSet.has("--staged");
  const includeRuntime = argsSet.has("--runtime");
  const includeFilesystem = argsSet.has("--filesystem");
  const fixMode = argsSet.has("--fix");
  const imageArg = args.find((arg) => arg.startsWith("--image="));
  const imageTag = imageArg ? imageArg.split("=")[1] : undefined;

  await validate(mode, parallel, stagedOnly, includeRuntime, includeFilesystem, imageTag, fixMode);
}
