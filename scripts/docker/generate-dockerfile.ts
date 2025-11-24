#!/usr/bin/env bun
/**
 * Generate Dockerfile from template using manifest data
 *
 * This script reads the Dockerfile.template and regression.Dockerfile.template
 * and replaces placeholders with actual values from the extensions manifest and extension-defaults.
 *
 * ARG Strategy:
 * - All version dependencies are HARDCODED at generation time (PG_VERSION, PG_MAJOR, PG_BASE_IMAGE_SHA, PGDG versions)
 * - Only BUILD_DATE and VCS_REF remain as ARGs WITHOUT defaults (required at build time)
 * - To test different versions: update extension-defaults.ts and regenerate
 *
 * Placeholders:
 * - {{PG_VERSION}} - PostgreSQL version (hardcoded, e.g., "18.1")
 * - {{PG_MAJOR}} - PostgreSQL major version (hardcoded, extracted from PG_VERSION, e.g., "18")
 * - {{PG_BASE_IMAGE_SHA}} - Base image SHA256 (hardcoded)
 * - {{PGDG_PACKAGES_INSTALL}} - Dynamic PGDG package installation (hardcoded versions)
 * - {{PGDG_PACKAGES_INSTALL_REGRESSION}} - Regression mode PGDG package installation (all extensions)
 * - {{VERSION_INFO_GENERATION}} - Version info generation script
 *
 * Usage:
 *   bun scripts/docker/generate-dockerfile.ts
 */

import { join } from "node:path";
import { extensionDefaults } from "../extension-defaults";
import { error, info, section, success } from "../utils/logger";

// Paths
const REPO_ROOT = join(import.meta.dir, "../..");
const TEMPLATE_PATH = join(REPO_ROOT, "docker/postgres/Dockerfile.template");
const OUTPUT_PATH = join(REPO_ROOT, "docker/postgres/Dockerfile");
const REGRESSION_TEMPLATE_PATH = join(REPO_ROOT, "docker/postgres/regression.Dockerfile.template");
const REGRESSION_OUTPUT_PATH = join(REPO_ROOT, "docker/postgres/regression.Dockerfile");
const MANIFEST_PATH = join(REPO_ROOT, "docker/postgres/extensions.manifest.json");
const PGXS_MANIFEST_PATH = join(REPO_ROOT, "docker/postgres/extensions.pgxs.manifest.json");
const CARGO_MANIFEST_PATH = join(REPO_ROOT, "docker/postgres/extensions.cargo.manifest.json");

/**
 * PGDG extension name mapping
 * Maps manifest name to PGDG package name and ARG variable name
 */
interface PgdgMapping {
  manifestName: string;
  packageName: string;
  argName: string;
  versionKey: keyof typeof extensionDefaults.pgdgVersions;
}

