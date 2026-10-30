#!/usr/bin/env bun
/**
 * Refuses a size labelled KiB/MiB/GiB/TiB anywhere in the repo: sizes read KB/MB/GB and mean 1024-based units (AGENTS.md, and
 * `formatSize` in scripts/utils/logger.ts). Agents default to IEC labels, so text alone does not hold the convention.
 * Skipped: released CHANGELOG sections (frozen: they record what shipped) and docker/postgres/patches/ (upstream
 * diffs we must not reword).
 */

import path from "node:path";
import { error, success } from "../utils/logger";

const root = path.resolve(import.meta.dir, "../..");
const proc = Bun.spawn(
  [
    "git",
    "grep",
    "--no-recurse-submodules",
    "--untracked",
    "-nIE",
    "[0-9][[:space:]]?[KMGT]iB([^[:alnum:]]|$)",
    "--",
    ".",
    ":!docker/postgres/patches/",
  ],
  { cwd: root, stdout: "pipe", stderr: "inherit" }
);
const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
if (code > 1) process.exit(code); // 1 = no match

const changelog = (await Bun.file(path.join(root, "CHANGELOG.md")).text()).split("\n");
const firstReleased = changelog.findIndex((line) => line.startsWith("## [v")) + 1; // 1-based; 0 = none yet
const hits = out
  .split("\n")
  .filter(Boolean)
  .filter((hit) => {
    const [file, line] = hit.split(":");
    return !(file === "CHANGELOG.md" && firstReleased > 0 && Number(line) >= firstReleased);
  });

if (hits.length > 0) {
  error(
    `Sizes in this repo read KB/MB/GB in 1024-based units; write MB, not MiB (AGENTS.md):\n${hits.join("\n")}`
  );
  process.exit(1);
}
success("Size units: no KiB/MiB/GiB/TiB");
