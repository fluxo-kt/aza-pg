/**
 * Test mode: which shared_preload_libraries list the extension suites start the image with.
 *
 * - production: the image's default preloads, exactly as released
 * - regression: the default preloads plus optional ones (getSharedPreloadLibraries adds those marked
 *   `preloadInComprehensiveTest`)
 *
 * The mode never changes which extensions are tested: the suites test enabled manifest entries only.
 */

import { preloadLibraryName } from "../../config-generator/manifest-loader";
import { MANIFEST_ENTRIES } from "../../extensions/manifest-data";

export type TestMode = "production" | "regression";

/** Mode when the suite was given no --mode: the TEST_MODE environment variable, else production. */
export function detectTestMode(): TestMode {
  const envMode = Bun.env.TEST_MODE;
  if (envMode === undefined || envMode === "") return "production";
  if (envMode === "regression" || envMode === "production") return envMode;
  throw new Error(`Invalid TEST_MODE=${envMode} (production | regression)`);
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
    preloadLibraries = MANIFEST_ENTRIES.filter(
      (ext) =>
        ext.runtime?.sharedPreload === true &&
        // Include if defaultEnable OR preloadInComprehensiveTest
        (ext.runtime?.defaultEnable === true || ext.runtime?.preloadInComprehensiveTest === true)
    ).map((ext) => preloadLibraryName(ext));
  } else {
    preloadLibraries = MANIFEST_ENTRIES.filter(
      (ext) => ext.runtime?.sharedPreload === true && ext.runtime?.defaultEnable === true
    ).map((ext) => preloadLibraryName(ext));
  }

  return preloadLibraries.join(",");
}
