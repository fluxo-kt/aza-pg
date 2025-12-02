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
  // NOTE: timescaledb removed - it uses install_via: "source" in manifest (compiled from source, not PGDG)
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
  kind?: "extension" | "tool" | "builtin";
  install_via?: string;
  pgdgVersion?: string;
  perconaVersion?: string;
  perconaPackage?: string;
  soFileName?: string;
  /** GitHub repository in owner/repo format for github-release installations */
  githubRepo?: string;
  /** GitHub release tag for downloading assets */
  githubReleaseTag?: string;
  /** Asset filename pattern with {version}, {pgMajor}, {arch} placeholders */
  githubAssetPattern?: string;
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

  // Build list of expected .so files for verification
  // Map PGDG package names to their .so file names
  const soFileMap: Record<string, string> = {
    cron: "pg_cron.so",
    pgvector: "vector.so",
    pgaudit: "pgaudit.so",
    repack: "pg_repack.so",
    hll: "hll.so",
    http: "http.so",
    hypopg: "hypopg.so",
    rum: "rum.so",
    "set-user": "set_user.so",
    "plpgsql-check": "plpgsql_check.so",
    partman: "pg_partman_bgw.so",
  };

  // Get expected .so files for enabled packages
  const expectedSoFiles = enabledPgdgPackages
    .map((pkg) => {
      const match = pkg.match(/postgresql-\d+-([^=]+)/);
      if (match?.[1] && soFileMap[match[1]]) {
        return soFileMap[match[1]];
      }
      return null;
    })
    .filter((f): f is string => f !== null);

  const soVerificationCommands =
    expectedSoFiles.length > 0
      ? expectedSoFiles
          .map((so) => `test -f /usr/lib/postgresql/${pgMajor}/lib/${so}`)
          .join(" && \\\n    ") + " && \\\n    "
      : "";

  return `RUN --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\
    --mount=type=cache,target=/var/cache/apt,sharing=locked \\
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
    test "$INSTALLED_COUNT" -ge ${expectedCount} || (echo "ERROR: Installed count mismatch (expected >= ${expectedCount}, got $INSTALLED_COUNT)" && exit 1) && \\
    rm -f /tmp/installed-pgdg-exts.log && \\
    # Verify critical .so files exist (prevents silent installation failures)
    echo "Verifying PGDG .so files exist..." && \\
    ${soVerificationCommands}echo "All ${expectedSoFiles.length} PGDG .so files verified" && \\
    apt-get clean && \\
    rm -rf /var/lib/apt/lists/* && \\
    rm -f /tmp/extensions.manifest.json && \\
    find /usr/lib/postgresql/${pgMajor}/lib -name "*.so" -type f -exec strip --strip-unneeded {} \\; 2>/dev/null || true`;
}

/**
 * Generate Percona package installation script
 * Percona repository provides extensions not available in PGDG (e.g., pg_stat_monitor, wal2json)
 * Versions are hardcoded directly from manifest perconaVersion field
 */