// PGDG packages ordered by cache stability (STABLE → VOLATILE)
// Based on comprehensive analysis: manifest history + upstream repo activity
// Stable extensions first create cache layers that survive frequent rebuilds
// Analysis: /tmp/combined-stability-ranking.json (2025-11-23)
//
// TIER 1 (STABLE - scores 24-46): Install first for foundation cache layers
// TIER 2 (MODERATE - scores 54-84): Install middle
// TIER 3 (VOLATILE - scores 102-118): Install LAST to prevent cache invalidation
const PGDG_MAPPINGS: PgdgMapping[] = [
  // STABLE tier (scores 24-46)
  {
    manifestName: "pg_repack",
    packageName: "repack",
    argName: "REPACK_VERSION",
    versionKey: "repack",
  }, // score 24
  { manifestName: "hll", packageName: "hll", argName: "HLL_VERSION", versionKey: "hll" }, // score 30
  {
    manifestName: "postgis",
    packageName: "postgis-3",
    argName: "POSTGIS_VERSION",
    versionKey: "postgis",
  }, // score 33
  {
    manifestName: "vector",
    packageName: "pgvector",
    argName: "PGVECTOR_VERSION",
    versionKey: "pgvector",
  }, // score 34
  { manifestName: "rum", packageName: "rum", argName: "RUM_VERSION", versionKey: "rum" }, // score 40
  {
    manifestName: "timescaledb",
    packageName: "timescaledb",
    argName: "TIMESCALEDB_VERSION",
    versionKey: "timescaledb",
  }, // stable (mature extension)
  {
    manifestName: "hypopg",
    packageName: "hypopg",
    argName: "HYPOPG_VERSION",
    versionKey: "hypopg",
  }, // score 46

  // MODERATE tier (scores 54-84)
  { manifestName: "http", packageName: "http", argName: "HTTP_VERSION", versionKey: "http" }, // score 54
  { manifestName: "pg_cron", packageName: "cron", argName: "PGCRON_VERSION", versionKey: "pgcron" }, // score 54
  {
    manifestName: "set_user",
    packageName: "set-user",
    argName: "SET_USER_VERSION",
    versionKey: "setUser",
  }, // score 55
  {
    manifestName: "pgrouting",
    packageName: "pgrouting",
    argName: "PGROUTING_VERSION",
    versionKey: "pgrouting",
  }, // score 84

  // VOLATILE tier (scores 102-118): Install LAST to minimize cache invalidation
  {
    manifestName: "pgaudit",
    packageName: "pgaudit",
    argName: "PGAUDIT_VERSION",
    versionKey: "pgaudit",
  }, // score 102
  {
    manifestName: "plpgsql_check",
    packageName: "plpgsql-check",
    argName: "PLPGSQL_CHECK_VERSION",
    versionKey: "plpgsqlCheck",
  }, // score 103
  {
    manifestName: "pg_partman",
    packageName: "partman",
    argName: "PARTMAN_VERSION",
    versionKey: "partman",
  }, // score 118 (MOST volatile - 8 releases/year)
];

interface BuildSpec {
  type: "pgxs" | "cargo-pgrx" | "timescaledb" | "autotools" | "cmake" | "meson" | "make" | "script";
  subdir?: string;
  features?: string[];
  noDefaultFeatures?: boolean;
  script?: string;
  patches?: string[];
}

interface ManifestEntry {
  name: string;
  install_via?: string;
  enabled?: boolean;
  enabledInComprehensiveTest?: boolean;
  build?: BuildSpec;
  runtime?: {
    sharedPreload?: boolean;
    defaultEnable?: boolean;
    preloadInComprehensiveTest?: boolean;
    preloadLibraryName?: string;
  };
  source: {
    tag?: string;
    ref?: string;
  };
}

interface Manifest {
  entries: ManifestEntry[];
}

/**
 * Validate package names to ensure they only contain safe characters
 * This prevents shell injection via SC2046/SC2086 word-splitting patterns
 */
function validatePackageName(packageName: string, context: string): void {
  // Safe characters: alphanumeric, hyphen, underscore, equals, dot, plus, colon
  // This regex matches the intentional word-splitting pattern in Dockerfile
  const SAFE_PACKAGE_REGEX = /^[a-zA-Z0-9\-_=.+:]*$/;

  if (!SAFE_PACKAGE_REGEX.test(packageName)) {
    throw new Error(
      `SECURITY: Unsafe characters in ${context}: "${packageName}"\n` +
        `Only alphanumeric and [-_=.+:] are allowed.\n` +
        `This validation protects against shell injection in Dockerfile word-splitting patterns.`
    );
  }
}

/**
 * Read and parse manifest
 */
async function readManifest(): Promise<Manifest> {
  if (!(await Bun.file(MANIFEST_PATH).exists())) {
    throw new Error(`Manifest not found: ${MANIFEST_PATH}`);
  }

  const content = Bun.file(MANIFEST_PATH);
  return (await content.json()) as Manifest;
}

/**
 * Generate PGDG package installation script
 * Versions and PG_MAJOR are hardcoded directly
 */
