/**
 * Test mode detection and configuration for dual-mode testing architecture.
 *
 * Supports two test modes:
 * - production: Tests exact release image behavior (enabled extensions + default preloads)
 * - regression: Tests ALL extensions and preloads (maximum coverage)
 */

import { preloadLibraryName } from "../../config-generator/manifest-loader";
import { MANIFEST_ENTRIES } from "../../extensions/manifest-data";

/**
 * Test execution mode.
 *
 * @property production - Test production image (only enabled extensions, default preloads)
 * @property regression - Test all extensions including disabled ones, all optional preloads
 */
export type TestMode = "production" | "regression";

/**
 * Version info embedded in Docker image at /etc/postgresql/version-info.json
 */
export interface VersionInfo {
  postgresVersion: string;
  pgMajor: string;
  buildDate: string;
  vcsRef: string;
  baseImageSha?: string;
  testMode?: TestMode; // Set in regression-test Docker stage
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
  if (envMode === "regression" || envMode === "production") {
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
 * Get shared_preload_libraries configuration for given test mode.
 *
 * @param mode - Test mode ('production' or 'regression')
 * @returns Comma-separated list of preload libraries
 */
export function getSharedPreloadLibraries(mode: TestMode): string {
  let preloadLibraries: string[];

  if (mode === "regression") {
    // Comprehensive mode: ALL preload libraries (default + optional)
    // Use preloadLibraryName if specified (e.g., pg_safeupdate → safeupdate)
    preloadLibraries = MANIFEST_ENTRIES.filter(
      (ext) =>
        ext.runtime?.sharedPreload === true &&
        // Include if defaultEnable OR preloadInComprehensiveTest
        (ext.runtime?.defaultEnable === true || ext.runtime?.preloadInComprehensiveTest === true)
    ).map((ext) => preloadLibraryName(ext));
  } else {
    // Production mode: Only default preload libraries
    // Use preloadLibraryName if specified (e.g., pg_safeupdate → safeupdate)
    preloadLibraries = MANIFEST_ENTRIES.filter(
      (ext) => ext.runtime?.sharedPreload === true && ext.runtime?.defaultEnable === true
    ).map((ext) => preloadLibraryName(ext));
  }

  return preloadLibraries.join(",");
}
