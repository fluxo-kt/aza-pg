#!/usr/bin/env bun
/**
 * Test pgflow functionality in newly created databases
 *
 * Verifies:
 * 1. realtime.send() stub exists in initial database (postgres)
 * 2. New databases inherit realtime.send() from template1 (proves template1 has it)
 * 3. realtime.send() functionality works in new databases
 * 4. pgflow prerequisites can be installed in new databases
 * 5. pgflow schema can be installed and works correctly in new databases
 *
 * Note: template1 has datallowconn=false after initialization, so we cannot check it directly.
 * Instead, we verify it has realtime.send() by creating a database from it and checking inheritance.
 *
 * This ensures full functionality across ALL databases, not just the default one.
 */

import { $ } from "bun";
import { TestHarness } from "./harness.ts";

// Support CLI image override for consistency with other tests
const IMAGE_TAG = Bun.argv[2] ?? Bun.env.POSTGRES_IMAGE ?? "ghcr.io/fluxo-kt/aza-pg:pg18";
Bun.env.POSTGRES_IMAGE = IMAGE_TAG;

const TEST_PASSWORD = "test_password_12345";
const harness = new TestHarness();

async function runTest() {
  console.log("=".repeat(70));
  console.log("PGFLOW NEW DATABASE FUNCTIONALITY TEST");
  console.log("=".repeat(70));

  let containerName = "";

  try {
    // Start container
    console.log("\n[1/8] Starting container...");
    containerName = await harness.startContainer("pgflow-newdb", {
      POSTGRES_PASSWORD: TEST_PASSWORD,
    });

    // Wait for PostgreSQL to be ready (with retry loop)
    console.log("[2/8] Waiting for PostgreSQL...");
    await harness.waitForReady(containerName);
    console.log("✅ PostgreSQL ready");

    // Test 1: Verify realtime.send() exists in initial database
    console.log("\n[3/8] Checking realtime.send() in postgres database...");
    const postgresCheck = await $`docker exec ${containerName} psql -U postgres -d postgres -t -c "
      SELECT COUNT(*) FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'realtime' AND p.proname = 'send'
    "`.text();

    if (postgresCheck.trim() !== "1") {
      throw new Error("❌ realtime.send() NOT found in postgres database");
    }
    console.log("✅ realtime.send() exists in postgres database");

    // Test 2: Create new database from template1 and verify inheritance
    // Note: We cannot check template1 directly because datallowconn=false (prevents accidental connections)
    // Instead, we verify template1 has realtime.send() by creating a database from it
    console.log("\n[4/8] Creating new database 'testdb' from template1...");
    await $`docker exec ${containerName} psql -U postgres -c "CREATE DATABASE testdb TEMPLATE template1"`.quiet();

    const testdbCheck = await $`docker exec ${containerName} psql -U postgres -d testdb -t -c "
      SELECT COUNT(*) FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'realtime' AND p.proname = 'send'
    "`.text();

    if (testdbCheck.trim() !== "1") {
      throw new Error(
        "❌ realtime.send() NOT inherited in new database (proves template1 has the function)"
      );
    }
    console.log(
      "✅ New database inherited realtime.send() from template1 (proves template1 has the function)"
    );

    // Test 3: Test realtime.send() functionality in new database
    console.log("\n[5/8] Testing realtime.send() functionality in new database...");
    try {
      await $`docker exec ${containerName} psql -U postgres -d testdb -c "
        SELECT realtime.send(
          '{\"test\": \"value\"}'::jsonb,
          'test:event',
          'test_topic',
          false
        );
      "`.quiet();
      console.log("✅ realtime.send() works in new database");
    } catch (err) {
      const errorDetails = err instanceof Error ? err.message : JSON.stringify(err);
      throw new Error(`❌ realtime.send() call failed in new database: ${errorDetails}`);
    }

    // Test 4: Install required extensions in new database
    console.log("\n[6/8] Installing pgflow prerequisites in new database...");
    await $`docker exec ${containerName} psql -v ON_ERROR_STOP=1 -U postgres -d testdb -c "
      CREATE EXTENSION IF NOT EXISTS pg_net;
      CREATE EXTENSION IF NOT EXISTS pgmq;
    "`.quiet();

    // supabase_vault is optional - match production behavior with exception handling
    try {
      await $`docker exec ${containerName} psql -v ON_ERROR_STOP=1 -U postgres -d testdb -c "
        DO \$\$
        BEGIN
          CREATE EXTENSION IF NOT EXISTS supabase_vault;
        EXCEPTION
          WHEN undefined_file THEN
            RAISE NOTICE 'supabase_vault extension not available - skipping (optional)';
        END \$\$;
      "`.quiet();
    } catch {
      // supabase_vault is optional, ignore errors
      console.log("⚠️  supabase_vault not available (optional)");
    }
    console.log("✅ Prerequisites installed");

    // Test 5: Install pgflow in new database
    console.log("\n[7/8] Installing pgflow schema in new database...");
    // Strip extensions that can't be created in non-default databases:
    // - supabase_vault: optional dependency, may not be available
    // - pg_cron: can only be created in the database specified by cron.database_name (typically 'postgres')
    try {
      await $`docker exec ${containerName} bash -c "
        sed -e '/create extension.*supabase_vault/Id' -e '/create extension.*pg_cron/Id' /opt/pgflow/schema.sql | psql -v ON_ERROR_STOP=1 -U postgres -d testdb
      "`.quiet();
    } catch (err) {
      console.error("❌ pgflow schema installation failed:", err);
      throw err;
    }
    await $`docker exec ${containerName} psql -v ON_ERROR_STOP=1 -U postgres -d testdb -f /opt/pgflow/security-patches.sql`;

    // Verify pgflow.is_local() works
    const isLocalCheck = await $`docker exec ${containerName} psql -U postgres -d testdb -t -c "
      SELECT pgflow.is_local();
    "`.text();

    const result = isLocalCheck.trim();
    if (result !== "t" && result !== "true") {
      throw new Error(
        `❌ pgflow.is_local() returned unexpected value: "${result}" (expected "t" or "true")`
      );
    }
    console.log("✅ pgflow installed and working in new database");

    console.log("\n" + "=".repeat(70));
    console.log("✅ ALL TESTS PASSED - pgflow works in new databases!");
    console.log("=".repeat(70));

    await harness.cleanupAll();
    process.exit(0);
  } catch (error) {
    console.error("\n" + "=".repeat(70));
    console.error("❌ TEST FAILED");
    console.error("=".repeat(70));
    if (error instanceof Error) {
      console.error(`${error.message}\n\nOriginal error: ${error.stack || error}`);
    } else {
      console.error(`Error: ${JSON.stringify(error)}`);
    }
    await harness.cleanupAll();
    process.exit(1);
  }
}

// Run tests
runTest();
