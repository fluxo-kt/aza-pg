#!/usr/bin/env bun
/**
 * Comprehensive pgflow functional test suite
 * Tests complete workflow orchestration lifecycle
 *
 * Coverage:
 * - Flow creation and configuration
 * - Step definition with dependencies
 * - Flow execution and state transitions
 * - Task polling and completion
 * - Error handling and retries
 * - Concurrent workflow execution
 * - Performance metrics
 *
 * Usage:
 *   bun run scripts/test/test-pgflow-functional.ts [--container=NAME] [--database=NAME]
 *   TEST_CONTAINER=my-postgres TEST_DATABASE=mydb bun run scripts/test/test-pgflow-functional.ts
 *   bun run scripts/test/test-pgflow-functional.ts --container=aza-pg-test --database=pgflow_test
 *
 * Container Configuration:
 *   --container=NAME         Override container name (e.g., --container=pgq-research)
 *   --database=NAME          Override database name (e.g., --database=pgflow_test)
 *   TEST_CONTAINER env var   Fallback if --container not provided
 *   TEST_DATABASE env var    Fallback if --database not provided
 *   Default                  aza-pg-test (container), postgres (database)
 *
 * CI Usage Example:
 *   docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
 *     myregistry/aza-pg-ci:latest \
 *     bun run scripts/test/test-pgflow-functional.ts --container=ci-postgres
 */

import { $ } from "bun";

const containerArg = Bun.argv.find((arg) => arg.startsWith("--container="))?.split("=")[1];
const databaseArg = Bun.argv.find((arg) => arg.startsWith("--database="))?.split("=")[1];
const CONTAINER = containerArg ?? Bun.env.TEST_CONTAINER ?? "aza-pg-test";
const DATABASE = databaseArg ?? Bun.env.TEST_DATABASE ?? "postgres";

