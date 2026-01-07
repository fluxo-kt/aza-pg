#!/usr/bin/env bun
/**
 * Comprehensive pgmq functional test suite
 * Tests complete message queue workflow with visibility timeouts and monitoring
 *
 * Coverage:
 * - Queue management (create, partitioned queues, drop)
 * - Message operations (send, batch send, read, pop)
 * - Visibility timeout (read with timeout, set VT, polling)
 * - Message lifecycle (delete, archive)
 * - Queue management (purge, metrics)
 * - Performance metrics (throughput, latency)
 *
 * Usage:
 *   bun run scripts/test/test-pgmq-functional.ts --image=aza-pg:local
 *   bun run scripts/test/test-pgmq-functional.ts --container=existing-container
 */

import { $ } from "bun";
import { join } from "node:path";
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
  CONTAINER = `test-pgmq-${Date.now()}-${process.pid}`;
  isOwnContainer = true;
  console.log(`Starting new container: ${CONTAINER}`);
  console.log(`Using image: ${imageTag}\n`);
} else {
  console.error("Error: Either --image or --container must be specified");
  process.exit(1);
}

// Check if pgmq extension is enabled in manifest
const REPO_ROOT = join(import.meta.dir, "../..");
const MANIFEST_PATH = join(REPO_ROOT, "docker/postgres/extensions.manifest.json");

