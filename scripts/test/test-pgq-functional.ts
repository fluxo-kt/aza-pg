#!/usr/bin/env bun
/**
 * Comprehensive pgq functional test suite
 * Tests complete producer->consumer->batch workflow with monitoring and retry logic
 *
 * Coverage:
 * - Queue management (create, configure, monitor)
 * - Producer operations (insert events with various data types)
 * - Consumer operations (register, batch processing, completion)
 * - Retry logic (event retry, batch retry)
 * - Monitoring (queue info, consumer info, batch info)
 * - Performance metrics (throughput, latency)
 *
 * Usage: bun run scripts/test/test-pgq-functional.ts [--container=pgq-research]
 */

import { $ } from "bun";

const CONTAINER =
  Bun.argv.find((arg) => arg.startsWith("--container="))?.split("=")[1] || "pgq-research";

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

// Test 1: Queue Creation and Configuration
await test("Queue creation and configuration", async () => {
  // Create queue
  const create = await runSQL("SELECT pgq.create_queue('test_queue_functional')");
  assert(create.success && create.stdout === "1", "Queue creation failed");

  // Verify queue exists in get_queue_info
  const info = await runSQL("SELECT queue_name FROM pgq.get_queue_info('test_queue_functional')");
  assert(
    info.success && info.stdout === "test_queue_functional",
    "Queue not found in get_queue_info"
  );

  // Configure queue for testing (lower thresholds so ticker creates ticks with few events)
  await runSQL("SELECT pgq.set_queue_config('test_queue_functional', 'ticker_max_count', '10')");
  await runSQL("SELECT pgq.set_queue_config('test_queue_functional', 'ticker_max_lag', '0')");

  // Verify configuration
  const verifyConfig = await runSQL(
    "SELECT queue_ticker_max_count FROM pgq.get_queue_info('test_queue_functional')"
  );
  assert(
    verifyConfig.success && verifyConfig.stdout === "10",
    "Queue configuration verification failed"
  );
});

// Test 2: Producer Operations - Insert Events
await test("Producer operations - insert events", async () => {
  // Insert simple event
  const event1 = await runSQL(
    "SELECT pgq.insert_event('test_queue_functional', 'user.created', '{\"user_id\": 1, \"email\": \"test@example.com\"}')"
  );
  assert(event1.success && parseInt(event1.stdout) > 0, "Simple event insertion failed");

  // Insert event with extra fields
  const event2 = await runSQL(
    "SELECT pgq.insert_event('test_queue_functional', 'user.updated', '{\"user_id\": 1}', 'extra1', 'extra2', 'extra3', 'extra4')"
  );
  assert(event2.success && parseInt(event2.stdout) > 0, "Event with extra fields insertion failed");

  // Insert multiple events for batch processing
  for (let i = 0; i < 10; i++) {
    const eventN = await runSQL(
      `SELECT pgq.insert_event('test_queue_functional', 'order.created', '{"order_id": ${i + 1}}')`
    );
    assert(eventN.success, `Batch event ${i + 1} insertion failed`);
  }
});

// Test 3: Consumer Registration (before ticker so consumer can see events)
await test("Consumer registration", async () => {
  // Register consumer BEFORE calling ticker so it can see the events
  const register = await runSQL(
    "SELECT pgq.register_consumer('test_queue_functional', 'test_consumer')"
  );
  assert(register.success && register.stdout === "1", "Consumer registration failed");

  // Verify consumer exists
  const consumerInfo = await runSQL(
    "SELECT consumer_name FROM pgq.get_consumer_info('test_queue_functional', 'test_consumer')"
  );
  assert(
    consumerInfo.success && consumerInfo.stdout === "test_consumer",
    "Consumer not found in get_consumer_info"
  );
});

// Test 4: Ticker - Create Tick to Make Events Available
await test("Ticker - create tick for event processing", async () => {
  // Now that consumer is registered, create tick to make events available to it
  // Ticker returns tick_id or 0/empty if no tick needed (depends on time/event thresholds)
  const tick = await runSQL("SELECT pgq.ticker('test_queue_functional')");
  assert(tick.success, `Ticker execution failed: ${tick.stderr}`);

  // Verify tick was recorded (queue should have at least one tick now)
  const tickCheck = await runSQL(
    "SELECT count(*) > 0 FROM pgq.get_queue_info('test_queue_functional') WHERE last_tick_id > 0"
  );
  assert(tickCheck.success && tickCheck.stdout === "t", "No ticks recorded for queue");
});

