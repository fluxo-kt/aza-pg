#!/usr/bin/env bun
/**
 * pg_partman_bgw (optional preload) runs maintenance by itself.
 *
 * The worker runs run_maintenance() in a background worker through its own portal, a path no direct call takes, and
 * PostgreSQL minors can break exactly that path (18.7's PortalDrop() refuses a portal still being set up; pg_partman
 * before 5.5.1 then errors after every run). The maintenance commits before that error, so the work alone proves
 * nothing: the worker must recreate a dropped premade partition AND the server log must hold no ERROR.
 *
 * Usage: bun scripts/test/test-pg-partman-bgw.ts [image] [--image=TAG]
 */
import { $ } from "bun";
import { TIMEOUTS } from "../config/test-timeouts";
import { TEST_SERVER, generateUniqueContainerName, waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";
import { getSharedPreloadLibraries } from "./lib/test-mode";
import { sqlOk } from "../utils/psql";

const container = generateUniqueContainerName("aza-pg-partman-bgw");
const sql = (query: string) => sqlOk(container, query);
// The worker needs a database, a short interval and a role that exists (its default, partman_maintainer, does not).
const preload = `${getSharedPreloadLibraries("production")},pg_partman_bgw`;
const bgwSettings = ["dbname=postgres", "interval=1", "role=postgres"].flatMap((s) => [
  "-c",
  `pg_partman_bgw.${s}`,
]);

async function run(): Promise<void> {
  await $`docker run -d --name ${container} ${TEST_SERVER} -e POSTGRES_PASSWORD=postgres -e POSTGRES_SHARED_PRELOAD_LIBRARIES=${preload} ${resolveImageTag()} postgres ${bgwSettings}`.quiet();
  await waitForPostgres({ container, timeout: TIMEOUTS.startup });

  // pgsodium's DDL event trigger fires on every child table pg_partman creates, the worker's included; this container
  // is thrown away, so it stays off.
  await sql("ALTER EVENT TRIGGER pgsodium_trg_mask_update DISABLE");
  await sql("CREATE TABLE events (id int, at timestamptz NOT NULL) PARTITION BY RANGE (at)");
  await sql(
    "SELECT partman.create_parent('public.events', 'at', '1 day', 'range', p_premake := 3)"
  );
  const newest = await sql(
    "SELECT partition_schemaname || '.' || partition_tablename FROM partman.show_partitions('public.events', 'DESC') LIMIT 1"
  );
  await sql(`DROP TABLE ${newest}`);

  const deadline = Date.now() + TIMEOUTS.health * 1000;
  while ((await sql(`SELECT to_regclass('${newest}') IS NOT NULL`)) !== "t") {
    if (Date.now() > deadline)
      throw new Error(`the worker did not recreate ${newest} within ${TIMEOUTS.health} s`);
    await Bun.sleep(250);
  }
  const errors = (await $`docker logs ${container}`.quiet().nothrow()).stderr
    .toString()
    .split("\n")
    .filter((line) => line.includes("ERROR:"));
  if (errors.length > 0)
    throw new Error(`the server logged errors while the worker ran:\n${errors.join("\n")}`);
}

let failure: string | null = null;
try {
  await run();
} catch (err) {
  failure = err instanceof Error ? err.message : String(err);
} finally {
  await $`docker rm -f -v ${container}`.quiet().nothrow();
}
if (failure) {
  console.error(`FAIL: pg_partman_bgw: ${failure}`);
  process.exit(1);
}
console.log("PASS: pg_partman_bgw recreated a dropped premade partition with no error logged");
