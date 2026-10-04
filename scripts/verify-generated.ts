#!/usr/bin/env bun
/**
 * Fails when `bun run generate` would change any file in GENERATED_FILES, i.e. a committed generated file
 * is stale or was edited by hand. This is the only freshness check: generation is offline and
 * deterministic (tag commits come from the lock in extensions.manifest.json), so regenerating and
 * comparing bytes is exact.
 *
 * It never writes the working tree: generation runs in a temporary copy of it (tracked and untracked,
 * non-ignored files, as they are on disk now) and only the outputs are compared. Regenerating in place
 * overwrote files other people were still editing whenever validate ran beside them.
 */

import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { GENERATED_FILES } from "./generated-files";

const root = resolve(import.meta.dir, "..");
/** Regenerates in `copy` and returns the exit code; the caller removes the copy whatever happens. */
async function check(copy: string): Promise<number> {
  const files = (await $`git ls-files -z --cached --others --exclude-standard`.cwd(root).text())
    .split("\0")
    .filter(Boolean);
  await Promise.all(
    files.map(async (file) => {
      const source = Bun.file(join(root, file));
      // A tracked file deleted in the working tree is absent from the copy too, as it is for generate.
      if (await source.exists()) await Bun.write(join(copy, file), source);
    })
  );
  // Generators run prettier and other dev tools from node_modules; linking avoids copying it.
  await symlink(join(root, "node_modules"), join(copy, "node_modules"));

  const proc = Bun.spawn(["bun", "run", "generate"], { cwd: copy, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    console.error(`❌ \`bun run generate\` failed (exit ${exitCode}):\n${stdout}${stderr}`);
    return 1;
  }

  const read = async (path: string) => {
    const handle = Bun.file(path);
    return (await handle.exists()) ? handle.text() : null;
  };
  const stale = (
    await Promise.all(
      GENERATED_FILES.map(async (file) =>
        (await read(join(root, file))) === (await read(join(copy, file))) ? null : file
      )
    )
  ).filter((file) => file !== null);

  if (stale.length === 0) {
    console.log(`✅ All ${GENERATED_FILES.length} generated files are up to date`);
    return 0;
  }
  console.error(
    [
      "❌ Generated files differ from what `bun run generate` produces from the current sources:",
      ...stale.map((file) => `  - ${file}`),
      "Edit the sources (manifest-data.ts, *.template, generators), never the generated files; then run",
      "`bun run generate` and commit the regenerated files with the source change that caused them.",
    ].join("\n")
  );
  return 1;
}

const copy = await mkdtemp(join(tmpdir(), "aza-pg-verify-generated-"));
try {
  process.exitCode = await check(copy);
} finally {
  await rm(copy, { recursive: true, force: true });
}
