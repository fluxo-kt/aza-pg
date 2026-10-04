#!/usr/bin/env bun
/**
 * Fails when `bun run generate` would change any file in GENERATED_FILES, i.e. a committed generated file
 * is stale or was edited by hand. This is the only freshness check: generation is offline and
 * deterministic (tag commits come from the lock in extensions.manifest.json), so regenerating and
 * comparing bytes is exact and takes under a second.
 *
 * The regenerated files are left in place, as the pre-commit hook would leave them; the previous bytes of
 * every changed file are saved first so a hand edit is never lost silently.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENERATED_FILES } from "./generated-files";

const readAll = () =>
  Promise.all(
    GENERATED_FILES.map(async (file) => {
      const handle = Bun.file(file);
      return (await handle.exists()) ? handle.text() : null;
    })
  );

const before = await readAll();

const proc = Bun.spawn(["bun", "run", "generate"], { stdout: "pipe", stderr: "pipe" });
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
]);
if (exitCode !== 0) {
  console.error(`❌ \`bun run generate\` failed (exit ${exitCode}):\n${stdout}${stderr}`);
  process.exit(1);
}

const after = await readAll();
const changed = GENERATED_FILES.flatMap((file, i) =>
  before[i] === after[i] ? [] : [{ file, previous: before[i] ?? null }]
);

if (changed.length === 0) {
  console.log(`✅ All ${GENERATED_FILES.length} generated files are up to date`);
  process.exit(0);
}

const backupDir = await mkdtemp(join(tmpdir(), "aza-pg-generated-before-"));
await Promise.all(
  changed.map(({ file, previous }) =>
    // Full path in the name: several stacks each generate a pg_hba.conf.
    previous === null ? null : Bun.write(join(backupDir, file.replaceAll("/", "__")), previous)
  )
);
console.error(
  [
    "❌ Generated files were stale; `bun run generate` has now rewritten them:",
    ...changed.map(({ file }) => `  - ${file}`),
    `Previous contents: ${backupDir}`,
    "Edit the sources (manifest-data.ts, *.template, generators), never the generated files.",
    "Review with `git diff`, then commit the regenerated files with the source change that caused them.",
  ].join("\n")
);
process.exit(1);
