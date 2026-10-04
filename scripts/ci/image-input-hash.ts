#!/usr/bin/env bun
/**
 * Prints the cache key of the CI image: equal keys mean the image would build the same, so CI may reuse it.
 *
 * Why: CI rebuilt the image on every push, docs-only commits included, and every test job waited for it. The key
 * covers what the build reads:
 * - every tracked file under a `COPY`/`ADD` source of the generated Dockerfile (git blob ids, so content, not
 *   mtimes), plus the Dockerfile and .dockerignore; `COPY --from=` copies between stages and reads no repo file;
 * - the package index state of each apt archive the base image configures (Debian <codename>, -updates, -security
 *   and PGDG), because the build runs `apt-get upgrade` (AGENTS.md "Digest-Pinned Base Security Drift"): without it
 *   a cached image would hide every security update published since it was built. The state is the SHA256 of each
 *   `<component>/binary-{amd64,arm64}/Packages` index listed in the archive's InRelease, for the components the
 *   image uses. Not the InRelease `Date:`: the archives re-sign several times a day without package changes, so a
 *   Date key would rebuild most pushes for nothing.
 * An archive that cannot be read yields a key no cache entry has, so CI rebuilds: a failure may cost time, never
 * reuse a stale image.
 *
 * Not covered, and why that is acceptable: inputs fetched by version from the network (rustup, bun installer,
 * extension git tags locked in extensions.manifest.json) follow tracked files; Percona/Timescale packages are
 * version-pinned. The key reads the git index, so locally uncommitted edits are invisible; CI checks out commits.
 *
 * Usage: bun scripts/ci/image-input-hash.ts   (prints the key on stdout)
 */

import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const DOCKERFILE = "docker/postgres/Dockerfile";
const ALWAYS = [DOCKERFILE, ".dockerignore"];

export interface IndexEntry {
  path: string;
  blob: string;
}

/** Repo paths the Dockerfile's COPY/ADD instructions read (stage-to-stage copies excluded). */
export function copySources(dockerfile: string): string[] {
  const sources = new Set<string>();
  for (const line of dockerfile.split("\n")) {
    const m = line.match(/^\s*(?:COPY|ADD)\s+(.*)$/i);
    if (!m) continue;
    const args = m[1]!.trim();
    if (args.startsWith("["))
      throw new Error(`JSON-form ${line.trim()} is not parsed; use the plain form`);
    const words = args.split(/\s+/);
    if (words.some((w) => w.startsWith("--from="))) continue;
    const operands = words.filter((w) => !w.startsWith("--"));
    // The last operand is the destination.
    for (const source of operands.slice(0, -1)) sources.add(source.replace(/^\.\//, ""));
  }
  return [...sources];
}

/** Index entries under any source (a file, or a directory written with or without a trailing slash). */
export function selectInputs(index: IndexEntry[], sources: string[]): IndexEntry[] {
  const dirs = sources.map((s) => (s.endsWith("/") ? s : `${s}/`));
  return index.filter((e) => sources.includes(e.path) || dirs.some((d) => e.path.startsWith(d)));
}

export function imageKey(inputs: IndexEntry[], archiveStates: string[]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const e of [...inputs].sort((a, b) => (a.path < b.path ? -1 : 1)))
    hasher.update(`${e.blob} ${e.path}\n`);
  for (const state of archiveStates) hasher.update(`archive ${state}\n`);
  return `aza-pg-ci-image-${hasher.digest("hex").slice(0, 32)}`;
}

/** Debian codename and PostgreSQL major of the base image, from `FROM postgres:<major>.<minor>-<codename>@sha256:…`. */
export function baseImage(dockerfile: string): { codename: string; pgMajor: string } {
  const m = dockerfile.match(/^FROM\s+postgres:(\d+)[\w.]*-([a-z]+)@sha256:/m);
  if (!m) throw new Error(`no "FROM postgres:<version>-<codename>@sha256:" line in ${DOCKERFILE}`);
  return { pgMajor: m[1]!, codename: m[2]! };
}

export interface Archive {
  url: string;
  /** Components the base image's apt sources enable for this archive. */
  components: string[];
}

export function archives(codename: string, pgMajor: string): Archive[] {
  const debian = ["main"];
  return [
    { url: `https://deb.debian.org/debian/dists/${codename}/InRelease`, components: debian },
    {
      url: `https://deb.debian.org/debian/dists/${codename}-updates/InRelease`,
      components: debian,
    },
    {
      url: `https://deb.debian.org/debian-security/dists/${codename}-security/InRelease`,
      components: debian,
    },
    // The base image's pgdg.list enables "main <major>".
    {
      url: `https://apt.postgresql.org/pub/repos/apt/dists/${codename}-pgdg/InRelease`,
      components: ["main", pgMajor],
    },
  ];
}

/**
 * "<sha256> <path>" of each Packages index for `components` in an InRelease file, sorted. Throws when a component
 * has no index, so an archive layout change forces a rebuild instead of a key that ignores the archive.
 */
export function packagesState(inRelease: string, components: string[]): string {
  const block = inRelease.split(/^SHA256:$/m)[1]?.split(/^\S/m)[0] ?? "";
  const lines = block
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter(
      (w) =>
        w.length === 3 &&
        components.some((c) => new RegExp(`^${c}/binary-(amd64|arm64)/Packages$`).test(w[2]!))
    )
    .map((w) => `${w[0]} ${w[2]}`)
    .sort();
  for (const c of components) {
    if (!lines.some((l) => l.endsWith(` ${c}/binary-amd64/Packages`))) {
      throw new Error(`no ${c}/binary-amd64/Packages in the SHA256 list`);
    }
  }
  return lines.join(",");
}

async function archiveState(archive: Archive): Promise<string> {
  const res = await fetch(archive.url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${archive.url}: HTTP ${res.status}`);
  return packagesState(await res.text(), archive.components);
}

async function main(): Promise<void> {
  const dockerfile = await Bun.file(join(ROOT, DOCKERFILE)).text();
  const sources = [...ALWAYS, ...copySources(dockerfile)];
  const index = (await Bun.$`git ls-files -s -z`.cwd(ROOT).quiet().text())
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      // "<mode> <blob> <stage>\t<path>"
      const [meta, path] = line.split("\t");
      return { path: path!, blob: meta!.split(" ")[1]! };
    });
  const inputs = selectInputs(index, sources);
  // A source no tracked file satisfies (generated at build time, or ignored) would change the image unseen.
  const uncovered = sources.filter((s) => selectInputs(index, [s]).length === 0);
  if (uncovered.length > 0) {
    throw new Error(
      `COPY sources with no tracked file, so the key cannot see them: ${uncovered.join(", ")}`
    );
  }

  const { codename, pgMajor } = baseImage(dockerfile);
  let states: string[];
  try {
    states = await Promise.all(archives(codename, pgMajor).map(archiveState));
  } catch (err) {
    console.error(
      `⚠️  apt archive state unreadable (${err instanceof Error ? err.message : err}); forcing a rebuild`
    );
    states = [`unreadable-${crypto.randomUUID()}`];
  }
  console.log(imageKey(inputs, states));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
