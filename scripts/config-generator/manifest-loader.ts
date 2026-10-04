/**
 * Manifest Loader
 * Handles loading and parsing of extension manifest files
 */

import { join } from "node:path";
import type { ManifestEntry } from "../extensions/manifest-data";

/**
 * Manifest structure as stored in JSON file
 */
export interface Manifest {
  generatedAt: string;
  entries: ManifestEntry[];
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

/**
 * Get extensions that should be enabled by default
 * Filters manifest entries for extensions with enabled=true AND runtime.defaultEnable=true
 * Excludes "tool" kind extensions and preload-only extensions (no CREATE EXTENSION support)
 * @param manifest - Parsed manifest object
 * @returns Array of manifest entries for extensions to enable
 */
export function getDefaultEnabledExtensions(manifest: Manifest): ManifestEntry[] {
  return manifest.entries.filter((entry) => {
    const enabled = entry.enabled ?? true; // Default to true for backward compatibility
    const defaultEnable = entry.runtime?.defaultEnable ?? false;
    const kind = entry.kind;
    const preloadOnly = entry.runtime?.preloadOnly ?? false;

    // Only enable if:
    // 1. Extension is enabled in manifest (not disabled)
    // 2. Extension has runtime.defaultEnable = true
    // 3. Extension is not a "tool" (tools don't support CREATE EXTENSION)
    // 4. Extension is not preload-only (activated via shared_preload_libraries, no .control file)
    return enabled && defaultEnable && kind !== "tool" && !preloadOnly;
  });
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
 * safeupdate), sorted so regeneration is stable. The entrypoint's DEFAULT_SHARED_PRELOAD_LIBRARIES and
 * the healthcheck's EXPECTED_PRELOAD (generator.ts) both read this, so the healthcheck expects exactly
 * what the entrypoint preloads.
 * @throws Error when an entry's preloadLibraryName is empty (see preloadLibraryName)
 */
export function getDefaultSharedPreloadLibraries(manifest: {
  entries: readonly PreloadCandidate[];
}): string {
  return manifest.entries
    .filter(
      (entry) =>
        entry.runtime?.sharedPreload === true &&
        entry.runtime.defaultEnable === true &&
        entry.enabled !== false
    )
    .map(preloadLibraryName)
    .sort()
    .join(",");
}
