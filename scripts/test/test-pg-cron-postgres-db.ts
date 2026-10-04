#!/usr/bin/env bun
/**
 * pg_cron and pgflow follow POSTGRES_DB (regression guard for 3b8c742).
 *
 * pg_cron runs jobs only in the database named by `cron.database_name`, which the entrypoint sets
 * from POSTGRES_DB; the init scripts must create pg_cron and install pgflow in that same database.
 * A wrong pairing still boots cleanly, so each case schedules a 1-second job and waits for it to
 * write a row: only a job that actually ran proves the scheduler is attached to the right database.
 *
 * Two containers boot in parallel: the default database and a custom POSTGRES_DB.
 *
 * Usage: bun scripts/test/test-pg-cron-postgres-db.ts [image] [--image=TAG]
 */
import { $ } from "bun";
import { generateUniqueContainerName, waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";

const image = resolveImageTag();
const REQUIRED_PGFLOW_TABLES = [
  "flows",
  "steps",
  "deps",
  "workers",
  "worker_functions",
  "runs",
  "step_states",
  "step_tasks",
];

interface Case {
  container: string;
  database: string;
  /** Extra docker run args selecting the database. */
  env: string[];
}
const cases: Case[] = [
  { container: generateUniqueContainerName("aza-pg-cron-default"), database: "postgres", env: [] },
  {
    container: generateUniqueContainerName("aza-pg-cron-custom"),
    database: "my_custom_db",
    env: ["-e", "POSTGRES_DB=my_custom_db"],
  },
];

async function sql(container: string, database: string, query: string): Promise<string> {
  const r =
    await $`docker exec ${container} psql -X -v ON_ERROR_STOP=1 -U postgres -d ${database} -tA -c ${query}`
      .quiet()
      .nothrow();
  if (r.exitCode !== 0) throw new Error(`[${database}] ${query}\n${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

async function verify({ container, database }: Case): Promise<void> {
  const setting = await sql(container, database, "SHOW cron.database_name");
  if (setting !== database) throw new Error(`cron.database_name = ${setting}, want ${database}`);

  const missing = await sql(
    container,
    database,
    `SELECT coalesce(string_agg(t, ', '), '') FROM unnest(ARRAY['${REQUIRED_PGFLOW_TABLES.join("','")}']) t
       WHERE to_regclass('pgflow.' || t) IS NULL`
  );
  if (missing !== "") throw new Error(`pgflow tables missing in ${database}: ${missing}`);

  if (database !== "postgres") {
    const stray = await sql(
      container,
      "postgres",
      "SELECT (SELECT count(*) FROM pg_extension WHERE extname = 'pg_cron') || '/' || (SELECT count(*) FROM pg_namespace WHERE nspname = 'pgflow')"
    );
    if (stray !== "0/0") throw new Error(`pg_cron/pgflow also present in postgres: ${stray}`);
  }

  await sql(container, database, "CREATE TABLE t2b_cron_tick (at timestamptz DEFAULT now())");
  await sql(
    container,
    database,
    "SELECT cron.schedule('t2b_tick', '1 seconds', 'INSERT INTO t2b_cron_tick DEFAULT VALUES')"
  );
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (Number(await sql(container, database, "SELECT count(*) FROM t2b_cron_tick")) > 0) return;
    await Bun.sleep(250);
  }
  const runs = await sql(
    container,
    database,
    "SELECT coalesce(string_agg(status || ': ' || coalesce(return_message, ''), '; '), 'no runs') FROM cron.job_run_details"
  );
  throw new Error(`scheduled job never wrote a row in ${database} within 20s (${runs})`);
}

let failed = false;
try {
  await Promise.all(
    cases.map((c) =>
      $`docker run -d --name ${c.container} -e POSTGRES_PASSWORD=postgres ${c.env} ${image}`.quiet()
    )
  );
  await Promise.all(cases.map((c) => waitForPostgres({ container: c.container, timeout: 120 })));
  const outcomes = await Promise.allSettled(cases.map(verify));
  outcomes.forEach((o, i) => {
    const name = `pg_cron + pgflow follow POSTGRES_DB=${cases[i]?.database}`;
    if (o.status === "fulfilled") {
      console.log(`PASS: ${name}`);
    } else {
      failed = true;
      console.error(`FAIL: ${name}: ${o.reason instanceof Error ? o.reason.message : o.reason}`);
    }
  });
} catch (err) {
  failed = true;
  console.error(`FAIL: setup: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await $`docker rm -f -v ${cases.map((c) => c.container)}`.quiet().nothrow();
}
process.exit(failed ? 1 : 0);
