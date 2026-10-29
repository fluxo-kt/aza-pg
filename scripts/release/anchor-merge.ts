#!/usr/bin/env bun
/**
 * Anchors the published release on dev: `bun scripts/release/anchor-merge.ts` (any branch checked out).
 *
 * Makes a commit whose tree IS the released tree, with dev's tip and the release tag as parents, and moves dev to it.
 * The next `git merge --squash refs/heads/dev` on release then carries only the work done after this release, and dev
 * holds every release-time edit (the dated CHANGELOG section, kaizen commits). `git merge --no-ff` would 3-way merge
 * and revert those edits; commit-tree forces the tree.
 *
 * Nothing here needs a person: the release is the v* tag on origin/release's tip (a re-tag or hand-pushed tag
 * elsewhere is never picked), and the only way to lose work is dev holding commits the squash did not contain, which
 * is checked against the Dev-Squash-Tip trailer and refused. Works without checking dev out: the ref moves only if it
 * still points where it was read (update-ref compare-and-swap). Re-running after success does nothing.
 */

export {}; // a module, for top-level await

async function git(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err.trim()}`);
  return out.trim();
}
const isAncestor = async (a: string, b: string) =>
  (await Bun.spawn(["git", "merge-base", "--is-ancestor", a, b], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited) === 0;
function stop(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
}

await git("fetch", "--tags", "origin");
const tag = (await git("tag", "-l", "v*", "--points-at", "origin/release")).split("\n")[0];
if (!tag)
  stop(
    "origin/release's tip has no v* tag: publish has not finished or failed. Re-run after it succeeds."
  );
const dev = await git("rev-parse", "refs/heads/dev");
if (dev !== (await git("rev-parse", "origin/dev")))
  stop(
    "local dev differs from origin/dev. Push or pull dev first, so the anchor is built on the commits everyone has."
  );
if (await isAncestor(tag, dev)) {
  console.log(`✅ dev already contains ${tag}; nothing to do.`);
  process.exit(0);
}

// The squash commit sits below any kaizen commits on the tag, hence the ancestry search.
const squashTip = (
  await git("log", tag, "-10", "--format=%(trailers:key=Dev-Squash-Tip,valueonly)")
)
  .split("\n")
  .find(Boolean);
// A release made by direct commits on release (a hotfix) has no trailer; then dev must hold nothing since its last
// anchor, or that work's files would be overwritten.
const base =
  squashTip ??
  (await git(
    "log",
    dev,
    "--merges",
    "--format=%H",
    "--regexp-ignore-case",
    "--grep=Anchor Merge",
    "-1"
  ));
if (!base)
  stop(
    `${tag} has no Dev-Squash-Tip trailer and dev has no earlier anchor: compare dev with it by hand.`
  );
if (base !== dev) {
  const extra = await git("log", "--oneline", `${base}..${dev}`);
  stop(
    `dev has commits the release does not contain; anchoring would overwrite their files:\n${extra || `(dev ${dev} is not a descendant of ${base})`}\n` +
      "Release them first (another /release), or anchor and cherry-pick them back onto dev."
  );
}

const anchor = await git(
  "commit-tree",
  `${tag}^{tree}`,
  "-p",
  dev,
  "-p",
  tag,
  "-m",
  `Anchor Merge: merging ${dev.slice(0, 7)} and ${tag} (${(await git("rev-parse", "--short", tag)).trim()})`
);
// A checked-out dev must move with its working tree; otherwise the ref alone moves.
if ((await git("rev-parse", "--abbrev-ref", "HEAD")) === "dev") {
  await git("merge", "--ff-only", anchor);
  console.log(
    "dev's working tree moved to the released tree: run bun install before validating there."
  );
} else await git("update-ref", "refs/heads/dev", anchor, dev);
await git("push", "origin", "refs/heads/dev");
console.log(`✅ dev anchored to ${tag} at ${anchor.slice(0, 7)} and pushed.`);
