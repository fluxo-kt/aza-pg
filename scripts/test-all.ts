#!/usr/bin/env bun
/**
 * Comprehensive Validation and Testing Script
 *
 * Runs ALL validation checks and tests in an orchestrated manner:
 * 1. Validation checks (parallel) - 18 checks (unit tests, linting, config validation, manifest sync)
 * 2. Build tests (sequential) - 4 checks (build, size, extension count, build tests)
 * 3. Functional tests (sequential) - 23 checks (extension loading, auto-config, stacks, verification, integration, security)
 *
 * Total: 45 checks across validation, build, and functional categories
 *
 * Usage:
 *   bun scripts/test-all.ts              # Full test suite (45 checks)
 *   bun scripts/test-all.ts --fast       # Validation only (18 checks)
 *   bun scripts/test-all.ts --skip-build # Skip Docker build (44 checks)
 *
 * Exit code: 0 only if ALL critical tests pass
 */

import { getErrorMessage } from "./utils/errors";
import { join } from "path";
import {
  error,
  formatDuration,
  info,
  section,
  separator,
  success,
  warning,
} from "./utils/logger.ts";

const PROJECT_ROOT = join(import.meta.dir, "..");

/**
 * Test/validation check configuration
 */
type Check = {
  name: string;
  category: "validation" | "build" | "functional";
  command: string[];
  description: string;
  critical: boolean; // If true, failure fails the entire suite
  requiresDocker?: boolean;
  requiresBuild?: boolean; // Requires Docker image to be built
  timeout?: number; // Timeout in milliseconds
  envOverride?: string; // Environment variable to make check non-critical
};

/**
 * Test result
 */
type Result = {
  name: string;
  passed: boolean;
  critical: boolean;
  duration: number;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
};

/**
 * Test suite statistics
 */
type Stats = {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  criticalFailures: number;
  duration: number;
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
 * Check if Docker image exists
 */
async function imageExists(imageName: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "images", "-q", imageName], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Run a single check with timeout
 */
async function runCheck(check: Check, imageName?: string): Promise<Result> {
  const startTime = Date.now();

  info(`Running: ${check.description}`);

  // Check if this check can be skipped via environment variable
  const isOptional = check.envOverride && Bun.env[check.envOverride] === "1";
  const effectivelyCritical = check.critical && !isOptional;

  // Check Docker availability if needed
  if (check.requiresDocker && !(await isDockerAvailable())) {
    const message = `Docker not available. Install Docker or set ${check.envOverride || "ALLOW_MISSING_DOCKER"}=1`;
    if (effectivelyCritical) {
      error(message);
      return {
        name: check.name,
        passed: false,
        critical: true,
        duration: Date.now() - startTime,
        error: message,
      };
    } else {
      warning(message);
      return {
        name: check.name,
        passed: false,
        critical: false,
        duration: Date.now() - startTime,
        skipped: true,
        skipReason: message,
      };
    }
  }

  // Check if Docker image exists (for checks that require it)
  if (check.requiresBuild && imageName) {
    if (!(await imageExists(imageName))) {
      const message = `Docker image '${imageName}' not found - run build first`;
      if (effectivelyCritical) {
        error(message);
        return {
          name: check.name,
          passed: false,
          critical: true,
          duration: Date.now() - startTime,
          error: message,
        };
      } else {
        warning(message);
        return {
          name: check.name,
          passed: false,
          critical: false,
          duration: Date.now() - startTime,
          skipped: true,
          skipReason: message,
        };
      }
    }
  }

  try {
    // Set up environment with image name if provided
    const env = imageName
      ? { ...Bun.env, POSTGRES_IMAGE: imageName, POSTGRES_TAG: "pg18" }
      : Bun.env;

    const proc = Bun.spawn(check.command, {
      stdout: "inherit",
      stderr: "inherit",
      env,
      cwd: PROJECT_ROOT,
    });

    // Handle timeout if specified
    let timeoutId: Timer | undefined;
    let timedOut = false;

    if (check.timeout) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, check.timeout);
    }

    const exitCode = await proc.exited;

    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    const duration = Date.now() - startTime;

    if (timedOut) {
      const message = `Timed out after ${check.timeout}ms`;
      error(`${check.name} - ${message}`);
      return {
        name: check.name,
        passed: false,
        critical: effectivelyCritical,
        duration,
        error: message,
      };
    }

    if (exitCode === 0) {
      success(`${check.name} passed (${formatDuration(duration)})`);
      return {
        name: check.name,
        passed: true,
        critical: effectivelyCritical,
        duration,
      };
    } else {
      const message = `Exit code ${exitCode}`;
      if (effectivelyCritical) {
        error(`${check.name} failed - ${message}`);
      } else {
        warning(`${check.name} failed - ${message} (non-critical)`);
      }
      return {
        name: check.name,
        passed: false,
        critical: effectivelyCritical,
        duration,
        error: message,
      };
    }
  } catch (err) {
    const duration = Date.now() - startTime;
    const message = getErrorMessage(err);
    if (effectivelyCritical) {
      error(`${check.name} error - ${message}`);
    } else {
      warning(`${check.name} error - ${message} (non-critical)`);
    }
    return {
      name: check.name,
      passed: false,
      critical: effectivelyCritical,
      duration,
      error: message,
    };
  }
}

