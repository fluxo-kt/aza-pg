#!/usr/bin/env bun
/**
 * Fetch PostgreSQL official regression tests from postgres/postgres repository.
 *
 * Downloads a curated subset (~25-30) of core PostgreSQL regression tests
 * from the REL_18_STABLE branch to verify that our custom build doesn't break
 * base PostgreSQL functionality.
 *
 * Usage:
 *   bun scripts/ci/fetch-pg-regression-tests.ts [options]
 *
 * Options:
 *   --force              Re-download even if cached
 *   --tests=test1,test2  Comma-separated list of specific tests to fetch
 *   --help               Show this help message
 *
 * Caches tests locally at: tests/regression/core/pg-official/
 */

import { $ } from "bun";
import { join } from "node:path";

// PostgreSQL repository configuration
const PG_REPO_OWNER = "postgres";
const PG_REPO_NAME = "postgres";
const PG_BRANCH = "REL_18_STABLE";
const BASE_URL = `https://raw.githubusercontent.com/${PG_REPO_OWNER}/${PG_REPO_NAME}/${PG_BRANCH}/src/test/regress`;

// Local cache directory
const CACHE_DIR = join(import.meta.dir, "../../tests/regression/core/pg-official");
const SQL_DIR = join(CACHE_DIR, "sql");
const EXPECTED_DIR = join(CACHE_DIR, "expected");

/**
 * Curated list of ~30 critical PostgreSQL regression tests
 * covering core data types, operations, and features.
 */
const CORE_TESTS = [
  // Basic data types (9 tests)
  "boolean",
  "int2",
  "int4",
  "int8",
  "float4",
  "float8",
  "numeric",
  "text",
  "varchar",

  // Core operations (7 tests)
  "select",
  "insert",
  "update",
  "delete",
  "join",
  "union",
  "subselect",

  // Essential features (8 tests)
  "constraints",
  "triggers",
  "create_index",
  "create_table",
  "transactions",
  "aggregates",
  "copy",
  "prepare",

  // Advanced features (6 tests)
  "json",
  "jsonb",
  "arrays",
  "strings",
  "numerology",
  "btree_index",
] as const;

interface FetchOptions {
  force: boolean;
  tests: string[];
}

/**
 * Parse CLI arguments
 */
function parseArgs(): FetchOptions | null {
  const args = Bun.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return null;
  }

  const force = args.includes("--force");
  let tests: string[] = [...CORE_TESTS];

  const testsArg = args.find((arg) => arg.startsWith("--tests="));
  if (testsArg) {
    const testList = testsArg.split("=")[1];
    if (testList) {
      tests = testList.split(",").map((t) => t.trim());
    }
  }

  return { force, tests };
}

/**
 * Print help message
 */
function printHelp(): void {
  console.log(
    `
Fetch PostgreSQL Official Regression Tests

Usage:
  bun scripts/ci/fetch-pg-regression-tests.ts [options]

Options:
  --force              Re-download even if cached
  --tests=test1,test2  Comma-separated list of specific tests to fetch
  --help               Show this help message

Default tests (${CORE_TESTS.length} total):
  ${CORE_TESTS.join(", ")}

Cache directory: ${CACHE_DIR}
Source: ${BASE_URL}
  `.trim()
  );
}

/**
 * Ensure cache directory structure exists
 */
async function ensureCacheDir(): Promise<void> {
  await $`mkdir -p ${SQL_DIR}`.quiet();
  await $`mkdir -p ${EXPECTED_DIR}`.quiet();
}

/**
 * Check if test files are already cached
 */
async function isTestCached(testName: string): Promise<boolean> {
  const sqlPath = join(SQL_DIR, `${testName}.sql`);
  const expectedPath = join(EXPECTED_DIR, `${testName}.out`);

  const sqlFile = Bun.file(sqlPath);
  const expectedFile = Bun.file(expectedPath);

  return (await sqlFile.exists()) && (await expectedFile.exists());
}

/**
 * Fetch a single test file (SQL or expected output)
 */
async function fetchFile(url: string, destPath: string, retries = 3): Promise<boolean> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url);

      if (!response.ok) {
        if (response.status === 404) {
          console.error(`  ✗ File not found (404): ${url}`);
          return false;
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const content = await response.text();
      await Bun.write(destPath, content);
      return true;
    } catch (error) {
      if (attempt === retries) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`  ✗ Failed after ${retries} attempts: ${errorMsg}`);
        return false;
      }
      // Exponential backoff: 1s, 2s, 4s
      await Bun.sleep(Math.pow(2, attempt - 1) * 1000);
    }
  }
  return false;
}

/**
 * Fetch both SQL and expected output for a test
 */
async function fetchTest(testName: string, force: boolean): Promise<boolean> {
  // Check cache unless --force
  if (!force && (await isTestCached(testName))) {
    console.log(`  ↻ ${testName} (cached)`);
    return true;
  }

  const sqlUrl = `${BASE_URL}/sql/${testName}.sql`;
  const expectedUrl = `${BASE_URL}/expected/${testName}.out`;

  const sqlPath = join(SQL_DIR, `${testName}.sql`);
  const expectedPath = join(EXPECTED_DIR, `${testName}.out`);

  console.log(`  ↓ ${testName}`);

  const sqlSuccess = await fetchFile(sqlUrl, sqlPath);
  if (!sqlSuccess) {
    return false;
  }

  const expectedSuccess = await fetchFile(expectedUrl, expectedPath);
  if (!expectedSuccess) {
    return false;
  }

  console.log(`  ✓ ${testName}`);
  return true;
}

/**
 * Main execution
 */
async function main(): Promise<number> {
  const options = parseArgs();
  if (!options) {
    return 0; // Help was shown
  }

  console.log("Fetching PostgreSQL regression tests...\n");
  console.log(`Source: ${BASE_URL}`);
  console.log(`Cache:  ${CACHE_DIR}`);
  console.log(`Tests:  ${options.tests.length}\n`);

  await ensureCacheDir();

  let successCount = 0;
  let failedTests: string[] = [];

  for (const testName of options.tests) {
    const success = await fetchTest(testName, options.force);
    if (success) {
      successCount++;
    } else {
      failedTests.push(testName);
    }
  }

  console.log(`\nSummary:`);
  console.log(`  Fetched: ${successCount}/${options.tests.length}`);

  if (failedTests.length > 0) {
    console.log(`  Failed:  ${failedTests.join(", ")}`);
    return 1;
  }

  console.log(`\n✓ All tests fetched successfully`);
  return 0;
}

// Execute if run directly
if (import.meta.main) {
  const exitCode = await main();
  process.exit(exitCode);
}

export { fetchTest, isTestCached, CORE_TESTS, CACHE_DIR, SQL_DIR, EXPECTED_DIR };
