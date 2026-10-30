#!/usr/bin/env bun
/**
 * Every enabled manifest entry whose shipped code differs from the newest release must be named in
 * CHANGELOG.md's [Unreleased] (AGENTS.md "Changelog": one entry per component).
 *
 * Shipped code = the pinned source commit plus the content of every patch applied to it (build.patches).
 * Comparing versions alone is not enough: a patch-only change (a lockfile bump that clears a CVE) moves no
 * version, and it is exactly the change an author names for one extension and forgets for the next.
 * An entry names a component by its manifest name (case-insensitive), e.g. "Vault (supabase_vault) …".
 *
 * The baseline is the tag of the newest dated heading. Without that tag in this clone (CI's shallow
 * checkout, or a release commit whose tag publish.yml has not created yet) there is nothing to compare;
 * the check prints that instead of passing as if it had compared. Pre-commit and /release run where tags exist.
 */

import { $ } from "bun";
import { newestRelease } from "../release/changelog";

type Entry = {
  name: string;
  enabled?: boolean;
  source?: { commit?: string };
  build?: { patches?: string[] };
};

const MANIFEST = "docker/postgres/extensions.manifest.json";
const PATCHES = "docker/postgres/patches";

const changelog = await Bun.file("CHANGELOG.md").text();
const release = newestRelease(changelog);
if (!release) {
  console.log("CHANGELOG.md has no dated release: nothing to compare against.");
  process.exit(0);
}
const tag = `v${release.version}`;
const oldManifest = await $`git show ${`${tag}:${MANIFEST}`}`.nothrow().quiet();
if (oldManifest.exitCode !== 0) {
  console.log(`Release tag ${tag} is not in this clone: changelog coverage NOT checked.`);
  process.exit(0);
}

const readAt = async (ref: string | null, file: string): Promise<string> =>
  ref === null
    ? Bun.file(file).text()
    : (await $`git show ${`${ref}:${file}`}`.nothrow().quiet()).stdout.toString();

/** What the entry puts into the image, or "absent" when it ships nothing. */
async function shipped(entry: Entry | undefined, ref: string | null): Promise<string> {
  if (!entry || entry.enabled === false) return "absent";
  const patches = await Promise.all(
    (entry.build?.patches ?? []).map(
      async (p) => `${p}:${Bun.hash(await readAt(ref, `${PATCHES}/${p}`))}`
    )
  );
  return JSON.stringify([entry.source?.commit ?? null, patches]);
}

const byName = (entries: Entry[]) => new Map(entries.map((e) => [e.name, e]));
const before = byName(JSON.parse(oldManifest.stdout.toString()).entries);
const now = byName((await Bun.file(MANIFEST).json()).entries);
const start = changelog.indexOf("## [Unreleased]");
const unreleased = changelog.slice(start, changelog.indexOf("\n## [v", start)).toLowerCase();

const missing: string[] = [];
for (const name of new Set([...before.keys(), ...now.keys()])) {
  const changed = (await shipped(before.get(name), tag)) !== (await shipped(now.get(name), null));
  if (changed && !unreleased.includes(name.toLowerCase())) missing.push(name);
}

if (missing.length > 0) {
  console.error(
    `CHANGELOG.md [Unreleased] does not name: ${missing.join(", ")}.\n` +
      `Their shipped code (pinned commit or build.patches content) differs from release ${tag}, so an operator ` +
      `upgrading from it gets a change the changelog does not mention. Add one entry per component as AGENTS.md ` +
      `"Changelog" says: "<name> <version in ${tag}> → <current>" with the concrete fix from upstream's notes for ` +
      `that range; for a patch-only change, name the patched dependency, its versions and the advisory. Write the ` +
      `manifest name in the entry (e.g. "Vault (supabase_vault)") so this check can find it.`
  );
  process.exit(1);
}
console.log(`Every component changed since ${tag} is named in [Unreleased].`);
