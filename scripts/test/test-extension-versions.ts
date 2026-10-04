#!/usr/bin/env bun
/**
 * Extension version gate for a fresh image: every enabled extension must be installable
 * (`pg_available_extensions`), and its control file's `default_version` — plus `extversion` of every
 * precreated extension — must be on the MAJOR.MINOR release line its manifest entry pins.
 *
 * `pg_aza_status.failed_extensions` is deliberately not read: 01-extensions.sql raises when any
 * extension fails, which rolls that row back and stops the container, so a ready server always
 * shows it empty; the failed init itself turns this suite red at startup.
 *
 * The manifest is read from this checkout, so testing a remote tag built from another commit can
 * report a mismatch that is real for that pairing.
 *
 * Usage: bun scripts/test/test-extension-versions.ts [image] [--image=TAG]
 */
import { $ } from "bun";
import { MANIFEST_ENTRIES } from "../extensions/manifest-data";
import { generateUniqueContainerName, waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";

const image = resolveImageTag();
const container = generateUniqueContainerName("aza-pg-ext-versions");

/**
 * The MAJOR.MINOR of a version string. Upstream tags carry prefixes (`v0.8.7`, `ver_1.2`), and the
 * SQL version in the control file is not the tag: pg_cron v1.6.8 ships `1.6`, and pg_net v0.20.5
 * still ships `0.20.4` (its Makefile pins EXTVERSION separately). MAJOR.MINOR is the finest grain
 * both agree on, and it still catches a build of the wrong release line.
 */
function majorMinor(version: string): string | null {
  return version.match(/(\d+\.\d+)/)?.[1] ?? null;
}

async function psql(sql: string): Promise<string> {
  const r =
    await $`docker exec ${container} psql -X -v ON_ERROR_STOP=1 -U postgres -tA ${"-F|"} -c ${sql}`
      .quiet()
      .nothrow();
  if (r.exitCode !== 0) throw new Error(`${sql}\n${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

async function main(): Promise<string[]> {
  await $`docker run -d --name ${container} -e POSTGRES_PASSWORD=postgres ${image}`.quiet();
  await waitForPostgres({ container, timeout: 120 });

  const failures: string[] = [];

  const rows = (s: string) =>
    new Map(
      s
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("|") as [string, string])
    );
  const available = rows(await psql("SELECT name, default_version FROM pg_available_extensions"));
  const installed = rows(await psql("SELECT extname, extversion FROM pg_extension"));

  let checked = 0;
  for (const entry of MANIFEST_ENTRIES) {
    if (entry.kind !== "extension" || entry.enabled === false || entry.runtime?.preloadOnly) {
      continue;
    }
    const tag = "tag" in entry.source ? entry.source.tag : undefined;
    const expected = tag ? majorMinor(tag) : null;
    if (!expected) continue; // commit-pinned sources declare no version to compare
    checked++;
    const shipped = available.get(entry.name);
    if (shipped === undefined) {
      failures.push(`${entry.name}: not in pg_available_extensions (manifest ${expected})`);
      continue;
    }
    if (majorMinor(shipped) !== expected) {
      failures.push(`${entry.name}: default_version ${shipped} != manifest ${expected}`);
    }
    const created = installed.get(entry.name);
    if (created !== undefined && majorMinor(created) !== expected) {
      failures.push(`${entry.name}: extversion ${created} != manifest ${expected}`);
    }
  }
  if (checked === 0) failures.push("no manifest extension had a comparable version");
  console.log(`Compared ${checked} extensions against the manifest`);
  return failures;
}

let failures: string[];
try {
  failures = await main();
} catch (err) {
  failures = [`setup: ${err instanceof Error ? err.message : String(err)}`];
} finally {
  await $`docker rm -f -v ${container}`.quiet().nothrow();
}
for (const f of failures) console.error(`FAIL: ${f}`);
console.log(failures.length === 0 ? "PASS: extension versions" : `${failures.length} failure(s)`);
process.exit(failures.length === 0 ? 0 : 1);
