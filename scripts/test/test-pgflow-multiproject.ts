#!/usr/bin/env bun
/**
 * pgflow Workflow Isolation Tests
 *
 * NOTE: pg_cron can only be installed in ONE database (cron.database_name, default: postgres).
 * True database-level isolation testing requires separate PostgreSQL instances.
 *
 * This test validates workflow isolation within a SINGLE database (postgres),
 * verifying that multiple workflows with different slugs don't interfere.
 *
 * Usage:
 *   bun scripts/test/test-pgflow-multiproject.ts --image=aza-pg:latest
 *   bun scripts/test/test-pgflow-multiproject.ts --container=my-postgres
 */

import { $ } from "bun";
import { resolveImageTag, parseContainerName } from "./image-resolver";
import {
  installPgflowSchema,
  installRealtimeStub,
  runSQL,
  isPgflowInstalled,
  PGFLOW_VERSION,
} from "../../tests/fixtures/pgflow/install";

// ============================================================================
// Configuration
// ============================================================================

const existingContainer = parseContainerName();
const useExistingContainer = Boolean(existingContainer);

const CONTAINER = useExistingContainer
  ? existingContainer!
  : `test-pgflow-multi-${Date.now()}-${process.pid}`;

// Using postgres database (pg_cron limitation)
const DATABASE = "postgres";
const FLOW_A = "alpha_workflow";
const FLOW_B = "beta_workflow";

const imageTag = !useExistingContainer ? resolveImageTag() : null;

// ============================================================================
// Test Infrastructure
// ============================================================================

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    const duration = Date.now() - start;
    results.push({ name, passed: true, duration });
    console.log(`✅ ${name} (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - start;
    const errorMsg = error instanceof Error ? error.message : String(error);
    results.push({ name, passed: false, duration, error: errorMsg });
    console.log(`❌ ${name} (${duration}ms)`);
    console.log(`   Error: ${errorMsg}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

// ============================================================================
// Container Lifecycle
// ============================================================================

async function startContainer(): Promise<void> {
  if (useExistingContainer) {
    console.log(`Using existing container: ${CONTAINER}`);
    return;
  }

  console.log(`Starting container ${CONTAINER}...`);
  // Uses image's built-in DEFAULT_SHARED_PRELOAD_LIBRARIES (includes pg_net, pgsodium for pgflow)
  await $`docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=test -e POSTGRES_HOST_AUTH_METHOD=trust ${imageTag}`.quiet();

  const start = Date.now();
  while (Date.now() - start < 60000) {
    const result = await $`docker exec ${CONTAINER} pg_isready -U postgres`.quiet().nothrow();
    if (result.exitCode === 0) {
      await Bun.sleep(2000);
      return;
    }
    await Bun.sleep(1000);
  }
  throw new Error("Container failed to start");
}

async function cleanup(): Promise<void> {
  // Clean up test flows
  try {
    for (const flow of [FLOW_A, FLOW_B]) {
      await runSQL(
        CONTAINER,
        DATABASE,
        `DELETE FROM pgflow.step_tasks WHERE flow_slug = '${flow}'`
      );
      await runSQL(
        CONTAINER,
        DATABASE,
        `DELETE FROM pgflow.step_states WHERE flow_slug = '${flow}'`
      );
      await runSQL(CONTAINER, DATABASE, `DELETE FROM pgflow.runs WHERE flow_slug = '${flow}'`);
      await runSQL(CONTAINER, DATABASE, `DELETE FROM pgflow.deps WHERE flow_slug = '${flow}'`);
      await runSQL(CONTAINER, DATABASE, `DELETE FROM pgflow.steps WHERE flow_slug = '${flow}'`);
      await runSQL(CONTAINER, DATABASE, `DELETE FROM pgflow.flows WHERE flow_slug = '${flow}'`);
    }
  } catch {
    // Ignore cleanup errors
  }

  if (!useExistingContainer) {
    await $`docker stop ${CONTAINER}`.quiet().nothrow();
    await $`docker rm ${CONTAINER}`.quiet().nothrow();
  }
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(1);
});

// ============================================================================
// Test Cases
// ============================================================================

