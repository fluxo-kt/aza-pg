#!/usr/bin/env bun
/**
 * pgflow v0.13.3 Schema-Level SQL Tests
 *
 * Tests SQL-side schema changes in pgflow v0.13.3 that can be verified from PostgreSQL.
 * Does NOT test TypeScript edge-worker features (PGFLOW_AUTH_SECRET, maxPgConnections)
 * as these have zero SQL presence in the schema.
 *
 * Test coverage:
 * - T3.1: poll_for_tasks deprecation notice
 * - T3.2: Requeue tracking columns (requeued_count, last_requeued_at, permanently_stalled_at)
 * - T3.3: last_worker_id column exists
 * - T3.4: workers table structure (7 columns)
 * - T3.5: Function signatures (start_tasks, set_vt_batch, step_task_record)
 * - T3.6: cascade_complete_taskless_steps (empty map flow auto-completion)
 *
 * Usage:
 *   # Start new container from image
 *   bun scripts/test/test-pgflow-schema-updates.ts --image=aza-pg:latest
 *
 *   # Use existing container
 *   bun scripts/test/test-pgflow-schema-updates.ts --container=my-postgres
 *
 *   # Specify database
 *   bun scripts/test/test-pgflow-schema-updates.ts --container=my-postgres --database=pgflow_test
 */

import { parseContainerName } from "./image-resolver";
import { TestHarness } from "./harness";
import { installPgflowSchema, runSQL, PGFLOW_VERSION } from "../../tests/fixtures/pgflow/install";

// ============================================================================
// Configuration
// ============================================================================

const existingContainer = parseContainerName();
const useExistingContainer = Boolean(existingContainer);

const DATABASE =
  process.env.TEST_DATABASE ||
  Bun.argv.find((a) => a.startsWith("--database="))?.split("=")[1] ||
  "postgres";

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
    throw new Error(`Assertion failed: ${message}`);
  }
}

// ============================================================================
// Container Lifecycle
// ============================================================================

const harness = new TestHarness();

// ============================================================================
// Test Cases
// ============================================================================

