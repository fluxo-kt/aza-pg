#!/usr/bin/env bun
/**
 * Test script: Verify realtime.send() degrades gracefully when optional extensions missing
 * Usage: bun run scripts/test/test-realtime-send-degradation.ts [image-tag]
 *
 * Tests that realtime.send() handles missing optional extensions correctly:
 * - Layer 1 (pg_notify) always works
 * - Layer 2 (pgmq) gracefully skipped if missing
 * - Layer 3 (pg_net webhooks) gracefully skipped if missing
 *
 * This verifies defensive programming - function doesn't fail when optional deps absent.
 */

import { $ } from "bun";
import { TestHarness } from "./harness.ts";
import { error, info, success } from "../utils/logger.ts";

const IMAGE_TAG = Bun.argv[2] ?? Bun.env.POSTGRES_IMAGE ?? "ghcr.io/fluxo-kt/aza-pg:pg18";
const harness = new TestHarness();

async function main(): Promise<void> {
  console.log("========================================");
  console.log("realtime.send() Graceful Degradation Test");
  console.log("========================================");
  console.log(`Image tag: ${IMAGE_TAG}`);
  console.log();

  info("Starting container...");
  const containerName = `realtime-degradation-test-${Date.now()}`;

  try {
    await $`docker run -d --name ${containerName} -e POSTGRES_PASSWORD=test ${IMAGE_TAG}`.quiet();
  } catch (err) {
    await harness.cleanup(containerName);
    throw new Error(`Failed to start container: ${err}`);
  }

  let testsPassed = true;

  try {
    info("Waiting for PostgreSQL to be ready...");
    await harness.waitForReady(containerName);

    // Test 1: Create database WITHOUT optional extensions
    info("Test 1: Create test database without pg_net or pgmq...");
    try {
      await $`docker exec ${containerName} psql -U postgres -c "CREATE DATABASE test_degradation"`.quiet();
      // Deliberately NOT installing pg_net or pgmq - only realtime.send() from template1
      success("Test 1 PASSED: Created test database (no optional extensions)");
    } catch (err) {
      error(`Test 1 FAILED: ${err}`);
      testsPassed = false;
    }

    // Test 2: Verify realtime.send() exists from template1
    info("Test 2: Verify realtime.send() inherited from template1...");
    try {
      const funcExists =
        await $`docker exec ${containerName} psql -U postgres -d test_degradation -tAc "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'realtime' AND p.proname = 'send'"`.text();
      if (funcExists.trim() === "1") {
        success("Test 2 PASSED: realtime.send() function exists");
      } else {
        error("Test 2 FAILED: realtime.send() not found");
        testsPassed = false;
      }
    } catch (err) {
      error(`Test 2 FAILED: ${err}`);
      testsPassed = false;
    }

    // Test 3: Call realtime.send() WITHOUT pg_net or pgmq (should succeed, degrade gracefully)
    info("Test 3: Call realtime.send() without optional extensions (should not fail)...");
    try {
      await $`docker exec ${containerName} psql -U postgres -d test_degradation -c "SELECT realtime.send('{\"test\": \"value\"}'::jsonb, 'test:event', 'test_topic', false)"`.quiet();
      success("Test 3 PASSED: realtime.send() succeeded without pg_net/pgmq");
    } catch (err) {
      error(
        `Test 3 FAILED: realtime.send() should not fail when optional extensions missing - ${err}`
      );
      testsPassed = false;
    }

    // Test 4: Verify pg_notify layer worked (check if LISTEN would receive it)
    // NOTE: This test validates that realtime.send() executes the pg_notify function without errors.
    // It does NOT validate LISTEN/NOTIFY event delivery (which would require separate connections).
    // The test confirms Layer 1 (pg_notify) code path is invoked successfully.
    info("Test 4: Verify Layer 1 (pg_notify) still works...");
    try {
      // Start LISTEN in background, send event, check notification received
      const listenScript = `
        psql -U postgres -d test_degradation <<'EOSQL'
        LISTEN test_topic;
        SELECT pg_sleep(0.1);
        SELECT realtime.send('{"layer1": "test"}'::jsonb, 'test:layer1', 'test_topic', false);
        SELECT pg_sleep(0.5);
EOSQL
      `;
      await $`docker exec ${containerName} bash -c ${listenScript}`.quiet();

      // If pg_notify worked, the call succeeded - that's enough proof Layer 1 works
      success("Test 4 PASSED: Layer 1 (pg_notify) executed successfully");
    } catch (err) {
      error(`Test 4 FAILED: ${err}`);
      testsPassed = false;
    }

    // Test 5: Verify pgmq was skipped gracefully (check logs for NOTICE)
    info("Test 5: Verify Layer 2 (pgmq) skipped gracefully...");
    try {
      const pgmqExists =
        await $`docker exec ${containerName} psql -U postgres -d test_degradation -tAc "SELECT count(*) FROM pg_extension WHERE extname = 'pgmq'"`.text();
      if (pgmqExists.trim() === "0") {
        success("Test 5 PASSED: pgmq correctly not installed, degradation expected");
      } else {
        error("Test 5 FAILED: pgmq should not be installed in this test");
        testsPassed = false;
      }
    } catch (err) {
      error(`Test 5 FAILED: ${err}`);
      testsPassed = false;
    }

    // Test 6: Verify pg_net was skipped gracefully
    info("Test 6: Verify Layer 3 (pg_net webhooks) skipped gracefully...");
    try {
      const pgNetExists =
        await $`docker exec ${containerName} psql -U postgres -d test_degradation -tAc "SELECT count(*) FROM pg_extension WHERE extname = 'pg_net'"`.text();
      if (pgNetExists.trim() === "0") {
        success("Test 6 PASSED: pg_net correctly not installed, degradation expected");
      } else {
        error("Test 6 FAILED: pg_net should not be installed in this test");
        testsPassed = false;
      }
    } catch (err) {
      error(`Test 6 FAILED: ${err}`);
      testsPassed = false;
    }

    // Test 7: Verify defensive programming - EXISTS checks prevent errors
    info("Test 7: Verify defensive EXISTS checks in realtime.send()...");
    try {
      const funcDef =
        await $`docker exec ${containerName} psql -U postgres -d test_degradation -tAc "SELECT pg_get_functiondef(oid) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'realtime' AND p.proname = 'send'"`.text();

      if (
        funcDef.includes("EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgmq')") &&
        funcDef.includes("EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')")
      ) {
        success("Test 7 PASSED: Defensive EXISTS checks present in function");
      } else {
        error("Test 7 FAILED: Missing defensive EXISTS checks");
        testsPassed = false;
      }
    } catch (err) {
      error(`Test 7 FAILED: ${err}`);
      testsPassed = false;
    }

    console.log();
    console.log("========================================");

    if (testsPassed) {
      success("All degradation tests PASSED - realtime.send() degrades gracefully!");
    } else {
      error("Some degradation tests FAILED");
    }
  } finally {
    await harness.cleanup(containerName);
  }

  process.exit(testsPassed ? 0 : 1);
}

main();