// Test 5: Batch Processing - Get Next Batch
await test("Batch processing - get next batch", async () => {
  // Get batch (ticker was called in previous test after consumer registration)
  const batch = await runSQL("SELECT pgq.next_batch('test_queue_functional', 'test_consumer')");
  assert(batch.success, `Getting next batch command failed: ${batch.stderr}`);

  const batchId = parseInt(batch.stdout);
  assert(batchId > 0, `No batch available: next_batch returned ${batch.stdout}`);

  // Get batch info
  const batchInfo = await runSQL(
    `SELECT batch_start IS NOT NULL FROM pgq.get_batch_info(${batchId})`
  );
  assert(batchInfo.success && batchInfo.stdout === "t", "Batch info retrieval failed");

  // Get batch events
  const events = await runSQL(`SELECT count(*) FROM pgq.get_batch_events(${batchId})`);
  assert(
    events.success && parseInt(events.stdout) >= 12,
    `Expected at least 12 events, got ${events.stdout}`
  );

  // Process events (simulate work)
  const eventDetails = await runSQL(
    `SELECT ev_type, ev_data FROM pgq.get_batch_events(${batchId}) ORDER BY ev_id LIMIT 3`
  );
  assert(eventDetails.success, "Getting event details failed");

  // Finish batch
  const finish = await runSQL(`SELECT pgq.finish_batch(${batchId})`);
  assert(finish.success && finish.stdout === "1", "Finishing batch failed");
});

// Test 6: Event Retry Logic
await test("Event retry logic", async () => {
  // Insert event for retry testing
  const event = await runSQL(
    "SELECT pgq.insert_event('test_queue_functional', 'order.failed', '{\"order_id\": 999}')"
  );
  assert(event.success, "Event insertion for retry failed");

  // Create tick
  await runSQL("SELECT pgq.ticker('test_queue_functional')");

  // Get batch
  const batch = await runSQL("SELECT pgq.next_batch('test_queue_functional', 'test_consumer')");
  assert(batch.success, `Getting batch command failed: ${batch.stderr}`);

  const batchId = parseInt(batch.stdout);
  assert(batchId > 0, `No batch available for retry test: ${batch.stdout}`);

  // Get an event ID
  const eventId = await runSQL(
    `SELECT ev_id FROM pgq.get_batch_events(${batchId}) WHERE ev_type = 'order.failed' LIMIT 1`
  );
  assert(eventId.success && Boolean(eventId.stdout), "Getting event ID for retry failed");

  // Retry event (5 seconds from now)
  const retry = await runSQL(`SELECT pgq.event_retry(${batchId}, ${eventId.stdout}, 5)`);
  assert(retry.success && retry.stdout === "1", "Event retry failed");

  // Finish batch
  await runSQL(`SELECT pgq.finish_batch(${batchId})`);
});

// Test 7: Batch Retry Logic
await test("Batch retry logic", async () => {
  // Insert events
  for (let i = 0; i < 3; i++) {
    await runSQL(
      `SELECT pgq.insert_event('test_queue_functional', 'bulk.retry', '{"item": ${i + 1}}')`
    );
  }

  // Create tick
  await runSQL("SELECT pgq.ticker('test_queue_functional')");

  // Get batch
  const batch = await runSQL("SELECT pgq.next_batch('test_queue_functional', 'test_consumer')");
  assert(batch.success, `Getting batch command failed: ${batch.stderr}`);

  const batchId = parseInt(batch.stdout);
  assert(batchId > 0, `No batch available for batch retry test: ${batch.stdout}`);

  // Retry entire batch (10 seconds from now)
  const retry = await runSQL(`SELECT pgq.batch_retry(${batchId}, 10)`);
  assert(
    retry.success && parseInt(retry.stdout) >= 3,
    `Expected at least 3 events retried, got ${retry.stdout}`
  );
});

// Test 8: Queue Monitoring
await test("Queue monitoring", async () => {
  // Get queue info
  const queueInfo = await runSQL(
    "SELECT queue_name, queue_ntables, queue_cur_table, ev_per_sec FROM pgq.get_queue_info('test_queue_functional')"
  );
  assert(
    queueInfo.success && queueInfo.stdout.includes("test_queue_functional"),
    "Queue info retrieval failed"
  );

  // Get consumer info
  const consumerInfo = await runSQL(
    "SELECT consumer_name, lag, pending_events FROM pgq.get_consumer_info('test_queue_functional', 'test_consumer')"
  );
  assert(
    consumerInfo.success && consumerInfo.stdout.includes("test_consumer"),
    "Consumer info retrieval failed"
  );

  // Parse metrics
  const queueData = queueInfo.stdout.split("|");
  const queueName = queueData[0];
  const ntables = parseInt(queueData[1]);
  const curTable = parseInt(queueData[2]);

  assert(queueName === "test_queue_functional", "Queue name mismatch");
  assert(ntables >= 1, "Queue should have at least 1 table");
  assert(curTable >= 0, "Current table should be non-negative");
});

