#!/usr/bin/env bun
/**
 * Test script: Verify pgflow works WITHOUT supabase_vault extension
 * Usage: bun run scripts/test/test-pgflow-without-vault.ts [image-tag]
 *
 * Tests that pgflow can be installed and used in databases where
 * supabase_vault extension is not available or deliberately disabled.
 *
 * This verifies the compatibility patch that makes supabase_vault optional.
 *
 * Examples:
 *   bun run scripts/test/test-pgflow-without-vault.ts                    # Use default tag
 *   bun run scripts/test/test-pgflow-without-vault.ts my-custom:tag      # Use custom tag
 */

import { $ } from "bun";
import { TestHarness } from "./harness.ts";
import { error, info, success } from "../utils/logger.ts";

const IMAGE_TAG = Bun.argv[2] ?? Bun.env.POSTGRES_IMAGE ?? "ghcr.io/fluxo-kt/aza-pg:pg18";
Bun.env.POSTGRES_IMAGE = IMAGE_TAG; // Set env var for harness to use
const harness = new TestHarness();

async function main(): Promise<void> {
  console.log("========================================");
  console.log("pgflow WITHOUT supabase_vault Test");
  console.log("========================================");
  console.log(`Image tag: ${IMAGE_TAG}`);
  console.log();

  info("Starting container...");
  const containerName = await harness.startContainer("pgflow-no-vault-test", {
    POSTGRES_PASSWORD: "test",
  });

  let testsPassed = true;

  try {
    info("Waiting for PostgreSQL to be ready...");
    await harness.waitForReady(containerName);

    // Test 1: Verify pgflow installed in default database (with vault if enabled by default)
    info("Test 1: Verify pgflow exists in default database...");
    try {
      const pgflowExists =
        await $`docker exec ${containerName} psql -U postgres -tAc "SELECT count(*) FROM pg_namespace WHERE nspname = 'pgflow'"`.text();
      if (pgflowExists.trim() === "1") {
        success("Test 1 PASSED: pgflow schema exists in default database");
      } else {
        error("Test 1 FAILED: pgflow schema not found in default database");
        testsPassed = false;
      }
    } catch (err) {
      error(`Test 1 FAILED: ${err}`);
      testsPassed = false;
    }

    // Test 2: Create new database WITHOUT supabase_vault
    info("Test 2: Create new database WITHOUT supabase_vault...");
    try {
      await $`docker exec ${containerName} psql -U postgres -c "CREATE DATABASE test_no_vault"`.quiet();
      success("Test 2 PASSED: Created test database");
    } catch (err) {
      error(`Test 2 FAILED: Could not create test database - ${err}`);
      testsPassed = false;
    }

    // Test 3: Install pgflow prerequisites EXCEPT supabase_vault
    info("Test 3: Install prerequisites (pgmq, pg_net) WITHOUT supabase_vault...");
    try {
      await $`docker exec ${containerName} psql -U postgres -d test_no_vault -c "CREATE EXTENSION IF NOT EXISTS pgmq"`.quiet();
      await $`docker exec ${containerName} psql -U postgres -d test_no_vault -c "CREATE EXTENSION IF NOT EXISTS pg_net"`.quiet();
      // Deliberately NOT creating supabase_vault
      success("Test 3 PASSED: Installed pgmq and pg_net (vault skipped)");
    } catch (err) {
      error(`Test 3 FAILED: Could not install prerequisites - ${err}`);
      testsPassed = false;
    }

    // Test 4: Install pgflow schema WITHOUT vault
    info("Test 4: Install pgflow schema (should succeed without vault)...");
    try {
      // Strip extensions that can't be created in non-default databases:
      // - supabase_vault: optional dependency being tested
      // - pg_cron: can only be created in cron.database_name database (typically 'postgres')
      await $`docker exec ${containerName} bash -c "sed -e '/create extension.*supabase_vault/Id' -e '/create extension.*pg_cron/Id' /opt/pgflow/schema.sql | psql -v ON_ERROR_STOP=1 -U postgres -d test_no_vault"`.quiet();
      await $`docker exec ${containerName} psql -v ON_ERROR_STOP=1 -U postgres -d test_no_vault -f /opt/pgflow/security-patches.sql`.quiet();
      success("Test 4 PASSED: pgflow schema installed without vault");
    } catch (err) {
      error(`Test 4 FAILED: pgflow schema installation failed - ${err}`);
      testsPassed = false;
    }

    // Test 5: Verify pgflow.is_local() works
    info("Test 5: Verify pgflow.is_local() function...");
    try {
      const isLocal =
        await $`docker exec ${containerName} psql -U postgres -d test_no_vault -tAc "SELECT pgflow.is_local()"`.text();
      const result = isLocal.trim();
      if (result === "t" || result === "true") {
        success(`Test 5 PASSED: pgflow.is_local() returns true (value: "${result}")`);
      } else {
        error(`Test 5 FAILED: pgflow.is_local() returned "${result}", expected "t" or "true"`);
        testsPassed = false;
      }
    } catch (err) {
      error(`Test 5 FAILED: ${err}`);
      testsPassed = false;
    }

    // Test 6: Verify supabase_vault is NOT installed
    info("Test 6: Verify supabase_vault extension is NOT installed...");
    try {
      const vaultExists =
        await $`docker exec ${containerName} psql -U postgres -d test_no_vault -tAc "SELECT count(*) FROM pg_extension WHERE extname = 'supabase_vault'"`.text();
      if (vaultExists.trim() === "0") {
        success("Test 6 PASSED: supabase_vault correctly NOT installed");
      } else {
        error("Test 6 FAILED: supabase_vault should not be installed but is present");
        testsPassed = false;
      }
    } catch (err) {
      error(`Test 6 FAILED: ${err}`);
      testsPassed = false;
    }

    // Test 7: Verify pgflow tables exist
    info("Test 7: Verify pgflow tables are accessible...");
    try {
      const tableCount =
        await $`docker exec ${containerName} psql -U postgres -d test_no_vault -tAc "SELECT count(*) FROM pg_tables WHERE schemaname = 'pgflow'"`.text();
      const count = Number.parseInt(tableCount.trim(), 10);
      if (!isNaN(count) && count >= 5) {
        // Should have at least flows, runs, step_states, migrations, etc.
        success(`Test 7 PASSED: Found ${count} pgflow tables`);
      } else {
        error(`Test 7 FAILED: Expected at least 5 pgflow tables, found ${count}`);
        testsPassed = false;
      }
    } catch (err) {
      error(`Test 7 FAILED: ${err}`);
      testsPassed = false;
    }

    // Test 8: Verify security patches applied
    info("Test 8: Verify security patches (SET search_path) applied...");
    try {
      const searchPath1 =
        await $`docker exec ${containerName} psql -U postgres -d test_no_vault -tAc "SELECT proconfig::text FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'pgflow' AND p.proname = 'get_run_with_states'"`.text();
      const searchPath2 =
        await $`docker exec ${containerName} psql -U postgres -d test_no_vault -tAc "SELECT proconfig::text FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'pgflow' AND p.proname = 'start_flow_with_states'"`.text();

      if (searchPath1.includes("search_path=") && searchPath2.includes("search_path=")) {
        success("Test 8 PASSED: Security patches applied (search_path protection enabled)");
      } else {
        error("Test 8 FAILED: Security patches missing");
        testsPassed = false;
      }
    } catch (err) {
      error(`Test 8 FAILED: ${err}`);
      testsPassed = false;
    }

    console.log();
    console.log("========================================");

    if (testsPassed) {
      success("All tests PASSED - pgflow works without supabase_vault!");
    } else {
      error("Some tests FAILED - pgflow may not work without supabase_vault");
    }
  } finally {
    // Always cleanup container, even if test throws
    await harness.cleanup(containerName);
  }

  // Exit after cleanup
  process.exit(testsPassed ? 0 : 1);
}

main();
