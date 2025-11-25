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
 * Get comma-separated list of extensions/modules that should be preloaded at server start
 * Filters for entries with shared_preload and defaultEnable = true
 * @param manifest - Parsed manifest object
 * @returns Comma-separated list of preload libraries (e.g., "auto_explain,pg_cron,timescaledb")
 */
export function getDefaultSharedPreloadLibraries(manifest: Manifest): string {
  // Filter extensions where:
  // 1. runtime.sharedPreload == true (must be loaded at server start)
  // 2. runtime.defaultEnable == true (enabled by default)
  // 3. enabled != false (not explicitly disabled in manifest)
  const preloadExtensions = manifest.entries.filter((entry) => {
    const runtime = entry.runtime;
    if (!runtime) return false;

    const isSharedPreload = runtime.sharedPreload === true;
    const isDefaultEnable = runtime.defaultEnable === true;
    const isEnabled = entry.enabled !== false; // null or true

    return isSharedPreload && isDefaultEnable && isEnabled;
  });

  // Sort alphabetically for consistency across regenerations
  // Use preloadLibraryName if specified (e.g., pg_safeupdate → safeupdate)
  const extensionNames = preloadExtensions
    .map((e) => e.runtime?.preloadLibraryName ?? e.name)
    .sort();

  return extensionNames.join(",");
}