function generatePgdgPackagesInstall(manifest: Manifest, pgMajor: string): string {
  const enabledPgdgPackages: string[] = [];

  for (const mapping of PGDG_MAPPINGS) {
    const entry = manifest.entries.find((e) => e.name === mapping.manifestName);
    // Check if entry exists, is PGDG, and is enabled (default true)
    if (entry && entry.install_via === "pgdg" && (entry.enabled ?? true)) {
      // Package is enabled - use hardcoded version from extensionDefaults
      const version = extensionDefaults.pgdgVersions[mapping.versionKey];

      // Validate package name and version for shell safety (SC2046/SC2086 protection)
      validatePackageName(mapping.packageName, `PGDG package name (${mapping.manifestName})`);
      validatePackageName(version, `PGDG version (${mapping.manifestName})`);

      enabledPgdgPackages.push(`postgresql-${pgMajor}-${mapping.packageName}=${version}`);
    }
  }

  if (enabledPgdgPackages.length === 0) {
    return `RUN echo "No PGDG packages enabled in manifest"`;
  }

  const packagesList = enabledPgdgPackages.join(" ");
  const expectedCount = enabledPgdgPackages.length;

  return `RUN --mount=type=cache,target=/var/lib/apt/lists \\
    --mount=type=cache,target=/var/cache/apt \\
    set -euo pipefail && \\
    rm -rf /var/lib/apt/lists/* && \\
    apt-get update && \\
    # Install enabled PGDG packages (pre-calculated in TS)
    echo "Installing PGDG packages: ${packagesList}" && \\
    apt-get install -y --no-install-recommends ${packagesList} && \\
    # Verify expected PGDG extensions were installed (Phase 4.1 assertion)
    dpkg -l | grep "^ii.*postgresql-${pgMajor}-" | tee /tmp/installed-pgdg-exts.log && \\
    INSTALLED_COUNT=$(wc -l < /tmp/installed-pgdg-exts.log) && \\
    echo "Installed $INSTALLED_COUNT PGDG extension package(s)" && \\
    echo "Expected ${expectedCount} enabled PGDG packages from manifest" && \\
    # Allow some variance but ensure we have at least 1 package
    test "$INSTALLED_COUNT" -ge ${expectedCount} || (echo "ERROR: Installed count mismatch (expected >= ${expectedCount}, got $INSTALLED_COUNT)" && exit 1) && \\
    rm -f /tmp/installed-pgdg-exts.log && \\
    apt-get clean && \\
    rm -f /tmp/extensions.manifest.json && \\
    find /usr/lib/postgresql/${pgMajor}/lib -name "*.so" -type f -exec strip --strip-unneeded {} \\; 2>/dev/null || true`;
}

/**
 * Generate regression mode shared preload libraries list
 * Includes ALL preload libraries (default + optional) for maximum test coverage
 */
function generateRegressionPreloadLibraries(manifest: Manifest): string {
  // Filter extensions where:
  // 1. runtime.sharedPreload == true
  // 2. (runtime.defaultEnable == true) OR (runtime.preloadInComprehensiveTest == true)
  // 3. enabled != false (i.e., enabled is null or true)
  const preloadExtensions = manifest.entries.filter((entry) => {
    const runtime = entry.runtime;
    if (!runtime || !runtime.sharedPreload) return false;

    const isDefaultEnable = runtime.defaultEnable === true;
    const isRegressionPreload = runtime.preloadInComprehensiveTest === true;
    const isEnabled = entry.enabled !== false;

    return (isDefaultEnable || isRegressionPreload) && isEnabled;
  });

  // Use preloadLibraryName if specified, otherwise use extension name
  const libraryNames = preloadExtensions.map((e) => e.runtime?.preloadLibraryName || e.name).sort();

  return libraryNames.join(",");
}

/**
 * Generate PGDG package installation script for regression test mode
 * Installs ALL PGDG packages (including disabled ones) for regression testing
 */
