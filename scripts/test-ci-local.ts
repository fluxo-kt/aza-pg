#!/usr/bin/env bun
/**
 * Comprehensive Local CI Test Script
 *
 * Mirrors all CI checks from .github/workflows/ci.yml for local validation.
 * Run this script before pushing to ensure all CI checks will pass.
 *
 * Usage:
 *   bun scripts/test-ci-local.ts
 *   bun run test:ci
 *
 * This script runs:
 * 1. Fast validation (lint, format, type-check, manifest)
 * 2. Unit tests
 * 3. Generated files verification
 * 4. Repository health checks
 *
 * Exit codes:
 *   0 - All checks passed
 *   1 - At least one check failed
 */

import { $ } from "bun";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const RESET = "\x1b[0m";

let failedChecks = 0;
const startTime = Date.now();

function log(message: string): void {
  console.log(message);
}

function success(message: string): void {
  console.log(`${GREEN}✅ ${message}${RESET}`);
}

function error(message: string): void {
  console.log(`${RED}❌ ${message}${RESET}`);
  failedChecks++;
}

function section(message: string): void {
  console.log(`\n${BLUE}═══════════════════════════════════════════════════════${RESET}`);
  console.log(`${BLUE}  ${message}${RESET}`);
  console.log(`${BLUE}═══════════════════════════════════════════════════════${RESET}\n`);
}

async function runCheck(name: string, command: () => Promise<void>): Promise<void> {
  log(`${YELLOW}▶${RESET} ${name}...`);
  try {
    await command();
    success(name);
  } catch (e) {
    error(`${name} - ${e}`);
  }
}

// ============================================================
// MAIN EXECUTION
// ============================================================

section("Local CI Test Suite");
log(`Mirroring .github/workflows/ci.yml checks\n`);

// STEP 1: Run fast validation (with CI=true environment)
await runCheck("Fast validation (lint, format, type-check)", async () => {
  const result = await $`CI=true bun run validate`.nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`Validation failed (exit code ${result.exitCode})`);
  }
});

// STEP 2: Run unit tests
await runCheck("Unit test: test-auto-config-units.ts", async () => {
  const result = await $`bun test ./scripts/test/test-auto-config-units.ts`.nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`Test failed (exit code ${result.exitCode})`);
  }
});

await runCheck("Unit test: test-utils.test.ts", async () => {
  const result = await $`bun test ./scripts/test/test-utils.test.ts`.nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`Test failed (exit code ${result.exitCode})`);
  }
});

// STEP 3: Verify generated files are up to date
await runCheck("Verify generated files are up-to-date", async () => {
  const result = await $`bun run verify:generated`.nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`Generated files check failed (exit code ${result.exitCode})`);
  }
});

// STEP 4: Repository health check
await runCheck("Repository health check", async () => {
  // Check files
  const files = [
    { path: "docker/postgres/Dockerfile", name: "Dockerfile" },
    {
      path: "docker/postgres/extensions.manifest.json",
      name: "extensions.manifest.json",
    },
    { path: "package.json", name: "package.json" },
  ];

  for (const check of files) {
    const exists = await Bun.file(check.path).exists();
    if (!exists) {
      throw new Error(`Missing ${check.name}`);
    }
  }

  // Check directories using shell test
  const dirs = [
    { path: "stacks/primary", name: "stacks/primary directory" },
    { path: "stacks/replica", name: "stacks/replica directory" },
    { path: "stacks/single", name: "stacks/single directory" },
  ];

  for (const check of dirs) {
    const result = await $`test -d ${check.path}`.nothrow();
    if (result.exitCode !== 0) {
      throw new Error(`Missing ${check.name}`);
    }
  }
});

// ============================================================
// SUMMARY
// ============================================================

const duration = ((Date.now() - startTime) / 1000).toFixed(2);

section("Test Summary");
console.log(
  `Total checks: ${failedChecks === 0 ? GREEN : RED}${5 - failedChecks}${RESET} passed, ${failedChecks > 0 ? RED : GREEN}${failedChecks}${RESET} failed`
);
console.log(`Duration: ${duration}s\n`);

if (failedChecks > 0) {
  error(`${failedChecks} check(s) failed`);
  error("Fix issues above before pushing to CI");
  process.exit(1);
}

success("All CI checks passed! ✨");
success("Safe to push to CI");