async function runTests(): Promise<void> {
  console.log("\n" + "=".repeat(70));
  console.log(`pgflow v${PGFLOW_VERSION} Workflow Isolation Tests`);
  console.log("=".repeat(70));
  console.log(`Container: ${CONTAINER}`);
  console.log(`Database: ${DATABASE}`);
  console.log(`Testing flow isolation: ${FLOW_A} vs ${FLOW_B}`);
  console.log("=".repeat(70) + "\n");

  await startContainer();

  // ALWAYS install realtime stub first (idempotent) - required for pgflow.start_flow()
  // This must happen before any pgflow operations, even if schema already exists
  console.log("📦 Ensuring realtime.send() stub is installed...");
  const stubResult = await installRealtimeStub(CONTAINER, DATABASE);
  if (!stubResult.success) {
    console.log(`❌ Failed to install realtime stub: ${stubResult.stderr}`);
    process.exitCode = 1;
    return;
  }
  console.log("✅ realtime.send() stub ready\n");

  // Setup pgflow schema if not already installed
  const installed = await isPgflowInstalled(CONTAINER, DATABASE);
  if (!installed) {
    await test("Install pgflow schema", async () => {
      // Clean any existing schema first
      await runSQL(CONTAINER, DATABASE, "DROP SCHEMA IF EXISTS pgflow CASCADE");
      const result = await installPgflowSchema(CONTAINER, DATABASE);
      assert(result.success, `Schema installation failed: ${result.stderr}`);
    });
  } else {
    console.log("ℹ️  pgflow schema already installed, skipping installation");
    results.push({ name: "Install pgflow schema", passed: true, duration: 0 });
  }

  // Create two independent workflows
  await test("Create alpha workflow", async () => {
    const result = await runSQL(
      CONTAINER,
      DATABASE,
      `SELECT pgflow.create_flow('${FLOW_A}', 3, 5, 60)`
    );
    assert(result.success, `Failed to create alpha workflow: ${result.stderr}`);

    // Add steps
    await runSQL(
      CONTAINER,
      DATABASE,
      `SELECT pgflow.add_step('${FLOW_A}', 'step1', ARRAY[]::text[], 3, 5, 30)`
    );
    await runSQL(
      CONTAINER,
      DATABASE,
      `SELECT pgflow.add_step('${FLOW_A}', 'step2', ARRAY['step1']::text[], 3, 5, 30)`
    );
  });

  await test("Create beta workflow", async () => {
    const result = await runSQL(
      CONTAINER,
      DATABASE,
      `SELECT pgflow.create_flow('${FLOW_B}', 3, 5, 60)`
    );
    assert(result.success, `Failed to create beta workflow: ${result.stderr}`);

    // Add steps (different structure)
    await runSQL(
      CONTAINER,
      DATABASE,
      `SELECT pgflow.add_step('${FLOW_B}', 'init', ARRAY[]::text[], 3, 5, 30)`
    );
    await runSQL(
      CONTAINER,
      DATABASE,
      `SELECT pgflow.add_step('${FLOW_B}', 'process', ARRAY['init']::text[], 3, 5, 30)`
    );
    await runSQL(
      CONTAINER,
      DATABASE,
      `SELECT pgflow.add_step('${FLOW_B}', 'finish', ARRAY['process']::text[], 3, 5, 30)`
    );
  });

  // Verify workflows are independent
  await test("Verify workflow independence", async () => {
    // Alpha has 2 steps
    const alphaSteps = await runSQL(
      CONTAINER,
      DATABASE,
      `SELECT COUNT(*) FROM pgflow.steps WHERE flow_slug = '${FLOW_A}'`
    );
    assert(alphaSteps.success && alphaSteps.stdout.trim() === "2", "Alpha should have 2 steps");

    // Beta has 3 steps
    const betaSteps = await runSQL(
      CONTAINER,
      DATABASE,
      `SELECT COUNT(*) FROM pgflow.steps WHERE flow_slug = '${FLOW_B}'`
    );
    assert(betaSteps.success && betaSteps.stdout.trim() === "3", "Beta should have 3 steps");
  });

  // Start runs on both workflows
  let alphaRunId = "";
  let betaRunId = "";

  await test("Start alpha workflow run", async () => {
    const result = await runSQL(
      CONTAINER,
      DATABASE,
      `SELECT run_id FROM pgflow.start_flow('${FLOW_A}', '{"project": "alpha"}'::jsonb)`
    );
    assert(result.success, `Failed to start alpha run: ${result.stderr}`);
    alphaRunId = result.stdout.trim();
    assert(alphaRunId.length > 0, "Should return run_id");
  });

  await test("Start beta workflow run", async () => {
    const result = await runSQL(
      CONTAINER,
      DATABASE,
      `SELECT run_id FROM pgflow.start_flow('${FLOW_B}', '{"project": "beta"}'::jsonb)`
    );
    assert(result.success, `Failed to start beta run: ${result.stderr}`);
    betaRunId = result.stdout.trim();
    assert(betaRunId.length > 0, "Should return run_id");
  });

  // Verify runs are isolated
  await test("Verify run isolation", async () => {
    // Alpha run only has step_states for alpha workflow
    const alphaStates = await runSQL(
      CONTAINER,
      DATABASE,
      `SELECT COUNT(*) FROM pgflow.step_states WHERE run_id = '${alphaRunId}'::uuid AND flow_slug = '${FLOW_A}'`
    );
    assert(
      alphaStates.success && alphaStates.stdout.trim() === "2",
      "Alpha run should have 2 step states"
    );

    // Beta run only has step_states for beta workflow
    const betaStates = await runSQL(
      CONTAINER,
      DATABASE,
      `SELECT COUNT(*) FROM pgflow.step_states WHERE run_id = '${betaRunId}'::uuid AND flow_slug = '${FLOW_B}'`
    );
    assert(
      betaStates.success && betaStates.stdout.trim() === "3",
      "Beta run should have 3 step states"
    );
  });

  // Verify deleting one workflow doesn't affect the other
  await test("Deleting alpha doesn't affect beta", async () => {
    // Delete alpha workflow
    await runSQL(
      CONTAINER,
      DATABASE,
      `DELETE FROM pgflow.step_tasks WHERE flow_slug = '${FLOW_A}'`
    );
    await runSQL(
      CONTAINER,
      DATABASE,
      `DELETE FROM pgflow.step_states WHERE flow_slug = '${FLOW_A}'`
    );
    await runSQL(CONTAINER, DATABASE, `DELETE FROM pgflow.runs WHERE flow_slug = '${FLOW_A}'`);
    await runSQL(CONTAINER, DATABASE, `DELETE FROM pgflow.deps WHERE flow_slug = '${FLOW_A}'`);
    await runSQL(CONTAINER, DATABASE, `DELETE FROM pgflow.steps WHERE flow_slug = '${FLOW_A}'`);
    await runSQL(CONTAINER, DATABASE, `DELETE FROM pgflow.flows WHERE flow_slug = '${FLOW_A}'`);

    // Verify alpha is gone
    const alphaGone = await runSQL(
      CONTAINER,
      DATABASE,
      `SELECT COUNT(*) FROM pgflow.flows WHERE flow_slug = '${FLOW_A}'`
    );
    assert(alphaGone.success && alphaGone.stdout.trim() === "0", "Alpha should be deleted");

    // Verify beta still exists
    const betaExists = await runSQL(
      CONTAINER,
      DATABASE,
      `SELECT COUNT(*) FROM pgflow.flows WHERE flow_slug = '${FLOW_B}'`
    );
    assert(betaExists.success && betaExists.stdout.trim() === "1", "Beta should still exist");

    // Verify beta run still exists
    const betaRunExists = await runSQL(
      CONTAINER,
      DATABASE,
      `SELECT COUNT(*) FROM pgflow.runs WHERE flow_slug = '${FLOW_B}'`
    );
    assert(
      betaRunExists.success && betaRunExists.stdout.trim() === "1",
      "Beta run should still exist"
    );
  });

  // Cleanup
  await cleanup();

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("Workflow Isolation Summary");
  console.log("=".repeat(70));
  console.log(`Total: ${results.length} tests`);
  console.log(`Passed: ${results.filter((r) => r.passed).length}`);
  console.log(`Failed: ${results.filter((r) => !r.passed).length}`);

  const failed = results.filter((r) => !r.passed);
  if (failed.length > 0) {
    console.log("\nFailed tests:");
    for (const f of failed) {
      console.log(`  - ${f.name}: ${f.error}`);
    }
  }
  console.log("=".repeat(70) + "\n");

  if (failed.length > 0) {
    process.exit(1);
  }
}

// Run tests
runTests().catch((error) => {
  console.error("Test execution failed:", error);
  cleanup().finally(() => process.exit(1));
});