try {
  const manifest = await Bun.file(MANIFEST_PATH).json();
  const pgmqEntry = manifest.entries.find((e: any) => e.name === "pgmq");

  if (pgmqEntry && pgmqEntry.enabled === false) {
    console.log("\n" + "=".repeat(80));
    console.log("PGMQ FUNCTIONAL TEST SKIPPED");
    console.log("=".repeat(80));
    console.log("⏭️  pgmq extension is disabled in manifest (enabled: false)");
    console.log("   Reason: " + (pgmqEntry.disabledReason || "Not specified"));
    console.log("   To enable: Set enabled: true in scripts/extensions/manifest-data.ts");
    console.log("=".repeat(80));
    process.exit(0);
  }
} catch (error) {
  console.error("Warning: Could not read manifest file:", error);
  console.log("Proceeding with tests...\n");
}

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
    console.log("⏳ Waiting for init scripts to complete...");
    let stableConnections = 0;
    const requiredStable = 3;

    for (let i = 0; i < 30 && stableConnections < requiredStable; i++) {
      const check = await $`docker exec ${CONTAINER} psql -U postgres -c "SELECT 1"`.nothrow();
      if (check.exitCode === 0) {
        stableConnections++;
      } else {
        stableConnections = 0;
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

// Test 0: Extension Setup (required before any pgmq operations)
await test("Extension setup", async () => {
  // Create pgmq extension if not exists
  const create = await runSQL("CREATE EXTENSION IF NOT EXISTS pgmq");
  assert(create.success, `Extension creation failed: ${create.stderr}`);

  // Verify extension exists
  const verify = await runSQL("SELECT extname FROM pg_extension WHERE extname = 'pgmq'");
  assert(verify.success && verify.stdout === "pgmq", "pgmq extension not found after creation");
});

// Test 1: Queue Creation
await test("Queue creation", async () => {
  // Create standard queue
  const create = await runSQL("SELECT pgmq.create('test_queue_standard')");
  assert(create.success, `Queue creation failed: ${create.stderr}`);

  // Verify queue exists by attempting to get metrics
  const metrics = await runSQL(
    "SELECT queue_name FROM pgmq.metrics('test_queue_standard') WHERE queue_name = 'test_queue_standard'"
  );
  assert(metrics.success && metrics.stdout === "test_queue_standard", "Queue not found in metrics");
});

// Test 2: Partitioned Queue Creation
await test("Partitioned queue creation", async () => {
  // Create partitioned queue with 1-day interval and 7-day retention
  const create = await runSQL(
    "SELECT pgmq.create_partitioned('test_queue_partitioned', '1 day'::text, '7 days'::text)"
  );
  assert(create.success, `Partitioned queue creation failed: ${create.stderr}`);

  // Verify partitioned queue exists
  const metrics = await runSQL(
    "SELECT queue_name FROM pgmq.metrics('test_queue_partitioned') WHERE queue_name = 'test_queue_partitioned'"
  );
  assert(
    metrics.success && metrics.stdout === "test_queue_partitioned",
    "Partitioned queue not found in metrics"
  );
});

// Test 3: Send Message
await test("Send single message", async () => {
  // Send a message and verify msg_id is returned
  const send = await runSQL(
    'SELECT pgmq.send(\'test_queue_standard\', \'{"user_id": 1, "action": "login", "timestamp": "2024-01-01T00:00:00Z"}\'::jsonb)'
  );
  assert(send.success, `Message send failed: ${send.stderr}`);

  const msgId = parseInt(send.stdout);
  assert(msgId > 0, `Invalid msg_id returned: ${send.stdout}`);
});

// Test 4: Send Batch
await test("Send batch of messages", async () => {
  // Send multiple messages in a batch
  const batch = await runSQL(
    "SELECT pgmq.send_batch('test_queue_standard', ARRAY['{\"order_id\": 1}'::jsonb, '{\"order_id\": 2}'::jsonb, '{\"order_id\": 3}'::jsonb])"
  );
  assert(batch.success, `Batch send failed: ${batch.stderr}`);

  // Verify the output contains msg_ids (returns array of bigint)
  assert(batch.stdout.length > 0, "Batch send returned no msg_ids");
});

// Test 5: Read Messages
await test("Read messages with visibility timeout", async () => {
  // Read up to 5 messages with 30 second visibility timeout
  const read = await runSQL("SELECT msg_id FROM pgmq.read('test_queue_standard', 30, 5)");
  assert(read.success, `Read messages failed: ${read.stderr}`);

  // Should have messages from previous tests
  const msgIds = read.stdout.split("\n").filter((line) => line.length > 0);
  assert(msgIds.length >= 1, `Expected at least 1 message, got ${msgIds.length}`);

  // Verify msg_id is numeric
  const firstMsgId = parseInt(msgIds[0] || "");
  assert(firstMsgId > 0, `Invalid msg_id: ${msgIds[0]}`);
});

// Test 6: Read with Poll
await test("Read with polling", async () => {
  // First, send a message to a new queue
  await runSQL("SELECT pgmq.create('test_queue_poll')");
  await runSQL("SELECT pgmq.send('test_queue_poll', '{\"test\": \"poll_message\"}'::jsonb)");

  // Read with poll (VT=30s, qty=1, max_poll=5s, poll_interval=100ms)
  const readPoll = await runSQL(
    "SELECT msg_id, message->>'test' as test_value FROM pgmq.read_with_poll('test_queue_poll', 30, 1, 5, 100)"
  );
  assert(readPoll.success, `Read with poll failed: ${readPoll.stderr}`);
  assert(
    readPoll.stdout.includes("poll_message"),
    `Expected poll_message in output, got: ${readPoll.stdout}`
  );
});

// Test 7: Pop Message (Atomic Read and Delete)
await test("Pop message (atomic read and delete)", async () => {
  // Send a message to pop
  await runSQL("SELECT pgmq.send('test_queue_standard', '{\"action\": \"pop_test\"}'::jsonb)");

  // Pop the message
  const pop = await runSQL(
    "SELECT msg_id, message->>'action' as action FROM pgmq.pop('test_queue_standard')"
  );
  assert(pop.success, `Pop message failed: ${pop.stderr}`);

  // Verify we got a message
  assert(pop.stdout.length > 0, "Pop returned no message");
  assert(pop.stdout.includes("pop_test"), `Expected pop_test in output, got: ${pop.stdout}`);
});

// Test 8: Delete Message
await test("Delete message by msg_id", async () => {
  // Send a message
  const send = await runSQL(
    "SELECT pgmq.send('test_queue_standard', '{\"action\": \"delete_test\"}'::jsonb)"
  );
  assert(send.success, `Send failed: ${send.stderr}`);

  const msgId = parseInt(send.stdout);
  assert(msgId > 0, `Invalid msg_id: ${send.stdout}`);

  // Delete the message
  const del = await runSQL(`SELECT pgmq.delete('test_queue_standard', ${msgId})`);
  assert(del.success, `Delete failed: ${del.stderr}`);
  assert(del.stdout === "t", `Delete returned ${del.stdout}, expected 't'`);
});

// Test 9: Archive Message
await test("Archive message", async () => {
  // Send a message to archive
  const send = await runSQL(
    "SELECT pgmq.send('test_queue_standard', '{\"action\": \"archive_test\"}'::jsonb)"
  );
  assert(send.success, `Send failed: ${send.stderr}`);

  const msgId = parseInt(send.stdout);
  assert(msgId > 0, `Invalid msg_id: ${send.stdout}`);

  // Archive the message
  const archive = await runSQL(`SELECT pgmq.archive('test_queue_standard', ${msgId})`);
  assert(archive.success, `Archive failed: ${archive.stderr}`);
  assert(archive.stdout === "t", `Archive returned ${archive.stdout}, expected 't'`);
});

// Test 10: Archive to partitioned queue (v1.8.1 fix for time-based archive partitioning)
await test("Archive to partitioned queue (v1.8.1)", async () => {
  // Send message to partitioned queue (created in Test 2)
  const send = await runSQL(
    "SELECT pgmq.send('test_queue_partitioned', '{\"action\": \"archive_partitioned_test\"}'::jsonb)"
  );
  assert(send.success, `Send to partitioned queue failed: ${send.stderr}`);

  const msgId = parseInt(send.stdout);
  assert(msgId > 0, `Invalid msg_id: ${send.stdout}`);

  // Archive the message (v1.8.1 fixed time-based archive partitioning)
  const archive = await runSQL(`SELECT pgmq.archive('test_queue_partitioned', ${msgId})`);
  assert(archive.success, `Archive to partitioned queue failed: ${archive.stderr}`);
  assert(archive.stdout === "t", `Archive returned ${archive.stdout}, expected 't'`);

  // Verify archive table exists and contains the message
  // v1.8.1 fix: archive tables now properly support archived_at column partitioning
  const archiveCheck = await runSQL(
    `SELECT count(*) FROM pgmq.a_test_queue_partitioned WHERE msg_id = ${msgId}`
  );
  assert(archiveCheck.success, `Archive table check failed: ${archiveCheck.stderr}`);
  assert(
    parseInt(archiveCheck.stdout) === 1,
    `Expected 1 archived message, got ${archiveCheck.stdout}`
  );

  // Verify archived_at column is populated (key fix in v1.8.1)
  const archivedAt = await runSQL(
    `SELECT archived_at IS NOT NULL as has_timestamp FROM pgmq.a_test_queue_partitioned WHERE msg_id = ${msgId}`
  );
  assert(archivedAt.success, `Archived_at check failed: ${archivedAt.stderr}`);
  assert(
    archivedAt.stdout.trim() === "t",
    `Expected archived_at to be populated (v1.8.1 fix), got: ${archivedAt.stdout}`
  );
});

// Test 11: Visibility Timeout Behavior
await test("Visibility timeout behavior", async () => {
  // Create a new queue for VT testing
  await runSQL("SELECT pgmq.create('test_queue_vt')");

  // Send a message
  const send = await runSQL(
    "SELECT pgmq.send('test_queue_vt', '{\"test\": \"vt_behavior\"}'::jsonb)"
  );
  assert(send.success, `Send failed: ${send.stderr}`);

  // Read with 2 second visibility timeout
  const read1 = await runSQL("SELECT msg_id FROM pgmq.read('test_queue_vt', 2, 1)");
  assert(read1.success, `First read failed: ${read1.stderr}`);
  assert(read1.stdout.length > 0, "No message read");

  // Try to read immediately (should get no messages - still invisible)
  const read2 = await runSQL("SELECT msg_id FROM pgmq.read('test_queue_vt', 2, 1)");
  assert(read2.success, `Second read failed: ${read2.stderr}`);
  assert(read2.stdout === "", `Expected no messages, got: ${read2.stdout}`);

  // Wait for visibility timeout to expire
  await new Promise((resolve) => setTimeout(resolve, 2500));

  // Read again (message should be visible again)
  const read3 = await runSQL("SELECT msg_id FROM pgmq.read('test_queue_vt', 30, 1)");
  assert(read3.success, `Third read failed: ${read3.stderr}`);
  assert(read3.stdout.length > 0, "Message not visible after VT expiration");
});

// Test 12: Set Visibility Timeout
await test("Set visibility timeout", async () => {
  // Create queue and send message
  await runSQL("SELECT pgmq.create('test_queue_setvt')");
  const send = await runSQL(
    "SELECT pgmq.send('test_queue_setvt', '{\"test\": \"set_vt\"}'::jsonb)"
  );
  const msgId = parseInt(send.stdout);
  assert(msgId > 0, `Invalid msg_id: ${send.stdout}`);

  // Read with 30 second VT
  await runSQL("SELECT pgmq.read('test_queue_setvt', 30, 1)");

  // Set new VT to 0 seconds (make visible immediately)
  const setVt = await runSQL(`SELECT pgmq.set_vt('test_queue_setvt', ${msgId}, 0)`);
  assert(setVt.success, `Set VT failed: ${setVt.stderr}`);

  // Read again immediately (should be visible due to VT=0)
  const read = await runSQL("SELECT msg_id FROM pgmq.read('test_queue_setvt', 30, 1)");
  assert(read.success, `Read after set_vt failed: ${read.stderr}`);
  assert(read.stdout.includes(String(msgId)), `Expected msg_id ${msgId}, got: ${read.stdout}`);
});

// Test 13: Queue Metrics
await test("Queue metrics", async () => {
  // Get metrics for specific queue
  const metrics = await runSQL(
    "SELECT queue_name, queue_length, newest_msg_age_sec, oldest_msg_age_sec, total_messages FROM pgmq.metrics('test_queue_standard')"
  );
  assert(metrics.success, `Metrics retrieval failed: ${metrics.stderr}`);
  assert(
    metrics.stdout.includes("test_queue_standard"),
    `Expected test_queue_standard in metrics, got: ${metrics.stdout}`
  );

  // Get all queue metrics
  const metricsAll = await runSQL("SELECT count(*) FROM pgmq.metrics_all()");
  assert(metricsAll.success, `Metrics all retrieval failed: ${metricsAll.stderr}`);

  const queueCount = parseInt(metricsAll.stdout);
  assert(queueCount >= 5, `Expected at least 5 queues, got ${queueCount}`);
});

// Test 14: Purge Queue
await test("Purge queue", async () => {
  // Create queue and add messages
  await runSQL("SELECT pgmq.create('test_queue_purge')");
  for (let i = 0; i < 10; i++) {
    await runSQL(`SELECT pgmq.send('test_queue_purge', '{"item": ${i + 1}}'::jsonb)`);
  }

  // Verify messages exist
  const before = await runSQL("SELECT queue_length FROM pgmq.metrics('test_queue_purge')");
  assert(before.success, `Metrics before purge failed: ${before.stderr}`);
  const lengthBefore = parseInt(before.stdout);
  assert(lengthBefore >= 10, `Expected at least 10 messages, got ${lengthBefore}`);

  // Purge queue
  const purge = await runSQL("SELECT pgmq.purge_queue('test_queue_purge')");
  assert(purge.success, `Purge failed: ${purge.stderr}`);

  // Verify queue is empty
  const after = await runSQL("SELECT queue_length FROM pgmq.metrics('test_queue_purge')");
  assert(after.success, `Metrics after purge failed: ${after.stderr}`);
  const lengthAfter = parseInt(after.stdout);
  assert(lengthAfter === 0, `Expected 0 messages after purge, got ${lengthAfter}`);
});

// Test 15: Drop Queue
await test("Drop queue", async () => {
  // Drop all test queues
  const queues = [
    "test_queue_standard",
    "test_queue_partitioned",
    "test_queue_poll",
    "test_queue_vt",
    "test_queue_setvt",
    "test_queue_purge",
  ];

  for (const queue of queues) {
    const drop = await runSQL(`SELECT pgmq.drop_queue('${queue}')`);
    assert(drop.success, `Drop queue ${queue} failed: ${drop.stderr}`);
  }

  // Verify no test queues remain
  const remaining = await runSQL(
    "SELECT count(*) FROM pgmq.metrics_all() WHERE queue_name LIKE 'test_queue_%'"
  );
  assert(remaining.success, `Check remaining queues failed: ${remaining.stderr}`);
  assert(remaining.stdout === "0", `Expected 0 remaining test queues, got ${remaining.stdout}`);
});

// Test 16: Performance Benchmark - Message Throughput
await test("Performance benchmark - message throughput", async () => {
  // Create benchmark queue
  await runSQL("SELECT pgmq.create('benchmark_queue')");

  const messageCount = 100;
  const start = Date.now();

  // Send messages
  for (let i = 0; i < messageCount; i++) {
    await runSQL(
      `SELECT pgmq.send('benchmark_queue', '{"id": ${i + 1}, "data": "benchmark_test"}'::jsonb)`
    );
  }

  const sendDuration = Date.now() - start;
  const sendThroughput = (messageCount / sendDuration) * 1000; // messages per second

  // Read messages
  const readStart = Date.now();
  const read = await runSQL(
    `SELECT count(*) FROM pgmq.read('benchmark_queue', 30, ${messageCount})`
  );
  const readDuration = Date.now() - readStart;
  const readThroughput = (messageCount / readDuration) * 1000;

  assert(read.success, `Benchmark read failed: ${read.stderr}`);
  const readCount = parseInt(read.stdout);
  assert(readCount === messageCount, `Expected ${messageCount} messages, got ${readCount}`);

  console.log(
    `   📊 Send Throughput: ${sendThroughput.toFixed(2)} msg/sec (${messageCount} messages in ${sendDuration}ms)`
  );
  console.log(
    `   📊 Read Throughput: ${readThroughput.toFixed(2)} msg/sec (${messageCount} messages in ${readDuration}ms)`
  );

  // Cleanup
  await runSQL("SELECT pgmq.drop_queue('benchmark_queue')");

  const lastResult = results[results.length - 1];
  if (lastResult) {
    lastResult.metrics = {
      messageCount,
      sendDuration,
      sendThroughput: sendThroughput.toFixed(2),
      readDuration,
      readThroughput: readThroughput.toFixed(2),
    };
  }

  assert(sendThroughput > 10, `Send throughput too low: ${sendThroughput.toFixed(2)} msg/sec`);
  assert(readThroughput > 50, `Read throughput too low: ${readThroughput.toFixed(2)} msg/sec`);
});

// Print Summary
console.log("\n" + "=".repeat(80));
console.log("PGMQ FUNCTIONAL TEST SUMMARY");
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
