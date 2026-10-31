#!/usr/bin/env bun
/**
 * pg_safeupdate owner (a preload hook, no CREATE EXTENSION).
 *
 * - Default image: UPDATE and DELETE without WHERE are rejected; with WHERE they run.
 * - POSTGRES_SHARED_PRELOAD_LIBRARIES without safeupdate: the same statements run, proving the
 *   operator override reaches shared_preload_libraries and the rejection came from safeupdate.
 *
 * The two containers boot in parallel.
 *
 * Usage: bun scripts/test/test-hook-extensions.ts [image] [--image=TAG]
 */
import { $ } from "bun";
import { TIMEOUTS } from "../config/test-timeouts";
import { EPHEMERAL_PGDATA, generateUniqueContainerName, waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";
import { getSharedPreloadLibraries } from "./lib/test-mode";
import { psql } from "../utils/psql";

const image = resolveImageTag();
const guarded = generateUniqueContainerName("aza-pg-safeupdate-on");
const unguarded = generateUniqueContainerName("aza-pg-safeupdate-off");
const preloadWithoutSafeupdate = getSharedPreloadLibraries("production")
  .split(",")
  .filter((lib) => lib !== "safeupdate")
  .join(",");

async function expect(
  container: string,
  query: string,
  allowed: boolean,
  error = ""
): Promise<void> {
  const r = await psql(container, query);
  if (r.ok !== allowed || (!allowed && !r.err.includes(error))) {
    throw new Error(
      `${query}: expected ${allowed ? "success" : `"${error}"`}, got: ${r.err || "success"}`
    );
  }
}

const failures: string[] = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL: ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

try {
  await Promise.all([
    $`docker run -d --name ${guarded} ${EPHEMERAL_PGDATA} -e POSTGRES_PASSWORD=postgres ${image}`.quiet(),
    $`docker run -d --name ${unguarded} ${EPHEMERAL_PGDATA} -e POSTGRES_PASSWORD=postgres -e POSTGRES_SHARED_PRELOAD_LIBRARIES=${preloadWithoutSafeupdate} ${image}`.quiet(),
  ]);
  await Promise.all([
    waitForPostgres({ container: guarded, timeout: TIMEOUTS.startup }),
    waitForPostgres({ container: unguarded, timeout: TIMEOUTS.startup }),
  ]);
  for (const c of [guarded, unguarded]) {
    const setup = await psql(
      c,
      "CREATE TABLE safeupdate_rows (id int); INSERT INTO safeupdate_rows VALUES (1), (2)"
    );
    if (!setup.ok) throw new Error(setup.err);
  }

  await check("safeupdate rejects UPDATE/DELETE without WHERE by default", async () => {
    await expect(
      guarded,
      "UPDATE safeupdate_rows SET id = 99",
      false,
      "UPDATE requires a WHERE clause"
    );
    await expect(guarded, "DELETE FROM safeupdate_rows", false, "DELETE requires a WHERE clause");
    await expect(guarded, "UPDATE safeupdate_rows SET id = 99 WHERE id = 1", true);
    await expect(guarded, "DELETE FROM safeupdate_rows WHERE id = 99", true);
  });

  await check(
    "removing safeupdate from POSTGRES_SHARED_PRELOAD_LIBRARIES disables it",
    async () => {
      await expect(unguarded, "UPDATE safeupdate_rows SET id = 99", true);
      await expect(unguarded, "DELETE FROM safeupdate_rows", true);
    }
  );
} catch (err) {
  failures.push("setup");
  console.error(`FAIL: setup: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await $`docker rm -f -v ${guarded} ${unguarded}`.quiet().nothrow();
}
process.exit(failures.length === 0 ? 0 : 1);