function generatePgdgPackagesInstallRegression(manifest: Manifest, pgMajor: string): string {
  const allPgdgPackages: string[] = [];

  for (const mapping of PGDG_MAPPINGS) {
    const entry = manifest.entries.find((e) => e.name === mapping.manifestName);
    // Include ALL PGDG packages (enabled OR enabledInComprehensiveTest)
    if (entry && entry.install_via === "pgdg") {
      const shouldInclude = (entry.enabled ?? true) || entry.enabledInComprehensiveTest === true;
      if (shouldInclude) {
        // Use hardcoded version from extensionDefaults
        const version = extensionDefaults.pgdgVersions[mapping.versionKey];

        // Validate package name and version for shell safety
        validatePackageName(mapping.packageName, `PGDG package name (${mapping.manifestName})`);
        validatePackageName(version, `PGDG version (${mapping.manifestName})`);

        allPgdgPackages.push(`postgresql-${pgMajor}-${mapping.packageName}=${version}`);
      }
    }
  }

  if (allPgdgPackages.length === 0) {
    return `RUN echo "No PGDG packages available for regression testing"`;
  }

  // For regression mode, use install-or-skip logic since some packages may not be available for PG18 yet
  const installCommands = allPgdgPackages
    .map(
      (pkg) =>
        `    (apt-get install -y --no-install-recommends ${pkg} && echo "✓ Installed: ${pkg}") || echo "⚠ Skipped (not available): ${pkg}"`
    )
    .join(" && \\\n");

  return `RUN set -euo pipefail && \\
    rm -rf /var/lib/apt/lists/* && \\
    apt-get update && \\
    # Install PGDG packages for regression testing (install-or-skip for unavailable packages)
    echo "Installing PGDG packages (regression mode): ${allPgdgPackages.length} packages" && \\
${installCommands} && \\
    # Report what was installed
    dpkg -l | grep "^ii.*postgresql-${pgMajor}-" | tee /tmp/installed-pgdg-exts.log || true && \\
    INSTALLED_COUNT=$(wc -l < /tmp/installed-pgdg-exts.log 2>/dev/null || echo "0") && \\
    echo "Successfully installed $INSTALLED_COUNT PGDG extension package(s) (regression mode)" && \\
    rm -f /tmp/installed-pgdg-exts.log && \\
    apt-get clean && \\
    rm -rf /var/lib/apt/lists/* /tmp/extensions.manifest.json && \\
    find /usr/lib/postgresql/${pgMajor}/lib -name "*.so" -type f -exec strip --strip-unneeded {} \\; 2>/dev/null || true`;
}

/**
 * Generate filtered manifest for PGXS-style builds
 * Includes: pgxs, autotools, cmake, meson, make, timescaledb
 */
function generatePgxsManifest(manifest: Manifest): Manifest {
  const pgxsBuildTypes = ["pgxs", "autotools", "cmake", "meson", "make", "timescaledb"];
  const filteredEntries = manifest.entries.filter(
    (entry) => entry.build && pgxsBuildTypes.includes(entry.build.type)
  );

  return {
    entries: filteredEntries,
  };
}

/**
 * Generate filtered manifest for Cargo builds
 * Includes: cargo-pgrx
 */
function generateCargoManifest(manifest: Manifest): Manifest {
  const filteredEntries = manifest.entries.filter(
    (entry) => entry.build && entry.build.type === "cargo-pgrx"
  );

  return {
    entries: filteredEntries,
  };
}

/**
 * Extract PG_MAJOR from PG_VERSION (e.g., "18.1" -> "18")
 */
function extractPgMajor(): string {
  const pgVersion = extensionDefaults.pgVersion;
  const majorVersion = pgVersion.split(".")[0];
  if (!majorVersion) {
    throw new Error(`Could not extract major version from PG_VERSION: ${pgVersion}`);
  }
  return majorVersion;
}

/**
 * Generate version info generation instructions
 * Uses a separate builder stage with Bun to generate version files
 * This ensures consistency between local testing and Docker builds
 */
