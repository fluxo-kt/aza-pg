#!/usr/bin/env bun
/**
 * `/release` Phase 0 and the mechanical half of Phase 1: `bun scripts/release/preflight.ts` on the release branch.
 *
 * Refuses unless a squash of dev would carry exactly the work since the last release:
 * - on `release` with a clean tree, so the squash commit holds nothing else;
 * - local dev contains origin/dev, so no pushed commit is left out (ahead is fine: unpushed work ships too);
 * - dev's newest "Anchor Merge" has the current release HEAD as its second parent: anything else means release
 *   moved after the anchor, and `git merge --squash` would re-apply or drop changes;
 * - dev has commits after that anchor.
 * Then prints what Phases 1–4 consume: the anchor, the dev tip for the Dev-Squash-Tip trailer, the work-commit range
 * and the deduplicated co-author trailers. Doing this in one process replaces hand-run pipelines that an output proxy
 * could truncate or rewrite without any error.
 */

import { git, isAncestor, stop } from "./git";

const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "release")
  stop(
    `on '${branch}', not 'release'. Agents cannot switch branches: ask Art to run ! git checkout release`
  );
const dirty = await git("status", "--porcelain");
if (dirty) stop(`the working tree is dirty; commit or remove these first:\n${dirty}`);

await git("fetch", "origin");
// refs/heads/dev, never bare `dev`: a repo file named dev would make git read it as a path.
const dev = await git("rev-parse", "refs/heads/dev");
if (!(await isAncestor("origin/dev", dev)))
  stop(
    "local dev lacks commits on origin/dev (behind or diverged); bring dev up to date with origin/dev first"
  );

const anchor = await git(
  "log",
  dev,
  "--merges",
  "--format=%H",
  "--regexp-ignore-case",
  "--grep=Anchor Merge",
  "-1"
);
if (!anchor)
  stop("dev has no Anchor Merge commit; anchor it first: bun scripts/release/anchor-merge.ts");
const head = await git("rev-parse", "HEAD");
const anchoredRelease = await git("rev-parse", `${anchor}^2`);
if (anchoredRelease !== head)
  stop(
    `dev's last anchor (${anchor.slice(0, 7)}) points at ${anchoredRelease.slice(0, 7)}, but release is at ${head.slice(0, 7)}. ` +
      "Anchor dev to the current release first: bun scripts/release/anchor-merge.ts"
  );

const range = `${anchor}..${dev}`;
const commits = await git("log", "--oneline", range);
if (!commits) stop("dev has no commits after its last anchor: nothing to release");
// Work commits only: merges are plumbing. Oldest last in git log order.
const work = (await git("rev-list", "--no-merges", range)).split("\n").filter(Boolean);
const first = work.at(-1) ?? anchor;
const last = work[0] ?? dev;

const coAuthors = new Map<string, string>();
for (const line of (await git("log", "--no-merges", "--format=%B", range)).split("\n")) {
  const trimmed = line.trim();
  if (/^co-authored-by:/i.test(trimmed) && !coAuthors.has(trimmed.toLowerCase()))
    coAuthors.set(trimmed.toLowerCase(), trimmed);
}

console.log(`ANCHOR=${anchor}
DEV_SQUASH_TIP=${dev}
RANGE=${first.slice(0, 7)}..${last.slice(0, 7)}
COMMITS=${commits.split("\n").length}

Commits (${range}):
${commits}

Co-authors:
${[...coAuthors.values()].join("\n") || "(none)"}`);
