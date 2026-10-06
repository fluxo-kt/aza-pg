#!/usr/bin/env bun
/**
 * Extension regression tests (Tier 2): each `tests/regression/extensions/<name>/sql/basic.sql` runs
 * against the image and its psql output must equal `expected/basic.out`.
 *
 * The set is every directory under `tests/regression/extensions/` whose manifest entry is not
 * `enabled: false` — never a hand-kept list, which silently stopped running the suites it omitted.
 * A directory with no manifest entry is an error, not a skip. The mode only picks the preload list.
 *
 * All files run in the `postgres` database because pg_cron and pg_net run their background workers
 * there; each file creates its own uniquely named objects.
 *
 * Usage:
 *   bun scripts/test/test-extension-regression.ts [image] [--mode=production|regression]
 *     [--extensions=a,b] [--generate-expected] [--verbose] [--container=NAME]
 */

import { $ } from "bun";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { MANIFEST_ENTRIES } from "../extensions/manifest-data";
import { TIMEOUTS } from "../config/test-timeouts";
import { generateUniqueContainerName, waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";
import { generateRegressionDiffs, runRegressionTest } from "./lib/regression-runner";
import type { TestResult } from "./lib/regression-runner";
import { detectTestMode, getSharedPreloadLibraries } from "./lib/test-mode";
import type { TestMode } from "./lib/test-mode";

const SUITE_DIR = join(import.meta.dir, "../../tests/regression/extensions");

interface Options {
  mode: TestMode | null;
  only: string[];
  generateExpected: boolean;
  verbose: boolean;
  container: string | null;
}

function parseArgs(argv: string[]): Options {
  const value = (flag: string) =>
    argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? null;
  const mode = value("--mode");
  if (mode !== null && mode !== "production" && mode !== "regression") {
    throw new Error(`Invalid --mode=${mode} (production | regression)`);
  }
  return {
    mode,
    only: (value("--extensions") ?? "").split(",").filter(Boolean),
    generateExpected: argv.includes("--generate-expected"),
    verbose: argv.includes("--verbose"),
    container: value("--container"),
  };
}

/** Directories to run: those whose manifest entry is enabled. */
export async function selectSuites(): Promise<string[]> {
  const dirs = (await readdir(SUITE_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const selected: string[] = [];
  for (const dir of dirs) {
    const entry = MANIFEST_ENTRIES.find((e) => e.name === dir);
    if (!entry) throw new Error(`tests/regression/extensions/${dir} matches no manifest entry`);
    if (entry.enabled !== false) selected.push(dir);
  }
  return selected;
}

async function main(): Promise<number> {
  const options = parseArgs(Bun.argv.slice(2));
  const mode = options.mode ?? detectTestMode();
  let suites = await selectSuites();
  if (options.only.length > 0) {
    const unknown = options.only.filter((name) => !suites.includes(name));
    if (unknown.length > 0) throw new Error(`No enabled regression suite: ${unknown.join(", ")}`);
    suites = options.only;
  }
  console.log(`Extension regression (${mode}): ${suites.join(", ")}`);

  const container = options.container ?? generateUniqueContainerName("aza-pg-ext-regression");
  const owned = options.container === null;
  try {
    if (owned) {
      // Production mode runs the image's own default preload: passing the manifest's list would hide an image whose
      // default differs from it. Regression mode adds the optional preloads its suites need.
      const preloadEnv =
        mode === "production"
          ? []
          : ["-e", `POSTGRES_SHARED_PRELOAD_LIBRARIES=${getSharedPreloadLibraries(mode)}`];
      await $`docker run -d --name ${container} -e POSTGRES_PASSWORD=postgres ${preloadEnv} ${resolveImageTag()}`.quiet();
      await waitForPostgres({ container, timeout: TIMEOUTS.startup });
    }
    const results: TestResult[] = [];
    for (const name of suites) {
      const sqlFile = join(SUITE_DIR, name, "sql/basic.sql");
      const expectedFile = join(SUITE_DIR, name, "expected/basic.out");
      if (options.generateExpected && !(await Bun.file(expectedFile).exists())) {
        await Bun.write(expectedFile, "");
      }
      const result = await runRegressionTest(name, sqlFile, expectedFile, {
        containerName: container,
        database: "postgres",
        user: "postgres",
      });
      results.push(result);
      if (options.generateExpected) await Bun.write(expectedFile, result.actualOutput);
      const mark = result.passed ? "PASS" : "FAIL";
      console.log(
        `${mark}: ${name} (${Math.round(result.duration)}ms)${result.error ? ` - ${result.error}` : ""}`
      );
      if (!result.passed && result.diff && (options.verbose || !options.generateExpected)) {
        console.log(result.diff);
      }
    }
    if (options.generateExpected) return 0;
    const failed = results.filter((r) => !r.passed);
    await generateRegressionDiffs(
      results,
      join(import.meta.dir, "../../extension-regression.diffs")
    );
    console.log(`Passed ${results.length - failed.length}/${results.length}`);
    return failed.length === 0 ? 0 : 1;
  } finally {
    if (owned) await $`docker rm -f -v ${container}`.quiet().nothrow();
  }
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (err) {
    console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
