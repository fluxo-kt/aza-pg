#!/usr/bin/env bun
/**
 * pgflow in the shipped image: one container serves every case.
 *
 * Covers what the image itself does for pgflow: initdb installs the schema with aza-pg's patches into POSTGRES_DB,
 * leaves upstream telemetry unscheduled, and puts the image's realtime.send() into template1 so every new database
 * inherits it. Cases then run pgflow for real (claim, complete, fail, map, visibility timeout) through that
 * realtime.send(), and install the image's /opt/pgflow files into a new database that has neither supabase_vault nor
 * pg_cron, where aza-pg's local patches must take over.
 *
 * Usage: bun scripts/test/test-pgflow.ts [image]   (also --image=TAG or POSTGRES_IMAGE; default: the local build)
 */

import { resolveImageTag } from "./image-resolver";
import { generateUniqueProjectName, waitForPostgres } from "../utils/docker";

const IMAGE = resolveImageTag();
const CONTAINER = generateUniqueProjectName("aza-pg-pgflow");
// POSTGRES_DB of the container: initdb installs pgflow, pg_cron and supabase_vault here.
const MAIN_DB = "postgres";
// Created after initdb from template1; gets pgmq + pg_net + the image's pgflow files, never vault or pg_cron.
const NO_VAULT_DB = "pgflow_no_vault";
// Created after initdb from template1; nothing installed, so realtime.send() runs with pgmq and pg_net absent.
const BARE_DB = "realtime_bare";

interface CaseResult {
  name: string;
  passed: boolean;
  ms: number;
  error?: string;
}

const results: CaseResult[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const start = performance.now();
  try {
    await fn();
    const ms = Math.round(performance.now() - start);
    results.push({ name, passed: true, ms });
    console.log(`✅ ${name} (${ms}ms)`);
  } catch (err) {
    const ms = Math.round(performance.now() - start);
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, ms, error: message });
    console.log(`❌ ${name} (${ms}ms)\n   ${message.replaceAll("\n", "\n   ")}`);
  }
}

