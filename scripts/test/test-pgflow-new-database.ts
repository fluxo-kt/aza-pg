#!/usr/bin/env bun
/**
 * Test pgflow functionality in newly created databases
 *
 * Verifies:
 * 1. realtime.send() stub exists in template1
 * 2. realtime.send() stub exists in initial database
 * 3. New databases inherit realtime.send() from template1
 * 4. pgflow can be installed in new databases
 * 5. pgflow functions work correctly in new databases
 *
 * This ensures full functionality across ALL databases, not just the default one.
 */

import { $ } from "bun";
import { TestHarness } from "./harness.ts";

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

    // Test 1: Verify realtime.send() exists in template1
    console.log("\n[3/8] Checking realtime.send() in template1...");
    const template1Check =
      await $`docker exec ${containerName} psql -U postgres -d template1 -t -c "
      SELECT COUNT(*) FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'realtime' AND p.proname = 'send'
    "`.text();

    if (template1Check.trim() !== "1") {
      throw new Error("❌ realtime.send() NOT found in template1");
    }
    console.log("✅ realtime.send() exists in template1");

    // Test 2: Verify realtime.send() exists in initial database
    console.log("\n[4/8] Checking realtime.send() in postgres database...");
    const postgresCheck = await $`docker exec ${containerName} psql -U postgres -d postgres -t -c "
      SELECT COUNT(*) FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'realtime' AND p.proname = 'send'
    "`.text();

    if (postgresCheck.trim() !== "1") {
      throw new Error("❌ realtime.send() NOT found in postgres database");
    }
    console.log("✅ realtime.send() exists in postgres database");

    // Test 3: Create new database and verify inheritance
    console.log("\n[5/8] Creating new database 'testdb' from template1...");
    await $`docker exec ${containerName} psql -U postgres -c "CREATE DATABASE testdb TEMPLATE template1"`.quiet();

    const testdbCheck = await $`docker exec ${containerName} psql -U postgres -d testdb -t -c "
      SELECT COUNT(*) FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'realtime' AND p.proname = 'send'
    "`.text();

    if (testdbCheck.trim() !== "1") {
      throw new Error("❌ realtime.send() NOT inherited in new database");
    }
    console.log("✅ New database inherited realtime.send() from template1");

    // Test 4: Test realtime.send() functionality in new database
    console.log("\n[6/8] Testing realtime.send() functionality in new database...");
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

    // Test 5: Install required extensions in new database
    console.log("\n[7/8] Installing pgflow prerequisites in new database...");
    await $`docker exec ${containerName} psql -U postgres -d testdb -c "
      CREATE EXTENSION IF NOT EXISTS pg_net;
      CREATE EXTENSION IF NOT EXISTS pgmq;
      CREATE EXTENSION IF NOT EXISTS supabase_vault;
    "`.quiet();
    console.log("✅ Prerequisites installed");

    // Test 6: Install pgflow in new database
    console.log("\n[8/8] Installing pgflow schema in new database...");
    await $`docker exec ${containerName} psql -U postgres -d testdb -f /opt/pgflow/schema.sql`.quiet();
    await $`docker exec ${containerName} psql -U postgres -d testdb -f /opt/pgflow/security-patches.sql`.quiet();

    // Verify pgflow.is_local() works
    const isLocalCheck = await $`docker exec ${containerName} psql -U postgres -d testdb -t -c "
      SELECT pgflow.is_local();
    "`.text();

    if (!isLocalCheck.trim().includes("t")) {
      throw new Error("❌ pgflow.is_local() returned false (expected true)");
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
