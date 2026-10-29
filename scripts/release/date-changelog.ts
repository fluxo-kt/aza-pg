#!/usr/bin/env bun
/**
 * Dates a published release in CHANGELOG.md: `bun scripts/release/date-changelog.ts <tag> [changelog]`.
 *
 * publish.yml names the tag at build time (v<pg>-<UTC timestamp>) and builds the GitHub release notes
 * from `[Unreleased]`, so the release commit cannot carry its own dated heading. The release is dated
 * right after the anchor merge (release.md Appendix A): the anchor makes dev's tree the released tree,
 * so `[Unreleased]` is then exactly the published text and moves whole under `## [<tag>] - <date>`.
 *
 * Catch-up (work landed on dev after the release): the section is the tag's own `[Unreleased]`, copied
 * byte-for-byte from `git show <tag>:CHANGELOG.md`; lines of it are removed from the current
 * `[Unreleased]` and every remaining line is printed. Those were added or edited after the release, so
 * each must state "<version in that release> → current", never a range that includes shipped steps.
 *
 * Idempotent: a changelog that already has `## [<tag>]` is left unchanged.
 */

import path from "node:path";

const [tag, changelogArg] = Bun.argv.slice(2);
if (!tag) {
  console.error("Usage: bun scripts/release/date-changelog.ts <published tag> [CHANGELOG path]");
  process.exit(2);
}
const changelogPath = changelogArg ?? path.join(import.meta.dir, "../../CHANGELOG.md");

async function git(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err.trim()}`);
  return out;
}

/** Splits a changelog around the section whose `## [` heading line starts with `heading`. */
function splitSection(
  text: string,
  heading: string
): { head: string[]; body: string[]; tail: string[] } {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start === -1) throw new Error(`no \`${heading}\` heading`);
  const rel = lines.slice(start + 1).findIndex((l) => l.startsWith("## ["));
  const end = rel === -1 ? lines.length : start + 1 + rel;
  return {
    head: lines.slice(0, start + 1),
    body: lines.slice(start + 1, end),
    tail: lines.slice(end),
  };
}

const current = await Bun.file(changelogPath).text();
if (current.split("\n").some((l) => l.startsWith(`## [${tag}]`))) {
  console.log(`${tag} is already dated; nothing to do.`);
  process.exit(0);
}

const date = (
  await git("for-each-ref", `refs/tags/${tag}`, "--format=%(creatordate:short)")
).trim();
if (!date) throw new Error(`tag ${tag} not found; run git fetch --tags origin`);
const released = splitSection(await git("show", `${tag}:CHANGELOG.md`), "## [Unreleased]").body;
if (!released.some((l) => l.startsWith("- ")))
  throw new Error(`${tag}'s [Unreleased] has no entries`);

const { head, body, tail } = splitSection(current, "## [Unreleased]");

// Remove the released lines once each (a line may legitimately repeat, e.g. blank lines), then drop
// category headings left without entries.
const pending = new Map<string, number>();
for (const l of released) pending.set(l, (pending.get(l) ?? 0) + 1);
const kept = body.filter((l) => {
  const n = pending.get(l) ?? 0;
  if (n === 0 || l.trim() === "") return true;
  pending.set(l, n - 1);
  return false;
});
const leftover = kept.filter((l, i) => {
  if (!l.startsWith("### ")) return true;
  const next = kept.slice(i + 1).find((x) => x.trim() !== "");
  return next !== undefined && !next.startsWith("### ");
});
const leftoverBody = leftover
  .join("\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const section = [`## [${tag}] - ${date}`, ...released];
const result = [...head, "", ...(leftoverBody ? [leftoverBody, ""] : []), ...section, ...tail].join(
  "\n"
);

// The dated section must be the published text, unchanged.
if (splitSection(result, `## [${tag}]`).body.join("\n") !== released.join("\n"))
  throw new Error(
    "internal: dated section differs from the released text; CHANGELOG left unchanged"
  );

await Bun.write(changelogPath, result);
console.log(`Dated ${tag} (${date}).`);
const entries = leftover.filter((l) => l.startsWith("- "));
if (entries.length > 0) {
  console.log(
    `\n${entries.length} [Unreleased] entr${entries.length === 1 ? "y was" : "ies were"} added or edited after ${tag}.` +
      ` Make each state "<version in ${tag}> → current" (see docker/postgres/extensions.manifest.json at the tag):\n`
  );
  for (const e of entries) console.log(e.length > 160 ? `${e.slice(0, 157)}...` : e);
}
