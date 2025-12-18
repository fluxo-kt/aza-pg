#!/usr/bin/env bun
/**
 * Test: pg_cron and pgflow POSTGRES_DB Integration
 *
 * Verifies that pg_cron and pgflow respect POSTGRES_DB environment variable:
 * - pg_cron extension is created in POSTGRES_DB (not hardcoded to 'postgres')
 * - cron.database_name configuration matches POSTGRES_DB
 * - pgflow schema is installed in POSTGRES_DB
 * - Both default (postgres) and custom database names work correctly
 *
 * Background:
 * pg_cron has a strict requirement: it can ONLY be created in the database
 * specified by the cron.database_name configuration parameter. This test
 * ensures our architecture properly handles this constraint by:
 * 1. Setting cron.database_name=${POSTGRES_DB:-postgres} in entrypoint
 * 2. Creating pg_cron in POSTGRES_DB via 01b-pg_cron.sh init script
 * 3. Installing pgflow in POSTGRES_DB via 05-pgflow-init.sh
 *
 * Usage:
 *   # Test with built image
 *   bun scripts/test/test-pg-cron-postgres-db.ts
 *
 *   # Test with specific image
 *   bun scripts/test/test-pg-cron-postgres-db.ts --image=aza-pg:latest
 */

import { $ } from "bun";
import { resolveImageTag } from "./image-resolver";
import { dockerCleanup } from "../utils/docker";
import { error, info, section, success } from "../utils/logger";

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    const duration = Date.now() - start;
    results.push({ name, passed: true, duration });
    success(`✅ ${name} (${duration}ms)`);
  } catch (err) {
    const duration = Date.now() - start;
    const errorMsg = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, duration, error: errorMsg });
    error(`❌ ${name} (${duration}ms)`);
    error(`   ${errorMsg}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runSQL(
  container: string,
  database: string,
  query: string
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const result =
    await $`docker exec ${container} psql -U postgres -d ${database} -tAc ${query}`.nothrow();
  return {
    success: result.exitCode === 0,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

async function waitForPostgres(container: string, timeout: number): Promise<boolean> {
  const start = Date.now();
  const timeoutMs = timeout * 1000;

  while (Date.now() - start < timeoutMs) {
    const result = await $`docker exec ${container} pg_isready -U postgres`.nothrow();
    if (result.exitCode === 0) {
      // PostgreSQL is ready, but init scripts might still be running or PG might restart
      // Wait additional time to ensure initdb scripts (pgflow, pg_cron) have completed
      await Bun.sleep(5000);
      return true;
    }
    await Bun.sleep(2000);
  }

  return false;
}

async function testDefaultPostgresDB(): Promise<void> {
  const container = `test-pgcron-default-${Date.now()}`;

  try {
    section("Test 1: Default POSTGRES_DB (postgres)");
    info("Starting container with default POSTGRES_DB...");

    // Start container without explicit POSTGRES_DB (defaults to 'postgres')
    await $`docker run -d --name ${container} \
      -e POSTGRES_PASSWORD=test \
      -e POSTGRES_MEMORY=2048 \
      ${imageTag}`.quiet();

    // Wait for PostgreSQL
    info("Waiting for PostgreSQL to be ready...");
    const ready = await waitForPostgres(container, 60);
    assert(ready, "PostgreSQL failed to start within timeout");
    success("PostgreSQL is ready");

    // Test 1.1: Verify pg_cron exists in 'postgres' database
    await test("pg_cron exists in postgres database", async () => {
      const result = await runSQL(
        container,
        "postgres",
        "SELECT extname FROM pg_extension WHERE extname = 'pg_cron'"
      );
      assert(result.success, `Query failed: ${result.stderr}`);
      assert(result.stdout.trim() === "pg_cron", `Expected pg_cron, got: ${result.stdout.trim()}`);
    });

    // Test 1.2: Verify cron.database_name is 'postgres'
    await test("cron.database_name is 'postgres'", async () => {
      const result = await runSQL(
        container,
        "postgres",
        "SELECT current_setting('cron.database_name')"
      );
      assert(result.success, `Query failed: ${result.stderr}`);
      assert(
        result.stdout.trim() === "postgres",
        `Expected 'postgres', got: ${result.stdout.trim()}`
      );
    });

    // Test 1.3: Verify pg_cron does NOT exist in template1 (shouldn't be created there)
    await test("pg_cron does NOT exist in template1", async () => {
      const result = await runSQL(
        container,
        "template1",
        "SELECT count(*) FROM pg_extension WHERE extname = 'pg_cron'"
      );
      assert(result.success, `Query failed: ${result.stderr}`);
      assert(result.stdout.trim() === "0", "pg_cron should not exist in template1");
    });
  } finally {
    await dockerCleanup(container);
    // Brief delay to ensure Docker daemon fully releases resources before next test
    await Bun.sleep(1000);
  }
}

async function testCustomPostgresDB(): Promise<void> {
  const container = `test-pgcron-custom-${Date.now()}`;
  const customDB = "my_custom_db";

  try {
    section(`Test 2: Custom POSTGRES_DB (${customDB})`);
    info(`Starting container with POSTGRES_DB=${customDB}...`);

    // Start container with custom POSTGRES_DB
    await $`docker run -d --name ${container} \
      -e POSTGRES_PASSWORD=test \
      -e POSTGRES_DB=${customDB} \
      -e POSTGRES_MEMORY=2048 \
      ${imageTag}`.quiet();

    // Wait for PostgreSQL
    info("Waiting for PostgreSQL to be ready...");
    const ready = await waitForPostgres(container, 60);
    assert(ready, "PostgreSQL failed to start within timeout");
    success("PostgreSQL is ready");

    // Test 2.1: Verify pg_cron exists in custom database
    await test(`pg_cron exists in ${customDB} database`, async () => {
      const result = await runSQL(
        container,
        customDB,
        "SELECT extname FROM pg_extension WHERE extname = 'pg_cron'"
      );
      assert(result.success, `Query failed: ${result.stderr}`);
      assert(
        result.stdout.trim() === "pg_cron",
        `Expected pg_cron in ${customDB}, got: ${result.stdout.trim()}`
      );
    });

    // Test 2.2: Verify cron.database_name matches custom DB
    await test(`cron.database_name is '${customDB}'`, async () => {
      const result = await runSQL(
        container,
        customDB,
        "SELECT current_setting('cron.database_name')"
      );
      assert(result.success, `Query failed: ${result.stderr}`);
      assert(
        result.stdout.trim() === customDB,
        `Expected '${customDB}', got: ${result.stdout.trim()}`
      );
    });

    // Test 2.3: Verify pg_cron does NOT exist in postgres database
    await test("pg_cron does NOT exist in postgres database", async () => {
      const result = await runSQL(
        container,
        "postgres",
        "SELECT count(*) FROM pg_extension WHERE extname = 'pg_cron'"
      );
      assert(result.success, `Query failed: ${result.stderr}`);
      assert(result.stdout.trim() === "0", "pg_cron should not exist in postgres database");
    });
  } finally {
    await dockerCleanup(container);
    // Brief delay to ensure Docker daemon fully releases resources before next test
    await Bun.sleep(1000);
  }
}

async function testPgflowDefaultDB(): Promise<void> {
  const container = `test-pgflow-default-${Date.now()}`;

  try {
    section("Test 3: pgflow with default POSTGRES_DB");
    info("Starting container with default POSTGRES_DB for pgflow testing...");

    // Start container (pgflow init script runs automatically if prerequisites are met)
    await $`docker run -d --name ${container} \
      -e POSTGRES_PASSWORD=test \
      -e POSTGRES_MEMORY=2048 \
      ${imageTag}`.quiet();

    // Wait for PostgreSQL
    info("Waiting for PostgreSQL to be ready...");
    const ready = await waitForPostgres(container, 60);
    assert(ready, "PostgreSQL failed to start within timeout");
    success("PostgreSQL is ready");

    // Test 3.1: Verify pgflow schema exists in postgres database
    await test("pgflow schema exists in postgres database", async () => {
      const result = await runSQL(
        container,
        "postgres",
        "SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'pgflow'"
      );
      assert(result.success, `Query failed: ${result.stderr}`);
      assert(result.stdout.trim() === "1", "pgflow schema should exist in postgres database");
    });

    // Test 3.2: Verify pgflow schema has expected table count
    await test("pgflow schema has 7 tables", async () => {
      const result = await runSQL(
        container,
        "postgres",
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'pgflow'"
      );
      assert(result.success, `Query failed: ${result.stderr}`);
      assert(result.stdout.trim() === "7", `Expected 7 tables, got: ${result.stdout.trim()}`);
    });

    // Test 3.3: Verify pg_cron and pgflow are in same database
    await test("pg_cron and pgflow are both in postgres database", async () => {
      const cronResult = await runSQL(
        container,
        "postgres",
        "SELECT extname FROM pg_extension WHERE extname = 'pg_cron'"
      );
      const pgflowResult = await runSQL(
        container,
        "postgres",
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'pgflow'"
      );

      assert(cronResult.success && pgflowResult.success, "Queries failed");
      assert(
        cronResult.stdout.trim() === "pg_cron" && pgflowResult.stdout.trim() === "pgflow",
        "pg_cron extension and pgflow schema should both be in postgres database"
      );
    });
  } finally {
    await dockerCleanup(container);
    // Brief delay to ensure Docker daemon fully releases resources before next test
    await Bun.sleep(1000);
  }
}

async function testPgflowCustomDB(): Promise<void> {
  const container = `test-pgflow-custom-${Date.now()}`;
  const customDB = "pgflow_test_db";

  try {
    section(`Test 4: pgflow with custom POSTGRES_DB (${customDB})`);
    info(`Starting container with POSTGRES_DB=${customDB} for pgflow testing...`);

    // Start container with custom POSTGRES_DB
    await $`docker run -d --name ${container} \
      -e POSTGRES_PASSWORD=test \
      -e POSTGRES_DB=${customDB} \
      -e POSTGRES_MEMORY=2048 \
      ${imageTag}`.quiet();

    // Wait for PostgreSQL
    info("Waiting for PostgreSQL to be ready...");
    const ready = await waitForPostgres(container, 60);
    assert(ready, "PostgreSQL failed to start within timeout");
    success("PostgreSQL is ready");

    // Test 4.1: Verify pgflow schema exists in custom database
    await test(`pgflow schema exists in ${customDB} database`, async () => {
      const result = await runSQL(
        container,
        customDB,
        "SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'pgflow'"
      );
      assert(result.success, `Query failed: ${result.stderr}`);
      assert(result.stdout.trim() === "1", `pgflow schema should exist in ${customDB} database`);
    });

    // Test 4.2: Verify pgflow schema has expected table count
    await test(`pgflow schema has 7 tables in ${customDB}`, async () => {
      const result = await runSQL(
        container,
        customDB,
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'pgflow'"
      );
      assert(result.success, `Query failed: ${result.stderr}`);
      assert(result.stdout.trim() === "7", `Expected 7 tables, got: ${result.stdout.trim()}`);
    });

    // Test 4.3: Verify pg_cron and pgflow are in same custom database
    await test(`pg_cron and pgflow are both in ${customDB} database`, async () => {
      const cronResult = await runSQL(
        container,
        customDB,
        "SELECT extname FROM pg_extension WHERE extname = 'pg_cron'"
      );
      const pgflowResult = await runSQL(
        container,
        customDB,
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'pgflow'"
      );

      assert(cronResult.success && pgflowResult.success, "Queries failed");
      assert(
        cronResult.stdout.trim() === "pg_cron" && pgflowResult.stdout.trim() === "pgflow",
        `pg_cron extension and pgflow schema should both be in ${customDB} database`
      );
    });

    // Test 4.4: Verify pgflow does NOT exist in postgres database
    await test("pgflow schema does NOT exist in postgres database", async () => {
      const result = await runSQL(
        container,
        "postgres",
        "SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'pgflow'"
      );
      assert(result.success, `Query failed: ${result.stderr}`);
      assert(result.stdout.trim() === "0", "pgflow schema should not exist in postgres database");
    });
  } finally {
    await dockerCleanup(container);
    // Brief delay to ensure Docker daemon fully releases resources before next test
    await Bun.sleep(1000);
  }
}

// Main execution
let imageTag: string;

async function main(): Promise<void> {
  section("pg_cron and pgflow POSTGRES_DB Integration Tests");
  info("Verifying pg_cron and pgflow respect POSTGRES_DB environment variable");
  console.log();

  // Resolve image tag
  imageTag = resolveImageTag();
  info(`Using image: ${imageTag}`);
  console.log();

  // Run all tests
  await testDefaultPostgresDB();
  console.log();

  await testCustomPostgresDB();
  console.log();

  await testPgflowDefaultDB();
  console.log();

  await testPgflowCustomDB();
  console.log();

  // Print summary
  section("Test Summary");
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  info(`Total: ${results.length} tests`);
  if (passed > 0) success(`Passed: ${passed}`);
  if (failed > 0) error(`Failed: ${failed}`);
  info(`Duration: ${totalDuration}ms`);

  if (failed > 0) {
    console.log();
    error("Failed tests:");
    for (const r of results.filter((r) => !r.passed)) {
      error(`  - ${r.name}: ${r.error}`);
    }
    process.exitCode = 1;
  } else {
    console.log();
    success("✅ All pg_cron and pgflow POSTGRES_DB integration tests passed!");
  }
}

main().catch((err) => {
  error(`Test execution failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
