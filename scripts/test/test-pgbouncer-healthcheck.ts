#!/usr/bin/env bun
/**
 * Primary stack (stacks/primary): PostgreSQL + PgBouncer + both exporters, deployed from a staged copy.
 *
 * One stack serves every check, because each one needs the whole deployment and a stack start is the cost:
 *   - client auth through PgBouncer's auth_query (a wrong auth_query or lookup function locks every app user out);
 *   - the auth_user password contains ':' and '\' — the characters the entrypoint must escape in .pgpass and that
 *     userlist.txt, initdb's ALTER ROLE and the compose healthcheck all have to carry through unchanged;
 *   - the rendered PgBouncer config is the one running (max_client_conn from the env, SHOW POOLS for the pool);
 *   - both exporters reach their targets (`pg_up 1`, `pgbouncer_up 1`; an exporter that cannot log in still serves
 *     /metrics with `pg_up 0`, so a healthy container proves nothing).
 * Every command passes its arguments as argv (docker exec -e …), never through `sh -c`, so no check can turn into
 * a shell assignment that exits 0.
 *
 * Usage: bun scripts/test/test-pgbouncer-healthcheck.ts [image]
 */

import { $ } from "bun";
import { TIMEOUTS } from "../config/test-timeouts";
import { waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";
import { stageStack } from "./staged-stack";

const image = resolveImageTag();
const suffix = crypto.randomUUID().slice(0, 8);
const POSTGRES_PASSWORD = `pg_${suffix}`;
// ':' and '\' are the two characters .pgpass needs escaped; the rest of the stack must pass them through verbatim.
const AUTH_PASS = `pgb:auth\\${suffix}`;
// Non-default, so a template or entrypoint that drops the variable shows PgBouncer's 200 instead.
const MAX_CLIENT_CONN = "37";

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

/** psql inside `container`; env entries become `docker exec -e`. Throws with psql's stderr on any failure. */
async function psql(
  container: string,
  conn: string[],
  sql: string,
  env: Record<string, string> = {}
): Promise<string> {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const r =
    await $`docker exec ${envArgs} ${container} psql -X -v ON_ERROR_STOP=1 ${conn} -tAc ${sql}`
      .nothrow()
      .quiet();
  if (r.exitCode !== 0) {
    throw new Error(`psql exited ${r.exitCode}: ${r.stderr.toString().trim()}`);
  }
  return r.stdout.toString().trim();
}

/** Poll an exporter's /metrics until `metric 1` appears; readiness is observed, the sleep only paces polling. */
async function expectMetricUp(port: number, metric: string): Promise<void> {
  const deadline = Date.now() + TIMEOUTS.health * 1000;
  let last = "";
  while (Date.now() < deadline) {
    last = await fetch(`http://127.0.0.1:${port}/metrics`)
      .then((r) => r.text())
      .catch((e: unknown) => String(e));
    if (new RegExp(`^${metric} 1$`, "m").test(last)) return;
    await Bun.sleep(500);
  }
  const line = last.split("\n").find((l) => l.startsWith(`${metric} `)) ?? "(metric absent)";
  throw new Error(`${metric} never reached 1 on :${port}; last: ${line}`);
}

const stage = await stageStack("primary", {
  POSTGRES_IMAGE: image,
  POSTGRES_PASSWORD,
  PG_REPLICATION_PASSWORD: `repl_${suffix}`,
  PGBOUNCER_AUTH_PASS: AUTH_PASS,
  PGBOUNCER_MAX_CLIENT_CONN: MAX_CLIENT_CONN,
});
const postgres = `${stage.project}-postgres-primary`;
const pgbouncer = `${stage.project}-pgbouncer-primary`;
const started = Date.now();

try {
  console.log(`Primary stack ${stage.project} (${image})`);
  // `up` returns once each depends_on condition held: postgres healthy, then pgbouncer healthy (its compose
  // healthcheck logs in with the special-character password), then the exporters started.
  const up = await stage.compose("up", "-d").nothrow().quiet();
  if (up.exitCode !== 0) {
    const logs = await stage.compose("logs", "--tail", "40").nothrow().quiet().text();
    throw new Error(`compose up failed: ${up.stderr.toString().trim()}\n${logs}`);
  }
  await waitForPostgres({ container: postgres, timeout: TIMEOUTS.startup });

  const viaPgbouncer = ["-h", "pgbouncer", "-p", "6432", "-d", "postgres"];

  await step("app user logs in through PgBouncer auth_query", async () => {
    // postgres is not in userlist.txt, so PgBouncer must fetch its SCRAM secret with auth_query.
    const who = await psql(postgres, [...viaPgbouncer, "-U", "postgres"], "SELECT current_user", {
      PGPASSWORD: POSTGRES_PASSWORD,
    });
    // [databases] pins the server login to pgbouncer_auth, so this is the pooled server session.
    if (who !== "pgbouncer_auth") throw new Error(`server session user was "${who}"`);
  });

  await step("wrong password is refused by PgBouncer", async () => {
    const r = await psql(postgres, [...viaPgbouncer, "-U", "postgres"], "SELECT 1", {
      PGPASSWORD: `${POSTGRES_PASSWORD}x`,
    }).then(
      () => "accepted",
      (e: Error) => e.message
    );
    // PgBouncer answers a failed SCRAM exchange with "SASL authentication failed".
    if (!/FATAL: +SASL authentication failed/.test(r)) {
      throw new Error(`expected an auth failure, got: ${r}`);
    }
  });

  await step("auth_user with ':' and '\\' in its password logs in from .pgpass", async () => {
    // No PGPASSWORD: libpq must read the entrypoint's escaped /tmp/.pgpass line back to the original password.
    await psql(
      pgbouncer,
      ["-h", "localhost", "-p", "6432", "-U", "pgbouncer_auth", "-d", "postgres"],
      "SELECT 1",
      {
        PGPASSFILE: "/tmp/.pgpass",
      }
    );
  });

  await step(
    `running PgBouncer has max_client_conn=${MAX_CLIENT_CONN} and a postgres pool`,
    async () => {
      const admin = ["-h", "localhost", "-p", "6432", "-U", "pgbouncer_auth", "-d", "pgbouncer"];
      const env = { PGPASSWORD: AUTH_PASS };
      const config = await psql(pgbouncer, admin, "SHOW CONFIG", env);
      const row = config.split("\n").find((l) => l.startsWith("max_client_conn|"));
      if (row?.split("|")[1] !== MAX_CLIENT_CONN) throw new Error(`SHOW CONFIG row: ${row}`);
      const pools = await psql(pgbouncer, admin, "SHOW POOLS", env);
      if (!pools.split("\n").some((l) => l.startsWith("postgres|pgbouncer_auth|"))) {
        throw new Error(`no postgres/pgbouncer_auth pool in SHOW POOLS:\n${pools}`);
      }
    }
  );

  await step("postgres_exporter reports pg_up 1", async () =>
    expectMetricUp(await stage.hostPort("postgres_exporter", 9187), "pg_up")
  );
  await step("pgbouncer_exporter reports pgbouncer_up 1", async () =>
    expectMetricUp(await stage.hostPort("pgbouncer_exporter", 9127), "pgbouncer_up")
  );
} catch (err) {
  failures.push("stack start");
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await stage.remove();
}

console.log(
  `\n${failures.length ? `FAILED: ${failures.join(", ")}` : "PASSED"} in ${Date.now() - started} ms`
);
process.exit(failures.length ? 1 : 0);