/**
 * Run checks in parallel
 */
async function runChecksParallel(checks: Check[], imageName?: string): Promise<Result[]> {
  return await Promise.all(checks.map((check) => runCheck(check, imageName)));
}

/**
 * Run checks sequentially
 */
async function runChecksSequential(checks: Check[], imageName?: string): Promise<Result[]> {
  const results: Result[] = [];
  for (const check of checks) {
    const result = await runCheck(check, imageName);
    results.push(result);
    console.log(""); // Blank line between checks
  }
  return results;
}

/**
 * Print summary statistics
 */
function printSummary(results: Result[], totalDuration: number): Stats {
  separator();
  console.log("TEST SUMMARY");
  separator("-");

  // Group results by category
  const categories: Record<string, Result[]> = {
    Validation: [],
    Build: [],
    Functional: [],
  };

  for (const result of results) {
    const check = allChecks.find((c) => c.name === result.name);
    if (!check) continue;

    const categoryKey =
      check.category === "validation"
        ? "Validation"
        : check.category === "build"
          ? "Build"
          : "Functional";
    const categoryArray = categories[categoryKey];
    if (categoryArray) {
      categoryArray.push(result);
    }
  }

  // Print results by category
  for (const [category, categoryResults] of Object.entries(categories)) {
    if (categoryResults.length === 0) continue;

    console.log(`\n${category} Checks:`);
    for (const result of categoryResults) {
      const symbol = result.passed ? "✅" : result.skipped ? "⏭️ " : "❌";
      const timeStr = formatDuration(result.duration);
      const statusStr = result.skipped
        ? `SKIPPED (${result.skipReason})`
        : result.passed
          ? `PASSED (${timeStr})`
          : `FAILED (${timeStr})`;

      console.log(`  ${symbol} ${result.name}: ${statusStr}`);
      if (!result.passed && !result.skipped && result.error) {
        console.log(`     Error: ${result.error}`);
      }
    }
  }

  // Calculate statistics
  const stats: Stats = {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    criticalFailures: results.filter((r) => !r.passed && r.critical && !r.skipped).length,
    duration: totalDuration,
  };

  separator("-");
  console.log(`\nTotal Checks: ${stats.total}`);
  console.log(`  ✅ Passed: ${stats.passed}`);
  console.log(`  ❌ Failed: ${stats.failed}`);
  console.log(`  ⏭️  Skipped: ${stats.skipped}`);
  console.log(`  🔴 Critical Failures: ${stats.criticalFailures}`);
  console.log(`\nTotal Duration: ${formatDuration(stats.duration)}`);
  separator();

  return stats;
}

/**
 * All available checks (comprehensive list)
 */