function generatePerconaPackagesInstall(manifest: Manifest, pgMajor: string): string {
  // Find all entries with install_via === "percona" that are enabled
  const enabledPerconaEntries = manifest.entries.filter(
    (entry) => entry.install_via === "percona" && (entry.enabled ?? true)
  );

  if (enabledPerconaEntries.length === 0) {
    return `RUN echo "No Percona packages enabled in manifest"`;
  }

  // Validate and build package list
  const packages: string[] = [];

  for (const entry of enabledPerconaEntries) {
    if (!entry.perconaPackage) {
      throw new Error(
        `Percona entry "${entry.name}" missing required perconaPackage field.\n` +
          `Add perconaPackage: "percona-pkg-name" to manifest entry.`
      );
    }

    // Validate package name for shell safety
    validatePackageName(entry.perconaPackage, `Percona package name (${entry.name})`);

    // perconaVersion is REQUIRED for reproducible builds (same as PGDG pattern)
    if (!entry.perconaVersion) {
      throw new Error(
        `Percona entry "${entry.name}" missing required perconaVersion field.\n` +
          `Add perconaVersion: "X.Y.Z-N.distro" to manifest entry for reproducible builds.`
      );
    }
    validatePackageName(entry.perconaVersion, `Percona version (${entry.name})`);

    // soFileName is REQUIRED for .so verification (single source of truth in manifest)
    if (!entry.soFileName) {
      throw new Error(
        `Percona entry "${entry.name}" missing required soFileName field.\n` +
          `Add soFileName: "${entry.name}.so" to manifest entry for .so verification.`
      );
    }
    // Validate soFileName format (must end with .so and be a safe filename)
    if (!entry.soFileName.endsWith(".so") || !/^[a-z0-9_-]+\.so$/i.test(entry.soFileName)) {
      throw new Error(
        `Percona entry "${entry.name}" has invalid soFileName: "${entry.soFileName}"\n` +
          `Must be alphanumeric with underscores/hyphens and end with .so`
      );
    }

    packages.push(`${entry.perconaPackage}=${entry.perconaVersion}`);
  }

  const packagesList = packages.join(" ");
  const expectedCount = packages.length;

  // Get expected .so files for verification (from manifest - single source of truth)
  const expectedSoFiles = enabledPerconaEntries
    .map((entry) => entry.soFileName)
    .filter((f): f is string => f !== undefined);

  const soVerificationCommands =
    expectedSoFiles.length > 0
      ? expectedSoFiles
          .map((so) => `test -f /usr/lib/postgresql/${pgMajor}/lib/${so}`)
          .join(" && \\\n    ") + " && \\\n    "
      : "";

  return `# Percona repository setup and package installation
# Provides: pg_stat_monitor, wal2json (extensions not in PGDG)
# Note: Percona packages are pinned via perconaVersion in manifest for reproducible builds
# hadolint ignore=DL3008
RUN --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\
    --mount=type=cache,target=/var/cache/apt,sharing=locked \\
    set -euo pipefail && \\
    echo "Setting up Percona repository for ppg-${pgMajor}..." && \\
    apt-get update && \\
    apt-get install -y --no-install-recommends curl gnupg2 gpgv lsb-release && \\
    curl -fsSL https://repo.percona.com/apt/percona-release_latest.generic_all.deb -o /tmp/percona-release.deb && \\
    dpkg -i /tmp/percona-release.deb && \\
    percona-release enable ppg-${pgMajor} release && \\
    apt-get update && \\
    echo "Installing Percona packages: ${packagesList}" && \\
    apt-get install -y --no-install-recommends ${packagesList} && \\
    echo "Installed ${expectedCount} Percona package(s)" && \\
    # Verify .so files exist
    echo "Verifying Percona .so files exist..." && \\
    ${soVerificationCommands}echo "All ${expectedSoFiles.length} Percona .so files verified" && \\
    # Cleanup Percona release package
    rm -f /tmp/percona-release.deb && \\
    apt-get clean && \\
    rm -rf /var/lib/apt/lists/* && \\
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
 * PGDG tool binary verification mapping
 * Maps tool name to expected binary path after PGDG installation
 */
const PGDG_TOOL_BINARIES: Record<string, string> = {
  pgbackrest: "/usr/bin/pgbackrest",
  pgbadger: "/usr/bin/pgbadger",
};

/**
 * Generate PGDG tool installation script
 * Tools are standalone binaries (no postgresql-XX prefix) installed from PGDG
 */
function generatePgdgToolsInstall(manifest: Manifest): string {
  const enabledPgdgTools: Array<{ name: string; version: string; binary: string }> = [];

  for (const entry of manifest.entries) {
    if (
      entry.kind === "tool" &&
      entry.install_via === "pgdg" &&
      entry.pgdgVersion &&
      (entry.enabled ?? true)
    ) {
      // Validate tool name and version for shell safety
      validatePackageName(entry.name, `PGDG tool name (${entry.name})`);
      validatePackageName(entry.pgdgVersion, `PGDG tool version (${entry.name})`);

      const binary = PGDG_TOOL_BINARIES[entry.name];
      if (!binary) {
        throw new Error(
          `Missing binary path in PGDG_TOOL_BINARIES for tool: ${entry.name}\n` +
            `Add it to the PGDG_TOOL_BINARIES object in generate-dockerfile.ts`
        );
      }

      enabledPgdgTools.push({
        name: entry.name,
        version: entry.pgdgVersion,
        binary,
      });
    }
  }

  if (enabledPgdgTools.length === 0) {
    return `RUN echo "No PGDG tools enabled in manifest"`;
  }

  const packagesList = enabledPgdgTools.map((t) => `${t.name}=${t.version}`).join(" ");
  const binaryVerifications = enabledPgdgTools
    .map((t) => `test -x ${t.binary}`)
    .join(" && \\\n    ");

  return `RUN --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\
    --mount=type=cache,target=/var/cache/apt,sharing=locked \\
    set -euo pipefail && \\
    apt-get update && \\
    echo "Installing PGDG tools: ${packagesList}" && \\
    apt-get install -y --no-install-recommends ${packagesList} && \\
    # Verify tool binaries exist and are executable
    ${binaryVerifications} && \\
    echo "All ${enabledPgdgTools.length} PGDG tool(s) verified" && \\
    apt-get clean && \\
    rm -rf /var/lib/apt/lists/*`;
}

/**
 * Generate GitHub release binary installation script.
 * Downloads pre-built binaries from GitHub releases for extensions not available via apt.
 * Supports multi-architecture builds (amd64, arm64) via runtime detection.
 */
function generateGithubReleaseInstall(manifest: Manifest, pgMajor: string): string {
  const enabledEntries = manifest.entries.filter(
    (entry) => entry.install_via === "github-release" && (entry.enabled ?? true)
  );

  if (enabledEntries.length === 0) {
    return `RUN echo "No GitHub release packages enabled in manifest"`;
  }

  // Validate required fields for each entry
  for (const entry of enabledEntries) {
    if (!entry.githubRepo) {
      throw new Error(`GitHub release entry "${entry.name}" missing required githubRepo field.`);
    }
    if (!entry.githubReleaseTag) {
      throw new Error(
        `GitHub release entry "${entry.name}" missing required githubReleaseTag field.`
      );
    }
    if (!entry.githubAssetPattern) {
      throw new Error(
        `GitHub release entry "${entry.name}" missing required githubAssetPattern field.`
      );
    }
    if (!entry.soFileName) {
      throw new Error(`GitHub release entry "${entry.name}" missing required soFileName field.`);
    }
    // Validate soFileName format
    if (!entry.soFileName.endsWith(".so") || !/^[a-z0-9_-]+\.so$/i.test(entry.soFileName)) {
      throw new Error(
        `GitHub release entry "${entry.name}" has invalid soFileName: "${entry.soFileName}"`
      );
    }
  }

  // Build installation commands for each extension
  // pgvectorscale releases contain .deb packages inside the zip, not raw .so files
  const installCommands = enabledEntries
    .map((entry) => {
      // Pattern uses {version}, {pgMajor}, {arch} placeholders
      // {arch} is resolved at runtime using dpkg --print-architecture
      const assetPattern = entry
        .githubAssetPattern!.replace("{version}", entry.githubReleaseTag!)
        .replace("{pgMajor}", pgMajor);
      // {arch} will be resolved at runtime in the shell

      const url = `https://github.com/${entry.githubRepo}/releases/download/${entry.githubReleaseTag}`;

      // The zip contains .deb packages. We extract and install the non-dbgsym one.
      // File pattern in zip: pgvectorscale-postgresql-18_0.9.0-Linux_arm64.deb
      return `    # Install ${entry.name} from GitHub release (.deb package inside zip)
    ARCH=$(dpkg --print-architecture) && \\
    ASSET="${assetPattern.replace("{arch}", "${ARCH}")}" && \\
    echo "Downloading ${entry.name} v${entry.githubReleaseTag} for $ARCH..." && \\
    curl -fsSL "${url}/$ASSET" -o /tmp/${entry.name}.zip && \\
    unzip -q /tmp/${entry.name}.zip -d /tmp/${entry.name} && \\
    # Install the .deb package (skip debug symbols package)
    DEB_FILE=$(find /tmp/${entry.name} -name "*.deb" ! -name "*-dbgsym*" | head -1) && \\
    echo "Installing $DEB_FILE..." && \\
    dpkg -i "$DEB_FILE" && \\
    rm -rf /tmp/${entry.name}* && \\
    echo "✓ Installed ${entry.name} v${entry.githubReleaseTag}"`;
    })
    .join(" && \\\n");

  // .so verification
  const soVerification = enabledEntries
    .map((e) => `test -f /usr/lib/postgresql/${pgMajor}/lib/${e.soFileName}`)
    .join(" && \\\n    ");

  return `# GitHub release binary installation
# Provides pre-built extensions not available via apt for Debian Trixie
# Architecture detected at build time (supports amd64, arm64)
# hadolint ignore=DL3008
RUN --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\
    --mount=type=cache,target=/var/cache/apt,sharing=locked \\
    set -euo pipefail && \\
    apt-get update && \\
    apt-get install -y --no-install-recommends curl unzip && \\
${installCommands} && \\
    # Verify .so files exist
    echo "Verifying GitHub release .so files..." && \\
    ${soVerification} && \\
    echo "All ${enabledEntries.length} GitHub release .so file(s) verified" && \\
    # Strip debug symbols from newly installed .so files
    find /usr/lib/postgresql/${pgMajor}/lib -name "*.so" -newer /tmp -exec strip --strip-unneeded {} \\; 2>/dev/null || true`;
}

/**
 * Generate filtered manifest for PGXS-style builds
 * Includes: pgxs, autotools, cmake, meson, make, timescaledb
 * Excludes: entries with install_via === "pgdg", "percona", or "github-release"
 */
function generatePgxsManifest(manifest: Manifest): Manifest {
  const pgxsBuildTypes = ["pgxs", "autotools", "cmake", "meson", "make", "timescaledb"];
  const filteredEntries = manifest.entries.filter(
    (entry) =>
      entry.build &&
      pgxsBuildTypes.includes(entry.build.type) &&
      entry.install_via !== "pgdg" && // Exclude PGDG-installed entries
      entry.install_via !== "percona" && // Exclude Percona-installed entries
      entry.install_via !== "github-release" // Exclude GitHub release entries
  );

  return {
    entries: filteredEntries,
  };
}

/**
 * Generate filtered manifest for Cargo builds
 * Includes: cargo-pgrx
 * Excludes: entries with install_via === "pgdg", "percona", or "github-release"
 */
function generateCargoManifest(manifest: Manifest): Manifest {
  const filteredEntries = manifest.entries.filter(
    (entry) =>
      entry.build &&
      entry.build.type === "cargo-pgrx" &&
      entry.install_via !== "pgdg" && // Exclude PGDG-installed entries
      entry.install_via !== "percona" && // Exclude Percona-installed entries
      entry.install_via !== "github-release" // Exclude GitHub release-installed entries
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

  info("Generating Percona package installation script...");
  const perconaPackagesInstall = generatePerconaPackagesInstall(manifest, pgMajor);

  info("Generating PGDG tools installation script...");
  const pgdgToolsInstall = generatePgdgToolsInstall(manifest);

  info("Generating GitHub release installation script...");
  const githubReleaseInstall = generateGithubReleaseInstall(manifest, pgMajor);

  info("Generating version info generation script...");
  const versionInfoGeneration = generateVersionInfoGeneration(manifest);

  // Replace placeholders
  info("Replacing placeholders...");
  dockerfile = dockerfile.replace(/\{\{PG_VERSION\}\}/g, extensionDefaults.pgVersion);
  dockerfile = dockerfile.replace(/\{\{PG_MAJOR\}\}/g, pgMajor);
  dockerfile = dockerfile.replace(/\{\{PG_BASE_IMAGE_SHA\}\}/g, extensionDefaults.baseImageSha);
  dockerfile = dockerfile.replace("{{PGDG_PACKAGES_INSTALL}}", pgdgPackagesInstall);
  dockerfile = dockerfile.replace("{{PERCONA_PACKAGES_INSTALL}}", perconaPackagesInstall);
  dockerfile = dockerfile.replace("{{PGDG_TOOLS_INSTALL}}", pgdgToolsInstall);
  dockerfile = dockerfile.replace("{{GITHUB_RELEASE_PACKAGES_INSTALL}}", githubReleaseInstall);
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

  info("Generating GitHub release installation script...");
  const githubReleaseInstall = generateGithubReleaseInstall(manifest, pgMajor);

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
  dockerfile = dockerfile.replace("{{GITHUB_RELEASE_PACKAGES_INSTALL}}", githubReleaseInstall);
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
    await Bun.$`bun run prettier:write ${PGXS_MANIFEST_PATH} ${CARGO_MANIFEST_PATH}`.quiet();
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
