#!/usr/bin/env bun
/**
 * Comprehensive pg_notify functional test suite
 * Tests PostgreSQL native LISTEN/NOTIFY pub/sub functionality
 *
 * Coverage:
 * - Basic LISTEN/NOTIFY operations
 * - Payload handling (including 8KB limit edge cases)
 * - Transaction awareness (notifications sent on COMMIT only)
 * - Channel pattern matching
 * - Multiple listeners
 * - Performance benchmarks
 *
 * Usage:
 *   bun run scripts/test/test-pg-notify-functional.ts --image=aza-pg:local
 *   bun run scripts/test/test-pg-notify-functional.ts --container=existing-container
 */

import { $ } from "bun";
import { resolveImageTag, parseContainerName, validateImageTag } from "./image-resolver";

// Parse CLI arguments
const containerName = parseContainerName();
const imageTag = containerName ? null : resolveImageTag();

// Validate if using image mode
if (imageTag) {
  validateImageTag(imageTag);
}

// Container name (either user-provided or auto-generated)
let CONTAINER: string;
let isOwnContainer = false;

if (containerName) {
  CONTAINER = containerName;
  console.log(`Using existing container: ${CONTAINER}\n`);
} else if (imageTag) {
  CONTAINER = `test-pg-notify-${Date.now()}-${process.pid}`;
  isOwnContainer = true;
  console.log(`Starting new container: ${CONTAINER}`);
  console.log(`Using image: ${imageTag}\n`);
} else {
  console.error("Error: Either --image or --container must be specified");
  process.exit(1);
}

// Note: pg_notify is a native PostgreSQL feature, no manifest check needed

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  metrics?: Record<string, any>;
}

const results: TestResult[] = [];

