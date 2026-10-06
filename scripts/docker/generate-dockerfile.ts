#!/usr/bin/env bun
/**
 * Generate Dockerfile from template using manifest data
 *
 * This script reads the Dockerfile.template and regression.Dockerfile.template
 * and replaces placeholders with values from the extensions manifest and MANIFEST_METADATA.
 *
 * ARG Strategy:
 * - All version dependencies are HARDCODED at generation time (PG_VERSION, PG_MAJOR, PG_BASE_IMAGE_SHA, PGDG versions)
 * - Only BUILD_DATE and VCS_REF remain as ARGs WITHOUT defaults (required at build time)
 * - To test different versions: update scripts/extensions/manifest-data.ts and regenerate
 *
 * Placeholders:
 * - {{PG_VERSION}} - PostgreSQL version (hardcoded, e.g., "18.1")
 * - {{PG_MAJOR}} - PostgreSQL major version (hardcoded, extracted from PG_VERSION, e.g., "18")
 * - {{PG_BASE_IMAGE_SHA}} - Base image SHA256 (hardcoded)
 * - {{RUST_TOOLCHAIN}} - Rust toolchain version (hardcoded)
 * - {{PGDG_PACKAGES_INSTALL}} - Dynamic PGDG package installation (hardcoded versions)
 * - {{PGDG_PACKAGES_INSTALL_REGRESSION}} - Regression mode PGDG package installation (all extensions)
 *
 * Usage:
 *   bun scripts/docker/generate-dockerfile.ts
 */

import { preloadLibraryName } from "../config-generator/manifest-loader";
import { join } from "node:path";
import { MANIFEST_METADATA } from "../extensions/manifest-data";
import { pgdgAptPackageName } from "../extensions/pgdg-package";
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

interface BuildSpec {
  type: "pgxs" | "cargo-pgrx" | "timescaledb" | "autotools" | "cmake" | "meson" | "make" | "script";
  subdir?: string;
  features?: string[];
  noDefaultFeatures?: boolean;
  mesonOptions?: string[];
  script?: string;
  patches?: string[];
}

interface ManifestEntry {
  name: string;
  kind?: "extension" | "tool" | "builtin";
  install_via?: string;
  pgdgVersion?: string;
  pgdgPackage?: string;
  perconaVersion?: string;
  perconaPackage?: string;
  /** Timescale repository package name (e.g., timescaledb-2-postgresql-18) */
  timescalePackage?: string;
  /** Timescale repository package version (e.g., 2.24.0~debian13-1801) */
  timescaleVersion?: string;
  soFileName?: string;
  binaryPath?: string;
  postgresOwnedDirs?: string[];
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
  sourceLibraries?: Record<string, unknown>;
}

/**
 * Validate package names to ensure they only contain safe characters
 * This prevents shell injection via SC2046/SC2086 word-splitting patterns
 */
function validatePackageName(packageName: string, context: string): void {
  // Safe characters: alphanumeric, hyphen, underscore, equals, dot, plus, colon, tilde
  // Tilde (~) is standard Debian version character for version ordering (e.g., 2.24.0~debian13)
  // This regex matches the intentional word-splitting pattern in Dockerfile
  const SAFE_PACKAGE_REGEX = /^[a-zA-Z0-9\-_=.+:~]*$/;

  if (!SAFE_PACKAGE_REGEX.test(packageName)) {
    throw new Error(
      `SECURITY: Unsafe characters in ${context}: "${packageName}"\n` +
        `Only alphanumeric and [-_=.+:~] are allowed.\n` +
        `This validation protects against shell injection in Dockerfile word-splitting patterns.`
    );
  }
}

/**
 * A `test -f` per entry for the module file it installs, so a package that ships nothing, or renames its
 * library, fails the build instead of the operator's first CREATE EXTENSION. The file name comes from the
 * entry's soFileName and is interpolated into the shell command, hence the strict pattern.
 */