async function runTests(): Promise<void> {
  let CONTAINER = existingContainer || "";

  try {
    if (!useExistingContainer) {
      // Start new container with TestHarness
      // MUST use "postgres" database - pg_cron is restricted to cron.database_name (default: "postgres")
      CONTAINER = await harness.startContainer("pgflow-schema-updates", {
        POSTGRES_PASSWORD: "test",
        POSTGRES_DB: "postgres",
      });
      console.log(`✅ Started test container: ${CONTAINER}`);

      // Wait for PostgreSQL to be ready
      console.log(`⏳ Waiting for PostgreSQL to be ready...`);
      await harness.waitForReady(CONTAINER);
      console.log(`✅ PostgreSQL ready`);
    } else {
      console.log(`✅ Using existing container: ${CONTAINER}`);
    }

    // Install pgflow schema
    console.log(`\n🔧 Installing pgflow v${PGFLOW_VERSION} schema...`);
    const installed = await installPgflowSchema(CONTAINER, DATABASE);
    if (!installed.success) {
      console.error(`\n❌ pgflow schema installation failed:`);
      console.error(`   Database: ${DATABASE}`);
      console.error(`   Error: ${installed.stderr || "Unknown error"}`);
      if (installed.stdout) {
        console.error(`   stdout: ${installed.stdout}`);
      }
    }
    assert(
      installed.success,
      `Failed to install pgflow schema in ${DATABASE}: ${installed.stderr || "Unknown error"}`
    );
    console.log(`✅ pgflow schema installed in ${DATABASE}`);

    // ========================================================================
    // T3.1: poll_for_tasks deprecation notice
    // ========================================================================

    await test("T3.1: poll_for_tasks deprecation notice", async () => {
      const result = await runSQL(
        CONTAINER,
        DATABASE,
        `SELECT pgflow.poll_for_tasks('test_queue', 30, 5);`
      );

      // Function should execute successfully but return empty set
      assert(result.success, "poll_for_tasks should execute successfully (even though deprecated)");

      // Should emit deprecation NOTICE in stderr
      assert(
        result.stderr.includes("DEPRECATED"),
        `Expected DEPRECATED notice in stderr, got: ${result.stderr}`
      );

      // Should return empty result
      assert(
        result.stdout === "" || result.stdout.trim() === "",
        `Expected empty result set, got: ${result.stdout}`
      );
    });

    // ========================================================================
    // T3.2: Requeue tracking columns on step_tasks
    // ========================================================================

    await test("T3.2: Requeue tracking columns exist with correct types", async () => {
      const result = await runSQL(
        CONTAINER,
        DATABASE,
        `
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'pgflow' AND table_name = 'step_tasks'
          AND column_name IN ('requeued_count', 'last_requeued_at', 'permanently_stalled_at')
        ORDER BY column_name;
      `
      );

      assert(result.success, `Query failed: ${result.stderr}`);

      const lines = result.stdout.split("\n").filter((l) => l.trim());
      assert(lines.length === 3, `Expected 3 columns, found ${lines.length}`);

      // Parse results: column_name|data_type|is_nullable|column_default
      const columns = lines.map((line) => {
        const parts = line.split("|");
        return {
          name: parts[0],
          type: parts[1],
          nullable: parts[2],
          default: parts[3],
        };
      });

      // Verify last_requeued_at
      const lastRequeued = columns.find((c) => c.name === "last_requeued_at");
      assert(lastRequeued !== undefined, "last_requeued_at column not found");
      assert(
        lastRequeued!.type === "timestamp with time zone",
        `last_requeued_at should be timestamptz, got ${lastRequeued!.type}`
      );
      assert(
        lastRequeued!.nullable === "YES",
        `last_requeued_at should be nullable, got ${lastRequeued!.nullable}`
      );

      // Verify permanently_stalled_at
      const permStalled = columns.find((c) => c.name === "permanently_stalled_at");
      assert(permStalled !== undefined, "permanently_stalled_at column not found");
      assert(
        permStalled!.type === "timestamp with time zone",
        `permanently_stalled_at should be timestamptz, got ${permStalled!.type}`
      );
      assert(
        permStalled!.nullable === "YES",
        `permanently_stalled_at should be nullable, got ${permStalled!.nullable}`
      );

      // Verify requeued_count
      const requeuedCount = columns.find((c) => c.name === "requeued_count");
      assert(requeuedCount !== undefined, "requeued_count column not found");
      assert(
        requeuedCount!.type === "integer",
        `requeued_count should be integer, got ${requeuedCount!.type}`
      );
      assert(
        requeuedCount!.nullable === "NO",
        `requeued_count should be NOT NULL, got ${requeuedCount!.nullable}`
      );
      assert(
        requeuedCount!.default === "0",
        `requeued_count should default to 0, got ${requeuedCount!.default}`
      );
    });

    await test("T3.2: Requeue tracking columns initialize correctly", async () => {
      // Create a flow and verify defaults
      const createFlow = await runSQL(
        CONTAINER,
        DATABASE,
        `SELECT pgflow.create_flow('requeue_test');`
      );
      assert(createFlow.success, `create_flow failed: ${createFlow.stderr}`);

      const addStep = await runSQL(
        CONTAINER,
        DATABASE,
        `SELECT pgflow.add_step('requeue_test', 'step1');`
      );
      assert(addStep.success, `add_step failed: ${addStep.stderr}`);

      const startFlow = await runSQL(
        CONTAINER,
        DATABASE,
        `SELECT * FROM pgflow.start_flow('requeue_test', '{"test": true}'::jsonb);`
      );
      assert(startFlow.success, `start_flow failed: ${startFlow.stderr}`);

      // Check step_tasks defaults
      const checkDefaults = await runSQL(
        CONTAINER,
        DATABASE,
        `
        SELECT requeued_count, last_requeued_at, permanently_stalled_at
        FROM pgflow.step_tasks WHERE flow_slug = 'requeue_test';
      `
      );
      assert(checkDefaults.success, `Query failed: ${checkDefaults.stderr}`);

      const values = checkDefaults.stdout.split("|");
      assert(values[0] === "0", `requeued_count should be 0, got ${values[0]}`);
      assert(values[1] === "" || !values[1], `last_requeued_at should be NULL, got ${values[1]}`);
      assert(
        values[2] === "" || !values[2],
        `permanently_stalled_at should be NULL, got ${values[2]}`
      );
    });

    // ========================================================================
    // T3.3: last_worker_id column on step_tasks
    // ========================================================================

    await test("T3.3: last_worker_id column exists", async () => {
      const result = await runSQL(
        CONTAINER,
        DATABASE,
        `
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'pgflow' AND table_name = 'step_tasks'
          AND column_name = 'last_worker_id';
      `
      );

      assert(result.success, `Query failed: ${result.stderr}`);

      const lines = result.stdout.split("\n").filter((l) => l.trim());
      assert(lines.length === 1, "last_worker_id column not found");

      const parts = lines[0]!.split("|");
      assert(parts[0] === "last_worker_id", `Expected last_worker_id, got ${parts[0]}`);
      assert(parts[1] === "uuid", `last_worker_id should be uuid, got ${parts[1]}`);
      assert(parts[2] === "YES", `last_worker_id should be nullable, got ${parts[2]}`);
    });

    // ========================================================================
    // T3.4: workers table exists (edge worker tracking)
    // ========================================================================

    await test("T3.4: workers table has 7 expected columns", async () => {
      const result = await runSQL(
        CONTAINER,
        DATABASE,
        `
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'pgflow' AND table_name = 'workers'
        ORDER BY ordinal_position;
      `
      );

      assert(result.success, `Query failed: ${result.stderr}`);

      const columns = result.stdout.split("\n").filter((l) => l.trim());
      assert(columns.length === 7, `Expected 7 columns, found ${columns.length}`);

      const expectedColumns = [
        "worker_id",
        "queue_name",
        "function_name",
        "started_at",
        "deprecated_at",
        "stopped_at",
        "last_heartbeat_at",
      ];

      for (let i = 0; i < expectedColumns.length; i++) {
        assert(
          columns[i] === expectedColumns[i],
          `Column ${i} should be ${expectedColumns[i]}, got ${columns[i]}`
        );
      }
    });

    // ========================================================================
    // T3.5: Function signature verification (key functions)
    // ========================================================================

    await test("T3.5: start_tasks signature includes worker_id", async () => {
      const result = await runSQL(
        CONTAINER,
        DATABASE,
        `
        SELECT proname, pronargs, proargnames
        FROM pg_proc
        WHERE pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'pgflow')
          AND proname = 'start_tasks';
      `
      );

      assert(result.success, `Query failed: ${result.stderr}`);

      const lines = result.stdout.split("\n").filter((l) => l.trim());
      assert(lines.length >= 1, "start_tasks function not found");

      const parts = lines[0]!.split("|");
      assert(parts[0] === "start_tasks", `Expected start_tasks, got ${parts[0]}`);
      assert(parts[1] === "3", `start_tasks should have 3 arguments, got ${parts[1]}`);

      // proargnames is a PostgreSQL array format: {arg1,arg2,arg3}
      const argNames = parts[2]!;
      assert(argNames.includes("flow_slug"), `Expected flow_slug in arguments, got ${argNames}`);
      assert(argNames.includes("msg_ids"), `Expected msg_ids in arguments, got ${argNames}`);
      assert(argNames.includes("worker_id"), `Expected worker_id in arguments, got ${argNames}`);
    });

    await test("T3.5: set_vt_batch function exists", async () => {
      const result = await runSQL(
        CONTAINER,
        DATABASE,
        `
        SELECT proname, pronargs
        FROM pg_proc
        WHERE pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'pgflow')
          AND proname = 'set_vt_batch';
      `
      );

      assert(result.success, `Query failed: ${result.stderr}`);

      const lines = result.stdout.split("\n").filter((l) => l.trim());
      assert(lines.length === 1, "set_vt_batch function not found");

      const parts = lines[0]!.split("|");
      assert(parts[0] === "set_vt_batch", `Expected set_vt_batch, got ${parts[0]}`);
      assert(parts[1] === "3", `set_vt_batch should have 3 arguments, got ${parts[1]}`);
    });

    await test("T3.5: step_task_record type includes flow_input", async () => {
      const result = await runSQL(
        CONTAINER,
        DATABASE,
        `
        SELECT a.attname FROM pg_attribute a
        JOIN pg_type t ON a.attrelid = t.typrelid
        WHERE t.typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'pgflow')
          AND t.typname = 'step_task_record'
          AND a.attnum > 0
          AND NOT a.attisdropped
        ORDER BY a.attnum;
      `
      );

      assert(result.success, `Query failed: ${result.stderr}`);

      const attributes = result.stdout.split("\n").filter((l) => l.trim());
      assert(attributes.length >= 7, `Expected at least 7 attributes, found ${attributes.length}`);

      const expectedAttrs = [
        "flow_slug",
        "run_id",
        "step_slug",
        "input",
        "msg_id",
        "task_index",
        "flow_input",
      ];

      for (const expected of expectedAttrs) {
        assert(
          attributes.includes(expected),
          `step_task_record should include ${expected}, found: ${attributes.join(", ")}`
        );
      }
    });

    // ========================================================================
    // T3.6: cascade_complete_taskless_steps exists
    // ========================================================================

    await test("T3.6: cascade_complete_taskless_steps function exists", async () => {
      const result = await runSQL(
        CONTAINER,
        DATABASE,
        `
        SELECT proname FROM pg_proc
        WHERE pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'pgflow')
          AND proname = 'cascade_complete_taskless_steps';
      `
      );

      assert(result.success, `Query failed: ${result.stderr}`);

      const lines = result.stdout.split("\n").filter((l) => l.trim());
      assert(lines.length === 1, "cascade_complete_taskless_steps function not found");
      assert(
        lines[0] === "cascade_complete_taskless_steps",
        `Expected cascade_complete_taskless_steps, got ${lines[0]}`
      );
    });

    await test("T3.6: Empty map flow auto-cascades to completion", async () => {
      // Create flow with map step
      const createFlow = await runSQL(
        CONTAINER,
        DATABASE,
        `SELECT pgflow.create_flow('cascade_test');`
      );
      assert(createFlow.success, `create_flow failed: ${createFlow.stderr}`);

      // Add map step with empty dependencies array
      const addStep = await runSQL(
        CONTAINER,
        DATABASE,
        `
        SELECT pgflow.add_step(
          'cascade_test',
          'map_step',
          ARRAY[]::text[],
          NULL,
          NULL,
          NULL,
          NULL,
          'map'
        );
      `
      );
      assert(addStep.success, `add_step failed: ${addStep.stderr}`);

      // Start flow with empty array (empty map = zero tasks)
      const startFlow = await runSQL(
        CONTAINER,
        DATABASE,
        `SELECT * FROM pgflow.start_flow('cascade_test', '[]'::jsonb);`
      );
      assert(startFlow.success, `start_flow failed: ${startFlow.stderr}`);

      // Verify run completes immediately (cascade should handle empty map)
      const checkStatus = await runSQL(
        CONTAINER,
        DATABASE,
        `SELECT status FROM pgflow.runs WHERE flow_slug = 'cascade_test';`
      );
      assert(checkStatus.success, `Query failed: ${checkStatus.stderr}`);

      const status = checkStatus.stdout.trim();
      assert(status === "completed", `Expected completed status, got: ${status}`);
    });

    // ========================================================================
    // Summary
    // ========================================================================

    console.log("\n" + "=".repeat(80));
    console.log("Test Summary");
    console.log("=".repeat(80));

    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;
    const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

    console.log(`Total: ${results.length} tests`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    console.log(`Duration: ${totalDuration}ms`);

    if (failed > 0) {
      console.log("\nFailed tests:");
      results
        .filter((r) => !r.passed)
        .forEach((r) => {
          console.log(`  ❌ ${r.name}`);
          console.log(`     ${r.error}`);
        });
    }

    process.exit(failed > 0 ? 1 : 0);
  } catch (error) {
    console.error("\n❌ Fatal error:", error);
    process.exit(1);
  } finally {
    if (!useExistingContainer) {
      console.log("\n🧹 Cleaning up test container...");
      await harness.cleanup(CONTAINER);
    }
  }
}

// ============================================================================
// Entry Point
// ============================================================================

runTests();