function generateVersionInfoGeneration(_manifest: Manifest): string {
  // The version-info files are generated in a separate builder stage (builder-version-info)
  // This stage is defined in the Dockerfile template and has Bun available
  // The generated files are then copied to the final stage
  //
  // Template must include:
  // FROM builder-base AS builder-version-info
  // ARG PG_VERSION
  // COPY scripts/generate-version-info.ts /tmp/
  // RUN PG_VER=$(echo ${PG_VERSION} | awk -F'-' '{print $1}') && \
  //     bun /tmp/generate-version-info.ts txt --pg-version=${PG_VER} > /tmp/version-info.txt && \
  //     bun /tmp/generate-version-info.ts json --pg-version=${PG_VER} > /tmp/version-info.json
  //
  // Then in final stage:
  // COPY --from=builder-version-info /tmp/version-info.txt /etc/postgresql/
  // COPY --from=builder-version-info /tmp/version-info.json /etc/postgresql/

  return `# Version info files copied from builder-version-info stage (defined earlier in template)`;
}

/**
 * Generate production Dockerfile from template
 */
async function generateProductionDockerfile(manifest: Manifest, pgMajor: string): Promise<void> {
  // Read template
  info("Reading production template...");
  if (!(await Bun.file(TEMPLATE_PATH).exists())) {
    throw new Error(`Template not found: ${TEMPLATE_PATH}`);
  }

  const templateFile = Bun.file(TEMPLATE_PATH);
  let dockerfile = await templateFile.text();

  info("Generating PGDG package installation script...");
  const pgdgPackagesInstall = generatePgdgPackagesInstall(manifest, pgMajor);

  info("Generating version info generation script...");
  const versionInfoGeneration = generateVersionInfoGeneration(manifest);

  // Replace placeholders
  info("Replacing placeholders...");
  dockerfile = dockerfile.replace(/\{\{PG_VERSION\}\}/g, extensionDefaults.pgVersion);
  dockerfile = dockerfile.replace(/\{\{PG_MAJOR\}\}/g, pgMajor);
  dockerfile = dockerfile.replace(/\{\{PG_BASE_IMAGE_SHA\}\}/g, extensionDefaults.baseImageSha);
  dockerfile = dockerfile.replace("{{PGDG_PACKAGES_INSTALL}}", pgdgPackagesInstall);
  dockerfile = dockerfile.replace("{{VERSION_INFO_GENERATION}}", versionInfoGeneration);

  // Add generation header
  const header = `# AUTO-GENERATED FILE - DO NOT EDIT
# Generator: scripts/docker/generate-dockerfile.ts
# Template: docker/postgres/Dockerfile.template
# Manifest: docker/postgres/extensions.manifest.json
# To regenerate: bun run generate

`;

  dockerfile = header + dockerfile;

  // Write output
  info(`Writing production Dockerfile to ${OUTPUT_PATH}...`);
  await Bun.write(OUTPUT_PATH, dockerfile);

  success("Production Dockerfile generated successfully!");
}

/**
 * Generate regression test Dockerfile from template
 */
