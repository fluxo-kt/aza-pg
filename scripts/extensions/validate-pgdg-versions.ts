#!/usr/bin/env bun
/**
 * Validates that PGDG package versions in the manifest match the latest available in the PGDG repo.
 * Prevents build failures from incorrect version strings, and flags pgdg packaging-revision drift
 * (e.g. `-2` → `-3`) that git-tag-based check-updates cannot see.
 *
 * Scope is intentionally PGDG-only. Percona and Timescale versions are NOT checked here because:
 *   - They are exact-pinned in the generated Dockerfile (`apt-get install pkg=version`), so a
 *     removed version already fails the release build loudly and blocks publish — the build is the
 *     authoritative oracle, and a pre-build apt-existence check would only move that same failure
 *     ~15 min earlier (no new safety).
 *   - Verifying them here would require setting up the Percona/packagecloud repos inside this check
 *     on every run, injecting third-party-repo network fragility into the `validate` hot path.
 *   - Their version *currency* (a newer revision exists) is surfaced informationally by
 *     check-updates.ts, not gated here (exact-match would red every dev on each vendor release).
 */

import { MANIFEST_ENTRIES, MANIFEST_METADATA } from "../extensions/manifest-data";
import { PACKAGE_NAME_MAP } from "../extensions/pgdg-mappings";

interface PgdgExtension {
  name: string;
  pgdgVersion: string;
  aptPackageName: string;
}

const pgdgExtensions: PgdgExtension[] = MANIFEST_ENTRIES.filter(
  (ext) => ext.install_via === "pgdg" && ext.pgdgVersion && ext.kind === "extension"
).map((ext) => ({
  name: ext.name,
  pgdgVersion: ext.pgdgVersion!,
  aptPackageName: `postgresql-18-${PACKAGE_NAME_MAP[ext.name] || ext.name.replace(/_/g, "-")}`,
}));

console.log(`Validating ${pgdgExtensions.length} PGDG package versions...\n`);

let hasErrors = false;

// Batch all apt-cache checks into a single Docker run for performance (20s → ~2s)
// Build bash script that checks all packages and outputs "packageName:version" per line
const checkCommands = pgdgExtensions
  .map(
    (ext) =>
      `version=$(apt-cache madison ${ext.aptPackageName} 2>&1 | head -1 | awk '{print $3}'); echo "${ext.aptPackageName}:$version"`
  )
  .join(" && ");

const bashScript = `apt-get update -qq >/dev/null 2>&1 && ${checkCommands}`;

// Run single Docker container to check all package versions
const result = Bun.spawnSync([
  "docker",
  "run",
  "--rm",
  `postgres:${MANIFEST_METADATA.pgVersion}-trixie`,
  "bash",
  "-c",
  bashScript,
]);

if (result.exitCode !== 0) {
  console.error(`❌ Failed to check PGDG versions (Docker command failed)`);
  console.error(`   stdout: ${result.stdout.toString()}`);
  console.error(`   stderr: ${result.stderr.toString()}`);
  process.exit(1);
}

// Parse output: each line is "packageName:version"
const output = result.stdout.toString().trim();
const versionMap = new Map<string, string>();

for (const line of output.split("\n")) {
  const colonIndex = line.indexOf(":");
  if (colonIndex === -1) continue;
  const pkg = line.slice(0, colonIndex);
  const version = line.slice(colonIndex + 1).trim();
  if (pkg && version) {
    versionMap.set(pkg, version);
  }
}

// Validate each extension against the retrieved versions
for (const ext of pgdgExtensions) {
  const availableVersion = versionMap.get(ext.aptPackageName);

  if (!availableVersion) {
    console.error(`❌ ${ext.name}: Package ${ext.aptPackageName} not found in PGDG`);
    hasErrors = true;
    continue;
  }

  if (availableVersion !== ext.pgdgVersion) {
    console.error(`❌ ${ext.name}: Version mismatch!`);
    console.error(`   Manifest:  ${ext.pgdgVersion}`);
    console.error(`   Available: ${availableVersion}`);
    console.error(`   → Update manifest-data.ts with the correct version`);
    hasErrors = true;
  } else {
    console.log(`✅ ${ext.name}: ${ext.pgdgVersion}`);
  }
}

if (hasErrors) {
  console.error("\n❌ PGDG version validation failed!");
  console.error("Fix the version mismatches in scripts/extensions/manifest-data.ts");
  process.exit(1);
}

console.log("\n✅ All PGDG versions validated successfully!");
