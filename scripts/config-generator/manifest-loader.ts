/**
 * Manifest Loader
 * Handles loading and parsing of extension manifest files
 */

import { join } from "node:path";
import type { ManifestEntry, SOURCE_LIBRARIES } from "../extensions/manifest-data";

/** A tagged source carries the commit its tag resolved to; the build clones that commit, not the tag. */
export type ResolvedSource =
  | { type: "builtin" }
  | { type: "git"; repository: string; tag: string; commit: string }
  | { type: "git-ref"; repository: string; ref: string; commit: string };

export type ResolvedEntry = Omit<ManifestEntry, "source"> & { source: ResolvedSource };

/**
 * docker/postgres/extensions.manifest.json as generate-manifest.ts writes it. Readers take this type rather than
 * declaring their own: a local copy keeps compiling after a manifest field is renamed, then reads `undefined`.
 */
export interface Manifest {
  /** Sorted by name. */
  entries: ResolvedEntry[];
  sourceLibraries: typeof SOURCE_LIBRARIES;
}

/**
 * Load and parse the extension manifest from JSON file
 * @param repoRoot - Repository root directory path
 * @returns Parsed manifest object
 * @throws Error if manifest file cannot be read or parsed
 */
export async function loadManifest(repoRoot: string): Promise<Manifest> {
  const manifestPath = join(repoRoot, "docker/postgres/extensions.manifest.json");

  try {
    const manifestFile = Bun.file(manifestPath);
    const manifestJson = await manifestFile.text();
    const manifest = JSON.parse(manifestJson) as Manifest;

    return manifest;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load manifest from ${manifestPath}: ${errorMsg}`, { cause: error });
  }
}

/** The entries initdb creates with CREATE EXTENSION in every new database (see isAutoCreated). */
export function getDefaultEnabledExtensions(manifest: Manifest): ResolvedEntry[] {
  return manifest.entries.filter(isAutoCreated);
}

/**
 * Whether initdb runs CREATE EXTENSION for this entry. defaultEnable alone is not enough: it is also set on
 * preload-only modules (auto_explain) and tools (pg_safeupdate), which have no CREATE EXTENSION. Every
 * "auto-created" list or count must use this, or it disagrees with what new databases actually contain.
 */
export function isAutoCreated(entry: {
  enabled?: boolean;
  kind?: string;
  runtime?: { defaultEnable?: boolean; preloadOnly?: boolean };
}): boolean {
  return (
    entry.enabled !== false &&
    entry.runtime?.defaultEnable === true &&
    entry.kind !== "tool" &&
    entry.runtime?.preloadOnly !== true
  );
}

/**
 * Whether this entry is in the default shared_preload_libraries. sharedPreload alone only means the library
 * must be preloaded to work; without defaultEnable it is opt-in (supautils, set_user, plan_filter).
 */
export function isPreloadedByDefault(entry: PreloadCandidate): boolean {
  return (
    entry.runtime?.sharedPreload === true &&
    entry.runtime.defaultEnable === true &&
    entry.enabled !== false
  );
}

/**
 * The manifest fields that decide whether an entry is preloaded by default. Structural, so a caller
 * holding only these fields (the entrypoint generator) shares this one implementation.
 */
export interface PreloadCandidate {
  name: string;
  enabled?: boolean;
  runtime?: { sharedPreload?: boolean; defaultEnable?: boolean; preloadLibraryName?: string };
}

/**
 * The library name an entry loads under in shared_preload_libraries: runtime.preloadLibraryName when set
 * (pg_safeupdate loads as safeupdate, pg_plan_filter as plan_filter), else the entry name. Every list of
 * preload libraries goes through here, so a renamed library cannot be spelled two ways.
 * @throws Error when preloadLibraryName is empty: it names no library, and neither guessing the extension
 *   name nor emitting an empty list element would load what was meant
 */
export function preloadLibraryName(entry: PreloadCandidate): string {
  const library = entry.runtime?.preloadLibraryName;
  if (library === "") throw new Error(`${entry.name}: runtime.preloadLibraryName is empty`);
  return library ?? entry.name;
}

/**
 * The default shared_preload_libraries value: entries with runtime.sharedPreload AND
 * runtime.defaultEnable that are not disabled, by preloadLibraryName when set (pg_safeupdate loads as
 * safeupdate), sorted so regeneration is stable. The entrypoint's DEFAULT_SHARED_PRELOAD_LIBRARIES
 * reads this.
 * @throws Error when an entry's preloadLibraryName is empty (see preloadLibraryName)
 */
export function getDefaultSharedPreloadLibraries(manifest: {
  entries: readonly PreloadCandidate[];
}): string {
  return manifest.entries.filter(isPreloadedByDefault).map(preloadLibraryName).sort().join(",");
}
