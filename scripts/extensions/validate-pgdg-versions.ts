#!/usr/bin/env bun
/**
 * Validates that PGDG package versions in manifest match what's available in the repository
 * Prevents build failures from incorrect version strings
 */

import { MANIFEST_ENTRIES } from "../extensions/manifest-data.ts";

interface PgdgExtension {
  name: string;
  pgdgVersion: string;
  aptPackageName: string;
}

// Map manifest extension names to PGDG apt package names
// Must match PGDG_MAPPINGS in scripts/docker/generate-dockerfile.ts
const PACKAGE_NAME_MAP: Record<string, string> = {
  pg_repack: "repack",
  hll: "hll",
  postgis: "postgis-3",
  vector: "pgvector",
  rum: "rum",
  hypopg: "hypopg",
  http: "http",
  pg_cron: "cron",
  set_user: "set-user",
  pgrouting: "pgrouting",
  pgaudit: "pgaudit",
  plpgsql_check: "plpgsql-check",
};

const pgdgExtensions: PgdgExtension[] = MANIFEST_ENTRIES.filter(
  (ext) => ext.install_via === "pgdg" && ext.pgdgVersion && ext.kind === "extension"
).map((ext) => ({
  name: ext.name,
  pgdgVersion: ext.pgdgVersion!,
  aptPackageName: `postgresql-18-${PACKAGE_NAME_MAP[ext.name] || ext.name.replace(/_/g, "-")}`,
}));

console.log(`Validating ${pgdgExtensions.length} PGDG package versions...\n`);

let hasErrors = false;

for (const ext of pgdgExtensions) {
  // Check if the version exists in PGDG repository
  const result = Bun.spawnSync([
    "docker",
    "run",
    "--rm",
    "postgres:18.1-trixie",
    "bash",
    "-c",
    `apt-get update -qq 2>&1 > /dev/null && apt-cache madison ${ext.aptPackageName} 2>&1 | head -1 | awk '{print $3}'`,
  ]);

  if (result.exitCode !== 0) {
    console.error(`❌ ${ext.name}: Failed to check version`);
    console.error(`   stderr: ${result.stderr.toString()}`);
    hasErrors = true;
    continue;
  }

  const availableVersion = result.stdout.toString().trim();

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
