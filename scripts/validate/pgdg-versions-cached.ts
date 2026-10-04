#!/usr/bin/env bun
/**
 * Run the PGDG version check (scripts/extensions/validate-pgdg-versions.ts) only when its inputs changed
 * since the last run that passed.
 *
 * The check starts a container and runs `apt-get update` against the PGDG repository, which costs tens of
 * seconds per run. Its inputs are the PostgreSQL version and every PGDG entry's apt package name and pin,
 * plus the check's own source; the cache key is the sha256 of exactly those, so editing any pin, adding or
 * removing a PGDG entry, or changing the check re-runs it. Only a passing run writes the key, so a failure
 * is re-checked every time until fixed.
 *
 * What the key cannot see is PGDG publishing a newer revision of an unchanged pin. `bun run validate:all`
 * (and so every CI lane) passes --no-cache, which always runs the real check; the fast lane trades that
 * drift signal for staying local.
 *
 * Usage: bun scripts/validate/pgdg-versions-cached.ts [--no-cache]
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { MANIFEST_ENTRIES, MANIFEST_METADATA } from "../extensions/manifest-data";
import { pgdgAptPackageName } from "../extensions/pgdg-package";

const REPO_ROOT = join(import.meta.dir, "../..");
const CHECK = "scripts/extensions/validate-pgdg-versions.ts";
const CACHE_DIR = join(REPO_ROOT, "node_modules/.cache/aza-pg/pgdg-versions");

type PgdgEntry = Parameters<typeof pgdgAptPackageName>[0] & {
  install_via?: string;
  pgdgVersion?: string;
};

/** sha256 over everything the PGDG check reads: PG version, each PGDG entry's apt name and pin, its source. */
export function pgdgCacheKey(
  entries: readonly PgdgEntry[],
  pgVersion: string,
  checkSource: string
): string {
  const pgMajor = pgVersion.split(".")[0]!;
  // pgdgAptPackageName throws for an extension without pgdgPackage, with the same message the check
  // itself would print, so that defect fails here before any cache lookup.
  const pins = entries
    .filter((entry) => entry.install_via === "pgdg")
    .map((entry) => [entry.name, pgdgAptPackageName(entry, pgMajor), entry.pgdgVersion ?? null]);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify({ pgVersion, pins }));
  hasher.update(checkSource);
  return hasher.digest("hex");
}

if (import.meta.main) {
  const noCache = Bun.argv.includes("--no-cache");
  const key = pgdgCacheKey(
    MANIFEST_ENTRIES,
    MANIFEST_METADATA.pgVersion,
    await Bun.file(join(REPO_ROOT, CHECK)).text()
  );
  const marker = join(CACHE_DIR, key);

  if (!noCache && (await Bun.file(marker).exists())) {
    console.log(
      `✅ PGDG pins unchanged since a passing check (cache ${key.slice(0, 12)}); PGDG not contacted. ` +
        "`bun run validate:all` always re-checks."
    );
    process.exit(0);
  }

  const proc = Bun.spawn(["bun", join(REPO_ROOT, CHECK)], {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode === 0) {
    await mkdir(CACHE_DIR, { recursive: true });
    await Bun.write(marker, `${new Date().toISOString()}\n`);
  }
  process.exit(exitCode);
}
