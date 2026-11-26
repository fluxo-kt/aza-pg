#!/usr/bin/env bun
/**
 * One server per data directory, and a stop that never costs crash recovery.
 *
 * PostgreSQL's own guard cannot see a server in another container, so a second container on a live volume used to
 * start a second postmaster on the same files. The entrypoint now holds a flock on the data directory for the server's
 * life: a second container must wait without starting a server, then start by itself once the first one stops.
 * The stop itself must be PostgreSQL's fast shutdown (StopSignal SIGINT): with Docker's default SIGTERM the server
 * waits for every client, so the open session below would run `docker stop` into its timeout and SIGKILL (exit 137),
 * and the next start would replay WAL. A container waiting for the lock must obey `docker stop` as well.
 * Exit codes decide, never elapsed time: 137 is the SIGKILL a hung stop ends in.
 *
 * Usage: bun scripts/test-all.ts scripts/test/test-data-dir-lock.ts
 */

import { $ } from "bun";
import { afterAll, expect, test } from "bun:test";
import { sqlOk } from "../utils/psql";
import { TEST_SERVER_MEMORY, generateUniqueContainerName, waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";

const IMAGE = resolveImageTag({ argv: [] });
const created: string[] = [];
const WAITING = "another container runs a server on";

// Newest first: a container started --volumes-from borrows the first one's anonymous volume, which `-v` removes with
// that first container only after every borrower is gone.
afterAll(async () => {
  for (const name of created.toReversed()) await $`docker rm -f -v ${name}`.nothrow().quiet();
});

async function start(prefix: string, args: string[] = []): Promise<string> {
  const name = generateUniqueContainerName(`aza-pg-lock-${prefix}`);
  created.push(name);
  await $`docker run -d --name ${name} ${TEST_SERVER_MEMORY} -e POSTGRES_PASSWORD=lock-test ${args} ${IMAGE}`.quiet();
  return name;
}

const logs = async (name: string) => {
  const r = await $`docker logs ${name}`.nothrow().quiet();
  return r.stdout.toString() + r.stderr.toString();
};

/** Poll until the container logs that it waits for the lock; fails if it stops or starts a server instead. */
async function expectWaiting(name: string) {
  for (let i = 0; i < 120; i++) {
    const text = await logs(name);
    if (text.includes(WAITING)) {
      expect(text).not.toContain("ready to accept connections");
      return;
    }
    const running = (await $`docker inspect -f {{.State.Running}} ${name}`.quiet().text()).trim();
    if (running !== "true") throw new Error(`${name} stopped instead of waiting:\n${text}`);
    await Bun.sleep(500);
  }
  throw new Error(`${name} never reported waiting for the lock:\n${await logs(name)}`);
}

const exitCode = async (name: string) =>
  Number((await $`docker inspect -f {{.State.ExitCode}} ${name}`.quiet().text()).trim());

test("a second container waits for the first, which stops fast with a client open", async () => {
  const first = await start("first");
  await waitForPostgres({ container: first, timeout: 120 });
  await sqlOk(first, ["CREATE TABLE lock_probe (id int)", "INSERT INTO lock_probe VALUES (1)"]);

  const second = await start("second", ["--volumes-from", first]);
  await expectWaiting(second);

  // A client inside a query: smart shutdown (SIGTERM) would wait for it until Docker's SIGKILL.
  await $`docker exec -d ${first} psql -X -U postgres -c "SELECT pg_sleep(600)"`.quiet();
  // exec -d returns before psql connects; a stop before that would pass under SIGTERM too.
  const sleeping = "SELECT count(*) FROM pg_stat_activity WHERE query = 'SELECT pg_sleep(600)'";
  for (let i = 0; (await sqlOk(first, sleeping)) !== "1"; i++) {
    if (i === 60) throw new Error("the client never reached pg_sleep");
    await Bun.sleep(250);
  }
  await $`docker stop ${first}`.quiet();
  expect(await exitCode(first)).toBe(0);

  await waitForPostgres({ container: second, timeout: 120 });
  expect(await sqlOk(second, "SELECT count(*) FROM lock_probe")).toBe("1");
  expect(await logs(second)).not.toContain("was not properly shut down");

  // A container waiting for the lock obeys docker stop instead of hanging into the SIGKILL.
  const third = await start("third", ["--volumes-from", first]);
  await expectWaiting(third);
  await $`docker stop -t 30 ${third}`.quiet();
  expect(await exitCode(third)).not.toBe(137);
}, 300_000);