console.log(`Container: ${CONTAINER}`);
console.log(`Database: ${DATABASE}\n`);

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
    const result =
      await $`docker exec ${CONTAINER} psql -U postgres -d ${DATABASE} -t -A -c ${sql}`.nothrow();
    return {
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
      success: result.exitCode === 0,
    };
  } catch (error) {
    const errorMsg = String(error);
    // Provide helpful troubleshooting message
    if (errorMsg.includes("No such container") || errorMsg.includes("Cannot connect")) {
      return {
        stdout: "",
        stderr: `Container '${CONTAINER}' not found or not running. Use --container=NAME or TEST_CONTAINER env var to specify a different container.`,
        success: false,
      };
    }
    return {
      stdout: "",
      stderr: errorMsg,
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

// Test 1: Schema Verification
await test("Schema verification", async () => {
  // Verify schema exists
  const schema = await runSQL(
    "SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'pgflow'"
  );
  assert(schema.success && schema.stdout === "1", "pgflow schema not found");

  // Verify core tables exist
  const tables = await runSQL(
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'pgflow' AND table_name IN ('flows', 'runs', 'steps', 'deps', 'step_states', 'step_tasks', 'workers')"
  );
  assert(
    tables.success && parseInt(tables.stdout) === 7,
    `Expected 7 tables, found ${tables.stdout}`
  );

  // Verify functions exist
  const functions = await runSQL(
    "SELECT count(*) FROM information_schema.routines WHERE routine_schema = 'pgflow'"
  );
  assert(
    functions.success && parseInt(functions.stdout) >= 13,
    `Expected at least 13 functions, found ${functions.stdout}`
  );
});

// Test 2: Flow Creation
await test("Flow creation", async () => {
  // Create flow with retry configuration
  const flow = await runSQL(`
    SELECT pgflow.create_flow(
      'test_workflow',
      '{"description": "Test workflow for comprehensive testing"}',
      3,
      '10 seconds'::interval
    )
  `);
  assert(flow.success && parseInt(flow.stdout) > 0, "Flow creation failed");

  // Verify flow exists in flows table
  const flowCheck = await runSQL("SELECT count(*) FROM pgflow.flows WHERE name = 'test_workflow'");
  assert(flowCheck.success && flowCheck.stdout === "1", "Flow not found in flows table");
});

// Test 3: Step Definition with Dependencies
await test("Step definition with dependencies", async () => {
  // Get flow_id
  const flowId = await runSQL("SELECT id FROM pgflow.flows WHERE name = 'test_workflow'");
  assert(flowId.success && Boolean(flowId.stdout), "Failed to get flow_id");

  const fid = parseInt(flowId.stdout);

  // Add step 1: Data extraction (no dependencies)
  const step1 = await runSQL(`
    SELECT pgflow.add_step(
      ${fid},
      'extract_data',
      '{"task": "extract", "source": "api"}',
      NULL,
      3,
      '5 seconds'::interval
    )
  `);
  assert(step1.success && parseInt(step1.stdout) > 0, "Step 1 creation failed");

  const step1Id = parseInt(step1.stdout);

  // Add step 2: Data transformation (depends on step 1)
  const step2 = await runSQL(`
    SELECT pgflow.add_step(
      ${fid},
      'transform_data',
      '{"task": "transform", "method": "normalize"}',
      ARRAY[${step1Id}],
      3,
      '5 seconds'::interval
    )
  `);
  assert(step2.success && parseInt(step2.stdout) > 0, "Step 2 creation failed");

  const step2Id = parseInt(step2.stdout);

  // Add step 3: Data validation (depends on step 2)
  const step3 = await runSQL(`
    SELECT pgflow.add_step(
      ${fid},
      'validate_data',
      '{"task": "validate", "rules": ["non_null", "format_check"]}',
      ARRAY[${step2Id}],
      3,
      '5 seconds'::interval
    )
  `);
  assert(step3.success && parseInt(step3.stdout) > 0, "Step 3 creation failed");

  // Add step 4: Data loading (depends on step 3)
  const step4 = await runSQL(`
    SELECT pgflow.add_step(
      ${fid},
      'load_data',
      '{"task": "load", "destination": "warehouse"}',
      ARRAY[${parseInt(step3.stdout)}],
      3,
      '5 seconds'::interval
    )
  `);
  assert(step4.success && parseInt(step4.stdout) > 0, "Step 4 creation failed");

  // Verify steps and dependencies
  const stepCount = await runSQL(`SELECT count(*) FROM pgflow.steps WHERE flow_id = ${fid}`);
  assert(
    stepCount.success && stepCount.stdout === "4",
    `Expected 4 steps, found ${stepCount.stdout}`
  );

  const depCount = await runSQL(`SELECT count(*) FROM pgflow.deps WHERE flow_id = ${fid}`);
  assert(
    depCount.success && depCount.stdout === "3",
    `Expected 3 dependencies, found ${depCount.stdout}`
  );
});

// Test 4: Flow Execution - Start Flow
await test("Flow execution - start flow", async () => {
  // Get flow_id
  const flowId = await runSQL("SELECT id FROM pgflow.flows WHERE name = 'test_workflow'");
  const fid = parseInt(flowId.stdout);

  // Start flow with input data
  const run = await runSQL(`
    SELECT pgflow.start_flow(
      ${fid},
      '{"input_data": {"user_id": 123, "batch_size": 100}}'
    )
  `);
  assert(run.success && parseInt(run.stdout) > 0, "Flow start failed");

  // Verify run exists
  const runCheck = await runSQL(`SELECT count(*) FROM pgflow.runs WHERE id = ${run.stdout}`);
  assert(runCheck.success && runCheck.stdout === "1", "Run not found in runs table");

  // Verify initial step_states created
  const statesCount = await runSQL(
    `SELECT count(*) FROM pgflow.step_states WHERE run_id = ${run.stdout}`
  );
  assert(
    statesCount.success && parseInt(statesCount.stdout) === 4,
    `Expected 4 step_states, found ${statesCount.stdout}`
  );

  // Verify first step is ready (no dependencies)
  const readySteps = await runSQL(`
    SELECT count(*) FROM pgflow.step_states
    WHERE run_id = ${run.stdout} AND state = 'ready'
  `);
  assert(
    readySteps.success && readySteps.stdout === "1",
    `Expected 1 ready step, found ${readySteps.stdout}`
  );
});

// Test 5: Task Polling and Execution
await test("Task polling and execution", async () => {
  // Get run_id
  const runId = await runSQL(
    "SELECT id FROM pgflow.runs WHERE flow_id = (SELECT id FROM pgflow.flows WHERE name = 'test_workflow') ORDER BY id DESC LIMIT 1"
  );
  const rid = parseInt(runId.stdout);

  // Start ready steps (moves ready -> running, creates tasks)
  const started = await runSQL(`SELECT pgflow.start_ready_steps(${rid})`);
  assert(started.success, "Starting ready steps failed");

  // Poll for tasks (simulating worker)
  const task = await runSQL(`
    SELECT pgflow.poll_for_tasks(
      'test_worker_1',
      ARRAY['extract_data', 'transform_data', 'validate_data', 'load_data']
    )
  `);
  assert(task.success, "Task polling failed");

  // Parse task result (format: task_id|step_name|config|...)
  const taskData = task.stdout.split("|");
  assert(taskData.length >= 3, `Invalid task data format: ${task.stdout}`);

  const taskIdStr = taskData[0];
  if (!taskIdStr) {
    throw new Error("No task_id in task data");
  }
  const taskId = parseInt(taskIdStr);
  const stepName = taskData[1];

  assert(taskId > 0, "Invalid task_id");
  assert(stepName === "extract_data", `Expected 'extract_data', got '${stepName}'`);

  // Complete task with output data
  const complete = await runSQL(`
    SELECT pgflow.complete_task(
      ${taskId},
      '{"output": {"records_extracted": 100, "status": "success"}}'
    )
  `);
  assert(complete.success, "Task completion failed");

  // Verify step state changed to completed
  const stepState = await runSQL(`
    SELECT state FROM pgflow.step_states
    WHERE run_id = ${rid} AND step_name = 'extract_data'
  `);
  assert(
    stepState.success && stepState.stdout === "completed",
    `Expected 'completed', got '${stepState.stdout}'`
  );
});

// Test 6: Dependency Chain Execution
await test("Dependency chain execution", async () => {
  // Get run_id
  const runId = await runSQL(
    "SELECT id FROM pgflow.runs WHERE flow_id = (SELECT id FROM pgflow.flows WHERE name = 'test_workflow') ORDER BY id DESC LIMIT 1"
  );
  const rid = parseInt(runId.stdout);

  // Start next ready steps (transform_data should be ready now)
  await runSQL(`SELECT pgflow.start_ready_steps(${rid})`);

  // Poll and complete transform_data
  let task = await runSQL(`SELECT pgflow.poll_for_tasks('test_worker_1', ARRAY['transform_data'])`);
  if (task.stdout) {
    const taskIdStr = task.stdout.split("|")[0];
    if (taskIdStr) {
      const taskId = parseInt(taskIdStr);
      await runSQL(
        `SELECT pgflow.complete_task(${taskId}, '{"output": {"records_transformed": 100}}')`
      );
    }
  }

  // Start and complete validate_data
  await runSQL(`SELECT pgflow.start_ready_steps(${rid})`);
  task = await runSQL(`SELECT pgflow.poll_for_tasks('test_worker_1', ARRAY['validate_data'])`);
  if (task.stdout) {
    const taskIdStr = task.stdout.split("|")[0];
    if (taskIdStr) {
      const taskId = parseInt(taskIdStr);
      await runSQL(
        `SELECT pgflow.complete_task(${taskId}, '{"output": {"validation_passed": true}}')`
      );
    }
  }

  // Start and complete load_data
  await runSQL(`SELECT pgflow.start_ready_steps(${rid})`);
  task = await runSQL(`SELECT pgflow.poll_for_tasks('test_worker_1', ARRAY['load_data'])`);
  if (task.stdout) {
    const taskIdStr = task.stdout.split("|")[0];
    if (taskIdStr) {
      const taskId = parseInt(taskIdStr);
      await runSQL(`SELECT pgflow.complete_task(${taskId}, '{"output": {"records_loaded": 100}}')`);
    }
  }

  // Verify all steps completed
  const completedSteps = await runSQL(`
    SELECT count(*) FROM pgflow.step_states
    WHERE run_id = ${rid} AND state = 'completed'
  `);
  assert(
    completedSteps.success && completedSteps.stdout === "4",
    `Expected 4 completed steps, found ${completedSteps.stdout}`
  );

  // Verify run completed
  const runState = await runSQL(`SELECT state FROM pgflow.runs WHERE id = ${rid}`);
  assert(
    runState.success && runState.stdout === "completed",
    `Expected run state 'completed', got '${runState.stdout}'`
  );
});

// Test 7: Error Handling and Task Failure
await test("Error handling and task failure", async () => {
  // Create new flow for failure testing
  const flowId = await runSQL(
    `SELECT pgflow.create_flow('test_failure', '{}', 1, '5 seconds'::interval)`
  );
  const fid = parseInt(flowId.stdout);

  // Add single step
  const stepId = await runSQL(
    `SELECT pgflow.add_step(${fid}, 'failing_step', '{"will_fail": true}', NULL, 1, '5 seconds'::interval)`
  );
  assert(stepId.success, "Step creation for failure test failed");

  // Start flow
  const runId = await runSQL(`SELECT pgflow.start_flow(${fid}, '{}')`);
  const rid = parseInt(runId.stdout);

  // Start step
  await runSQL(`SELECT pgflow.start_ready_steps(${rid})`);

  // Poll for task
  const task = await runSQL(
    `SELECT pgflow.poll_for_tasks('test_worker_failure', ARRAY['failing_step'])`
  );
  assert(Boolean(task.stdout), "No task available for failure test");

  const taskIdStr = task.stdout.split("|")[0];
  if (!taskIdStr) {
    throw new Error("No task_id in failure test");
  }
  const taskId = parseInt(taskIdStr);

  // Fail task
  const fail = await runSQL(`
    SELECT pgflow.fail_task(
      ${taskId},
      '{"error": "Simulated failure", "code": "TEST_ERROR"}'
    )
  `);
  assert(fail.success, "Task failure marking failed");

  // Verify step state is failed
  const stepState = await runSQL(`SELECT state FROM pgflow.step_states WHERE run_id = ${rid}`);
  assert(
    stepState.success && stepState.stdout === "failed",
    `Expected 'failed', got '${stepState.stdout}'`
  );

  // Verify run state is failed
  const runState = await runSQL(`SELECT state FROM pgflow.runs WHERE id = ${rid}`);
  assert(
    runState.success && runState.stdout === "failed",
    `Expected run state 'failed', got '${runState.stdout}'`
  );
});

// Test 8: Concurrent Workflow Execution
await test("Concurrent workflow execution", async () => {
  // Create flow for concurrency test
  const flowId = await runSQL(
    `SELECT pgflow.create_flow('test_concurrent', '{}', 3, '5 seconds'::interval)`
  );
  const fid = parseInt(flowId.stdout);

  // Add parallel steps (no dependencies - can run concurrently)
  const step1 = await runSQL(
    `SELECT pgflow.add_step(${fid}, 'parallel_1', '{}', NULL, 3, '5 seconds'::interval)`
  );
  const step2 = await runSQL(
    `SELECT pgflow.add_step(${fid}, 'parallel_2', '{}', NULL, 3, '5 seconds'::interval)`
  );
  const step3 = await runSQL(
    `SELECT pgflow.add_step(${fid}, 'parallel_3', '{}', NULL, 3, '5 seconds'::interval)`
  );

  assert(step1.success && step2.success && step3.success, "Parallel steps creation failed");

  // Start flow
  const runId = await runSQL(`SELECT pgflow.start_flow(${fid}, '{}')`);
  const rid = parseInt(runId.stdout);

  // Start all ready steps
  await runSQL(`SELECT pgflow.start_ready_steps(${rid})`);

  // Verify 3 steps are running
  const runningSteps = await runSQL(
    `SELECT count(*) FROM pgflow.step_states WHERE run_id = ${rid} AND state = 'running'`
  );
  assert(
    runningSteps.success && runningSteps.stdout === "3",
    `Expected 3 running steps, found ${runningSteps.stdout}`
  );

  // Verify 3 tasks available
  const taskCount = await runSQL(
    `SELECT count(*) FROM pgflow.step_tasks WHERE run_id = ${rid} AND state = 'assigned'`
  );
  assert(
    taskCount.success && taskCount.stdout === "3",
    `Expected 3 tasks, found ${taskCount.stdout}`
  );

  // Simulate 3 workers processing tasks concurrently
  const workers = ["worker_1", "worker_2", "worker_3"];
  for (const worker of workers) {
    const task = await runSQL(
      `SELECT pgflow.poll_for_tasks('${worker}', ARRAY['parallel_1', 'parallel_2', 'parallel_3'])`
    );
    if (task.stdout) {
      const taskIdStr = task.stdout.split("|")[0];
      if (taskIdStr) {
        const taskId = parseInt(taskIdStr);
        await runSQL(`SELECT pgflow.complete_task(${taskId}, '{}')`);
      }
    }
  }

  // Verify all steps completed
  const completedSteps = await runSQL(
    `SELECT count(*) FROM pgflow.step_states WHERE run_id = ${rid} AND state = 'completed'`
  );
  assert(
    completedSteps.success && completedSteps.stdout === "3",
    `Expected 3 completed steps, found ${completedSteps.stdout}`
  );
});

// Test 9: Performance Benchmark
await test("Performance benchmark - workflow execution", async () => {
  const workflowCount = 10;
  const start = Date.now();

  for (let i = 0; i < workflowCount; i++) {
    // Create flow
    const flowId = await runSQL(
      `SELECT pgflow.create_flow('perf_test_${i}', '{}', 1, '5 seconds'::interval)`
    );
    const fid = parseInt(flowId.stdout);

    // Add single step
    await runSQL(
      `SELECT pgflow.add_step(${fid}, 'perf_step', '{}', NULL, 1, '5 seconds'::interval)`
    );

    // Start flow
    const runId = await runSQL(`SELECT pgflow.start_flow(${fid}, '{}')`);
    const rid = parseInt(runId.stdout);

    // Start step
    await runSQL(`SELECT pgflow.start_ready_steps(${rid})`);

    // Poll and complete
    const task = await runSQL(`SELECT pgflow.poll_for_tasks('perf_worker', ARRAY['perf_step'])`);
    if (task.stdout) {
      const taskIdStr = task.stdout.split("|")[0];
      if (taskIdStr) {
        const taskId = parseInt(taskIdStr);
        await runSQL(`SELECT pgflow.complete_task(${taskId}, '{}')`);
      }
    }
  }

  const duration = Date.now() - start;
  const throughput = (workflowCount / duration) * 1000; // workflows per second

  console.log(
    `   📊 Workflow Throughput: ${throughput.toFixed(2)} workflows/sec (${workflowCount} workflows in ${duration}ms)`
  );

  const lastResult = results[results.length - 1];
  if (lastResult) {
    lastResult.metrics = {
      workflowCount,
      duration,
      throughput: throughput.toFixed(2),
      avgPerWorkflow: (duration / workflowCount).toFixed(2),
    };
  }

  assert(throughput > 1, `Throughput too low: ${throughput.toFixed(2)} workflows/sec`);
});

// Test 10: Cleanup
await test("Cleanup test data", async () => {
  // Clean up test flows (this will cascade delete runs, steps, etc.)
  const cleanup = await runSQL(`
    DELETE FROM pgflow.flows
    WHERE name LIKE 'test_%' OR name LIKE 'perf_test_%'
  `);
  assert(cleanup.success, "Cleanup failed");

  // Verify cleanup
  const remainingFlows = await runSQL(
    "SELECT count(*) FROM pgflow.flows WHERE name LIKE 'test_%' OR name LIKE 'perf_test_%'"
  );
  assert(
    remainingFlows.success && remainingFlows.stdout === "0",
    `Cleanup incomplete: ${remainingFlows.stdout} flows remain`
  );
});

// Print Summary
console.log("\n" + "=".repeat(80));
console.log("PGFLOW FUNCTIONAL TEST SUMMARY");
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