async function generateRegressionDockerfile(manifest: Manifest, pgMajor: string): Promise<void> {
  // Read template
  info("Reading regression template...");
  if (!(await Bun.file(REGRESSION_TEMPLATE_PATH).exists())) {
    throw new Error(`Template not found: ${REGRESSION_TEMPLATE_PATH}`);
  }

  const templateFile = Bun.file(REGRESSION_TEMPLATE_PATH);
  let dockerfile = await templateFile.text();

  info("Generating regression PGDG package installation script...");
  const pgdgPackagesInstallRegression = generatePgdgPackagesInstallRegression(manifest, pgMajor);

  info("Generating regression preload libraries list...");
  const regressionPreloadLibs = generateRegressionPreloadLibraries(manifest);

  // Replace placeholders
  info("Replacing placeholders...");
  dockerfile = dockerfile.replace(/\{\{PG_VERSION\}\}/g, extensionDefaults.pgVersion);
  dockerfile = dockerfile.replace(/\{\{PG_MAJOR\}\}/g, pgMajor);
  dockerfile = dockerfile.replace(/\{\{PG_BASE_IMAGE_SHA\}\}/g, extensionDefaults.baseImageSha);
  dockerfile = dockerfile.replace(
    "{{PGDG_PACKAGES_INSTALL_REGRESSION}}",
    pgdgPackagesInstallRegression
  );
  dockerfile = dockerfile.replace("{{REGRESSION_PRELOAD_LIBRARIES}}", regressionPreloadLibs);

  // Add generation header
  const header = `# AUTO-GENERATED FILE - DO NOT EDIT
# Generator: scripts/docker/generate-dockerfile.ts
# Template: docker/postgres/regression.Dockerfile.template
# Manifest: docker/postgres/extensions.manifest.json
# To regenerate: bun run generate

`;

  dockerfile = header + dockerfile;

  // Write output
  info(`Writing regression Dockerfile to ${REGRESSION_OUTPUT_PATH}...`);
  await Bun.write(REGRESSION_OUTPUT_PATH, dockerfile);

  success("Regression Dockerfile generated successfully!");
}

/**
 * Generate both Dockerfiles from templates
 */
async function generateDockerfile(): Promise<void> {
  section("Dockerfile Generation");

  // Read manifest
  info("Reading manifest...");
  const manifest = await readManifest();
  info(`Manifest loaded: ${manifest.entries.length} total entries`);

  // Generate filtered manifests
  info("Generating filtered manifests...");
  const pgxsManifest = generatePgxsManifest(manifest);
  const cargoManifest = generateCargoManifest(manifest);
  info(`PGXS manifest: ${pgxsManifest.entries.length} entries`);
  info(`Cargo manifest: ${cargoManifest.entries.length} entries`);

  // Write filtered manifests (unformatted first)
  info("Writing filtered manifests...");
  await Bun.write(PGXS_MANIFEST_PATH, JSON.stringify(pgxsManifest, null, 2));
  await Bun.write(CARGO_MANIFEST_PATH, JSON.stringify(cargoManifest, null, 2));

  // Format with Prettier for consistency
  info("Formatting filtered manifests with Prettier...");
  try {
    await Bun.$`bunx prettier --write ${PGXS_MANIFEST_PATH} ${CARGO_MANIFEST_PATH}`.quiet();
    success(`Filtered manifests written and formatted`);
  } catch {
    // Non-critical - manifests are valid JSON even if not formatted
    info("Note: Could not format with Prettier (not critical)");
  }

  // Extract PG_MAJOR
  info("Extracting PG_MAJOR...");
  const pgMajor = extractPgMajor();

  // Generate production Dockerfile
  console.log("");
  section("Production Dockerfile");
  await generateProductionDockerfile(manifest, pgMajor);

  // Generate regression Dockerfile
  console.log("");
  section("Regression Dockerfile");
  await generateRegressionDockerfile(manifest, pgMajor);

  // Print stats
  console.log("");
  section("Summary");
  const enabledPgdg = manifest.entries.filter(
    (e) => e.install_via === "pgdg" && (e.enabled ?? true) === true
  ).length;
  const disabledPgdg = manifest.entries.filter(
    (e) => e.install_via === "pgdg" && e.enabled === false
  ).length;
  const regressionOnlyPgdg = manifest.entries.filter(
    (e) => e.install_via === "pgdg" && e.enabled === false && e.enabledInComprehensiveTest === true
  ).length;

  info(`PGDG extensions: ${enabledPgdg} enabled, ${disabledPgdg} disabled`);
  info(`Regression-only extensions: ${regressionOnlyPgdg}`);
  info(`Total extensions: ${manifest.entries.length}`);
  console.log("");
  success("All Dockerfiles generated successfully!");
}

// Main execution
if (import.meta.main) {
  try {
    await generateDockerfile();
  } catch (err) {
    error(`Failed to generate Dockerfile: ${String(err)}`);
    process.exit(1);
  }
}