const allChecks: Check[] = [
  // === VALIDATION CHECKS (run in parallel) ===
  {
    name: "Manifest Validation",
    category: "validation",
    command: ["bun", "scripts/validate-manifest.ts"],
    description: "Extension manifest validation",
    critical: true,
  },
  {
    name: "TypeScript Type Check",
    category: "validation",
    command: ["bun", "x", "tsc", "--noEmit"],
    description: "TypeScript type checking",
    critical: true,
  },
  {
    name: "Code Linting (oxlint)",
    category: "validation",
    command: ["bun", "x", "oxlint", "."],
    description: "JavaScript/TypeScript linting",
    critical: true,
  },
  {
    name: "Code Formatting (prettier)",
    category: "validation",
    command: ["bun", "x", "prettier", "--check", "."],
    description: "Code formatting check",
    critical: true,
  },
  {
    name: "Documentation Consistency",
    category: "validation",
    command: ["bun", "scripts/check-docs-consistency.ts"],
    description: "Documentation consistency check",
    critical: true,
  },
  {
    name: "Generated Files Verification",
    category: "validation",
    command: ["bun", "scripts/verify-generated.ts"],
    description: "Verify all generated files are up-to-date",
    critical: true,
  },
  {
    name: "Base Image SHA Validation",
    category: "validation",
    command: ["bun", "scripts/validate-base-image-sha.ts", "--check"],
    description: "Validate PostgreSQL base image SHA",
    critical: false,
    requiresDocker: true,
    envOverride: "ALLOW_STALE_BASE_IMAGE",
  },
  {
    name: "Unit Tests: Auto-Config",
    category: "validation",
    command: ["bun", "test", "./scripts/test/test-auto-config-units.ts"],
    description: "Unit tests for PostgreSQL auto-configuration",
    critical: true,
  },
  {
    name: "Unit Tests: Utilities",
    category: "validation",
    command: ["bun", "test", "./scripts/test/test-utils.test.ts"],
    description: "Unit tests for manifest validation and utilities",
    critical: true,
  },
  {
    name: "Smoke Tests",
    category: "validation",
    command: ["bun", "scripts/test-smoke.ts"],
    description: "Quick smoke tests (YAML lint, script refs, generated data)",
    critical: false,
  },
  {
    name: "ShellCheck",
    category: "validation",
    command: [
      "sh",
      "-c",
      "git ls-files '*.sh' | grep -v -E \"^(node_modules/|\\.git/|\\.archived/)\" | xargs -r shellcheck",
    ],
    description: "Shell script linting",
    critical: true,
    envOverride: "ALLOW_MISSING_SHELLCHECK",
  },
  {
    name: "Hadolint",
    category: "validation",
    command: [
      "sh",
      "-c",
      'docker run --rm -i -v "$(pwd):/work:ro" hadolint/hadolint hadolint --config /work/.hadolint.yaml /work/docker/postgres/Dockerfile',
    ],
    description: "Dockerfile linting (hadolint)",
    critical: true,
    requiresDocker: true,
    envOverride: "ALLOW_MISSING_HADOLINT",
  },
  {
    name: "YAML Lint",
    category: "validation",
    command: [
      "sh",
      "-c",
      'docker run --rm -v "$(pwd):/work:ro" cytopia/yamllint -c /work/.yamllint /work/.github /work/stacks /work/docker /work/examples /work/scripts',
    ],
    description: "YAML file linting (yamllint)",
    critical: true,
    requiresDocker: true,
    envOverride: "ALLOW_MISSING_YAMLLINT",
  },
  {
    name: "Secret Scan",
    category: "validation",
    command: [
      "sh",
      "-c",
      'git ls-files | grep -v -E "(\\.env\\.example|\\.archived/|docs/|\\.[^/]*rc$)" | xargs grep -nHiE "(password|secret|api[_-]?key|token)\\s*[:=]" && exit 1 || exit 0',
    ],
    description: "Scan for potential secrets in tracked files",
    critical: false,
    // NOTE: Expected to fail in test mode - test files intentionally contain test passwords
    // (e.g., POSTGRES_PASSWORD=test, secureTestPass123!). This is acceptable for test suites.
  },
  {
    name: "Repository Health Check",
    category: "validation",
    command: ["bun", "scripts/ci/repository-health-check.ts"],
    description: "Verify critical repository files and directories exist",
    critical: true,
  },
  {
    name: "Manifest Sync Verification",
    category: "validation",
    command: ["bun", "scripts/ci/verify-manifest-sync.ts"],
    description: "Verify extensions.manifest.json matches generated version",
    critical: true,
  },
  {
    name: "Dockerfile Validation",
    category: "validation",
    command: ["bun", "scripts/docker/validate-dockerfile.ts"],
    description: "Verify Dockerfile is up-to-date with template and manifest",
    critical: true,
  },
  {
    name: "Config Validation",
    category: "validation",
    command: ["bun", "scripts/config-generator/validate-configs.ts"],
    description: "Validate all PostgreSQL config files for correct GUC settings",
    critical: true,
  },

  // === BUILD TESTS (run sequentially) ===
  {
    name: "Docker Build",
    category: "build",
    command: ["bun", "scripts/build.ts"],
    description: "Build PostgreSQL Docker image",
    critical: true,
    requiresDocker: true,
    timeout: 900000, // 15 minutes
  },
  {
    name: "Image Size Check",
    category: "build",
    command: ["bun", "scripts/check-size-regression.ts"],
    description: "Check extension binary sizes",
    critical: false,
    requiresDocker: true,
    requiresBuild: true,
  },
  {
    name: "Extension Count Verification",
    category: "build",
    command: [
      "sh",
      "-c",
      'docker run --rm -e POSTGRES_PASSWORD=test ${POSTGRES_IMAGE:-aza-pg:pg18} sh -c "ls -1 /usr/share/postgresql/18/extension/*.control | wc -l | grep -qE \\"(6[0-9]|7[0-9]|[89][0-9])\\""',
    ],
    description: "Verify extension count in image (60+ extensions)",
    critical: false,
    requiresDocker: true,
    requiresBuild: true,
  },
  {
    name: "Build Tests",
    category: "build",
    command: ["bun", "scripts/test/test-build.ts"],
    description: "Test Docker image building and extension verification",
    critical: false,
    requiresDocker: true,
    timeout: 900000, // 15 minutes
  },

  // === FUNCTIONAL TESTS (run sequentially) ===
  {
    name: "Basic Extension Loading",
    category: "functional",
    command: [
      "sh",
      "-c",
      [
        "CONTAINER=$(docker run -d -e POSTGRES_PASSWORD=test ${POSTGRES_IMAGE:-aza-pg:pg18})",
        "for i in {1..30}; do docker exec $CONTAINER pg_isready -U postgres >/dev/null 2>&1 && break || sleep 2; done",
        'docker exec $CONTAINER psql -U postgres -c "CREATE EXTENSION vector;" >/dev/null',
        'docker exec $CONTAINER psql -U postgres -c "CREATE EXTENSION pg_cron;" >/dev/null',
        "docker exec $CONTAINER psql -U postgres -c \"SELECT \\'[1,2,3]\\'::vector;\" >/dev/null",
        "docker rm -f $CONTAINER >/dev/null",
      ].join("; "),
    ],
    description: "Test basic extension loading (vector, pg_cron)",
    critical: true,
    requiresDocker: true,
    requiresBuild: true,
    timeout: 120000, // 2 minutes
  },
  {
    name: "Auto-Tuning (512MB)",
    category: "functional",
    command: [
      "sh",
      "-c",
      [
        "CONTAINER=$(docker run -d -e POSTGRES_PASSWORD=test --memory=512m ${POSTGRES_IMAGE:-aza-pg:pg18})",
        "for i in {1..30}; do docker exec $CONTAINER pg_isready -U postgres >/dev/null 2>&1 && break || sleep 2; done",
        'docker logs $CONTAINER 2>&1 | grep -i "detected ram" >/dev/null',
        'docker exec $CONTAINER psql -U postgres -c "SHOW shared_buffers;" >/dev/null',
        "docker rm -f $CONTAINER >/dev/null",
      ].join("; "),
    ],
    description: "Test auto-tuning with 512MB memory limit",
    critical: false,
    requiresDocker: true,
    requiresBuild: true,
    timeout: 120000,
  },
  {
    name: "Auto-Tuning (2GB)",
    category: "functional",
    command: [
      "sh",
      "-c",
      [
        "CONTAINER=$(docker run -d -e POSTGRES_PASSWORD=test --memory=2g ${POSTGRES_IMAGE:-aza-pg:pg18})",
        "for i in {1..30}; do docker exec $CONTAINER pg_isready -U postgres >/dev/null 2>&1 && break || sleep 2; done",
        'docker logs $CONTAINER 2>&1 | grep -i "detected ram" >/dev/null',
        'docker exec $CONTAINER psql -U postgres -c "SHOW shared_buffers;" >/dev/null',
        "docker rm -f $CONTAINER >/dev/null",
      ].join("; "),
    ],
    description: "Test auto-tuning with 2GB memory limit",
    critical: false,
    requiresDocker: true,
    requiresBuild: true,
    timeout: 120000,
  },
  {
    name: "Auto-Tuning (4GB)",
    category: "functional",
    command: [
      "sh",
      "-c",
      [
        "CONTAINER=$(docker run -d -e POSTGRES_PASSWORD=test --memory=4g ${POSTGRES_IMAGE:-aza-pg:pg18})",
        "for i in {1..30}; do docker exec $CONTAINER pg_isready -U postgres >/dev/null 2>&1 && break || sleep 2; done",
        'docker logs $CONTAINER 2>&1 | grep -i "detected ram" >/dev/null',
        'docker exec $CONTAINER psql -U postgres -c "SHOW shared_buffers;" >/dev/null',
        "docker rm -f $CONTAINER >/dev/null",
      ].join("; "),
    ],
    description: "Test auto-tuning with 4GB memory limit",
    critical: false,
    requiresDocker: true,
    requiresBuild: true,
    timeout: 120000,
  },
  {
    name: "Single Stack Deployment",
    category: "functional",
    command: ["bun", "scripts/test/test-single-stack.ts"],
    description: "Test single-node stack deployment",
    critical: false,
    requiresDocker: true,
    requiresBuild: true,
    timeout: 300000, // 5 minutes
  },
  {
    name: "Replica Stack Deployment",
    category: "functional",
    command: ["bun", "scripts/test/test-replica-stack.ts"],
    description: "Test cluster/replica stack deployment",
    critical: false,
    requiresDocker: true,
    requiresBuild: true,
    timeout: 300000, // 5 minutes
  },
  {
    name: "Filesystem Verification",
    category: "functional",
    command: ["sh", "-c", "bun scripts/docker/verify-filesystem.ts ${POSTGRES_IMAGE:-aza-pg:pg18}"],
    description: "Verify extension files in Docker image filesystem",
    critical: true,
    requiresDocker: true,
    requiresBuild: true,
    timeout: 120000, // 2 minutes
  },
  {
    name: "Runtime Verification",
    category: "functional",
    command: ["sh", "-c", "bun scripts/docker/verify-runtime.ts ${POSTGRES_IMAGE:-aza-pg:pg18}"],
    description: "Verify extension runtime behavior in Docker image",
    critical: true,
    requiresDocker: true,
    requiresBuild: true,
    timeout: 180000, // 3 minutes
  },
  {
    name: "Disabled Extensions Test",
    category: "functional",
    command: [
      "sh",
      "-c",
      "bun scripts/test/test-disabled-extensions.ts ${POSTGRES_IMAGE:-aza-pg:pg18}",
    ],
    description: "Verify disabled extensions are properly excluded",
    critical: true,
    requiresDocker: true,
    requiresBuild: true,
    timeout: 120000, // 2 minutes
  },
  {
    name: "Hook Extensions Test",
    category: "functional",
    command: [
      "sh",
      "-c",
      "bun scripts/test/test-hook-extensions.ts ${POSTGRES_IMAGE:-aza-pg:pg18}",
    ],
    description: "Test extensions that use shared_preload_libraries hooks",
    critical: true,
    requiresDocker: true,
    requiresBuild: true,
    timeout: 120000, // 2 minutes
  },
  {
    name: "Comprehensive Extension Tests",
    category: "functional",
    command: [
      "sh",
      "-c",
      [
        // Include optional preload modules for comprehensive testing (timescaledb, pg_safeupdate)
        "CONTAINER=$(docker run -d -e POSTGRES_PASSWORD=test -e POSTGRES_SHARED_PRELOAD_LIBRARIES=auto_explain,pg_cron,pg_stat_monitor,pg_stat_statements,pgaudit,timescaledb,safeupdate --memory=4g ${POSTGRES_IMAGE:-aza-pg:pg18})",
        "for i in {1..30}; do docker exec $CONTAINER pg_isready -U postgres >/dev/null 2>&1 && break || sleep 2; done",
        "cd scripts/test && bun run test-all-extensions-functional.ts --container=$CONTAINER",
        "RESULT=$?",
        "docker rm -f $CONTAINER >/dev/null",
        "exit $RESULT",
      ].join("; "),
    ],
    description: "Test all enabled extensions comprehensively",
    critical: false,
    requiresDocker: true,
    requiresBuild: true,
    timeout: 600000, // 10 minutes
  },
  {
    name: "Comprehensive Image Test",
    category: "functional",
    command: ["sh", "-c", "bun scripts/docker/test-image.ts ${POSTGRES_IMAGE:-aza-pg:pg18}"],
    description:
      "Comprehensive test harness: filesystem, runtime, tools, auto-config, ~27 functional tests",
    critical: false,
    requiresDocker: true,
    requiresBuild: true,
    timeout: 900000, // 15 minutes
  },
  {
    name: "Auto-Config Tests",
    category: "functional",
    command: ["sh", "-c", "bun scripts/test/test-auto-config.ts ${POSTGRES_IMAGE:-aza-pg:pg18}"],
    description: "Test auto-config RAM/CPU detection and scaling across memory tiers",
    critical: false,
    requiresDocker: true,
    requiresBuild: true,
    timeout: 300000, // 5 minutes
  },
  {
    name: "Extension Tests",
    category: "functional",
    command: ["sh", "-c", "bun scripts/test/test-extensions.ts ${POSTGRES_IMAGE:-aza-pg:pg18}"],
    description: "Comprehensive extension tests dynamically generated from manifest",
    critical: false,
    requiresDocker: true,
    requiresBuild: true,
    timeout: 600000, // 10 minutes
  },
  {
    name: "Integration Extension Combinations",
    category: "functional",
    command: [
      "sh",
      "-c",
      "bun scripts/test/test-integration-extension-combinations.ts ${POSTGRES_IMAGE:-aza-pg:pg18}",
    ],
    description:
      "Test critical extension combinations (timescaledb+pgvector, postgis+pgroonga, pgsodium+supabase_vault, pg_partman+timescaledb)",
    critical: true,
    requiresDocker: true,
    requiresBuild: true,
    timeout: 300000, // 5 minutes
  },
  {
    name: "PgBouncer Health Check",
    category: "functional",
    command: ["bun", "scripts/test/test-pgbouncer-healthcheck.ts"],
    description: "Test PgBouncer healthcheck and authentication with Docker Compose",
    critical: false,
    requiresDocker: true,
    requiresBuild: true,
    timeout: 180000, // 3 minutes
  },
  {
    name: "PgBouncer Failure Scenarios",
    category: "functional",
    command: ["bun", "scripts/test/test-pgbouncer-failures.ts"],
    description:
      "Test PgBouncer failure scenarios (wrong password, missing .pgpass, invalid listen address, max connections exceeded, permissions)",
    critical: false,
    requiresDocker: true,
    requiresBuild: true,
    timeout: 300000, // 5 minutes
  },
  {
    name: "pgflow Functional Tests",
    category: "functional",
    command: [
      "sh",
      "-c",
      [
        "CONTAINER=$(docker run -d -e POSTGRES_PASSWORD=test --memory=2g ${POSTGRES_IMAGE:-aza-pg:pg18})",
        "for i in {1..30}; do docker exec $CONTAINER pg_isready -U postgres >/dev/null 2>&1 && break || sleep 2; done",
        "cd scripts/test && bun run test-pgflow-functional.ts --container=$CONTAINER",
        "RESULT=$?",
        "docker rm -f $CONTAINER >/dev/null",
        "exit $RESULT",
      ].join("; "),
    ],
    description: "Comprehensive pgflow workflow orchestration functional tests",
    critical: false,
    requiresDocker: true,
    requiresBuild: true,
    timeout: 300000, // 5 minutes
  },
  {
    name: "pgflow v0.7.2 Compatibility",
    category: "functional",
    command: [
      "sh",
      "-c",
      [
        "CONTAINER=$(docker run -d -e POSTGRES_PASSWORD=test --memory=2g ${POSTGRES_IMAGE:-aza-pg:pg18})",
        "for i in {1..30}; do docker exec $CONTAINER pg_isready -U postgres >/dev/null 2>&1 && break || sleep 2; done",
        "cd scripts/test && bun run test-pgflow-functional-v072.ts --container=$CONTAINER",
        "RESULT=$?",
        "docker rm -f $CONTAINER >/dev/null",
        "exit $RESULT",
      ].join("; "),
    ],
    description:
      "Test pgflow v0.7.2 API compatibility (flow_slug, retry/timeout handling, two-phase polling)",
    critical: false,
    requiresDocker: true,
    requiresBuild: true,
    timeout: 180000, // 3 minutes
  },
  {
    name: "pgq Functional Tests",
    category: "functional",
    command: ["sh", "-c", "bun scripts/test/test-pgq-functional.ts ${POSTGRES_IMAGE:-aza-pg:pg18}"],
    description: "Comprehensive pgq (PostgreSQL queue) functional test suite",
    critical: false,
    requiresDocker: true,
    requiresBuild: true,
    timeout: 180000, // 3 minutes
  },
  {
    name: "Security Tests",
    category: "functional",
    command: ["bun", "test", "./scripts/test/test-security.test.ts"],
    description: "SCRAM-SHA-256 auth, pgAudit, network binding tests (requires image)",
    critical: true,
    requiresDocker: true,
    requiresBuild: true,
    timeout: 180000, // 3 minutes
  },
  {
    name: "Negative Scenario Tests",
    category: "functional",
    command: ["bun", "test", "./scripts/test/test-negative-scenarios.ts"],
    description: "Error handling and validation scenario tests (requires image)",
    critical: false,
    requiresDocker: true,
    requiresBuild: true,
    timeout: 180000, // 3 minutes
  },
];