function expectEqual(actual: string, expected: string, what: string): void {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/**
 * Runs SQL in one psql session and returns its rows; throws with psql's error on failure.
 * ON_ERROR_STOP makes psql exit non-zero on the first SQL error (without it psql exits 0 after a failed statement);
 * -q drops command tags (SET, CREATE ...) so stdout holds only query rows.
 */
async function query(database: string, sql: string): Promise<string> {
  const proc = Bun.spawn(
    [
      "docker",
      "exec",
      "-i",
      "-u",
      "postgres",
      CONTAINER,
      "psql",
      "-X",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-d",
      database,
      "-t",
      "-A",
    ],
    { stdin: new Blob([sql]), stdout: "pipe", stderr: "pipe" }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    // psql's CONTEXT block repeats whole function bodies; the ERROR and DETAIL lines carry the diagnosis.
    const diagnosis = (stderr.trim() || stdout.trim()).split("\nCONTEXT:")[0];
    throw new Error(`SQL failed in ${database}: ${diagnosis}\n   SQL: ${sql.trim()}`);
  }
  return stdout.trim();
}

async function dockerExec(args: string[]): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(["docker", "exec", CONTAINER, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: (out + err).trim() };
}

/** Defines a flow of single steps; each entry is [step, deps]. */
async function createFlow(
  database: string,
  flow: string,
  steps: [string, string[]][],
  maxAttempts = 3
): Promise<void> {
  const addSteps = steps
    .map(([step, deps]) => {
      const depList = deps.map((dep) => `'${dep}'`).join(",");
      return `SELECT pgflow.add_step('${flow}', '${step}', ARRAY[${depList}]::text[], ${maxAttempts}, 1, 30);`;
    })
    .join("\n");
  await query(
    database,
    `SELECT pgflow.create_flow('${flow}', ${maxAttempts}, 1, 60);\n${addSteps}`
  );
}

/**
 * Reads `count` messages from the flow's queue and claims their tasks the way a pgflow worker does: the worker is
 * registered first (step_tasks.last_worker_id references pgflow.workers), and pgflow 0.17 takes the queue name
 * explicitly; plain flows store lower(flow_slug). A test that patched step_tasks by hand would pass while the worker
 * path is broken.
 */
async function claimTasks(database: string, flow: string, count: number): Promise<string[]> {
  const ids = (await query(database, `SELECT msg_id FROM pgmq.read('${flow}', 60, ${count})`))
    .split("\n")
    .filter(Boolean);
  expectEqual(String(ids.length), String(count), `messages read from queue '${flow}'`);
  const workerId = crypto.randomUUID();
  const claimed = await query(
    database,
    `INSERT INTO pgflow.workers (worker_id, queue_name, function_name)
     VALUES ('${workerId}', lower('${flow}'), 'test-pgflow');
     SELECT count(*) FROM pgflow.start_tasks('${flow}', ARRAY[${ids.join(",")}]::bigint[], '${workerId}', lower('${flow}'));`
  );
  expectEqual(claimed, String(count), `tasks claimed by start_tasks for messages ${ids.join(",")}`);
  return ids;
}

async function startRun(database: string, flow: string, input: string): Promise<string> {
  const runId = await query(
    database,
    `SELECT run_id FROM pgflow.start_flow('${flow}', '${input}'::jsonb)`
  );
  if (!/^[0-9a-f-]{36}$/.test(runId)) throw new Error(`start_flow returned run_id '${runId}'`);
  return runId;
}

async function stepStatus(database: string, runId: string, step: string): Promise<string> {
  return query(
    database,
    `SELECT status FROM pgflow.step_states WHERE run_id = '${runId}' AND step_slug = '${step}'`
  );
}

async function removeContainer(): Promise<void> {
  await Bun.spawn(["docker", "rm", "-f", "-v", CONTAINER], { stdout: "ignore", stderr: "ignore" })
    .exited;
}

async function main(): Promise<void> {
  console.log(`pgflow image tests — image ${IMAGE}, container ${CONTAINER}`);
  const run = Bun.spawn(
    ["docker", "run", "-d", "--name", CONTAINER, "-e", "POSTGRES_PASSWORD=test", IMAGE],
    { stdout: "ignore", stderr: "pipe" }
  );
  const [runErr, runCode] = await Promise.all([new Response(run.stderr).text(), run.exited]);
  if (runCode !== 0) throw new Error(`docker run failed: ${runErr.trim()}`);
  await waitForPostgres({ container: CONTAINER, timeout: 120 });

  // --- initdb state of POSTGRES_DB -------------------------------------------------------------------------------

  await test("initdb leaves pgflow telemetry unscheduled", async () => {
    // pgflow's own requeue job is the control: it proves cron.job is readable and holds what the install scheduled.
    const jobs = (await query(MAIN_DB, "SELECT jobname FROM cron.job ORDER BY jobname")).split(
      "\n"
    );
    if (!jobs.includes("pgflow_requeue_stalled_tasks")) {
      throw new Error(`control job pgflow_requeue_stalled_tasks missing; cron.job holds: ${jobs}`);
    }
    const telemetry = jobs.filter((job) => job.startsWith("pgflow_telemetry"));
    expectEqual(telemetry.join(","), "", "telemetry jobs scheduled at initdb");
  });

  await test("security patches pin search_path to empty on SECURITY DEFINER functions", async () => {
    // Upstream defines both functions SECURITY DEFINER without SET search_path (AZA-PGFLOW-001/002).
    const config = await query(
      MAIN_DB,
      `SELECT p.proname || ' ' || p.prosecdef || ' ' || coalesce(array_to_string(p.proconfig, ','), '<none>')
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'pgflow' AND p.proname IN ('get_run_with_states', 'start_flow_with_states')
       ORDER BY 1`
    );
    expectEqual(
      config,
      'get_run_with_states true search_path=""\nstart_flow_with_states true search_path=""',
      "proname prosecdef proconfig"
    );
  });

  // --- pgflow lifecycle in POSTGRES_DB, through the image's realtime.send() ----------------------------------------

  const flow = `etl_${Date.now()}`;
  let runId = "";

  await test("create a flow with dependent steps", async () => {
    await createFlow(MAIN_DB, flow, [
      ["extract", []],
      ["transform", ["extract"]],
      ["load", ["transform"]],
    ]);
    expectEqual(
      await query(
        MAIN_DB,
        `SELECT (SELECT count(*) FROM pgflow.steps WHERE flow_slug = '${flow}') || ' ' ||
                (SELECT count(*) FROM pgflow.deps WHERE flow_slug = '${flow}')`
      ),
      "3 2",
      "steps and deps"
    );
  });

  await test("start_flow starts the run and only the root step", async () => {
    runId = await startRun(MAIN_DB, flow, '{"source": "test"}');
    expectEqual(
      await query(MAIN_DB, `SELECT status FROM pgflow.runs WHERE run_id = '${runId}'`),
      "started",
      "run status"
    );
    expectEqual(
      await query(
        MAIN_DB,
        `SELECT string_agg(step_slug || '=' || status, ',' ORDER BY step_slug)
         FROM pgflow.step_states WHERE run_id = '${runId}'`
      ),
      "extract=started,load=created,transform=created",
      "step states"
    );
  });

  await test("completing the claimed root task starts its dependent", async () => {
    const [msgId] = await claimTasks(MAIN_DB, flow, 1);
    expectEqual(
      await query(
        MAIN_DB,
        `SELECT message_id FROM pgflow.step_tasks WHERE run_id = '${runId}' AND step_slug = 'extract'`
      ),
      msgId ?? "",
      "step_tasks.message_id of the claimed message"
    );
    await query(
      MAIN_DB,
      `SELECT pgflow.complete_task('${runId}', 'extract', 0, '{"records": 100}'::jsonb)`
    );
    expectEqual(await stepStatus(MAIN_DB, runId, "extract"), "completed", "extract status");
    expectEqual(await stepStatus(MAIN_DB, runId, "transform"), "started", "transform status");
  });

  await test("completing the remaining tasks completes the run", async () => {
    for (const step of ["transform", "load"]) {
      await claimTasks(MAIN_DB, flow, 1);
      await query(MAIN_DB, `SELECT pgflow.complete_task('${runId}', '${step}', 0, '{"ok": true}')`);
    }
    expectEqual(
      await query(
        MAIN_DB,
        `SELECT r.status || ' ' || count(*) FILTER (WHERE s.status = 'completed')
         FROM pgflow.runs r JOIN pgflow.step_states s USING (run_id)
         WHERE r.run_id = '${runId}' GROUP BY r.status`
      ),
      "completed 3",
      "run status and completed steps"
    );
  });

  await test("fail_task requeues a task that has attempts left", async () => {
    const retryFlow = `retry_${Date.now()}`;
    await createFlow(MAIN_DB, retryFlow, [["failing", []]]);
    const retryRun = await startRun(MAIN_DB, retryFlow, "{}");
    await claimTasks(MAIN_DB, retryFlow, 1);
    expectEqual(
      await query(
        MAIN_DB,
        `SELECT status || '|' || error_message || '|' || attempts_count
         FROM pgflow.fail_task('${retryRun}', 'failing', 0, 'Test failure')`
      ),
      "queued|Test failure|1",
      "row returned by fail_task"
    );
  });

  await test("a root map step fans out one task per array element", async () => {
    const mapFlow = `map_${Date.now()}`;
    await query(
      MAIN_DB,
      `SELECT pgflow.create_flow('${mapFlow}', 3, 1, 60);
       SELECT pgflow.add_step('${mapFlow}', 'upper', ARRAY[]::text[], step_type => 'map');`
    );
    const mapRun = await startRun(MAIN_DB, mapFlow, '["a", "b", "c"]');
    expectEqual(
      await query(
        MAIN_DB,
        `SELECT string_agg(task_index::text, ',' ORDER BY task_index) FROM pgflow.step_tasks WHERE run_id = '${mapRun}'`
      ),
      "0,1,2",
      "task indexes of the map step"
    );
    await claimTasks(MAIN_DB, mapFlow, 3);
    for (const [index, letter] of ["A", "B", "C"].entries()) {
      await query(
        MAIN_DB,
        `SELECT pgflow.complete_task('${mapRun}', 'upper', ${index}, '"${letter}"'::jsonb)`
      );
    }
    expectEqual(
      await query(
        MAIN_DB,
        `SELECT status || ' ' || output FROM pgflow.runs WHERE run_id = '${mapRun}'`
      ),
      'completed {"upper": ["A", "B", "C"]}',
      "map run status and aggregated output"
    );
  });

  await test("set_vt_batch hides the message for the new visibility timeout", async () => {
    const vtFlow = `vt_${Date.now()}`;
    await createFlow(MAIN_DB, vtFlow, [["only", []]]);
    const vtRun = await startRun(MAIN_DB, vtFlow, "{}");
    const msgId = await query(
      MAIN_DB,
      `SELECT message_id FROM pgflow.step_tasks WHERE run_id = '${vtRun}'`
    );
    expectEqual(
      await query(
        MAIN_DB,
        `SELECT msg_id FROM pgflow.set_vt_batch('${vtFlow}', ARRAY[${msgId}]::bigint[], ARRAY[60])`
      ),
      msgId,
      "message returned by set_vt_batch"
    );
    // A fresh message is visible at once; only a visibility timeout moved into the future hides it from read.
    expectEqual(
      await query(MAIN_DB, `SELECT count(*) FROM pgmq.read('${vtFlow}', 30, 10)`),
      "0",
      "messages still visible after set_vt_batch"
    );
  });

  // --- realtime.send(): inherited by new databases, guarded optional delivery ------------------------------------

  // Session GUCs that switch on realtime.send()'s optional pgmq and pg_net branches. Port 9 (discard) on loopback:
  // any request pg_net would send cannot leave the container.
  const deliveryOn = `SET realtime.pgmq_enabled = 'true';
SET realtime.webhook_url = 'http://127.0.0.1:9/pgflow-test';`;

  await test("realtime.send() delivers through pgmq and pg_net when they are installed", async () => {
    // Control for the next case: proves these GUCs really reach the optional branches. Rolled back, so nothing is sent.
    const delivered = await query(
      MAIN_DB,
      `BEGIN;
${deliveryOn}
SELECT realtime.send('{"k": 1}'::jsonb, 'test:event', 'test_topic', false);
SELECT (SELECT count(*) FROM pgmq.read('pgflow_events', 30, 10) WHERE message->>'event' = 'test:event')
    || ' ' || (SELECT count(*) FROM net.http_request_queue WHERE url = 'http://127.0.0.1:9/pgflow-test');
ROLLBACK;`
    );
    expectEqual(delivered.split("\n").at(-1) ?? "", "1 1", "pgmq messages and pg_net requests");
  });

  await test("new database inherits realtime.send(), which degrades when pgmq and pg_net are absent", async () => {
    await query(MAIN_DB, `CREATE DATABASE ${BARE_DB}`);
    const output = await query(
      BARE_DB,
      `${deliveryOn}
SELECT realtime.send('{"k": 1}'::jsonb, 'test:event', 'test_topic', false);
SELECT count(*) FROM pg_extension WHERE extname IN ('pgmq', 'pg_net');`
    );
    expectEqual(output.split("\n").at(-1) ?? "", "0", "pgmq/pg_net installed in the bare database");
  });

  // --- the image's pgflow files in a new database without supabase_vault and pg_cron ------------------------------

  await test("pgflow installs from /opt/pgflow into a new database without vault and pg_cron", async () => {
    await query(MAIN_DB, `CREATE DATABASE ${NO_VAULT_DB}`);
    await query(NO_VAULT_DB, "CREATE EXTENSION pgmq; CREATE EXTENSION pg_net;");
    // Exactly the documented commands (docs/PGFLOW.md "New Databases"): the shipped schema.sql must install unchanged
    // outside cron.database_name, skipping pg_cron there. Vault is then dropped so the next case runs without it.
    const install = await dockerExec([
      "bash",
      "-c",
      `set -euo pipefail
psql -X -q -v ON_ERROR_STOP=1 -U postgres -d ${NO_VAULT_DB} -f /opt/pgflow/schema.sql >/dev/null
psql -X -q -v ON_ERROR_STOP=1 -U postgres -d ${NO_VAULT_DB} -f /opt/pgflow/security-patches.sql >/dev/null
psql -X -q -v ON_ERROR_STOP=1 -U postgres -d ${NO_VAULT_DB} -c 'DROP EXTENSION IF EXISTS supabase_vault' >/dev/null`,
    ]);
    if (install.code !== 0) throw new Error(`install failed:\n${install.output}`);
    expectEqual(
      await query(
        NO_VAULT_DB,
        `SELECT count(*) FROM pg_extension WHERE extname IN ('supabase_vault', 'pg_cron')`
      ),
      "0",
      "vault/pg_cron extensions in the new database"
    );
  });

  await test("local patches run without vault and pg_cron", async () => {
    const output = await query(
      NO_VAULT_DB,
      `SELECT pgflow.setup_ensure_workers_cron();
SELECT pgflow.setup_requeue_stalled_tasks_cron();
SELECT cron_deleted FROM pgflow.cleanup_ensure_workers_logs();
SELECT pgflow.aza_vault_secret('x') IS NULL;
-- A registered HTTP worker makes ensure_workers() evaluate its credentials, i.e. read Vault through the patch.
INSERT INTO pgflow.worker_functions (function_name) VALUES ('t1_worker');
SELECT count(*) FROM pgflow.ensure_workers();`
    );
    expectEqual(
      output,
      [
        "pg_cron is not available in this database; skipped pgflow worker cron setup",
        "pg_cron is not available in this database; skipped pgflow stalled-task cron setup",
        "0",
        "t",
        "0",
      ].join("\n"),
      "setup_*_cron, cleanup_ensure_workers_logs, aza_vault_secret, ensure_workers"
    );
  });

  await test("start_flow runs in the new database through the inherited realtime.send()", async () => {
    const newFlow = `newdb_${Date.now()}`;
    await createFlow(NO_VAULT_DB, newFlow, [["only", []]]);
    const newRun = await startRun(NO_VAULT_DB, newFlow, "{}");
    expectEqual(await stepStatus(NO_VAULT_DB, newRun, "only"), "started", "root step status");
    await claimTasks(NO_VAULT_DB, newFlow, 1);
  });
}

let fatal: unknown;
process.on("SIGINT", () => void removeContainer().then(() => process.exit(130)));
process.on("SIGTERM", () => void removeContainer().then(() => process.exit(143)));
const started = performance.now();
try {
  await main();
} catch (err) {
  fatal = err;
} finally {
  await removeContainer();
}

const failed = results.filter((r) => !r.passed);
console.log(
  `\n${results.length - failed.length}/${results.length} passed, ${failed.length} failed, ` +
    `${Math.round((performance.now() - started) / 1000)}s`
);
for (const r of failed) console.log(`  FAILED ${r.name}: ${r.error}`);
if (fatal) console.error(`Setup failed: ${fatal instanceof Error ? fatal.message : String(fatal)}`);
process.exit(failed.length > 0 || fatal ? 1 : 0);
