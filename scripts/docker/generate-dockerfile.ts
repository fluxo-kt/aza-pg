#!/usr/bin/env bun
/**
 * Generate Dockerfile from template using manifest data
 *
 * This script reads the Dockerfile.template and replaces placeholders with
 * actual values from the extensions manifest and extension-defaults.
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

const PGDG_MAPPINGS: PgdgMapping[] = [
  { manifestName: "pg_cron", packageName: "cron", argName: "PGCRON_VERSION", versionKey: "pgcron" },
  {
    manifestName: "pgaudit",
    packageName: "pgaudit",
    argName: "PGAUDIT_VERSION",
    versionKey: "pgaudit",
  },
  {
    manifestName: "vector",
    packageName: "pgvector",
    argName: "PGVECTOR_VERSION",
    versionKey: "pgvector",
  },
  {
    manifestName: "timescaledb",
    packageName: "timescaledb",
    argName: "TIMESCALEDB_VERSION",
    versionKey: "timescaledb",
  },
  {
    manifestName: "postgis",
    packageName: "postgis-3",
    argName: "POSTGIS_VERSION",
    versionKey: "postgis",
  },
  {
    manifestName: "pg_partman",
    packageName: "partman",
    argName: "PARTMAN_VERSION",
    versionKey: "partman",
  },
  {
    manifestName: "pg_repack",
    packageName: "repack",
    argName: "REPACK_VERSION",
    versionKey: "repack",
  },
  {
    manifestName: "plpgsql_check",
    packageName: "plpgsql-check",
    argName: "PLPGSQL_CHECK_VERSION",
    versionKey: "plpgsqlCheck",
  },
  { manifestName: "hll", packageName: "hll", argName: "HLL_VERSION", versionKey: "hll" },
  { manifestName: "http", packageName: "http", argName: "HTTP_VERSION", versionKey: "http" },
  {
    manifestName: "hypopg",
    packageName: "hypopg",
    argName: "HYPOPG_VERSION",
    versionKey: "hypopg",
  },
  {
    manifestName: "pgrouting",
    packageName: "pgrouting",
    argName: "PGROUTING_VERSION",
    versionKey: "pgrouting",
  },
  { manifestName: "rum", packageName: "rum", argName: "RUM_VERSION", versionKey: "rum" },
  {
    manifestName: "set_user",
    packageName: "set-user",
    argName: "SET_USER_VERSION",
    versionKey: "setUser",
  },
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
  build?: BuildSpec;
  runtime?: {
    sharedPreload?: boolean;
  };
  source: {
    tag?: string;
    ref?: string;
  };
}

interface Manifest {
  generatedAt: string;
  entries: ManifestEntry[];
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
      enabledPgdgPackages.push(`postgresql-${pgMajor}-${mapping.packageName}=${version}`);
    }
  }

  if (enabledPgdgPackages.length === 0) {
    return `RUN echo "No PGDG packages enabled in manifest"`;
  }

  const packagesList = enabledPgdgPackages.join(" ");
  const expectedCount = enabledPgdgPackages.length;

  return `RUN set -eu && \\
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
    generatedAt: manifest.generatedAt,
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
    generatedAt: manifest.generatedAt,
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
 * Generate Dockerfile from template
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

  // Read template
  info("Reading template...");
  if (!(await Bun.file(TEMPLATE_PATH).exists())) {
    throw new Error(`Template not found: ${TEMPLATE_PATH}`);
  }

  const templateFile = Bun.file(TEMPLATE_PATH);
  let dockerfile = await templateFile.text();

  // Extract PG_MAJOR and generate dynamic content
  info("Extracting PG_MAJOR...");
  const pgMajor = extractPgMajor();

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
  const now = new Date().toISOString();
  const header = `# AUTO-GENERATED FILE - DO NOT EDIT
# Generated at: ${now}
# Generator: scripts/docker/generate-dockerfile.ts
# Template: docker/postgres/Dockerfile.template
# Manifest: docker/postgres/extensions.manifest.json
# To regenerate: bun run generate

`;

  dockerfile = header + dockerfile;

  // Write output
  info(`Writing Dockerfile to ${OUTPUT_PATH}...`);
  await Bun.write(OUTPUT_PATH, dockerfile);

  success("Dockerfile generated successfully!");

  // Print stats
  const enabledPgdg = manifest.entries.filter(
    (e) => e.install_via === "pgdg" && (e.enabled ?? true) === true
  ).length;
  const disabledPgdg = manifest.entries.filter(
    (e) => e.install_via === "pgdg" && e.enabled === false
  ).length;

  console.log("");
  info(`PGDG extensions: ${enabledPgdg} enabled, ${disabledPgdg} disabled`);
  info(`Total extensions: ${manifest.entries.length}`);
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
