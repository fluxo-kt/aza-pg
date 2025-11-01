#!/usr/bin/env bun
/**
 * pgflow Multi-Project Isolation Tests
 *
 * Validates that pgflow schemas in separate databases are truly isolated.
 * This test creates two "projects" (databases) and verifies that:
 * 1. Each has independent pgflow schema
 * 2. Workflows in one don't affect the other
 * 3. Data is properly isolated
 *
 * Usage:
 *   bun scripts/test/test-pgflow-multiproject.ts --image=aza-pg:latest
 *   bun scripts/test/test-pgflow-multiproject.ts --container=my-postgres
 */

import { $ } from "bun";
import { resolveImageTag, parseContainerName } from "./image-resolver";
import {
  installPgflowSchema,
  runSQL,
  createDatabase,
  dropDatabase,
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

const PROJECT_A = "project_alpha";
const PROJECT_B = "project_beta";

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
  // Always try to drop test databases
  await dropDatabase(CONTAINER, PROJECT_A);
  await dropDatabase(CONTAINER, PROJECT_B);

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
  console.log(`pgflow v${PGFLOW_VERSION} Multi-Project Isolation Tests`);
  console.log("=".repeat(70));
  console.log(`Container: ${CONTAINER}`);
  console.log(`Project A: ${PROJECT_A}`);
  console.log(`Project B: ${PROJECT_B}`);
  console.log("=".repeat(70) + "\n");

  await startContainer();

  // Setup: Create two separate project databases
  await test("Create project_alpha database", async () => {
    await dropDatabase(CONTAINER, PROJECT_A);
    const created = await createDatabase(CONTAINER, PROJECT_A);
    assert(created, "Failed to create project_alpha database");
  });

  await test("Create project_beta database", async () => {
    await dropDatabase(CONTAINER, PROJECT_B);
    const created = await createDatabase(CONTAINER, PROJECT_B);
    assert(created, "Failed to create project_beta database");
  });

  // Install pgflow in both
  await test("Install pgflow in project_alpha", async () => {
    const result = await installPgflowSchema(CONTAINER, PROJECT_A);
    assert(result.success, `Installation failed: ${result.stderr}`);
    assert(
      result.tablesCreated !== undefined && result.tablesCreated >= 6,
      "Insufficient tables created"
    );
  });

  await test("Install pgflow in project_beta", async () => {
    const result = await installPgflowSchema(CONTAINER, PROJECT_B);
    assert(result.success, `Installation failed: ${result.stderr}`);
    assert(
      result.tablesCreated !== undefined && result.tablesCreated >= 6,
      "Insufficient tables created"
    );
  });

  // Verify both have independent schemas
  await test("Both projects have pgflow schema", async () => {
    const alphaInstalled = await isPgflowInstalled(CONTAINER, PROJECT_A);
    const betaInstalled = await isPgflowInstalled(CONTAINER, PROJECT_B);
    assert(alphaInstalled, "pgflow not installed in project_alpha");
    assert(betaInstalled, "pgflow not installed in project_beta");
  });

  // Create workflow in project_alpha only
  const ALPHA_FLOW = "alpha_workflow";

  await test("Create workflow in project_alpha", async () => {
    const result = await runSQL(
      CONTAINER,
      PROJECT_A,
      `
      SELECT pgflow.create_flow('${ALPHA_FLOW}', 3, 5, 60)
    `
    );
    assert(result.success, `Failed to create flow: ${result.stderr}`);

    await runSQL(
      CONTAINER,
      PROJECT_A,
      `
      SELECT pgflow.add_step('${ALPHA_FLOW}', 'step_one', ARRAY[]::text[], 3, 5, 30)
    `
    );
  });

  // Verify workflow exists in alpha but NOT in beta
  await test("Workflow exists only in project_alpha", async () => {
    // Check alpha
    const alphaFlow = await runSQL(
      CONTAINER,
      PROJECT_A,
      `
      SELECT COUNT(*) FROM pgflow.flows WHERE flow_slug = '${ALPHA_FLOW}'
    `
    );
    assert(
      alphaFlow.success && alphaFlow.stdout.trim() === "1",
      "Workflow should exist in project_alpha"
    );

    // Check beta - should NOT exist
    const betaFlow = await runSQL(
      CONTAINER,
      PROJECT_B,
      `
      SELECT COUNT(*) FROM pgflow.flows WHERE flow_slug = '${ALPHA_FLOW}'
    `
    );
    assert(
      betaFlow.success && betaFlow.stdout.trim() === "0",
      "Workflow should NOT exist in project_beta"
    );
  });

  // Create different workflow in project_beta
  const BETA_FLOW = "beta_workflow";

  await test("Create different workflow in project_beta", async () => {
    const result = await runSQL(
      CONTAINER,
      PROJECT_B,
      `
      SELECT pgflow.create_flow('${BETA_FLOW}', 5, 10, 120)
    `
    );
    assert(result.success, `Failed to create flow: ${result.stderr}`);

    await runSQL(
      CONTAINER,
      PROJECT_B,
      `
      SELECT pgflow.add_step('${BETA_FLOW}', 'beta_step', ARRAY[]::text[], 5, 10, 60)
    `
    );
  });

  await test("Workflows remain isolated", async () => {
    // Alpha has alpha_workflow only
    const alphaCount = await runSQL(CONTAINER, PROJECT_A, `SELECT COUNT(*) FROM pgflow.flows`);
    assert(
      alphaCount.success && alphaCount.stdout.trim() === "1",
      "project_alpha should have exactly 1 flow"
    );

    // Beta has beta_workflow only
    const betaCount = await runSQL(CONTAINER, PROJECT_B, `SELECT COUNT(*) FROM pgflow.flows`);
    assert(
      betaCount.success && betaCount.stdout.trim() === "1",
      "project_beta should have exactly 1 flow"
    );

    // Verify correct flows
    const alphaFlow = await runSQL(CONTAINER, PROJECT_A, `SELECT flow_slug FROM pgflow.flows`);
    assert(alphaFlow.stdout.trim() === ALPHA_FLOW, `project_alpha should have ${ALPHA_FLOW}`);

    const betaFlow = await runSQL(CONTAINER, PROJECT_B, `SELECT flow_slug FROM pgflow.flows`);
    assert(betaFlow.stdout.trim() === BETA_FLOW, `project_beta should have ${BETA_FLOW}`);
  });

  // Start workflow runs in both
  await test("Start workflow run in project_alpha", async () => {
    const result = await runSQL(
      CONTAINER,
      PROJECT_A,
      `
      SELECT run_id FROM pgflow.start_flow('${ALPHA_FLOW}', '{"project": "alpha"}'::jsonb)
    `
    );
    assert(result.success && result.stdout.trim().length > 0, "Failed to start alpha workflow");
  });

  await test("Start workflow run in project_beta", async () => {
    const result = await runSQL(
      CONTAINER,
      PROJECT_B,
      `
      SELECT run_id FROM pgflow.start_flow('${BETA_FLOW}', '{"project": "beta"}'::jsonb)
    `
    );
    assert(result.success && result.stdout.trim().length > 0, "Failed to start beta workflow");
  });

  // Verify run isolation
  await test("Workflow runs are isolated", async () => {
    const alphaRuns = await runSQL(CONTAINER, PROJECT_A, `SELECT COUNT(*) FROM pgflow.runs`);
    assert(
      alphaRuns.success && alphaRuns.stdout.trim() === "1",
      "project_alpha should have exactly 1 run"
    );

    const betaRuns = await runSQL(CONTAINER, PROJECT_B, `SELECT COUNT(*) FROM pgflow.runs`);
    assert(
      betaRuns.success && betaRuns.stdout.trim() === "1",
      "project_beta should have exactly 1 run"
    );
  });

  // Verify input data isolation
  await test("Run input data is isolated", async () => {
    const alphaInput = await runSQL(
      CONTAINER,
      PROJECT_A,
      `
      SELECT input->>'project' FROM pgflow.runs LIMIT 1
    `
    );
    assert(
      alphaInput.success && alphaInput.stdout.trim() === "alpha",
      "Alpha run should have project=alpha"
    );

    const betaInput = await runSQL(
      CONTAINER,
      PROJECT_B,
      `
      SELECT input->>'project' FROM pgflow.runs LIMIT 1
    `
    );
    assert(
      betaInput.success && betaInput.stdout.trim() === "beta",
      "Beta run should have project=beta"
    );
  });

  // Verify step_states isolation
  await test("Step states are isolated", async () => {
    const alphaStates = await runSQL(
      CONTAINER,
      PROJECT_A,
      `SELECT step_slug FROM pgflow.step_states`
    );
    assert(
      alphaStates.success && alphaStates.stdout.trim() === "step_one",
      "Alpha should have step_one"
    );

    const betaStates = await runSQL(
      CONTAINER,
      PROJECT_B,
      `SELECT step_slug FROM pgflow.step_states`
    );
    assert(
      betaStates.success && betaStates.stdout.trim() === "beta_step",
      "Beta should have beta_step"
    );
  });

  // Test that dropping one database doesn't affect the other
  await test("Dropping project_alpha doesn't affect project_beta", async () => {
    await dropDatabase(CONTAINER, PROJECT_A);

    // project_beta should still work
    const betaFlow = await runSQL(CONTAINER, PROJECT_B, `SELECT flow_slug FROM pgflow.flows`);
    assert(
      betaFlow.success && betaFlow.stdout.trim() === BETA_FLOW,
      "project_beta should be unaffected"
    );

    const betaRuns = await runSQL(CONTAINER, PROJECT_B, `SELECT COUNT(*) FROM pgflow.runs`);
    assert(
      betaRuns.success && betaRuns.stdout.trim() === "1",
      "project_beta runs should be intact"
    );
  });

  // Cleanup
  await cleanup();

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("Multi-Project Isolation Summary");
  console.log("=".repeat(70));

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log(`Total: ${results.length} tests`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    console.log("\nFailed tests:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  - ${r.name}: ${r.error}`);
    }
  }

  console.log("=".repeat(70) + "\n");
  process.exitCode = failed > 0 ? 1 : 0;
}

runTests().catch((error) => {
  console.error("Test execution failed:", error);
  process.exitCode = 1;
});