function soFileChecks(entries: ManifestEntry[], source: string, pgMajor: string): string[] {
  return entries.map((entry) => {
    if (!entry.soFileName) {
      throw new Error(
        `${source} entry "${entry.name}" has no soFileName. Add the module file it installs ` +
          `(listed by: ls $(pg_config --pkglibdir)), e.g. soFileName: "${entry.name}.so".`
      );
    }
    if (!/^[a-z0-9_.-]+\.so$/i.test(entry.soFileName)) {
      throw new Error(
        `${source} entry "${entry.name}" has invalid soFileName "${entry.soFileName}": ` +
          `use a bare file name of letters, digits, dots, underscores or hyphens ending in .so.`
      );
    }
    return `test -f /usr/lib/postgresql/${pgMajor}/lib/${entry.soFileName}`;
  });
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
 * `postgresql-<major>-<pgdgPackage>=<pgdgVersion>` for every PGDG extension `include` selects, in
 * manifest order. Tools are excluded: they install in their own layer (generatePgdgToolsInstall).
 * Name and version are validated here because both are interpolated into a shell command.
 */
function pgdgExtensionPins(
  manifest: Manifest,
  pgMajor: string,
  include: (entry: ManifestEntry) => boolean
): string[] {
  return manifest.entries
    .filter((e) => e.kind === "extension" && e.install_via === "pgdg" && include(e))
    .map((entry) => {
      if (!entry.pgdgVersion) {
        throw new Error(
          `PGDG extension "${entry.name}" has no pgdgVersion. Pin it in manifest-data.ts to the version ` +
            `shown by: apt-cache madison ${pgdgAptPackageName(entry, pgMajor)}`
        );
      }
      const pin = `${pgdgAptPackageName(entry, pgMajor)}=${entry.pgdgVersion}`;
      validatePackageName(pin, `PGDG package pin (${entry.name})`);
      return pin;
    });
}

/**
 * Generate PGDG package installation script
 * Versions and PG_MAJOR are hardcoded directly
 */
function generatePgdgPackagesInstall(manifest: Manifest, pgMajor: string): string {
  const enabledPgdgPackages = pgdgExtensionPins(manifest, pgMajor, (e) => e.enabled ?? true);

  if (enabledPgdgPackages.length === 0) {
    return `RUN echo "No PGDG packages enabled in manifest"`;
  }

  const packagesList = enabledPgdgPackages.join(" ");
  const soChecks = soFileChecks(
    manifest.entries.filter(
      (e) => e.kind === "extension" && e.install_via === "pgdg" && (e.enabled ?? true)
    ),
    "PGDG",
    pgMajor
  );

  return `RUN --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\
    --mount=type=cache,target=/var/cache/apt,sharing=locked \\
    set -euo pipefail && \\
    rm -rf /var/lib/apt/lists/* && \\
    apt-get update && \\
    # Install enabled PGDG packages (pre-calculated in TS)
    echo "Installing PGDG packages: ${packagesList}" && \\
    apt-get install -y --no-install-recommends ${packagesList} && \\
    # Each entry's module file must exist (prevents silent installation failures)
    ${soChecks.join(" && \\\n    ")} && \\
    echo "All ${soChecks.length} PGDG module files verified" && \\
    apt-get clean && \\
    rm -rf /var/lib/apt/lists/* && \\
    { find /usr/lib/postgresql/${pgMajor}/lib -name "*.so" -type f -exec strip --strip-unneeded {} \\; 2>/dev/null || true; }`;
}

/**
 * Generate Percona package installation script
 * Percona repository provides pg_stat_monitor and keeps wal2json on the same already-required repo layer.
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

    packages.push(`${entry.perconaPackage}=${entry.perconaVersion}`);
  }

  const packagesList = packages.join(" ");
  const expectedCount = packages.length;
  const soChecks = soFileChecks(enabledPerconaEntries, "Percona", pgMajor);

  return `# Percona repository setup and package installation
# Provides: pg_stat_monitor and wal2json from Percona ppg-${pgMajor}
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
    ${soChecks.join(" && \\\n    ")} && \\
    echo "All ${soChecks.length} Percona module files verified" && \\
    # Cleanup Percona release package
    rm -f /tmp/percona-release.deb && \\
    apt-get clean && \\
    rm -rf /var/lib/apt/lists/* && \\
    { find /usr/lib/postgresql/${pgMajor}/lib -name "*.so" -type f -exec strip --strip-unneeded {} \\; 2>/dev/null || true; }`;
}

/**
 * Generate Timescale repository package installation script
 * Timescale repository provides TimescaleDB (TSL) not available in PGDG
 * Versions are hardcoded directly from manifest timescaleVersion field
 */
function generateTimescalePackagesInstall(manifest: Manifest, pgMajor: string): string {
  // Find all entries with install_via === "timescale" that are enabled
  const enabledTimescaleEntries = manifest.entries.filter(
    (entry) => entry.install_via === "timescale" && (entry.enabled ?? true)
  );

  if (enabledTimescaleEntries.length === 0) {
    return `RUN echo "No Timescale packages enabled in manifest"`;
  }

  // Validate and build package list
  const packages: string[] = [];

  for (const entry of enabledTimescaleEntries) {
    if (!entry.timescalePackage) {
      throw new Error(
        `Timescale entry "${entry.name}" missing required timescalePackage field.\n` +
          `Add timescalePackage: "timescaledb-2-postgresql-${pgMajor}" to manifest entry.`
      );
    }

    // Validate package name for shell safety
    validatePackageName(entry.timescalePackage, `Timescale package name (${entry.name})`);

    // timescaleVersion is REQUIRED for reproducible builds
    if (!entry.timescaleVersion) {
      throw new Error(
        `Timescale entry "${entry.name}" missing required timescaleVersion field.\n` +
          `Add timescaleVersion: "X.Y.Z~debianNN-NNNN" to manifest entry for reproducible builds.`
      );
    }
    validatePackageName(entry.timescaleVersion, `Timescale version (${entry.name})`);

    packages.push(`${entry.timescalePackage}=${entry.timescaleVersion}`);

    // Also pin the loader package for timescaledb-2-postgresql-N to prevent loader version drift.
    // The loader is installed as a dependency and its version determines what extension version
    // PostgreSQL tries to load — a mismatched loader version causes "no installation script for
    // version X" failures even when the main package is correctly pinned.
    const loaderPackage = entry.timescalePackage.replace(
      /^(timescaledb-\d+-)(postgresql-.+)$/,
      "$1loader-$2"
    );
    if (loaderPackage !== entry.timescalePackage) {
      // Only add loader if the pattern matched (i.e., this is a timescaledb-N-postgresql-M package)
      packages.push(`${loaderPackage}=${entry.timescaleVersion}`);
    }
  }

  const packagesList = packages.join(" ");
  const expectedCount = packages.length;
  const soChecks = soFileChecks(enabledTimescaleEntries, "Timescale", pgMajor);

  return `# Timescale repository setup and package installation
# Provides: TimescaleDB with full TSL license (not available in PGDG)
# Note: Timescale packages are pinned via timescaleVersion in manifest for reproducible builds
# hadolint ignore=DL3008
RUN --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\
    --mount=type=cache,target=/var/cache/apt,sharing=locked \\
    set -euo pipefail && \\
    echo "Setting up Timescale repository for PostgreSQL ${pgMajor}..." && \\
    apt-get update && \\
    apt-get install -y --no-install-recommends curl gnupg2 lsb-release && \\
    curl -fsSL https://packagecloud.io/install/repositories/timescale/timescaledb/script.deb.sh | bash && \\
    apt-get update && \\
    echo "Installing Timescale packages: ${packagesList}" && \\
    apt-get install -y --no-install-recommends ${packagesList} && \\
    echo "Installed ${expectedCount} Timescale package(s)" && \\
    # Verify .so files exist
    echo "Verifying Timescale .so files exist..." && \\
    ${soChecks.join(" && \\\n    ")} && \\
    echo "All ${soChecks.length} Timescale module files verified" && \\
    apt-get clean && \\
    rm -rf /var/lib/apt/lists/* && \\
    { find /usr/lib/postgresql/${pgMajor}/lib -name "*.so" -type f -exec strip --strip-unneeded {} \\; 2>/dev/null || true; }`;
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
  const libraryNames = preloadExtensions.map((e) => preloadLibraryName(e)).sort();

  return libraryNames.join(",");
}

/**
 * Generate PGDG package installation script for regression test mode
 * Installs ALL PGDG packages (including disabled ones) for regression testing
 */
function generatePgdgPackagesInstallRegression(manifest: Manifest, pgMajor: string): string {
  const allPgdgPackages = pgdgExtensionPins(
    manifest,
    pgMajor,
    (e) => (e.enabled ?? true) || e.enabledInComprehensiveTest === true
  );

  if (allPgdgPackages.length === 0) {
    return `RUN echo "No PGDG packages available for regression testing"`;
  }

  // For regression mode, use install-or-skip logic since some packages may not be available for PG18 yet
  const installCommands = allPgdgPackages
    .map(
      (pkg) =>
        `    { apt-get install -y --no-install-recommends ${pkg} && echo "✓ Installed: ${pkg}" || echo "⚠ Skipped (not available): ${pkg}"; }`
    )
    .join(" && \\\n");

  return `RUN set -euo pipefail && \\
    rm -rf /var/lib/apt/lists/* && \\
    apt-get update && \\
    # Install PGDG packages for regression testing (install-or-skip for unavailable packages)
    echo "Installing PGDG packages (regression mode): ${allPgdgPackages.length} packages" && \\
${installCommands} && \\
    # Report what was installed
    { dpkg -l | grep "^ii.*postgresql-${pgMajor}-" || true; } | tee /tmp/installed-pgdg-exts.log && \\
    INSTALLED_COUNT=$(wc -l < /tmp/installed-pgdg-exts.log 2>/dev/null || echo "0") && \\
    echo "Successfully installed $INSTALLED_COUNT PGDG extension package(s) (regression mode)" && \\
    rm -f /tmp/installed-pgdg-exts.log && \\
    apt-get clean && \\
    rm -rf /var/lib/apt/lists/* && \\
    { find /usr/lib/postgresql/${pgMajor}/lib -name "*.so" -type f -exec strip --strip-unneeded {} \\; 2>/dev/null || true; }`;
}

/** Paths are interpolated into RUN lines, so only plain absolute paths pass. */
function safeAbsolutePath(path: string | undefined, context: string): string {
  if (!path || !/^(\/[a-zA-Z0-9_.+-]+)+$/.test(path) || path.split("/").includes("..")) {
    throw new Error(
      `${context}: "${path ?? ""}" is not a plain absolute path. Use letters, digits and [_.+-] between slashes, e.g. "/usr/bin/pgbackrest".`
    );
  }
  return path;
}

/**
 * Enabled tools built from source that install an executable. The builder copies exactly each
 * binaryPath into the final image (a whole-directory copy of /usr/local/bin once shipped bun and the
 * build scripts), and the final stage fails the build when the binary misses a shared library.
 */
function sourceTools(manifest: Manifest): ManifestEntry[] {
  return manifest.entries.filter(
    (e) =>
      e.kind === "tool" &&
      (e.install_via ?? "source") === "source" &&
      (e.enabled ?? true) &&
      e.binaryPath !== undefined
  );
}

/** Builder-stage lines (each ending in "&& \\") copying every source tool binary into /opt/ext-out. */
function sourceToolBinariesCopy(manifest: Manifest): string {
  return sourceTools(manifest)
    .map((e) => {
      const bin = safeAbsolutePath(e.binaryPath, `tool "${e.name}" binaryPath`);
      return `    install -D -m 0755 ${bin} /opt/ext-out${bin} && \\\n`;
    })
    .join("");
}

/**
 * Final-stage steps appended to the ldconfig RUN, each starting with " && \\": no missing shared
 * library per source tool binary (ldd prints "not found"; the image has only the base image's
 * libraries plus extensions.runtime-packages.txt), and the directories the tool writes by default,
 * postgres-owned so a named volume mounted there starts writable by postgres.
 */
function sourceToolsRuntimeSetup(manifest: Manifest): string {
  return sourceTools(manifest)
    .map((e) => {
      const bin = safeAbsolutePath(e.binaryPath, `tool "${e.name}" binaryPath`);
      const dirs = (e.postgresOwnedDirs ?? []).map((d) =>
        safeAbsolutePath(d, `tool "${e.name}" postgresOwnedDirs`)
      );
      const steps = [`test -x ${bin}`, `! ldd ${bin} | grep "not found"`];
      if (dirs.length > 0)
        steps.push(`install -d -o postgres -g postgres -m 0750 ${dirs.join(" ")}`);
      return steps.map((s) => ` && \\\n    ${s}`).join("");
    })
    .join("");
}

/**
 * Generate PGDG tool installation script
 * Tools are standalone binaries (no postgresql-XX prefix) installed from PGDG
 *
 * Every tool must be version-pinned: an unpinned name installs whatever apt resolves on build day,
 * so two builds of one commit can differ. (pgbadger was once left unpinned on the belief that it is
 * a Percona virtual package; with the Percona repo enabled it resolves to the real PGDG package and
 * `pgbadger=<version>` installs fine.)
 */
function generatePgdgToolsInstall(manifest: Manifest): string {
  const enabledPgdgTools: Array<{ name: string; version: string; binary: string }> = [];

  for (const entry of manifest.entries) {
    if (entry.kind === "tool" && entry.install_via === "pgdg" && (entry.enabled ?? true)) {
      // Validate tool name for shell safety
      validatePackageName(entry.name, `PGDG tool name (${entry.name})`);
      if (!entry.pgdgVersion) {
        throw new Error(
          `PGDG tool "${entry.name}" has no pgdgVersion. Pin it in manifest-data.ts to the version ` +
            `shown by: apt-cache madison ${entry.name} (run inside postgres:<pgVersion>-trixie)`
        );
      }
      validatePackageName(entry.pgdgVersion, `PGDG tool version (${entry.name})`);

      const binary = safeAbsolutePath(
        entry.binaryPath,
        `PGDG tool "${entry.name}" binaryPath (the executable listed by: dpkg -L ${entry.name})`
      );

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
 * Generate filtered manifest for PGXS-style builds
 * Includes: pgxs, autotools, cmake, meson, make, timescaledb (build type)
 * Excludes: entries with install_via === "pgdg", "percona", or "timescale"
 */
function generatePgxsManifest(manifest: Manifest): Manifest {
  const pgxsBuildTypes = ["pgxs", "autotools", "cmake", "meson", "make", "timescaledb"];
  const filteredEntries = manifest.entries.filter(
    (entry) =>
      entry.build &&
      pgxsBuildTypes.includes(entry.build.type) &&
      entry.install_via !== "pgdg" && // Exclude PGDG-installed entries
      entry.install_via !== "percona" && // Exclude Percona-installed entries
      entry.install_via !== "timescale" // Exclude Timescale repo entries
  );

  return {
    entries: filteredEntries,
    sourceLibraries: manifest.sourceLibraries,
  };
}

/**
 * Generate filtered manifest for Cargo builds
 * Includes: cargo-pgrx
 * Excludes: entries with install_via === "pgdg", "percona", or "timescale"
 */
function generateCargoManifest(manifest: Manifest): Manifest {
  const filteredEntries = manifest.entries.filter(
    (entry) =>
      entry.build &&
      entry.build.type === "cargo-pgrx" &&
      entry.install_via !== "pgdg" && // Exclude PGDG-installed entries
      entry.install_via !== "percona" && // Exclude Percona-installed entries
      entry.install_via !== "timescale" // Exclude Timescale repo entries
  );

  return {
    entries: filteredEntries,
    sourceLibraries: manifest.sourceLibraries,
  };
}

/**
 * Extract PG_MAJOR from PG_VERSION (e.g., "18.1" -> "18")
 */
function extractPgMajor(): string {
  const pgVersion = MANIFEST_METADATA.pgVersion;
  const majorVersion = pgVersion.split(".")[0];
  if (!majorVersion) {
    throw new Error(`Could not extract major version from PG_VERSION: ${pgVersion}`);
  }
  return majorVersion;
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

  info("Generating Timescale package installation script...");
  const timescalePackagesInstall = generateTimescalePackagesInstall(manifest, pgMajor);

  info("Generating PGDG tools installation script...");
  const pgdgToolsInstall = generatePgdgToolsInstall(manifest);

  // Replace placeholders
  info("Replacing placeholders...");
  dockerfile = dockerfile.replace(/\{\{PG_VERSION\}\}/g, MANIFEST_METADATA.pgVersion);
  dockerfile = dockerfile.replace(/\{\{PG_MAJOR\}\}/g, pgMajor);
  dockerfile = dockerfile.replace(/\{\{PG_BASE_IMAGE_SHA\}\}/g, MANIFEST_METADATA.baseImageSha);
  dockerfile = dockerfile.replace(/\{\{RUST_TOOLCHAIN\}\}/g, MANIFEST_METADATA.rustToolchain);
  dockerfile = dockerfile.replace("{{PGDG_PACKAGES_INSTALL}}", pgdgPackagesInstall);
  dockerfile = dockerfile.replace("{{PERCONA_PACKAGES_INSTALL}}", perconaPackagesInstall);
  dockerfile = dockerfile.replace("{{TIMESCALE_PACKAGES_INSTALL}}", timescalePackagesInstall);
  dockerfile = dockerfile.replace("{{PGDG_TOOLS_INSTALL}}", pgdgToolsInstall);
  dockerfile = dockerfile.replace("{{SOURCE_TOOL_BINARIES_COPY}}\n", () =>
    sourceToolBinariesCopy(manifest)
  );
  dockerfile = dockerfile.replace("{{SOURCE_TOOLS_RUNTIME_SETUP}}", () =>
    sourceToolsRuntimeSetup(manifest)
  );

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
  dockerfile = dockerfile.replace(/\{\{PG_VERSION\}\}/g, MANIFEST_METADATA.pgVersion);
  dockerfile = dockerfile.replace(/\{\{PG_MAJOR\}\}/g, pgMajor);
  dockerfile = dockerfile.replace(/\{\{PG_BASE_IMAGE_SHA\}\}/g, MANIFEST_METADATA.baseImageSha);
  dockerfile = dockerfile.replace(/\{\{RUST_TOOLCHAIN\}\}/g, MANIFEST_METADATA.rustToolchain);
  dockerfile = dockerfile.replace(
    "{{PGDG_PACKAGES_INSTALL_REGRESSION}}",
    pgdgPackagesInstallRegression
  );
  dockerfile = dockerfile.replace("{{REGRESSION_PRELOAD_LIBRARIES}}", regressionPreloadLibs);
  dockerfile = dockerfile.replace("{{SOURCE_TOOL_BINARIES_COPY}}\n", () =>
    sourceToolBinariesCopy(manifest)
  );
  dockerfile = dockerfile.replace("{{SOURCE_TOOLS_RUNTIME_SETUP}}", () =>
    sourceToolsRuntimeSetup(manifest)
  );

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
