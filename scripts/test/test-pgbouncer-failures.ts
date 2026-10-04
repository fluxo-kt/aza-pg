#!/usr/bin/env bun
/**
 * PgBouncer entrypoint input validation (stacks/primary/scripts/pgbouncer-entrypoint.sh), in a PgBouncer-only
 * container: the validation is pure shell that runs before PgBouncer starts, so no PostgreSQL is needed.
 *
 * Each rejected input must stop the container with the entrypoint's own message — a bare non-zero exit could be a
 * missing mount or a crash. The accepted case is the control: it proves the same mounts and image reach
 * `exec pgbouncer` with the rendered values, so the rejections are about the input, not the harness.
 *
 * Usage: bun scripts/test/test-pgbouncer-failures.ts
 */

import { $ } from "bun";
import { resolve } from "node:path";
import { TIMEOUTS } from "../config/test-timeouts";
import { generateUniqueContainerName } from "../utils/docker";

const ROOT = resolve(import.meta.dir, "../..");
const COMPOSE = Bun.YAML.parse(await Bun.file(`${ROOT}/stacks/primary/compose.yml`).text()) as {
  services: { pgbouncer: { image: string } };
};
// The image the primary stack ships, read from its compose default.
const PGBOUNCER_IMAGE =
  Bun.env.PGBOUNCER_IMAGE ??
  COMPOSE.services.pgbouncer.image.match(/\$\{PGBOUNCER_IMAGE:-([^}]+)\}/)?.[1] ??
  "";
const MOUNTS = [
  "-v",
  `${ROOT}/stacks/primary/configs/pgbouncer.ini.template:/etc/pgbouncer/pgbouncer.ini.template:ro`,
  "-v",
  `${ROOT}/stacks/primary/scripts/pgbouncer-entrypoint.sh:/opt/pgbouncer-entrypoint.sh:ro`,
];

const created: string[] = [];
const failures: string[] = [];

/** Run the entrypoint to completion; a rejected input exits before `exec pgbouncer`, so this never blocks. */
async function runEntrypoint(env: Record<string, string>): Promise<{ code: number; out: string }> {
  const name = generateUniqueContainerName("aza-pg-pgbouncer-entrypoint");
  created.push(name);
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const r =
    await $`docker run --name ${name} ${envArgs} ${MOUNTS} --entrypoint /bin/sh ${PGBOUNCER_IMAGE} /opt/pgbouncer-entrypoint.sh`
      .nothrow()
      .quiet();
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

const VALID = { PGBOUNCER_AUTH_PASS: "secret", PGBOUNCER_LISTEN_ADDR: "0.0.0.0" };
const REJECTED: Array<[string, Record<string, string>, string]> = [
  ["missing PGBOUNCER_AUTH_PASS", {}, "PGBOUNCER_AUTH_PASS not set"],
  [
    "listen address that is not an IPv4 address",
    { ...VALID, PGBOUNCER_LISTEN_ADDR: "localhost" },
    "Invalid PGBOUNCER_LISTEN_ADDR format: 'localhost'",
  ],
  [
    "listen address with an octet above 255",
    { ...VALID, PGBOUNCER_LISTEN_ADDR: "10.0.256.1" },
    "third octet '256' is invalid",
  ],
  [
    "unknown server TLS mode",
    { ...VALID, PGBOUNCER_SERVER_SSLMODE: "required" },
    "Invalid PGBOUNCER_SERVER_SSLMODE: 'required'",
  ],
];

const started = Date.now();
try {
  if (!PGBOUNCER_IMAGE)
    throw new Error("PgBouncer image default not found in stacks/primary/compose.yml");

  for (const [name, env, message] of REJECTED) {
    const { code, out } = await runEntrypoint(env);
    if (code === 1 && out.includes(message)) {
      console.log(`✅ rejects ${name}`);
    } else {
      failures.push(name);
      console.error(`❌ rejects ${name}: exit ${code}, expected "${message}" in:\n${out.trim()}`);
    }
  }

  // Control: valid input reaches PgBouncer with the rendered values.
  const name = generateUniqueContainerName("aza-pg-pgbouncer-entrypoint-ok");
  created.push(name);
  const envArgs = Object.entries({ ...VALID, PGBOUNCER_MAX_CLIENT_CONN: "41" }).flatMap(
    ([k, v]) => ["-e", `${k}=${v}`]
  );
  await $`docker run -d --name ${name} ${envArgs} ${MOUNTS} --entrypoint /bin/sh ${PGBOUNCER_IMAGE} /opt/pgbouncer-entrypoint.sh`.quiet();
  const deadline = Date.now() + TIMEOUTS.health * 1000;
  let logs = "";
  while (Date.now() < deadline && !/listening on 0\.0\.0\.0:6432/.test(logs)) {
    logs = (await $`docker logs ${name}`.nothrow().quiet()).stderr.toString();
    await Bun.sleep(250);
  }
  const ini = (
    await $`docker exec ${name} cat /tmp/pgbouncer.ini`.nothrow().quiet()
  ).stdout.toString();
  if (/listening on 0\.0\.0\.0:6432/.test(logs) && /^max_client_conn = 41$/m.test(ini)) {
    console.log("✅ accepts valid input and starts PgBouncer with the rendered config");
  } else {
    failures.push("valid input");
    console.error(`❌ valid input did not start PgBouncer as configured:\n${logs.trim()}\n${ini}`);
  }
} catch (err) {
  failures.push("setup");
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
} finally {
  for (const name of created) await $`docker rm -f -v ${name}`.nothrow().quiet();
}

console.log(
  `\n${failures.length ? `FAILED: ${failures.join(", ")}` : "PASSED"} in ${Date.now() - started} ms`
);
process.exit(failures.length ? 1 : 0);