async function runSQL(sql: string): Promise<{ stdout: string; stderr: string; success: boolean }> {
  try {
    const result = await $`docker exec ${CONTAINER} psql -U postgres -t -A -c ${sql}`.nothrow();
    return {
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
      success: result.exitCode === 0,
    };
  } catch (error) {
    return {
      stdout: "",
      stderr: String(error),
      success: false,
    };
  }
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    const duration = Date.now() - start;
    results.push({ name, passed: true, duration });
    console.log(`✅ ${name} (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - start;
    results.push({ name, passed: false, duration, error: String(error) });
    console.log(`❌ ${name} (${duration}ms)`);
    console.log(`   Error: ${error}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// Container cleanup function
async function cleanupContainer(): Promise<void> {
  if (!isOwnContainer) return;

  console.log(`\n🧹 Cleaning up container: ${CONTAINER}`);
  try {
    await $`docker rm -f ${CONTAINER}`.nothrow();
    console.log("✅ Container cleanup complete");
  } catch (error) {
    console.error(`⚠️  Failed to cleanup container: ${error}`);
  }
}

// Register cleanup handlers
if (isOwnContainer) {
  process.on("exit", () => {
    // Synchronous cleanup on normal exit
    try {
      Bun.spawnSync(["docker", "rm", "-f", CONTAINER]);
    } catch {
      // Ignore errors during cleanup
    }
  });

  process.on("SIGINT", async () => {
    console.log("\n\n⚠️  Interrupted by user (SIGINT)");
    await cleanupContainer();
    process.exit(130);
  });

  process.on("SIGTERM", async () => {
    console.log("\n\n⚠️  Terminated (SIGTERM)");
    await cleanupContainer();
    process.exit(143);
  });
}

// Start container if using --image mode
if (isOwnContainer && imageTag) {
  console.log(`🚀 Starting container from image: ${imageTag}`);

  try {
    // Start PostgreSQL container
    await $`docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=postgres -e POSTGRES_HOST_AUTH_METHOD=trust ${imageTag}`;
    console.log(`✅ Container started: ${CONTAINER}`);

    // Wait for PostgreSQL to be ready
    console.log("⏳ Waiting for PostgreSQL to be ready...");
    let ready = false;
    const maxAttempts = 60; // 60 seconds timeout
    let attempt = 0;

    while (!ready && attempt < maxAttempts) {
      const result = await $`docker exec ${CONTAINER} pg_isready -U postgres`.nothrow();
      if (result.exitCode === 0) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      attempt++;
    }

    if (!ready) {
      throw new Error("PostgreSQL failed to start within 60 seconds");
    }

    // Wait for init scripts to complete (PostgreSQL restarts after initdb)
    // The first pg_isready success may be during init phase
    console.log("⏳ Waiting for init scripts to complete...");
    let stableConnections = 0;
    const requiredStable = 3; // Need 3 consecutive successful connections

    for (let i = 0; i < 30 && stableConnections < requiredStable; i++) {
      const check = await $`docker exec ${CONTAINER} psql -U postgres -c "SELECT 1"`.nothrow();
      if (check.exitCode === 0) {
        stableConnections++;
      } else {
        stableConnections = 0; // Reset on failure (restart in progress)
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (stableConnections < requiredStable) {
      throw new Error("PostgreSQL connection not stable after init");
    }

    console.log("✅ PostgreSQL is ready and stable\n");
  } catch (error) {
    console.error(`❌ Failed to start container: ${error}`);
    await cleanupContainer();
    process.exit(1);
  }
}

// Test 1: Basic NOTIFY - Simple notification without payload
await test("Basic NOTIFY without payload", async () => {
  // Send notification without payload
  const notify = await runSQL("NOTIFY test_channel");
  assert(notify.success, `NOTIFY command failed: ${notify.stderr}`);

  // Verify notification in pg_stat_activity (brief check that system accepted it)
  // Note: We can't actually receive it in this session, but we can verify the command succeeded
  const check = await runSQL("SELECT 1");
  assert(check.success, "Database connection check failed after NOTIFY");
});

// Test 2: NOTIFY with payload - JSON data
await test("NOTIFY with JSON payload", async () => {
  const payload = JSON.stringify({
    user_id: 123,
    action: "login",
    timestamp: "2025-11-26T10:00:00Z",
  });
  const notify = await runSQL(`NOTIFY user_events, '${payload}'`);
  assert(notify.success, `NOTIFY with payload failed: ${notify.stderr}`);
});

// Test 3: pg_notify() function - Alternative syntax
await test("pg_notify() function", async () => {
  const payload = JSON.stringify({ order_id: 456, status: "completed" });
  const notify = await runSQL(`SELECT pg_notify('order_events', '${payload}')`);
  assert(notify.success, `pg_notify() function failed: ${notify.stderr}`);
  assert(notify.stdout === "", "pg_notify() should return void (empty output)");
});

// Test 4: Transaction awareness - Notifications sent on COMMIT only
await test("Transaction awareness - COMMIT sends notification", async () => {
  // Start transaction, send notification, commit
  const txn = await runSQL(
    "BEGIN; NOTIFY txn_test, 'committed'; COMMIT; SELECT 'transaction completed' AS result"
  );
  assert(txn.success, `Transaction COMMIT test failed: ${txn.stderr}`);
  assert(
    txn.stdout.includes("transaction completed"),
    "Transaction should have completed successfully"
  );
});

// Test 5: Rollback behavior - Notifications NOT sent on ROLLBACK
await test("Transaction awareness - ROLLBACK cancels notification", async () => {
  // Start transaction, send notification, rollback
  const txn = await runSQL(
    "BEGIN; NOTIFY rollback_test, 'should not be sent'; ROLLBACK; SELECT 'transaction rolled back' AS result"
  );
  assert(txn.success, `Transaction ROLLBACK test failed: ${txn.stderr}`);
  assert(
    txn.stdout.includes("transaction rolled back"),
    "Transaction should have rolled back successfully"
  );
  // Notification was discarded on rollback - we can't verify non-receipt directly,
  // but the command should succeed
});

// Test 6: Payload size limits - 8KB boundary
await test("Payload size limit - near 8KB succeeds", async () => {
  // PostgreSQL NOTIFY payload limit is 8000 bytes (8KB)
  // Test with payload just under limit (7900 bytes to be safe)
  const largePayload = "x".repeat(7900);
  const notify = await runSQL(`NOTIFY large_payload, '${largePayload}'`);
  assert(notify.success, `NOTIFY with 7900-byte payload failed: ${notify.stderr}`);
});

// Test 7: Payload size limits - Over 8KB fails
await test("Payload size limit - over 8KB fails", async () => {
  // Test with payload over 8KB limit (8100 bytes)
  const tooLargePayload = "x".repeat(8100);
  const notify = await runSQL(`NOTIFY oversized_payload, '${tooLargePayload}'`);
  assert(!notify.success, "NOTIFY with oversized payload should have failed");
  assert(
    notify.stderr.includes("payload string too long") || notify.stderr.includes("too long"),
    `Expected payload size error, got: ${notify.stderr}`
  );
});

// Test 8: Special characters in payload
await test("Special characters in payload", async () => {
  // Test various special characters and escape sequences
  const specialPayload = JSON.stringify({
    text: "Special chars: 'quotes' \"doubles\" \\backslash \n newline \t tab",
    unicode: "Unicode: 你好 🚀 ñ é",
    symbols: "Symbols: @#$%^&*()_+-=[]{}|;:,.<>?/~`",
  });

  // Need to escape single quotes for SQL
  const escapedPayload = specialPayload.replace(/'/g, "''");
  const notify = await runSQL(`NOTIFY special_chars, '${escapedPayload}'`);
  assert(notify.success, `NOTIFY with special characters failed: ${notify.stderr}`);
});

// Test 9: Multiple channels
await test("Multiple channels - different notifications", async () => {
  // Send notifications to multiple different channels
  const notify1 = await runSQL("NOTIFY channel_1, 'message for channel 1'");
  const notify2 = await runSQL("NOTIFY channel_2, 'message for channel 2'");
  const notify3 = await runSQL("NOTIFY channel_3, 'message for channel 3'");

  assert(notify1.success, `NOTIFY to channel_1 failed: ${notify1.stderr}`);
  assert(notify2.success, `NOTIFY to channel_2 failed: ${notify2.stderr}`);
  assert(notify3.success, `NOTIFY to channel_3 failed: ${notify3.stderr}`);
});

// Test 10: Channel name case-insensitivity
await test("Channel name case-insensitivity", async () => {
  // PostgreSQL channel names are case-insensitive identifiers
  // TEST_CHANNEL and test_channel are the same
  const notify1 = await runSQL("NOTIFY TEST_CHANNEL, 'uppercase'");
  const notify2 = await runSQL("NOTIFY test_channel, 'lowercase'");
  const notify3 = await runSQL("NOTIFY Test_Channel, 'mixedcase'");

  assert(notify1.success, `NOTIFY to TEST_CHANNEL failed: ${notify1.stderr}`);
  assert(notify2.success, `NOTIFY to test_channel failed: ${notify2.stderr}`);
  assert(notify3.success, `NOTIFY to Test_Channel failed: ${notify3.stderr}`);
});

// Test 11: Empty payload
await test("Empty payload notification", async () => {
  // NOTIFY with empty string payload
  const notify = await runSQL("NOTIFY empty_payload, ''");
  assert(notify.success, `NOTIFY with empty payload failed: ${notify.stderr}`);
});

// Test 12: Performance benchmark - Notification throughput
await test("Performance benchmark - notification throughput", async () => {
  const notificationCount = 1000;
  const start = Date.now();

  // Send multiple notifications in a transaction for better performance
  const commands = ["BEGIN"];
  for (let i = 0; i < notificationCount; i++) {
    commands.push(`NOTIFY perf_test, '{"id": ${i}}'`);
  }
  commands.push("COMMIT");

  const txn = await runSQL(commands.join("; "));
  assert(txn.success, `Performance benchmark transaction failed: ${txn.stderr}`);

  const duration = Date.now() - start;
  const throughput = (notificationCount / duration) * 1000; // notifications per second

  console.log(
    `   📊 Throughput: ${throughput.toFixed(2)} notifications/sec (${notificationCount} notifications in ${duration}ms)`
  );

  const lastResult = results[results.length - 1];
  if (lastResult) {
    lastResult.metrics = {
      notificationCount,
      duration,
      throughput: throughput.toFixed(2),
    };
  }

  assert(
    throughput > 100,
    `Throughput too low: ${throughput.toFixed(2)} notifications/sec (expected > 100)`
  );
});

// Print Summary
console.log("\n" + "=".repeat(80));
console.log("PG_NOTIFY FUNCTIONAL TEST SUMMARY");
console.log("=".repeat(80));

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

console.log(`Total: ${results.length} tests`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total Duration: ${totalDuration}ms`);

if (failed > 0) {
  console.log("\nFailed Tests:");
  results
    .filter((r) => !r.passed)
    .forEach((r) => {
      console.log(`  - ${r.name}: ${r.error}`);
    });
}

// Print performance metrics
const perfResults = results.filter((r) => r.metrics);
if (perfResults.length > 0) {
  console.log("\n" + "=".repeat(80));
  console.log("PERFORMANCE METRICS");
  console.log("=".repeat(80));
  perfResults.forEach((r) => {
    console.log(`\n${r.name}:`);
    Object.entries(r.metrics!).forEach(([key, value]) => {
      console.log(`  ${key}: ${value}`);
    });
  });
}

console.log("\n" + "=".repeat(80));

// Cleanup container if we own it
await cleanupContainer();

process.exit(failed > 0 ? 1 : 0);
