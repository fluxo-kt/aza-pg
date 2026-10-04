#!/usr/bin/env bun
/**
 * Replica stack (stacks/replica) attached to a primary stack, then failover — both from staged copies.
 *
 * The replica must attach with the slot the PRIMARY's initdb created (02-replication.sh): the test never creates
 * or recreates it, because doing so hides a primary that ships without the slot the replica's setup requires.
 * Streaming is proven by rows written on the primary arriving on the replica (polled, never slept on), and the
 * replica's walreceiver must be using that slot. Failover runs last because promotion is destructive: the
 * primary is stopped, the replica promoted, and it must keep every streamed row and accept writes.
 *
 * Usage: bun scripts/test/test-replica-stack.ts [image]
 */

import { $ } from "bun";
import { TIMEOUTS } from "../config/test-timeouts";
import { waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";
import { stageStack, type StagedStack } from "./staged-stack";

const image = resolveImageTag();
const suffix = crypto.randomUUID().slice(0, 8);
const POSTGRES_PASSWORD = `pg_${suffix}`;
const PG_REPLICATION_PASSWORD = `repl_${suffix}`;
const SLOT = "replica_slot_1"; // both stacks' compose default; neither stage overrides it
const ROWS = 100;
// A standby refuses to start when max_connections or max_worker_processes is below the primary's, and auto-config
// derives both from the container's RAM and CPUs, so both stacks get the same limits — the documented rule for
// replicas (the shipped compose defaults differ: primary 2048m/2 CPUs, replica 512m/0.5).
const LIMITS = { POSTGRES_MEMORY_LIMIT: "2048m", POSTGRES_CPU_LIMIT: "2" };

const failures: string[] = [];
async function step(name: string, body: () => Promise<void>): Promise<void> {
  const started = Date.now();
  try {
    await body();
    console.log(`✅ ${name} (${Date.now() - started} ms)`);
  } catch (err) {
    failures.push(name);
    console.error(`❌ ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function psql(container: string, sql: string): Promise<string> {
  const r = await $`docker exec ${container} psql -X -v ON_ERROR_STOP=1 -U postgres -tAc ${sql}`
    .nothrow()
    .quiet();
  if (r.exitCode !== 0) throw new Error(`psql exited ${r.exitCode}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

/** Poll `sql` until it returns `expected`; readiness is observed, the sleep only paces polling. */
async function until(
  container: string,
  sql: string,
  expected: string,
  seconds: number
): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  let last = "";
  while (Date.now() < deadline) {
    last = await psql(container, sql).catch((e: Error) => e.message);
    if (last === expected) return;
    await Bun.sleep(250);
  }
  throw new Error(`"${sql}" returned "${last}", expected "${expected}" within ${seconds}s`);
}

async function composeUp(stage: StagedStack, ...services: string[]): Promise<void> {
  const up = await stage
    .compose("up", "-d", ...services)
    .nothrow()
    .quiet();
  if (up.exitCode !== 0) {
    const logs = await stage.compose("logs", "--tail", "40").nothrow().quiet().text();
    throw new Error(`${stage.project}: compose up failed: ${up.stderr.toString().trim()}\n${logs}`);
  }
}

const stages: StagedStack[] = [];
const started = Date.now();
try {
  const primary = await stageStack("primary", {
    POSTGRES_IMAGE: image,
    POSTGRES_PASSWORD,
    PG_REPLICATION_PASSWORD,
    PGBOUNCER_AUTH_PASS: `pgb_${suffix}`,
    ...LIMITS,
  });
  stages.push(primary);
  const primaryDb = `${primary.project}-postgres-primary`;
  console.log(`Primary ${primary.project}, replica follows (${image})`);
  // PgBouncer and the primary's exporters are the primary-stack suite's subject; the replica needs PostgreSQL only.
  await composeUp(primary, "postgres");
  await waitForPostgres({ container: primaryDb, timeout: TIMEOUTS.startup });

  const replica = await stageStack("replica", {
    POSTGRES_IMAGE: image,
    POSTGRES_PASSWORD,
    PG_REPLICATION_PASSWORD,
    PRIMARY_HOST: primaryDb,
    POSTGRES_NETWORK_NAME: primary.env.POSTGRES_NETWORK_NAME ?? "",
    ...LIMITS,
  });
  stages.push(replica);
  const replicaDb = `${replica.project}-postgres-replica`;
  // Returns once the replica is healthy (its exporter depends on it). waitForPostgres cannot be used here: it waits
  // for "ready to accept connections", and a standby logs "ready to accept read-only connections".
  await composeUp(replica);

  await step(`replica streams through the initdb-created slot ${SLOT}`, async () => {
    await until(
      replicaDb,
      "SELECT status || '|' || coalesce(slot_name, '') FROM pg_stat_wal_receiver",
      `streaming|${SLOT}`,
      TIMEOUTS.health
    );
    await until(
      primaryDb,
      `SELECT active FROM pg_replication_slots WHERE slot_name = '${SLOT}'`,
      "t",
      TIMEOUTS.health
    );
  });

  await step(`${ROWS} rows written on the primary arrive on the replica`, async () => {
    await psql(
      primaryDb,
      `CREATE TABLE streamed AS SELECT g AS id FROM generate_series(1, ${ROWS}) g`
    );
    await until(replicaDb, "SELECT count(*) FROM streamed", String(ROWS), TIMEOUTS.health);
  });

  await step("replica postgres_exporter reports pg_up 1", async () => {
    const port = await replica.hostPort("postgres_exporter", 9187);
    const deadline = Date.now() + TIMEOUTS.health * 1000;
    let last = "";
    while (Date.now() < deadline) {
      last = await fetch(`http://127.0.0.1:${port}/metrics`).then((r) => r.text(), String);
      if (/^pg_up 1$/m.test(last)) return;
      await Bun.sleep(500);
    }
    throw new Error(
      `pg_up never 1; last: ${last.split("\n").find((l) => l.startsWith("pg_up ")) ?? "(absent)"}`
    );
  });

  // Destructive: stays last.
  await step(
    "failover: primary stopped, replica promoted keeps the rows and accepts writes",
    async () => {
      await $`docker stop ${primaryDb}`.quiet();
      const promoted = await psql(replicaDb, "SELECT pg_promote(wait => true)");
      if (promoted !== "t") throw new Error(`pg_promote returned "${promoted}"`);
      await until(replicaDb, "SELECT pg_is_in_recovery()", "f", TIMEOUTS.health);
      await psql(replicaDb, `INSERT INTO streamed VALUES (${ROWS + 1})`);
      const count = await psql(replicaDb, "SELECT count(*) FROM streamed");
      if (count !== String(ROWS + 1))
        throw new Error(`row count after promotion and insert: ${count}`);
    }
  );
} catch (err) {
  failures.push("stack start");
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
} finally {
  // Replica first: it joins the primary's network, which the primary's removal deletes.
  for (const stage of stages.reverse()) await stage.remove();
}

console.log(
  `\n${failures.length ? `FAILED: ${failures.join(", ")}` : "PASSED"} in ${Date.now() - started} ms`
);
process.exit(failures.length ? 1 : 0);