// Test 9: Consumer Unregistration and Queue Cleanup
await test("Consumer unregistration and cleanup", async () => {
  // Unregister consumer
  const unregister = await runSQL(
    "SELECT pgq.unregister_consumer('test_queue_functional', 'test_consumer')"
  );
  assert(unregister.success && unregister.stdout === "1", "Consumer unregistration failed");

  // Verify consumer removed
  const consumerCheck = await runSQL(
    "SELECT count(*) FROM pgq.get_consumer_info('test_queue_functional', 'test_consumer')"
  );
  assert(
    consumerCheck.success && consumerCheck.stdout === "0",
    "Consumer still exists after unregistration"
  );

  // Drop queue
  const drop = await runSQL("SELECT pgq.drop_queue('test_queue_functional')");
  assert(drop.success && drop.stdout === "1", "Queue drop failed");

  // Verify queue removed
  const queueCheck = await runSQL(
    "SELECT count(*) FROM pgq.get_queue_info('test_queue_functional')"
  );
  assert(queueCheck.success && queueCheck.stdout === "0", "Queue still exists after drop");
});

// Test 10: Performance Benchmarks
await test("Performance benchmark - event throughput", async () => {
  // Create benchmark queue
  await runSQL("SELECT pgq.create_queue('benchmark_queue')");

  // Configure for testing
  await runSQL("SELECT pgq.set_queue_config('benchmark_queue', 'ticker_max_count', '10')");
  await runSQL("SELECT pgq.set_queue_config('benchmark_queue', 'ticker_max_lag', '0')");

  const eventCount = 100;
  const start = Date.now();

  // Insert events
  for (let i = 0; i < eventCount; i++) {
    await runSQL(`SELECT pgq.insert_event('benchmark_queue', 'perf.test', '{"id": ${i + 1}}')`);
  }

  const insertDuration = Date.now() - start;
  const throughput = (eventCount / insertDuration) * 1000; // events per second

  console.log(
    `   📊 Throughput: ${throughput.toFixed(2)} events/sec (${eventCount} events in ${insertDuration}ms)`
  );

  // Cleanup
  await runSQL("SELECT pgq.drop_queue('benchmark_queue')");

  results[results.length - 1].metrics = {
    eventCount,
    insertDuration,
    throughput: throughput.toFixed(2),
  };

  assert(throughput > 10, `Throughput too low: ${throughput.toFixed(2)} events/sec`);
});

// Test 11: Concurrent Consumer Processing
await test("Concurrent consumer processing", async () => {
  // Create queue
  await runSQL("SELECT pgq.create_queue('concurrent_queue')");

  // Configure for testing
  await runSQL("SELECT pgq.set_queue_config('concurrent_queue', 'ticker_max_count', '10')");
  await runSQL("SELECT pgq.set_queue_config('concurrent_queue', 'ticker_max_lag', '0')");

  // Insert events
  for (let i = 0; i < 20; i++) {
    await runSQL(
      `SELECT pgq.insert_event('concurrent_queue', 'concurrent.test', '{"id": ${i + 1}}')`
    );
  }

  // Create tick
  await runSQL("SELECT pgq.ticker('concurrent_queue')");

  // Register two consumers
  await runSQL("SELECT pgq.register_consumer('concurrent_queue', 'consumer_1')");
  await runSQL("SELECT pgq.register_consumer('concurrent_queue', 'consumer_2')");

  // Get batches for both consumers
  const batch1 = await runSQL("SELECT pgq.next_batch('concurrent_queue', 'consumer_1')");
  const batch2 = await runSQL("SELECT pgq.next_batch('concurrent_queue', 'consumer_2')");

  assert(batch1.success, `Consumer 1 batch command failed: ${batch1.stderr}`);
  assert(batch2.success, `Consumer 2 batch command failed: ${batch2.stderr}`);

  const batch1Id = parseInt(batch1.stdout);
  const batch2Id = parseInt(batch2.stdout);

  assert(batch1Id > 0, `Consumer 1: No batch available: ${batch1.stdout}`);
  assert(batch2Id > 0, `Consumer 2: No batch available: ${batch2.stdout}`);

  // Verify same events in both batches (each consumer gets same events)
  const count1 = await runSQL(`SELECT count(*) FROM pgq.get_batch_events(${batch1Id})`);
  const count2 = await runSQL(`SELECT count(*) FROM pgq.get_batch_events(${batch2Id})`);

  assert(
    count1.stdout === count2.stdout,
    `Event counts don't match: ${count1.stdout} vs ${count2.stdout}`
  );
  assert(parseInt(count1.stdout) >= 20, `Expected at least 20 events, got ${count1.stdout}`);

  // Finish batches
  await runSQL(`SELECT pgq.finish_batch(${batch1Id})`);
  await runSQL(`SELECT pgq.finish_batch(${batch2Id})`);

  // Cleanup
  await runSQL("SELECT pgq.unregister_consumer('concurrent_queue', 'consumer_1')");
  await runSQL("SELECT pgq.unregister_consumer('concurrent_queue', 'consumer_2')");
  await runSQL("SELECT pgq.drop_queue('concurrent_queue')");
});

// Print Summary
console.log("\n" + "=".repeat(80));
console.log("PGQ FUNCTIONAL TEST SUMMARY");
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

process.exit(failed > 0 ? 1 : 0);
