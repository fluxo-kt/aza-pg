#!/usr/bin/env bun
/**
 * Single stack (stacks/single) and the life of its data volume, from a staged copy.
 *
 * One volume goes through every hand-off an operator's data goes through, each proven by an exact row count:
 *   1. `docker run` of the bare image initialises it — then the compose stack must find that data, which fails
 *      when the compose mount path differs from the image's PGDATA (a fresh cluster appears instead);
 *   2. `compose down` without -v and `up` again must keep it;
 *   3. `docker stop` must shut PostgreSQL down cleanly (exit 0, "database system is shut down"), so the next start
 *      needs no crash recovery — a wrong stop signal or a too-short grace period shows up as recovery on restart.
 * The stack's exporter must also reach PostgreSQL (`pg_up 1`).
 *
 * Usage: bun scripts/test/test-single-stack.ts [image]
 */

import { $ } from "bun";
import { TIMEOUTS } from "../config/test-timeouts";
import { generateUniqueContainerName, waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";
import { stageStack } from "./staged-stack";

const image = resolveImageTag();
const POSTGRES_PASSWORD = `pg_${crypto.randomUUID().slice(0, 8)}`;

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

async function expectRows(container: string, expected: number): Promise<void> {
  const count = await psql(container, "SELECT count(*) FROM handoff");
  if (count !== String(expected))
    throw new Error(`handoff has ${count} rows, expected ${expected}`);
}

/** Logs of the container's current start only (a restart keeps the earlier output). */
async function currentLogs(container: string): Promise<string> {
  const since = (
    await $`docker inspect -f {{.State.StartedAt}} ${container}`.quiet().text()
  ).trim();
  const r = await $`docker logs --since ${since} ${container}`.nothrow().quiet();
  return r.stdout.toString() + r.stderr.toString();
}

const stage = await stageStack("single", { POSTGRES_IMAGE: image, POSTGRES_PASSWORD });
const volume = stage.env.POSTGRES_DATA_VOLUME ?? "";
const postgres = `${stage.project}-postgres-single`;
const bare = generateUniqueContainerName("aza-pg-single-handoff");
const started = Date.now();

try {
  console.log(`Single stack ${stage.project} (${image})`);
  if (!volume.startsWith(stage.project)) throw new Error(`unscoped data volume "${volume}"`);

  await step("data initialised by `docker run` is served by the compose stack", async () => {
    await $`docker run -d --name ${bare} -e POSTGRES_PASSWORD=${POSTGRES_PASSWORD} -v ${volume}:/var/lib/postgresql ${image}`.quiet();
    await waitForPostgres({ container: bare, timeout: TIMEOUTS.startup });
    await psql(bare, "CREATE TABLE handoff AS SELECT g AS id FROM generate_series(1, 100) g");
    await $`docker stop ${bare}`.quiet();
    await $`docker rm -v ${bare}`.quiet(); // -v drops anonymous volumes only; the named data volume stays

    const up = await stage.compose("up", "-d").nothrow().quiet();
    if (up.exitCode !== 0) throw new Error(`compose up failed: ${up.stderr.toString().trim()}`);
    await waitForPostgres({ container: postgres, timeout: TIMEOUTS.startup });
    if (!(await currentLogs(postgres)).includes("Skipping initialization")) {
      throw new Error("compose start ran initdb: it did not find the existing cluster");
    }
    await expectRows(postgres, 100);
  });

  await step("postgres_exporter reports pg_up 1", async () => {
    const port = await stage.hostPort("postgres_exporter", 9187);
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

  await step("`compose down` without -v, then `up`, keeps the data", async () => {
    await psql(postgres, "INSERT INTO handoff SELECT g FROM generate_series(101, 150) g");
    await stage.compose("down").quiet();
    await stage.compose("up", "-d").quiet();
    await waitForPostgres({ container: postgres, timeout: TIMEOUTS.startup });
    await expectRows(postgres, 150);
  });

  await step("`docker stop` shuts down cleanly and the restart needs no recovery", async () => {
    await $`docker stop ${postgres}`.quiet();
    const exitCode = (
      await $`docker inspect -f {{.State.ExitCode}} ${postgres}`.quiet().text()
    ).trim();
    const stopLogs = await currentLogs(postgres);
    if (exitCode !== "0") throw new Error(`exit code ${exitCode}`);
    if (!stopLogs.includes("database system is shut down")) {
      throw new Error(
        `no clean shutdown line; last lines:\n${stopLogs.trimEnd().split("\n").slice(-10).join("\n")}`
      );
    }
    await $`docker start ${postgres}`.quiet();
    await waitForPostgres({ container: postgres, timeout: TIMEOUTS.startup });
    const startLogs = await currentLogs(postgres);
    if (/not properly shut down|automatic recovery in progress/.test(startLogs)) {
      throw new Error("restart ran crash recovery");
    }
    await expectRows(postgres, 150);
  });
} catch (err) {
  failures.push("setup");
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await $`docker rm -f -v ${bare}`.nothrow().quiet();
  await stage.remove();
  // Created by `docker run`, not by compose, so `down -v` may leave it; the name is this run's own.
  await $`docker volume rm -f ${volume}`.nothrow().quiet();
}

console.log(
  `\n${failures.length ? `FAILED: ${failures.join(", ")}` : "PASSED"} in ${Date.now() - started} ms`
);
process.exit(failures.length ? 1 : 0);
