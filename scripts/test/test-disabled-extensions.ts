#!/usr/bin/env bun
/**
 * Extensions disabled in the manifest (`enabled: false`) must not be created by the image's init
 * scripts. Checked on the initialised database rather than by reading 01-extensions.sql: if the
 * generator emitted a disabled extension, init either fails (its files are not shipped, so the
 * container never becomes ready) or creates it (some package still ships it) — both turn this red.
 *
 * Usage: bun scripts/test/test-disabled-extensions.ts [image] [--image=TAG]
 */
import { $ } from "bun";
import { MANIFEST_ENTRIES } from "../extensions/manifest-data";
import { generateUniqueContainerName, waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";

const container = generateUniqueContainerName("aza-pg-disabled-ext");
const disabled = MANIFEST_ENTRIES.filter((e) => e.enabled === false && e.kind !== "tool").map(
  (e) => e.name
);

let failure: string | null = null;
try {
  if (disabled.length === 0) throw new Error("manifest has no disabled extension to check");
  await $`docker run -d --name ${container} -e POSTGRES_PASSWORD=postgres ${resolveImageTag()}`.quiet();
  await waitForPostgres({ container, timeout: 120 });
  const query = `SELECT coalesce(string_agg(extname, ', '), '') FROM pg_extension WHERE extname = ANY(ARRAY['${disabled.join("','")}'])`;
  const r = await $`docker exec ${container} psql -X -v ON_ERROR_STOP=1 -U postgres -tA -c ${query}`
    .quiet()
    .nothrow();
  if (r.exitCode !== 0) throw new Error(r.stderr.toString().trim());
  const created = r.stdout.toString().trim();
  if (created !== "") failure = `init created disabled extension(s): ${created}`;
} catch (err) {
  failure = `setup: ${err instanceof Error ? err.message : String(err)}`;
} finally {
  await $`docker rm -f -v ${container}`.quiet().nothrow();
}
if (failure) {
  console.error(`FAIL: ${failure}`);
  process.exit(1);
}
console.log(`PASS: init created none of the disabled extensions (${disabled.join(", ")})`);
