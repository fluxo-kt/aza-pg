#!/usr/bin/env bun
/**
 * Generate docker/postgres/extensions.manifest.json from manifest-data.ts.
 * Resolves git commits for tagged sources to guarantee reproducible builds.
 */

import { dirname, join } from "node:path";
import { spawn } from "bun";
import { MANIFEST_ENTRIES, ManifestEntry, SourceSpec } from "./manifest-data";

type ResolvedSource =
  | { type: "builtin" }
  | { type: "git"; repository: string; tag: string; commit: string }
  | { type: "git-ref"; repository: string; ref: string; commit: string };

type ResolvedEntry = Omit<ManifestEntry, "source"> & { source: ResolvedSource };

async function resolveGitCommit(repo: string, tag: string): Promise<string> {
  const proc = spawn(["git", "ls-remote", repo, `refs/tags/${tag}^{}`, `refs/tags/${tag}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`git ls-remote failed for ${repo} tag ${tag}: ${stderr || stdout}`);
  }
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    throw new Error(`No commits found for ${repo} tag ${tag}`);
  }
  // Prefer peeled commit if available (^{}), otherwise first entry.
  const peeled = lines.find((line) => line.endsWith(`refs/tags/${tag}^{}`));
  const selected = peeled ?? lines[0];
  if (!selected) {
    throw new Error(`No lines available from ls-remote output for ${repo} tag ${tag}`);
  }
  const [commit] = selected.split(/\s+/);
  if (!commit) {
    throw new Error(`Unable to parse commit from ls-remote output for ${repo} tag ${tag}`);
  }
  return commit;
}

async function resolveSource(source: SourceSpec): Promise<ResolvedSource> {
  if (source.type === "builtin") {
    return source;
  }
  if (source.type === "git") {
    const commit = await resolveGitCommit(source.repository, source.tag);
    return { ...source, commit };
  }
  // git-ref
  return { ...source, commit: source.ref };
}

async function main() {
  const resolved: ResolvedEntry[] = [];
  for (const entry of MANIFEST_ENTRIES) {
    const source = await resolveSource(entry.source);
    resolved.push({ ...entry, source });
  }

  resolved.sort((a, b) => a.name.localeCompare(b.name));

  const manifest = {
    generatedAt: new Date().toISOString(),
    entries: resolved,
  };

  const outputPath = join("docker", "postgres", "extensions.manifest.json");
  await Bun.$`mkdir -p ${dirname(outputPath)}`;
  await Bun.write(outputPath, JSON.stringify(manifest, null, 2) + "\n");

  const packages = Array.from(
    new Set(
      resolved
        .flatMap((entry) => entry.aptPackages ?? [])
        .filter((pkg): pkg is string => typeof pkg === "string" && pkg.length > 0)
    )
  ).toSorted((a, b) => a.localeCompare(b));
  const packagesPath = join("docker", "postgres", "extensions.build-packages.txt");
  await Bun.write(packagesPath, packages.join("\n") + "\n");

  console.log(
    `Wrote ${outputPath} with ${resolved.length} entries and ${packages.length} build packages.`
  );
}

await main();
