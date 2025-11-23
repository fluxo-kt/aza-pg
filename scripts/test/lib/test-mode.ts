/**
 * Test mode detection and configuration for dual-mode testing architecture.
 *
 * Supports two test modes:
 * - production: Tests exact release image behavior (enabled extensions + default preloads)
 * - comprehensive: Tests ALL extensions and preloads (maximum coverage)
 */

import type { ManifestEntry } from "../../extensions/manifest-data.ts";
import { MANIFEST_ENTRIES } from "../../extensions/manifest-data.ts";

/**
 * Test execution mode.
 *
 * @property production - Test production image (only enabled extensions, default preloads)
 * @property comprehensive - Test all extensions including disabled ones, all optional preloads
 */
export type TestMode = "production" | "comprehensive";

/**
 * Version info embedded in Docker image at /etc/postgresql/version-info.json
 */
export interface VersionInfo {
  postgresVersion: string;
  pgMajor: string;
  buildDate: string;
  vcsRef: string;
  baseImageSha?: string;
  testMode?: TestMode; // Set in comprehensive-test Docker stage
}

/**
 * Detect current test mode from environment or image metadata.
 *
 * Detection order:
 * 1. TEST_MODE environment variable
 * 2. /etc/postgresql/version-info.json metadata (if running in container)
 * 3. Default to 'production'
 *
 * @returns Current test mode
 */
export async function detectTestMode(): Promise<TestMode> {
  // Check environment variable
  const envMode = Bun.env.TEST_MODE;
  if (envMode === "comprehensive" || envMode === "production") {
    return envMode;
  }

  // Check version-info.json in container
  try {
    const versionInfoPath = "/etc/postgresql/version-info.json";
    const versionInfoFile = Bun.file(versionInfoPath);
    if (await versionInfoFile.exists()) {
      const versionInfo = (await versionInfoFile.json()) as VersionInfo;
      if (versionInfo.testMode) {
        return versionInfo.testMode;
      }
    }
  } catch {
    // File doesn't exist or can't be read - not in container
  }

  // Default to production mode
  return "production";
}

/**
 * Get list of enabled extensions for given test mode.
 *
 * @param mode - Test mode ('production' or 'comprehensive')
 * @returns Array of extension names that should be available
 */
export function getEnabledExtensions(mode: TestMode): string[] {
  if (mode === "comprehensive") {
    // Comprehensive mode: ALL extensions except those with technical blockers
    return MANIFEST_ENTRIES.filter(
      (ext) =>
        ext.kind === "extension" &&
        // Include if enabled OR enabledInComprehensiveTest
        (ext.enabled !== false || ext.enabledInComprehensiveTest === true)
    ).map((ext) => ext.name);
  } else {
    // Production mode: Only currently enabled extensions
    return MANIFEST_ENTRIES.filter((ext) => ext.kind === "extension" && ext.enabled !== false).map(
      (ext) => ext.name
    );
  }
}

/**
 * Get list of builtin extensions (always available, no CREATE EXTENSION needed).
 *
 * @returns Array of builtin extension names
 */
export function getBuiltinExtensions(): string[] {
  return MANIFEST_ENTRIES.filter((ext) => ext.kind === "builtin").map((ext) => ext.name);
}

/**
 * Get list of tools (installed binaries, no CREATE EXTENSION).
 *
 * @returns Array of tool names
 */
export function getTools(): string[] {
  return MANIFEST_ENTRIES.filter((ext) => ext.kind === "tool").map((ext) => ext.name);
}

/**
 * Get shared_preload_libraries configuration for given test mode.
 *
 * @param mode - Test mode ('production' or 'comprehensive')
 * @returns Comma-separated list of preload libraries
 */
export function getSharedPreloadLibraries(mode: TestMode): string {
  let preloadLibraries: string[];

  if (mode === "comprehensive") {
    // Comprehensive mode: ALL preload libraries (default + optional)
    preloadLibraries = MANIFEST_ENTRIES.filter(
      (ext) =>
        ext.runtime?.sharedPreload === true &&
        // Include if defaultEnable OR preloadInComprehensiveTest
        (ext.runtime?.defaultEnable === true || ext.runtime?.preloadInComprehensiveTest === true)
    ).map((ext) => ext.name);
  } else {
    // Production mode: Only default preload libraries
    preloadLibraries = MANIFEST_ENTRIES.filter(
      (ext) => ext.runtime?.sharedPreload === true && ext.runtime?.defaultEnable === true
    ).map((ext) => ext.name);
  }

  return preloadLibraries.join(",");
}

/**
 * Get full manifest entry for given extension name.
 *
 * @param name - Extension name
 * @returns Manifest entry or undefined if not found
 */
export function getExtensionManifest(name: string): ManifestEntry | undefined {
  return MANIFEST_ENTRIES.find((ext) => ext.name === name);
}

/**
 * Check if extension should be tested in current mode.
 *
 * @param name - Extension name
 * @param mode - Test mode
 * @returns true if extension should be tested
 */
export function shouldTestExtension(name: string, mode: TestMode): boolean {
  const manifest = getExtensionManifest(name);
  if (!manifest) return false;

  if (mode === "comprehensive") {
    // Comprehensive mode: test if enabled OR enabledInComprehensiveTest
    return manifest.enabled !== false || manifest.enabledInComprehensiveTest === true;
  } else {
    // Production mode: test only if enabled
    return manifest.enabled !== false;
  }
}

/**
 * Get test mode summary for logging/reporting.
 *
 * @param mode - Test mode
 * @returns Human-readable summary
 */
export function getTestModeSummary(mode: TestMode): string {
  const extensions = getEnabledExtensions(mode);
  const builtins = getBuiltinExtensions();
  const tools = getTools();
  const preloads = getSharedPreloadLibraries(mode);

  return `
Test Mode: ${mode.toUpperCase()}

Extensions to test:
  - User extensions: ${extensions.length} (${extensions.slice(0, 5).join(", ")}${extensions.length > 5 ? ", ..." : ""})
  - Builtin extensions: ${builtins.length} (${builtins.slice(0, 5).join(", ")}${builtins.length > 5 ? ", ..." : ""})
  - Tools: ${tools.length} (${tools.join(", ")})

Shared preload libraries: ${preloads || "(none)"}
`.trim();
}
