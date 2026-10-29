#!/usr/bin/env bun
/**
 * pg_cron and pgflow follow POSTGRES_DB (regression guard for 3b8c742).
 *
 * pg_cron runs jobs only in the database named by `cron.database_name`, which the entrypoint sets
 * from POSTGRES_DB; the init scripts must create pg_cron and install pgflow in that same database.
 * A wrong pairing still boots cleanly, so each case schedules a 1-second job and waits for it to
 * write a row: only a job that actually ran proves the scheduler is attached to the right database.
 *
 * Each case also runs the image's healthcheck, which must find the extensions in that same database
 * as that same superuser: a healthcheck looking elsewhere leaves the container unhealthy for good.
 *
 * Three containers boot in parallel: the default database, a custom POSTGRES_DB, and a superuser
 * renamed through POSTGRES_USER_FILE (Docker secrets: no postgres role exists, POSTGRES_DB defaults to
 * that user's name, and only the file carries it, so the image must read it the way the official
 * entrypoint does). The plain POSTGRES_USER rename runs in the primary-stack suite.
 *
 * Usage: bun scripts/test/test-pg-cron-postgres-db.ts [image] [--image=TAG]
 */
import { $ } from "bun";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { TIMEOUTS } from "../config/test-timeouts";
import { EPHEMERAL_PGDATA, generateUniqueContainerName, waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";

const image = resolveImageTag();
const userFile = join(tmpdir(), `${generateUniqueContainerName("aza-pg-cron-user")}.secret`);
await Bun.write(userFile, "admin\n");
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
  /** The superuser initdb creates. */
  user: string;
  /** Extra docker run args selecting the database and superuser. */
  env: string[];
}
const cases: Case[] = [
  {
    container: generateUniqueContainerName("aza-pg-cron-default"),
    database: "postgres",
    user: "postgres",
    env: [],
  },
  {
    container: generateUniqueContainerName("aza-pg-cron-custom"),
    database: "my_custom_db",
    user: "postgres",
    env: ["-e", "POSTGRES_DB=my_custom_db"],
  },
  {
    container: generateUniqueContainerName("aza-pg-cron-user"),
    database: "admin",
    user: "admin",
    env: [
      "-v",
      `${userFile}:/run/secrets/postgres_user:ro`,
      "-e",
      "POSTGRES_USER_FILE=/run/secrets/postgres_user",
    ],
  },
];

async function sql({ container, user }: Case, database: string, query: string): Promise<string> {
  const r =
    await $`docker exec ${container} psql -X -v ON_ERROR_STOP=1 -U ${user} -d ${database} -tA -c ${query}`
      .quiet()
      .nothrow();
  if (r.exitCode !== 0) throw new Error(`[${database}] ${query}\n${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

async function verify(c: Case): Promise<void> {
  const { container, database } = c;
  const health = await $`docker exec ${container} /usr/local/bin/healthcheck.sh`.quiet().nothrow();
  if (health.exitCode !== 0)
    throw new Error(`healthcheck failed: ${health.stderr.toString().trim()}`);

  const setting = await sql(c, database, "SHOW cron.database_name");
  if (setting !== database) throw new Error(`cron.database_name = ${setting}, want ${database}`);

  const missing = await sql(
    c,
    database,
    `SELECT coalesce(string_agg(t, ', '), '') FROM unnest(ARRAY['${REQUIRED_PGFLOW_TABLES.join("','")}']) t
       WHERE to_regclass('pgflow.' || t) IS NULL`
  );
  if (missing !== "") throw new Error(`pgflow tables missing in ${database}: ${missing}`);

  if (database !== "postgres") {
    const stray = await sql(
      c,
      "postgres",
      "SELECT (SELECT count(*) FROM pg_extension WHERE extname = 'pg_cron') || '/' || (SELECT count(*) FROM pg_namespace WHERE nspname = 'pgflow')"
    );
    if (stray !== "0/0") throw new Error(`pg_cron/pgflow also present in postgres: ${stray}`);
  }

  await sql(c, database, "CREATE TABLE cron_tick (at timestamptz DEFAULT now())");
  await sql(
    c,
    database,
    "SELECT cron.schedule('cron_tick_job', '1 seconds', 'INSERT INTO cron_tick DEFAULT VALUES')"
  );
  const deadline = Date.now() + TIMEOUTS.health * 1000;
  while (Date.now() < deadline) {
    if (Number(await sql(c, database, "SELECT count(*) FROM cron_tick")) > 0) return;
    await Bun.sleep(250);
  }
  const runs = await sql(
    c,
    database,
    "SELECT coalesce(string_agg(status || ': ' || coalesce(return_message, ''), '; '), 'no runs') FROM cron.job_run_details"
  );
  throw new Error(
    `scheduled job never wrote a row in ${database} within ${TIMEOUTS.health}s (${runs})`
  );
}

let failed = false;
try {
  await Promise.all(
    cases.map((c) =>
      $`docker run -d --name ${c.container} ${EPHEMERAL_PGDATA} -e POSTGRES_PASSWORD=postgres ${c.env} ${image}`.quiet()
    )
  );
  // Each case boots and verifies on its own, so one container failing init still lets the others report.
  const outcomes = await Promise.allSettled(
    cases.map(async (c) => {
      await waitForPostgres({ container: c.container, user: c.user, timeout: TIMEOUTS.startup });
      await verify(c);
    })
  );
  outcomes.forEach((o, i) => {
    const name = `healthy, pg_cron + pgflow follow POSTGRES_DB=${cases[i]?.database} (POSTGRES_USER=${cases[i]?.user})`;
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
  await rm(userFile, { force: true });
}
process.exit(failed ? 1 : 0);
