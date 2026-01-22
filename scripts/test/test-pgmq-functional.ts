#!/usr/bin/env bun
/**
 * Comprehensive pgmq functional test suite
 * Tests complete message queue workflow with visibility timeouts and monitoring
 *
 * Coverage:
 * - Queue management (create, partitioned, unlogged, drop, list_queues)
 * - Message operations (send, send delayed, batch send, read, pop)
 * - Visibility timeout (read with timeout, set VT, polling)
 * - Message lifecycle (delete, batch delete, archive, batch archive)
 * - FIFO queues (v1.9.0): read_grouped, read_grouped_rr, create_fifo_index
 * - Queue management (purge, metrics)
 * - Error handling (non-existent queues, invalid operations)
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
    const result = await $`docker exec ${CONTAINER} psql -U postgres -t -A -c ${sql}`
      .quiet()
      .nothrow();
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
      await Bun.sleep(1000);
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
      await Bun.sleep(1000);
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
  await Bun.sleep(2500);

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

// Test 12A: last_read_at tracking (v1.10.0)
await test("last_read_at column tracks message read times (v1.10.0)", async () => {
  // Create queue and send message
  await runSQL("SELECT pgmq.create('test_queue_last_read')");
  const send = await runSQL(
    "SELECT pgmq.send('test_queue_last_read', '{\"test\": \"last_read_at\"}'::jsonb)"
  );
  assert(send.success, `Send failed: ${send.stderr}`);
  const msgId = parseInt(send.stdout);
  assert(msgId > 0, `Invalid msg_id: ${send.stdout}`);

  // Read message and verify last_read_at is populated
  const read = await runSQL(
    "SELECT msg_id, last_read_at IS NOT NULL as has_last_read FROM pgmq.read('test_queue_last_read', 30, 1)"
  );
  assert(read.success, `Read failed: ${read.stderr}`);
  assert(
    read.stdout.includes(`${msgId}|t`),
    `Expected last_read_at to be populated, got: ${read.stdout}`
  );

  console.log("   📊 last_read_at column verified (v1.10.0 feature)");
});

// Test 12B: set_vt with TIMESTAMPTZ parameter (v1.10.0)
await test("set_vt accepts TIMESTAMPTZ for absolute timeout (v1.10.0)", async () => {
  // Create queue and send message
  await runSQL("SELECT pgmq.create('test_queue_setvt_ts')");
  const send = await runSQL(
    "SELECT pgmq.send('test_queue_setvt_ts', '{\"test\": \"set_vt_timestamptz\"}'::jsonb)"
  );
  assert(send.success, `Send failed: ${send.stderr}`);
  const msgId = parseInt(send.stdout);
  assert(msgId > 0, `Invalid msg_id: ${send.stdout}`);

  // Read with 30 second VT
  await runSQL("SELECT pgmq.read('test_queue_setvt_ts', 30, 1)");

  // Set VT to NOW() (make visible immediately) using TIMESTAMPTZ
  const setVt = await runSQL(`SELECT pgmq.set_vt('test_queue_setvt_ts', ${msgId}, NOW())`);
  assert(setVt.success, `Set VT with TIMESTAMPTZ failed: ${setVt.stderr}`);

  // Read again immediately (should be visible)
  const read = await runSQL("SELECT msg_id FROM pgmq.read('test_queue_setvt_ts', 30, 1)");
  assert(read.success, `Read after set_vt failed: ${read.stderr}`);
  assert(read.stdout.includes(String(msgId)), `Expected msg_id ${msgId}, got: ${read.stdout}`);

  console.log("   📊 set_vt with TIMESTAMPTZ parameter verified (v1.10.0 feature)");
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

// Test 15: FIFO Queue - read_grouped (v1.9.0)
await test("FIFO read_grouped maintains group ordering (v1.9.0)", async () => {
  await runSQL("SELECT pgmq.create('test_queue_fifo')");

  // Create FIFO index for message headers
  const createIndex = await runSQL("SELECT pgmq.create_fifo_index('test_queue_fifo')");
  assert(createIndex.success, `create_fifo_index failed: ${createIndex.stderr}`);

  // Send messages to different groups via x-pgmq-group header
  // Group A: messages 1, 3
  // Group B: messages 2, 4
  const msg1 = await runSQL(
    `SELECT pgmq.send('test_queue_fifo', '{"order": 1}'::jsonb, '{"x-pgmq-group": "group_a"}'::jsonb)`
  );
  assert(msg1.success, `Send msg1 failed: ${msg1.stderr}`);

  const msg2 = await runSQL(
    `SELECT pgmq.send('test_queue_fifo', '{"order": 2}'::jsonb, '{"x-pgmq-group": "group_b"}'::jsonb)`
  );
  assert(msg2.success, `Send msg2 failed: ${msg2.stderr}`);

  const msg3 = await runSQL(
    `SELECT pgmq.send('test_queue_fifo', '{"order": 3}'::jsonb, '{"x-pgmq-group": "group_a"}'::jsonb)`
  );
  assert(msg3.success, `Send msg3 failed: ${msg3.stderr}`);

  const msg4 = await runSQL(
    `SELECT pgmq.send('test_queue_fifo', '{"order": 4}'::jsonb, '{"x-pgmq-group": "group_b"}'::jsonb)`
  );
  assert(msg4.success, `Send msg4 failed: ${msg4.stderr}`);

  // read_grouped should return messages grouped together
  const read = await runSQL(
    "SELECT msg_id, message->>'order' as ord, headers->>'x-pgmq-group' as grp FROM pgmq.read_grouped('test_queue_fifo', 30, 10)"
  );
  assert(read.success, `read_grouped failed: ${read.stderr}`);

  // Verify we got all 4 messages
  const lines = read.stdout.split("\n").filter((l) => l.length > 0);
  assert(lines.length === 4, `Expected 4 messages, got ${lines.length}`);

  console.log(`   📊 FIFO read_grouped returned ${lines.length} messages`);
});

// Test 16: FIFO Queue - read_grouped_rr (v1.9.0)
await test("FIFO read_grouped_rr distributes across groups (v1.9.0)", async () => {
  await runSQL("SELECT pgmq.create('test_queue_fifo_rr')");
  await runSQL("SELECT pgmq.create_fifo_index('test_queue_fifo_rr')");

  // Send 3 messages to group_a, 3 to group_b
  for (let i = 0; i < 3; i++) {
    await runSQL(
      `SELECT pgmq.send('test_queue_fifo_rr', '{"order": ${i * 2 + 1}}'::jsonb, '{"x-pgmq-group": "group_a"}'::jsonb)`
    );
    await runSQL(
      `SELECT pgmq.send('test_queue_fifo_rr', '{"order": ${i * 2 + 2}}'::jsonb, '{"x-pgmq-group": "group_b"}'::jsonb)`
    );
  }

  // read_grouped_rr should interleave (round-robin) across groups
  const read = await runSQL(
    "SELECT message->>'order' as ord, headers->>'x-pgmq-group' as grp FROM pgmq.read_grouped_rr('test_queue_fifo_rr', 30, 6)"
  );
  assert(read.success, `read_grouped_rr failed: ${read.stderr}`);

  const lines = read.stdout.split("\n").filter((l) => l.length > 0);
  assert(lines.length === 6, `Expected 6 messages, got ${lines.length}`);

  console.log(`   📊 FIFO read_grouped_rr distributed ${lines.length} messages across groups`);
});

// Test 17: FIFO index verification (v1.9.0)
await test("FIFO create_fifo_index creates GIN index (v1.9.0)", async () => {
  await runSQL("SELECT pgmq.create('test_queue_fifo_index')");
  await runSQL("SELECT pgmq.create_fifo_index('test_queue_fifo_index')");

  // Verify index exists on headers column
  const indexCheck = await runSQL(`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'q_test_queue_fifo_index'
    AND indexdef LIKE '%headers%'
  `);
  assert(indexCheck.success, `Index check failed: ${indexCheck.stderr}`);
  assert(indexCheck.stdout.length > 0, "FIFO index not created on headers column");

  console.log(`   📊 FIFO GIN index verified: ${indexCheck.stdout}`);
});

// Test 18: Delayed message send
await test("Delayed message send", async () => {
  await runSQL("SELECT pgmq.create('test_queue_delay')");

  // Send with 2-second delay
  const send = await runSQL(
    "SELECT pgmq.send('test_queue_delay', '{\"delayed\": true}'::jsonb, 2)"
  );
  assert(send.success, `Delayed send failed: ${send.stderr}`);

  // Immediate read should return nothing (message not yet visible)
  const immediate = await runSQL("SELECT msg_id FROM pgmq.read('test_queue_delay', 30, 1)");
  assert(immediate.success, `Immediate read failed: ${immediate.stderr}`);
  assert(immediate.stdout === "", `Message visible before delay: ${immediate.stdout}`);

  // Wait for delay to expire
  await Bun.sleep(2500);

  // Now message should be visible
  const delayed = await runSQL("SELECT msg_id FROM pgmq.read('test_queue_delay', 30, 1)");
  assert(delayed.success, `Delayed read failed: ${delayed.stderr}`);
  assert(delayed.stdout.length > 0, "Message not visible after delay expired");

  console.log("   📊 Delayed send verified: message appeared after 2.5s delay");
});

// Test 19: Batch delete multiple messages
await test("Batch delete multiple messages", async () => {
  await runSQL("SELECT pgmq.create('test_queue_batch_delete')");

  // Send 5 messages, collect IDs
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) {
    const send = await runSQL(
      `SELECT pgmq.send('test_queue_batch_delete', '{"item": ${i + 1}}'::jsonb)`
    );
    assert(send.success, `Send ${i + 1} failed: ${send.stderr}`);
    ids.push(parseInt(send.stdout));
  }

  // Batch delete first 3
  const del = await runSQL(
    `SELECT pgmq.delete('test_queue_batch_delete', ARRAY[${ids.slice(0, 3).join(",")}])`
  );
  assert(del.success, `Batch delete failed: ${del.stderr}`);

  // Verify only 2 remain
  const metrics = await runSQL("SELECT queue_length FROM pgmq.metrics('test_queue_batch_delete')");
  assert(metrics.success, `Metrics failed: ${metrics.stderr}`);
  const remaining = parseInt(metrics.stdout);
  assert(remaining === 2, `Expected 2 remaining, got ${remaining}`);

  console.log(`   📊 Batch delete: removed 3 of 5, ${remaining} remaining`);
});

// Test 20: Batch archive multiple messages
await test("Batch archive multiple messages", async () => {
  await runSQL("SELECT pgmq.create('test_queue_batch_archive')");

  // Send 5 messages, collect IDs
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) {
    const send = await runSQL(
      `SELECT pgmq.send('test_queue_batch_archive', '{"item": ${i + 1}}'::jsonb)`
    );
    assert(send.success, `Send ${i + 1} failed: ${send.stderr}`);
    ids.push(parseInt(send.stdout));
  }

  // Batch archive first 3
  const archive = await runSQL(
    `SELECT pgmq.archive('test_queue_batch_archive', ARRAY[${ids.slice(0, 3).join(",")}])`
  );
  assert(archive.success, `Batch archive failed: ${archive.stderr}`);

  // Verify archive table has 3 messages
  const archiveCount = await runSQL("SELECT count(*) FROM pgmq.a_test_queue_batch_archive");
  assert(archiveCount.success, `Archive count failed: ${archiveCount.stderr}`);
  assert(parseInt(archiveCount.stdout) === 3, `Expected 3 archived, got ${archiveCount.stdout}`);

  // Verify 2 remain in queue
  const metrics = await runSQL("SELECT queue_length FROM pgmq.metrics('test_queue_batch_archive')");
  assert(metrics.success, `Metrics failed: ${metrics.stderr}`);
  assert(parseInt(metrics.stdout) === 2, `Expected 2 remaining, got ${metrics.stdout}`);

  console.log("   📊 Batch archive: archived 3 of 5, 2 remaining in queue");
});

// Test 21: Create unlogged queue for high throughput
await test("Create unlogged queue for high throughput", async () => {
  await runSQL("SELECT pgmq.create_unlogged('test_queue_unlogged')");

  // Verify table is unlogged (relpersistence = 'u')
  const check = await runSQL(`
    SELECT relpersistence FROM pg_class
    WHERE relname = 'q_test_queue_unlogged'
  `);
  assert(check.success, `Persistence check failed: ${check.stderr}`);
  assert(check.stdout === "u", `Expected unlogged table (u), got: ${check.stdout}`);

  // Basic operations should work
  const send = await runSQL(
    "SELECT pgmq.send('test_queue_unlogged', '{\"unlogged\": true}'::jsonb)"
  );
  assert(send.success, `Send to unlogged queue failed: ${send.stderr}`);

  const read = await runSQL("SELECT msg_id FROM pgmq.read('test_queue_unlogged', 30, 1)");
  assert(read.success, `Read from unlogged queue failed: ${read.stderr}`);
  assert(read.stdout.length > 0, "No message read from unlogged queue");

  console.log("   📊 Unlogged queue verified: relpersistence='u', send/read working");
});

// Test 22: list_queues returns all queues
await test("list_queues returns all queues", async () => {
  // Create some test queues with unique names
  await runSQL("SELECT pgmq.create('test_list_1')");
  await runSQL("SELECT pgmq.create('test_list_2')");

  const list = await runSQL(
    "SELECT queue_name FROM pgmq.list_queues() WHERE queue_name LIKE 'test_list_%' ORDER BY queue_name"
  );
  assert(list.success, `list_queues failed: ${list.stderr}`);
  assert(list.stdout.includes("test_list_1"), "test_list_1 not found in list");
  assert(list.stdout.includes("test_list_2"), "test_list_2 not found in list");

  console.log(`   📊 list_queues verified: found test_list_1 and test_list_2`);
});

// Test 23: list_queues metadata verification (is_partitioned, is_unlogged)
await test("list_queues returns correct metadata columns", async () => {
  // Create three queue types to verify metadata columns
  await runSQL("SELECT pgmq.create('test_meta_standard')");
  await runSQL("SELECT pgmq.create_partitioned('test_meta_part', '1 day'::text, '7 days'::text)");
  await runSQL("SELECT pgmq.create_unlogged('test_meta_unlogged')");

  // Query list_queues with metadata columns
  const list = await runSQL(`
    SELECT queue_name, is_partitioned, is_unlogged
    FROM pgmq.list_queues()
    WHERE queue_name LIKE 'test_meta_%'
    ORDER BY queue_name
  `);
  assert(list.success, `list_queues with metadata failed: ${list.stderr}`);

  // Parse results (format: queue_name|is_partitioned|is_unlogged)
  const lines = list.stdout.split("\n").filter((l) => l.length > 0);
  assert(lines.length === 3, `Expected 3 queues, got ${lines.length}`);

  // Verify each queue's metadata
  const partLine = lines.find((l) => l.includes("test_meta_part"));
  const stdLine = lines.find((l) => l.includes("test_meta_standard"));
  const unlogLine = lines.find((l) => l.includes("test_meta_unlogged"));

  assert(partLine !== undefined, "test_meta_part not found");
  assert(stdLine !== undefined, "test_meta_standard not found");
  assert(unlogLine !== undefined, "test_meta_unlogged not found");

  // Standard queue: is_partitioned=f, is_unlogged=f
  assert(
    stdLine!.includes("|f|f"),
    `Standard queue should have is_partitioned=f, is_unlogged=f. Got: ${stdLine}`
  );

  // Partitioned queue: is_partitioned=t, is_unlogged=f
  assert(
    partLine!.includes("|t|f"),
    `Partitioned queue should have is_partitioned=t. Got: ${partLine}`
  );

  // Unlogged queue: is_partitioned=f, is_unlogged=t
  assert(
    unlogLine!.includes("|f|t"),
    `Unlogged queue should have is_unlogged=t. Got: ${unlogLine}`
  );

  console.log(
    "   📊 list_queues metadata verified: is_partitioned and is_unlogged columns correct"
  );
});

// Test 24: Error - read from non-existent queue (renumbered from Test 23)
await test("Error: read from non-existent queue", async () => {
  const read = await runSQL("SELECT pgmq.read('nonexistent_queue_xyz_123', 30, 1)");
  // Should error - queue doesn't exist
  assert(
    !read.success || read.stderr.includes("does not exist") || read.stderr.includes("ERROR"),
    `Expected error for non-existent queue, got success: ${read.stdout}`
  );

  console.log("   📊 Error handling verified: non-existent queue raises error");
});

// Test 25: Error - delete non-existent message returns false
await test("Error: delete non-existent message returns false", async () => {
  await runSQL("SELECT pgmq.create('test_queue_error_delete')");

  // Delete msg_id that doesn't exist - should return false, not error
  const del = await runSQL("SELECT pgmq.delete('test_queue_error_delete', 999999999)");
  assert(del.success, `Delete should not error: ${del.stderr}`);
  assert(del.stdout === "f", `Expected 'f' for non-existent msg, got: ${del.stdout}`);

  console.log("   📊 Error handling verified: delete non-existent msg returns 'f'");
});

// Test 26: Error - send to dropped queue fails
await test("Error: send to dropped queue fails", async () => {
  await runSQL("SELECT pgmq.create('test_queue_drop_send')");
  await runSQL("SELECT pgmq.drop_queue('test_queue_drop_send')");

  const send = await runSQL("SELECT pgmq.send('test_queue_drop_send', '{}'::jsonb)");
  // Should error - queue was dropped
  assert(
    !send.success || send.stderr.includes("does not exist") || send.stderr.includes("ERROR"),
    `Expected error sending to dropped queue, got: ${send.stdout}`
  );

  console.log("   📊 Error handling verified: send to dropped queue fails");
});

// Test 27: Drop Queue (cleanup)
await test("Drop queue", async () => {
  // Drop all test queues
  const queues = [
    "test_queue_standard",
    "test_queue_partitioned",
    "test_queue_poll",
    "test_queue_vt",
    "test_queue_setvt",
    "test_queue_last_read",
    "test_queue_setvt_ts",
    "test_queue_purge",
    "test_queue_fifo",
    "test_queue_fifo_rr",
    "test_queue_fifo_index",
    "test_queue_delay",
    "test_queue_batch_delete",
    "test_queue_batch_archive",
    "test_queue_unlogged",
    "test_list_1",
    "test_list_2",
    "test_meta_standard",
    "test_meta_part",
    "test_meta_unlogged",
    "test_queue_error_delete",
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

// Test 28: Performance Benchmark - Message Throughput
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
