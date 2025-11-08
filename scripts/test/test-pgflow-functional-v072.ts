#!/usr/bin/env bun
/**
 * PGFlow v0.7.2 Functional Test Suite
 *
 * Tests workflow orchestration against actual v0.7.2 API:
 * - flow_slug (text) primary keys, not integer IDs
 * - Simple retry/timeout integers, no JSON configs
 * - Two-phase polling: read_with_poll() then start_tasks()
 * - Status: 'created' → 'started' → 'completed'/'failed'
 *
 * Usage: bun run scripts/test/test-pgflow-functional-v072.ts
 */

import { randomUUID } from "crypto";

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
}

const results: TestResult[] = [];

async function runSQL(sql: string): Promise<{ stdout: string; stderr: string; success: boolean }> {
  try {
    // Use stdin to avoid shell escaping hell
    const proc = Bun.spawn(
      ["docker", "exec", "-i", "primary-postgres-primary", "su", "postgres", "-c", "psql -t -A"],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
    );
    proc.stdin.write(sql);
    proc.stdin.end();
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { stdout: stdout.trim(), stderr: stderr.trim(), success: exitCode === 0 };
  } catch (error) {
    return { stdout: "", stderr: String(error), success: false };
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

console.log("================================================================================");
console.log("PGFLOW v0.7.2 FUNCTIONAL TESTS");
console.log("================================================================================\n");

// ============================================================================
// TEST 1: Schema Verification
// ============================================================================

await test("Schema verification", async () => {
  const schema = await runSQL("SELECT count(*) FROM pg_namespace WHERE nspname = 'pgflow'");
  assert(schema.success && schema.stdout === "1", "pgflow schema not found");

  const tables = await runSQL(`
    SELECT count(*) FROM information_schema.tables
    WHERE table_schema = 'pgflow'
    AND table_name IN ('flows', 'steps', 'deps', 'runs', 'step_states', 'step_tasks', 'workers')
  `);
  assert(
    tables.success && parseInt(tables.stdout) === 7,
    `Expected 7 tables, found ${tables.stdout}`
  );

  const functions = await runSQL(`
    SELECT count(*) FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'pgflow'
    AND p.proname IN ('create_flow', 'add_step', 'start_flow', 'start_ready_steps', 'start_tasks', 'complete_task', 'fail_task')
  `);
  assert(
    functions.success && parseInt(functions.stdout) >= 7,
    `Expected at least 7 functions, found ${functions.stdout}`
  );
});

// ============================================================================
// TEST 2: Create Flow (v0.7.2 API: flow_slug as PK, no JSON config)
// ============================================================================

const FLOW_SLUG = `test_flow_${Date.now()}`;

await test("Create flow with slug (v0.7.2 API)", async () => {
  // create_flow(flow_slug text, max_attempts int, base_delay int, timeout int)
  const create = await runSQL(`
    SELECT pgflow.create_flow(
      '${FLOW_SLUG}',
      3,
      5,
      60
    )
  `);
  assert(create.success, `Failed to create flow: ${create.stderr}`);

  // Verify flow exists using flow_slug (not id)
  const verify = await runSQL(`SELECT count(*) FROM pgflow.flows WHERE flow_slug = '${FLOW_SLUG}'`);
  assert(verify.success && verify.stdout === "1", "Flow not found in flows table");
});

// ============================================================================
// TEST 3: Add Steps with Dependencies
// ============================================================================

await test("Add steps with dependencies (v0.7.2 API)", async () => {
  // add_step(flow_slug, step_slug, deps_slugs[], max_attempts, base_delay, timeout)
  // Step 1: extract (no dependencies)
  const step1 = await runSQL(`
    SELECT pgflow.add_step(
      '${FLOW_SLUG}',
      'extract',
      ARRAY[]::text[],
      3,
      5,
      30
    )
  `);
  assert(step1.success, `Failed to add step 'extract': ${step1.stderr}`);

  // Step 2: transform (depends on extract)
  const step2 = await runSQL(`
    SELECT pgflow.add_step(
      '${FLOW_SLUG}',
      'transform',
      ARRAY['extract']::text[],
      3,
      5,
      30
    )
  `);
  assert(step2.success, `Failed to add step 'transform': ${step2.stderr}`);

  // Step 3: validate (depends on transform)
  const step3 = await runSQL(`
    SELECT pgflow.add_step(
      '${FLOW_SLUG}',
      'validate',
      ARRAY['transform']::text[],
      3,
      5,
      30
    )
  `);
  assert(step3.success, `Failed to add step 'validate': ${step3.stderr}`);

  // Verify steps
  const stepCount = await runSQL(
    `SELECT count(*) FROM pgflow.steps WHERE flow_slug = '${FLOW_SLUG}'`
  );
  assert(
    stepCount.success && stepCount.stdout === "3",
    `Expected 3 steps, found ${stepCount.stdout}`
  );

  // Verify dependencies
  const depsCount = await runSQL(
    `SELECT count(*) FROM pgflow.deps WHERE flow_slug = '${FLOW_SLUG}'`
  );
  assert(
    depsCount.success && depsCount.stdout === "2",
    `Expected 2 dependencies, found ${depsCount.stdout}`
  );
});

// ============================================================================
// TEST 4: Start Flow and Verify Run State
// ============================================================================

let RUN_ID: string = "";

await test("Start flow execution (v0.7.2 API)", async () => {
  // start_flow(flow_slug text, input jsonb) RETURNS runs
  const start = await runSQL(`
    SELECT run_id FROM pgflow.start_flow(
      '${FLOW_SLUG}',
      '{"test_data": 123}'::jsonb
    )
  `);
  assert(start.success, `Failed to start flow: ${start.stderr}`);

  RUN_ID = start.stdout;
  assert(RUN_ID.length > 0, "No run_id returned from start_flow");

  // Verify run exists
  const runCheck = await runSQL(`SELECT status FROM pgflow.runs WHERE run_id = '${RUN_ID}'`);
  assert(
    runCheck.success && runCheck.stdout === "started",
    `Expected status 'started', got '${runCheck.stdout}'`
  );

  // Verify step_states created (status should be 'created', not 'ready')
  const statesCount = await runSQL(
    `SELECT count(*) FROM pgflow.step_states WHERE run_id = '${RUN_ID}'`
  );
  assert(
    statesCount.success && parseInt(statesCount.stdout) === 3,
    `Expected 3 step_states, found ${statesCount.stdout}`
  );

  // Verify first step is ready (status='created', remaining_deps=0)
  const readySteps = await runSQL(`
    SELECT count(*) FROM pgflow.step_states
    WHERE run_id = '${RUN_ID}' AND status = 'created' AND remaining_deps = 0
  `);
  assert(
    readySteps.success && readySteps.stdout === "1",
    `Expected 1 ready step, found ${readySteps.stdout}`
  );
});

// ============================================================================
// TEST 5: Poll and Start Tasks (v0.7.2 Two-Phase Polling)
// ============================================================================

let TASK_MSG_ID: string = "";
const WORKER_ID = randomUUID();

await test("Poll for tasks (v0.7.2 two-phase API)", async () => {
  // Register worker BEFORE calling start_tasks (required in v0.7.2)
  const registerWorker = await runSQL(`
    INSERT INTO pgflow.workers (worker_id, queue_name, function_name)
    VALUES ('${WORKER_ID}'::uuid, '${FLOW_SLUG}', 'test_handler')
  `);
  assert(registerWorker.success, `Failed to register worker: ${registerWorker.stderr}`);

  // Phase 1: read_with_poll to get message IDs from queue
  const poll = await runSQL(`
    SELECT msg_id FROM pgflow.read_with_poll(
      '${FLOW_SLUG}',
      30,
      1,
      5,
      100
    )
  `);
  assert(poll.success, `Failed to poll for messages: ${poll.stderr}`);

  const lines = poll.stdout.split("\n").filter((l) => l.trim());
  assert(lines.length > 0, "No messages available from read_with_poll");

  TASK_MSG_ID = lines[0];

  // Phase 2: start_tasks with worker_id to claim the task
  const startTask = await runSQL(`
    SELECT flow_slug, run_id, step_slug, input, msg_id
    FROM pgflow.start_tasks(
      '${FLOW_SLUG}',
      ARRAY[${TASK_MSG_ID}]::bigint[],
      '${WORKER_ID}'::uuid
    )
  `);
  assert(startTask.success, `Failed to start_tasks: ${startTask.stderr}`);

  const taskData = startTask.stdout.split("|");
  assert(taskData.length >= 3, `Invalid task data: ${startTask.stdout}`);
  assert(taskData[0] === FLOW_SLUG, `Expected flow_slug '${FLOW_SLUG}', got '${taskData[0]}'`);
  assert(taskData[2] === "extract", `Expected step_slug 'extract', got '${taskData[2]}'`);

  // Verify task status changed to 'started' (v0.7.2: queued → started)
  const taskStatus = await runSQL(`
    SELECT status FROM pgflow.step_tasks
    WHERE run_id = '${RUN_ID}' AND step_slug = 'extract'
  `);
  assert(
    taskStatus.success && taskStatus.stdout === "started",
    `Expected status 'started', got '${taskStatus.stdout}'`
  );
});

// ============================================================================
// TEST 6: Complete Task
// ============================================================================

await test("Complete task (v0.7.2 API)", async () => {
  // complete_task(run_id uuid, step_slug text, task_index int, output jsonb)
  const complete = await runSQL(`
    SELECT pgflow.complete_task(
      '${RUN_ID}'::uuid,
      'extract',
      0,
      '{"records": 100, "status": "ok"}'::jsonb
    )
  `);
  assert(complete.success, `Failed to complete task: ${complete.stderr}`);

  // Verify step_state changed to 'completed'
  const stepState = await runSQL(`
    SELECT status FROM pgflow.step_states
    WHERE run_id = '${RUN_ID}' AND step_slug = 'extract'
  `);
  assert(
    stepState.success && stepState.stdout === "completed",
    `Expected 'completed', got '${stepState.stdout}'`
  );

  // Verify task marked as completed
  const taskState = await runSQL(`
    SELECT status FROM pgflow.step_tasks
    WHERE run_id = '${RUN_ID}' AND step_slug = 'extract'
  `);
  assert(
    taskState.success && taskState.stdout === "completed",
    `Expected task 'completed', got '${taskState.stdout}'`
  );
});

// ============================================================================
// TEST 7: Dependency Chain Execution
// ============================================================================

await test("Execute dependent steps", async () => {
  // Next step (transform) should now be ready
  const readySteps = await runSQL(`
    SELECT count(*) FROM pgflow.step_states
    WHERE run_id = '${RUN_ID}' AND status = 'created' AND remaining_deps = 0
  `);
  assert(
    readySteps.success && parseInt(readySteps.stdout) >= 1,
    `Expected at least 1 ready step, found ${readySteps.stdout}`
  );

  // Poll and complete transform step
  const poll2 = await runSQL(`
    SELECT msg_id FROM pgflow.read_with_poll('${FLOW_SLUG}', 30, 1, 5, 100)
  `);

  if (poll2.success && poll2.stdout) {
    const msgId = poll2.stdout.split("\n")[0];
    const startTask = await runSQL(`
      SELECT step_slug FROM pgflow.start_tasks('${FLOW_SLUG}', ARRAY[${msgId}]::bigint[], '${WORKER_ID}'::uuid)
    `);

    if (startTask.success && startTask.stdout.includes("transform")) {
      await runSQL(`
        SELECT pgflow.complete_task('${RUN_ID}'::uuid, 'transform', 0, '{"processed": true}'::jsonb)
      `);
    }
  }

  // Poll and complete validate step
  const poll3 = await runSQL(`
    SELECT msg_id FROM pgflow.read_with_poll('${FLOW_SLUG}', 30, 1, 5, 100)
  `);

  if (poll3.success && poll3.stdout) {
    const msgId = poll3.stdout.split("\n")[0];
    const startTask = await runSQL(`
      SELECT step_slug FROM pgflow.start_tasks('${FLOW_SLUG}', ARRAY[${msgId}]::bigint[], '${WORKER_ID}'::uuid)
    `);

    if (startTask.success && startTask.stdout.includes("validate")) {
      await runSQL(`
        SELECT pgflow.complete_task('${RUN_ID}'::uuid, 'validate', 0, '{"valid": true}'::jsonb)
      `);
    }
  }

  // Verify all steps completed
  const completedCount = await runSQL(`
    SELECT count(*) FROM pgflow.step_states
    WHERE run_id = '${RUN_ID}' AND status = 'completed'
  `);
  assert(
    completedCount.success && parseInt(completedCount.stdout) === 3,
    `Expected 3 completed steps, found ${completedCount.stdout}`
  );

  // Verify run completed
  const runStatus = await runSQL(`SELECT status FROM pgflow.runs WHERE run_id = '${RUN_ID}'`);
  assert(
    runStatus.success && runStatus.stdout === "completed",
    `Expected run 'completed', got '${runStatus.stdout}'`
  );
});

// ============================================================================
// TEST 8: Task Failure and Retry
// ============================================================================

await test("Task failure handling (v0.7.2 API)", async () => {
  // Create new flow for failure test
  const failFlowSlug = `test_fail_${Date.now()}`;
  const failWorkerId = randomUUID();

  await runSQL(`SELECT pgflow.create_flow('${failFlowSlug}', 2, 5, 30)`);
  await runSQL(
    `SELECT pgflow.add_step('${failFlowSlug}', 'failing_step', ARRAY[]::text[], 2, 5, 30)`
  );

  const failRun = await runSQL(
    `SELECT run_id FROM pgflow.start_flow('${failFlowSlug}', '{}'::jsonb)`
  );
  const failRunId = failRun.stdout;

  // Register worker for failure test
  await runSQL(`
    INSERT INTO pgflow.workers (worker_id, queue_name, function_name)
    VALUES ('${failWorkerId}'::uuid, '${failFlowSlug}', 'fail_test_handler')
  `);

  // Poll and start the task
  const poll = await runSQL(
    `SELECT msg_id FROM pgflow.read_with_poll('${failFlowSlug}', 30, 1, 5, 100)`
  );
  if (poll.success && poll.stdout) {
    const msgId = poll.stdout.split("\n")[0];
    await runSQL(
      `SELECT pgflow.start_tasks('${failFlowSlug}', ARRAY[${msgId}]::bigint[], '${failWorkerId}'::uuid)`
    );

    // Fail the task (should retry since max_attempts=2)
    await runSQL(`
      SELECT pgflow.fail_task('${failRunId}'::uuid, 'failing_step', 0, 'Test failure')
    `);

    // Verify task is back to 'queued' for retry
    const retryStatus = await runSQL(`
      SELECT status FROM pgflow.step_tasks
      WHERE run_id = '${failRunId}' AND step_slug = 'failing_step'
    `);
    assert(
      retryStatus.success && retryStatus.stdout === "queued",
      `Expected 'queued' for retry, got '${retryStatus.stdout}'`
    );

    // Fail again (should now be failed since attempts exhausted)
    const poll2 = await runSQL(
      `SELECT msg_id FROM pgflow.read_with_poll('${failFlowSlug}', 30, 1, 5, 100)`
    );
    if (poll2.success && poll2.stdout) {
      const msgId2 = poll2.stdout.split("\n")[0];
      await runSQL(
        `SELECT pgflow.start_tasks('${failFlowSlug}', ARRAY[${msgId2}]::bigint[], '${failWorkerId}'::uuid)`
      );
      await runSQL(
        `SELECT pgflow.fail_task('${failRunId}'::uuid, 'failing_step', 0, 'Final failure')`
      );
    }

    // Verify final failure
    const finalStatus = await runSQL(`
      SELECT status FROM pgflow.step_tasks
      WHERE run_id = '${failRunId}' AND step_slug = 'failing_step'
    `);
    assert(
      finalStatus.success && finalStatus.stdout === "failed",
      `Expected 'failed', got '${finalStatus.stdout}'`
    );

    const runFailed = await runSQL(`SELECT status FROM pgflow.runs WHERE run_id = '${failRunId}'`);
    assert(
      runFailed.success && runFailed.stdout === "failed",
      `Expected run 'failed', got '${runFailed.stdout}'`
    );
  }
});

// ============================================================================
// CLEANUP
// ============================================================================

await test("Cleanup test data", async () => {
  // Clean up workers first
  await runSQL(`DELETE FROM pgflow.workers WHERE queue_name LIKE 'test_%'`);

  // Delete steps (this will CASCADE to deps due to foreign key)
  await runSQL(`DELETE FROM pgflow.steps WHERE flow_slug LIKE 'test_%'`);

  // Now delete flows
  const cleanup = await runSQL(`DELETE FROM pgflow.flows WHERE flow_slug LIKE 'test_%'`);
  assert(cleanup.success, `Cleanup failed: ${cleanup.stderr}`);

  const verify = await runSQL(`SELECT count(*) FROM pgflow.flows WHERE flow_slug LIKE 'test_%'`);
  assert(
    verify.success && verify.stdout === "0",
    `Cleanup incomplete: ${verify.stdout} flows remain`
  );
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log("\n" + "=".repeat(80));
console.log("PGFLOW v0.7.2 TEST SUMMARY");
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

console.log("\n" + "=".repeat(80));

process.exit(failed > 0 ? 1 : 0);
