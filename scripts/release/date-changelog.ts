#!/usr/bin/env bun
/**
 * Dates the release being made: `bun scripts/release/date-changelog.ts` (run by /release Phase 4.4 in
 * the squashed release commit). Moves the `[Unreleased]` entries under
 * `## [v<pgVersion>-<UTC yyyymmddHHMM>] - <UTC date>` and prints that tag.
 *
 * The heading is the release's single source of truth (see changelog.ts): publish.yml names the tag and
 * builds the GitHub notes from it, so it must be written here, in the commit that ships, never after.
 * pgVersion comes from the manifest; publish.yml refuses the heading if the built image's PostgreSQL
 * differs.
 */

import path from "node:path";
import { MANIFEST_METADATA } from "../extensions/manifest-data";
import { newestRelease } from "./changelog";

const changelogPath = path.join(import.meta.dir, "../../CHANGELOG.md");
const text = await Bun.file(changelogPath).text();
const lines = text.split("\n");

const start = lines.findIndex((line) => line === "## [Unreleased]");
if (start === -1) throw new Error("CHANGELOG.md has no `## [Unreleased]` heading");
const rel = lines.slice(start + 1).findIndex((line) => line.startsWith("## ["));
const end = rel === -1 ? lines.length : start + 1 + rel;
const body = lines.slice(start + 1, end);
if (!body.some((line) => line.startsWith("- "))) {
  console.error(
    `[Unreleased] has no entries, so there is nothing to release. Newest release: ${newestRelease(text)?.version ?? "none"}.`
  );
  process.exit(1);
}

const now = new Date().toISOString(); // 2026-11-10T15:30:12.345Z
const date = now.slice(0, 10);
const tag = `v${MANIFEST_METADATA.pgVersion}-${now.slice(0, 16).replace(/[-T:]/g, "")}`;

const result = [
  ...lines.slice(0, start + 1),
  "",
  `## [${tag}] - ${date}`,
  ...body,
  ...lines.slice(end),
].join("\n");

// publish.yml reads the tag back through newestRelease; prove it gets this one.
if (`v${newestRelease(result)?.version}` !== tag)
  throw new Error(`internal: ${tag} would not be read back as the newest release`);

await Bun.write(changelogPath, result);
console.log(tag);
