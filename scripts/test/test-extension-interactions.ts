#!/usr/bin/env bun
/**
 * Extension interaction test (Tier 3): executor-hook preloads must all see the same statement.
 *
 * pgaudit, pg_stat_statements and pg_stat_monitor each hook the executor and must call the
 * previous hook; one that breaks the chain silently starves the others while every extension still
 * loads. One tagged SELECT must therefore produce a pgaudit log line AND a pg_stat_statements row
 * AND a pg_stat_monitor row, in one server whose shared_preload_libraries is the mode's full list:
 * `production` = the default preloads, `regression` = every preload library the manifest ships
 * (defaults plus the optional ones such as supautils and plan_filter), a combination no
 * single-extension owner boots.
 *
 * Usage: bun scripts/test/test-extension-interactions.ts [image] [--mode=production|regression]
 */
import { preloadLibraryName } from "../config-generator/manifest-loader";
import { $ } from "bun";
import { TIMEOUTS } from "../config/test-timeouts";
import { MANIFEST_ENTRIES } from "../extensions/manifest-data";
import { generateUniqueContainerName, waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";
import { detectTestMode, getSharedPreloadLibraries } from "./lib/test-mode";
import type { TestMode } from "./lib/test-mode";

const modeArg = Bun.argv.find((a) => a.startsWith("--mode="))?.slice("--mode=".length);
if (modeArg !== undefined && modeArg !== "production" && modeArg !== "regression") {
  console.error(`FAIL: invalid --mode=${modeArg}`);
  process.exit(1);
}
const mode: TestMode = modeArg ?? (await detectTestMode());
const container = generateUniqueContainerName("aza-pg-interactions");
const marker = `t2b_hook_${Date.now()}`;

async function psql(...commands: string[]): Promise<string> {
  const args = commands.flatMap((c) => ["-c", c]);
  const r = await $`docker exec ${container} psql -X -v ON_ERROR_STOP=1 -U postgres -tA ${args}`
    .quiet()
    .nothrow();
  if (r.exitCode !== 0) throw new Error(`${commands.join("; ")}\n${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

let failure: string | null = null;
try {
  const preload =
    mode === "production"
      ? getSharedPreloadLibraries("production")
      : MANIFEST_ENTRIES.filter((e) => e.runtime?.sharedPreload === true && e.enabled !== false)
          .map((e) => preloadLibraryName(e))
          .join(",");
  console.log(
    `Mode ${mode}: shared_preload_libraries=${mode === "production" ? "(image default)" : preload}`
  );
  // Production mode runs the image's own default preload: passing the manifest's list would hide an image whose
  // default differs from it. Regression mode adds the optional preloads, which are what it tests.
  const preloadEnv =
    mode === "production" ? [] : ["-e", `POSTGRES_SHARED_PRELOAD_LIBRARIES=${preload}`];
  await $`docker run -d --name ${container} -e POSTGRES_PASSWORD=postgres ${preloadEnv} ${resolveImageTag()}`.quiet();
  await waitForPostgres({ container, timeout: 120 });

  await psql(`CREATE TABLE ${marker} (id int)`);
  await psql("SET pgaudit.log = 'read'", `SELECT count(*) FROM ${marker}`);

  const missing: string[] = [];
  // Docker copies the container's output into its log asynchronously, so one read right after the query can miss
  // a line the server already wrote; poll until it appears.
  const audited = (text: string) =>
    text.split("\n").some((l) => l.includes("AUDIT: SESSION") && l.includes(marker));
  const deadline = Date.now() + TIMEOUTS.health * 1000;
  let seen = false;
  while (!seen && Date.now() < deadline) {
    const logs = await $`docker logs ${container}`.quiet().nothrow();
    seen = audited(logs.stdout.toString() + logs.stderr.toString());
    if (!seen) await Bun.sleep(200);
  }
  if (!seen) missing.push("pgaudit log line");
  const pgss = await psql(
    `SELECT count(*) FROM pg_stat_statements WHERE query LIKE 'SELECT count(*) FROM ${marker}%'`
  );
  if (pgss === "0") missing.push("pg_stat_statements row");
  const pgsm = await psql(
    `SELECT count(*) FROM pg_stat_monitor WHERE query LIKE 'SELECT count(*) FROM ${marker}%'`
  );
  if (pgsm === "0") missing.push("pg_stat_monitor row");
  if (missing.length > 0) failure = `one SELECT was not seen by: ${missing.join(", ")}`;
} catch (err) {
  failure = `setup: ${err instanceof Error ? err.message : String(err)}`;
} finally {
  await $`docker rm -f -v ${container}`.quiet().nothrow();
}
if (failure) {
  console.error(`FAIL: executor hook chain (${mode}): ${failure}`);
  process.exit(1);
}
console.log(`PASS: executor hook chain (${mode}): pgaudit, pg_stat_statements, pg_stat_monitor`);