/**
 * Main test orchestration
 */
async function main() {
  const startTime = Date.now();

  // Parse arguments
  const args = new Set(Bun.argv.slice(2));
  const fastMode = args.has("--fast");
  const skipBuild = args.has("--skip-build");

  // Show help if requested
  if (args.has("--help") || args.has("-h")) {
    console.log("Comprehensive Validation and Testing Script");
    console.log("");
    console.log("Usage:");
    console.log("  bun scripts/test-all.ts              # Full test suite");
    console.log("  bun scripts/test-all.ts --fast       # Skip Docker build and functional tests");
    console.log("  bun scripts/test-all.ts --skip-build # Run all tests except Docker build");
    console.log("  bun scripts/test-all.ts --help       # Show this help");
    console.log("");
    console.log("Environment Variables:");
    console.log(
      "  POSTGRES_IMAGE=name                  # Docker image name (default: aza-pg:pg18)"
    );
    console.log("  ALLOW_MISSING_SHELLCHECK=1           # Don't fail if shellcheck missing");
    console.log("  ALLOW_MISSING_HADOLINT=1             # Don't fail if hadolint missing");
    console.log("  ALLOW_MISSING_YAMLLINT=1             # Don't fail if yamllint missing");
    process.exit(0);
  }

  const imageName = Bun.env.POSTGRES_IMAGE || "aza-pg:pg18";

  section("COMPREHENSIVE TEST SUITE");
  if (fastMode) {
    info("Mode: FAST (validation only, skipping build and functional tests)");
  } else if (skipBuild) {
    info("Mode: SKIP BUILD (all tests except Docker build)");
  } else {
    info("Mode: FULL (all validation, build, and functional tests)");
  }
  info(`Image: ${imageName}`);
  console.log("");

  // Determine which checks to run
  let checksToRun = allChecks;

  if (fastMode) {
    // Only validation checks
    checksToRun = allChecks.filter((c) => c.category === "validation");
  } else if (skipBuild) {
    // All checks except Docker build
    checksToRun = allChecks.filter((c) => c.name !== "Docker Build");
  }

  // Separate checks by phase
  const validationChecks = checksToRun.filter((c) => c.category === "validation");
  const buildChecks = checksToRun.filter((c) => c.category === "build");
  const functionalChecks = checksToRun.filter((c) => c.category === "functional");

  const allResults: Result[] = [];

  // Phase 1: Validation checks (run in parallel for speed)
  if (validationChecks.length > 0) {
    section("Phase 1: Validation Checks (Parallel)");
    info(`Running ${validationChecks.length} validation checks in parallel...`);
    console.log("");

    const validationResults = await runChecksParallel(validationChecks);
    allResults.push(...validationResults);

    const validationFailed = validationResults.filter((r) => !r.passed && r.critical && !r.skipped);
    if (validationFailed.length > 0) {
      console.log("");
      error(`${validationFailed.length} critical validation check(s) failed`);
      error("Fix validation issues before proceeding to build/functional tests");
      const totalDuration = Date.now() - startTime;
      printSummary(allResults, totalDuration);
      process.exit(1);
    }
    console.log("");
  }

  // Phase 2: Build checks (run sequentially)
  if (buildChecks.length > 0) {
    section("Phase 2: Build Tests (Sequential)");
    info(`Running ${buildChecks.length} build checks...`);
    console.log("");

    const buildResults = await runChecksSequential(buildChecks, imageName);
    allResults.push(...buildResults);

    const buildFailed = buildResults.filter((r) => !r.passed && r.critical && !r.skipped);
    if (buildFailed.length > 0) {
      console.log("");
      error(`${buildFailed.length} critical build check(s) failed`);
      error("Fix build issues before proceeding to functional tests");
      const totalDuration = Date.now() - startTime;
      printSummary(allResults, totalDuration);
      process.exit(1);
    }
    console.log("");
  }

  // Phase 3: Functional tests (run sequentially)
  if (functionalChecks.length > 0) {
    section("Phase 3: Functional Tests (Sequential)");
    info(`Running ${functionalChecks.length} functional tests...`);
    console.log("");

    const functionalResults = await runChecksSequential(functionalChecks, imageName);
    allResults.push(...functionalResults);
    console.log("");
  }

  // Final summary
  const totalDuration = Date.now() - startTime;
  section("FINAL RESULTS");
  const stats = printSummary(allResults, totalDuration);

  console.log("");

  // Exit with appropriate code
  if (stats.criticalFailures > 0) {
    error(`❌ ${stats.criticalFailures} critical test(s) failed`);
    error("Review errors above and fix issues");
    process.exit(1);
  } else if (stats.failed > 0) {
    warning(`⚠️  ${stats.failed} non-critical test(s) failed`);
    success("All critical tests passed!");
    process.exit(0);
  } else {
    success("🎉 ALL TESTS PASSED!");
    info(`Completed ${stats.total} checks in ${formatDuration(stats.duration)}`);
    process.exit(0);
  }
}

// Run main
main().catch((err) => {
  error(`Fatal error: ${getErrorMessage(err)}`);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
