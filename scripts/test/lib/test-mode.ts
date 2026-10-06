/**
 * Test mode: which shared_preload_libraries list the extension suites start the image with.
 *
 * - production: the image's default preloads, exactly as released
 * - regression: the default preloads plus optional ones (getSharedPreloadLibraries adds those marked
 *   `preloadInComprehensiveTest`)
 *
 * The mode never changes which extensions are tested: the suites test enabled manifest entries only.
 */

import { $ } from "bun";
import { preloadLibraryName } from "../../config-generator/manifest-loader";
import { MANIFEST_ENTRIES } from "../../extensions/manifest-data";

export type TestMode = "production" | "regression";

/**
 * Mode for `image` when the suite was given no --mode: TEST_MODE, else the `testMode` marker the regression image
 * writes into /etc/postgresql/version-info.json, else production. The marker is read from the image itself: the suite
 * runs on the host, where that path is not the image's.
 */
export async function detectTestMode(image: string): Promise<TestMode> {
  const envMode = Bun.env.TEST_MODE;
  if (envMode === "regression" || envMode === "production") return envMode;
  const info =
    await $`docker run --rm --network none --entrypoint cat ${image} /etc/postgresql/version-info.json`
      .nothrow()
      .quiet();
  if (info.exitCode !== 0) {
    throw new Error(
      `cannot read /etc/postgresql/version-info.json from ${image}: ${info.stderr.toString().trim()}`
    );
  }
  const marker = (JSON.parse(info.stdout.toString()) as { testMode?: unknown }).testMode;
  return marker === "regression" ? "regression" : "production";
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
