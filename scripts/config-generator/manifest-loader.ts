/**
 * Manifest Loader
 * Handles loading and parsing of extension manifest files
 */

import { readFileSync } from "fs";
import { join } from "path";
import type { ManifestEntry } from "../extensions/manifest-data.js";

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
export function loadManifest(repoRoot: string): Manifest {
  const manifestPath = join(repoRoot, "docker/postgres/extensions.manifest.json");

  try {
    const manifestJson = readFileSync(manifestPath, "utf-8");
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
