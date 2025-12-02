#!/usr/bin/env bun
/**
 * pgflow Schema Verification Tests
 *
 * Validates that the pgflow schema is complete and correctly structured.
 * This is a lighter test that verifies schema integrity without full workflow testing.
 *
 * Usage:
 *   bun scripts/test/test-pgflow-schema.ts --image=aza-pg:latest
 *   bun scripts/test/test-pgflow-schema.ts --container=my-postgres
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
  : `test-pgflow-schema-${Date.now()}-${process.pid}`;

// pg_cron can only be created in the database configured in cron.database_name (default: postgres)
// So we use the postgres database for testing
const DATABASE = "postgres";
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
  if (useExistingContainer) {
    // When using postgres database, just drop the pgflow schema instead of the database
    if (DATABASE === "postgres") {
      await runSQL(CONTAINER, DATABASE, "DROP SCHEMA IF EXISTS pgflow CASCADE");
    } else {
      await dropDatabase(CONTAINER, DATABASE);
    }
    return;
  }
  await $`docker stop ${CONTAINER}`.quiet().nothrow();
  await $`docker rm ${CONTAINER}`.quiet().nothrow();
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(1);
});

// ============================================================================
// Expected Schema Components
// ============================================================================

const EXPECTED_TABLES = ["flows", "steps", "deps", "workers", "runs", "step_states", "step_tasks"];

const EXPECTED_FUNCTIONS = [
  "is_valid_slug",
  "calculate_retry_delay",
  "create_flow",
  "add_step",
  "start_flow",
  "start_ready_steps",
  "start_tasks",
  "complete_task",
  "fail_task",
  "maybe_complete_run",
  "cascade_complete_taskless_steps",
  "get_run_with_states",
  "set_vt_batch",
  "start_flow_with_states",
];

const EXPECTED_TYPES = ["step_task_record"];

const EXPECTED_INDEXES = ["flows_pkey", "steps_pkey", "deps_pkey", "runs_pkey", "step_states_pkey"];

// ============================================================================
// Test Cases
// ============================================================================

async function runTests(): Promise<void> {
  console.log("\n" + "=".repeat(70));
  console.log(`pgflow v${PGFLOW_VERSION} Schema Verification Tests`);
  console.log("=".repeat(70));
  console.log(`Container: ${CONTAINER}`);
  console.log(`Database: ${DATABASE}`);
  console.log("=".repeat(70) + "\n");

  await startContainer();

  // Setup - when using postgres database, just clean up existing pgflow schema
  if (DATABASE === "postgres") {
    await test("Clean existing pgflow schema", async () => {
      // Drop pgflow schema if it exists from previous test runs
      await runSQL(CONTAINER, DATABASE, "DROP SCHEMA IF EXISTS pgflow CASCADE");
    });
  } else {
    await test("Create test database", async () => {
      await dropDatabase(CONTAINER, DATABASE);
      const created = await createDatabase(CONTAINER, DATABASE);
      assert(created, "Failed to create database");
    });
  }

  await test("Install pgflow schema", async () => {
    const result = await installPgflowSchema(CONTAINER, DATABASE);
    assert(result.success, `Installation failed: ${result.stderr}`);
  });

  // Table verification
  await test("All expected tables exist", async () => {
    for (const table of EXPECTED_TABLES) {
      const result = await runSQL(
        CONTAINER,
        DATABASE,
        `
        SELECT 1 FROM pg_tables WHERE schemaname = 'pgflow' AND tablename = '${table}'
      `
      );
      assert(result.success && result.stdout.trim() === "1", `Missing table: pgflow.${table}`);
    }
  });

  await test("Table count matches expected", async () => {
    const result = await runSQL(
      CONTAINER,
      DATABASE,
      `
      SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'pgflow'
    `
    );
    const count = parseInt(result.stdout.trim());
    assert(
      count >= EXPECTED_TABLES.length,
      `Expected at least ${EXPECTED_TABLES.length} tables, got ${count}`
    );
  });

  // Function verification
  await test("All expected functions exist", async () => {
    for (const fn of EXPECTED_FUNCTIONS) {
      const result = await runSQL(
        CONTAINER,
        DATABASE,
        `
        SELECT COUNT(*) FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'pgflow' AND p.proname = '${fn}'
      `
      );
      assert(
        result.success && parseInt(result.stdout.trim()) >= 1,
        `Missing function: pgflow.${fn}()`
      );
    }
  });

  await test("Function count meets minimum", async () => {
    const result = await runSQL(
      CONTAINER,
      DATABASE,
      `
      SELECT COUNT(DISTINCT p.proname) FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'pgflow'
    `
    );
    const count = parseInt(result.stdout.trim());
    assert(
      count >= EXPECTED_FUNCTIONS.length,
      `Expected at least ${EXPECTED_FUNCTIONS.length} functions, got ${count}`
    );
  });

  // Type verification
  await test("Custom types exist", async () => {
    for (const typeName of EXPECTED_TYPES) {
      const result = await runSQL(
        CONTAINER,
        DATABASE,
        `
        SELECT 1 FROM pg_type t
        JOIN pg_namespace n ON t.typnamespace = n.oid
        WHERE n.nspname = 'pgflow' AND t.typname = '${typeName}'
      `
      );
      assert(result.success && result.stdout.trim() === "1", `Missing type: pgflow.${typeName}`);
    }
  });

  // Index verification
  await test("Primary key indexes exist", async () => {
    for (const index of EXPECTED_INDEXES) {
      const result = await runSQL(
        CONTAINER,
        DATABASE,
        `
        SELECT 1 FROM pg_indexes WHERE schemaname = 'pgflow' AND indexname = '${index}'
      `
      );
      assert(result.success && result.stdout.trim() === "1", `Missing index: ${index}`);
    }
  });

  // Column verification for key tables
  await test("flows table has correct columns", async () => {
    const expectedColumns = [
      "flow_slug",
      "opt_max_attempts",
      "opt_base_delay",
      "opt_timeout",
      "created_at",
    ];
    for (const col of expectedColumns) {
      const result = await runSQL(
        CONTAINER,
        DATABASE,
        `
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'pgflow' AND table_name = 'flows' AND column_name = '${col}'
      `
      );
      assert(result.success && result.stdout.trim() === "1", `Missing column: pgflow.flows.${col}`);
    }
  });

  await test("steps table has correct columns", async () => {
    const expectedColumns = [
      "flow_slug",
      "step_slug",
      "step_type",
      "deps_count",
      "opt_max_attempts",
    ];
    for (const col of expectedColumns) {
      const result = await runSQL(
        CONTAINER,
        DATABASE,
        `
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'pgflow' AND table_name = 'steps' AND column_name = '${col}'
      `
      );
      assert(result.success && result.stdout.trim() === "1", `Missing column: pgflow.steps.${col}`);
    }
  });

  await test("runs table has correct columns", async () => {
    const expectedColumns = ["run_id", "flow_slug", "status", "input", "output", "remaining_steps"];
    for (const col of expectedColumns) {
      const result = await runSQL(
        CONTAINER,
        DATABASE,
        `
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'pgflow' AND table_name = 'runs' AND column_name = '${col}'
      `
      );
      assert(result.success && result.stdout.trim() === "1", `Missing column: pgflow.runs.${col}`);
    }
  });

  await test("step_tasks table supports map steps (task_index)", async () => {
    const result = await runSQL(
      CONTAINER,
      DATABASE,
      `
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'pgflow' AND table_name = 'step_tasks' AND column_name = 'task_index'
    `
    );
    assert(
      result.success && result.stdout.trim() === "1",
      "Missing column: pgflow.step_tasks.task_index (required for map steps)"
    );
  });

  // Constraint verification
  await test("Foreign key constraints exist", async () => {
    const result = await runSQL(
      CONTAINER,
      DATABASE,
      `
      SELECT COUNT(*) FROM information_schema.table_constraints
      WHERE constraint_schema = 'pgflow' AND constraint_type = 'FOREIGN KEY'
    `
    );
    const count = parseInt(result.stdout.trim());
    assert(count >= 5, `Expected at least 5 foreign key constraints, got ${count}`);
  });

  // pgmq dependency
  await test("pgmq extension is available", async () => {
    const result = await runSQL(
      CONTAINER,
      DATABASE,
      `
      SELECT 1 FROM pg_extension WHERE extname = 'pgmq'
    `
    );
    assert(result.success && result.stdout.trim() === "1", "pgmq extension not installed");
  });

  // Utility function
  await test("isPgflowInstalled helper works", async () => {
    const installed = await isPgflowInstalled(CONTAINER, DATABASE);
    assert(installed, "isPgflowInstalled should return true after installation");
  });

  // Cleanup
  await cleanup();

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("Schema Verification Summary");
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
