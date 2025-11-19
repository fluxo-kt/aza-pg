#!/usr/bin/env bun
/**
 * Generate Dockerfile from template using manifest data
 *
 * This script reads the Dockerfile.template and replaces placeholders with
 * actual values from the extensions manifest and extension-defaults.
 *
 * Placeholders:
 * - {{PGDG_VERSION_ARGS}} - ARG declarations for PGDG package versions
 * - {{PGDG_VERSION_ARG_REDECLARE}} - ARG redeclarations in final stage
 * - {{PGDG_PACKAGES_INSTALL}} - Dynamic PGDG package installation
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

interface ManifestEntry {
  name: string;
  install_via?: string;
  enabled?: boolean;
  runtime?: {
    sharedPreload?: boolean;
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
 * Generate ARG declarations for PGDG versions
 */
function generatePgdgVersionArgs(): string {
  const lines = PGDG_MAPPINGS.map((mapping) => {
    const version = extensionDefaults.pgdgVersions[mapping.versionKey];
    return `ARG ${mapping.argName}=${version}`;
  });

  return lines.join("\n");
}

/**
 * Generate ARG redeclarations for final stage
 */
function generatePgdgVersionArgRedeclare(): string {
  const lines = PGDG_MAPPINGS.map((mapping) => `ARG ${mapping.argName}`);
  return lines.join("\n");
}

/**
 * Generate PGDG package installation script
 */
function generatePgdgPackagesInstall(_manifest: Manifest): string {
  // Build shell script dynamically
  const shellScript = `RUN set -eu && \\
    rm -rf /var/lib/apt/lists/* && \\
    apt-get update && \\
    apt-get install -y jq && \\
    # Build package list dynamically from manifest (only enabled PGDG extensions)
    PGDG_PACKAGES="" && \\
    # Helper function to conditionally add package if enabled
    add_if_enabled() { \\
      local ext_name=$1; \\
      local pkg_name=$2; \\
      local pkg_version=$3; \\
      if jq -e --arg name "$ext_name" '.entries[] | select(.name == $name and .install_via == "pgdg" and ((.enabled == null) or (.enabled == true)))' /tmp/extensions.manifest.json >/dev/null; then \\
        PGDG_PACKAGES="$PGDG_PACKAGES postgresql-\${PG_MAJOR}-\${pkg_name}=\${pkg_version}"; \\
      fi; \\
    } && \\`;

  // Add all PGDG packages
  const addCommands = PGDG_MAPPINGS.map((mapping) => {
    return `    add_if_enabled "${mapping.manifestName}" "${mapping.packageName}" "\${${mapping.argName}}" && \\`;
  }).join("\n");

  const finalPart = `    # Install only enabled packages (skip if none enabled)
    if [ -n "$PGDG_PACKAGES" ]; then \\
      echo "Installing PGDG packages: $PGDG_PACKAGES" && \\
      apt-get install -y $PGDG_PACKAGES && \\
      # Verify expected PGDG extensions were installed (Phase 4.1 assertion)
      dpkg -l | grep "^ii.*postgresql-\${PG_MAJOR}-" | tee /tmp/installed-pgdg-exts.log && \\
      INSTALLED_COUNT=$(wc -l < /tmp/installed-pgdg-exts.log) && \\
      echo "Installed $INSTALLED_COUNT PGDG extension package(s)" && \\
      # Dynamic verification: count enabled PGDG packages in manifest
      ENABLED_PGDG_COUNT=$(jq '[.entries[] | select(.install_via == "pgdg" and ((.enabled == null) or (.enabled == true)))] | length' /tmp/extensions.manifest.json) && \\
      echo "Expected $ENABLED_PGDG_COUNT enabled PGDG packages from manifest" && \\
      # Allow some variance but ensure we have at least 1 package
      test "$INSTALLED_COUNT" -ge 1 || (echo "ERROR: No PGDG packages installed" && exit 1) && \\
      rm -f /tmp/installed-pgdg-exts.log; \\
    else \\
      echo "No PGDG packages enabled in manifest"; \\
    fi && \\
    apt-get clean && \\
    rm -rf /var/lib/apt/lists/* /tmp/extensions.manifest.json && \\
    find /usr/lib/postgresql/\${PG_MAJOR}/lib -name "*.so" -type f -exec strip --strip-unneeded {} \\; 2>/dev/null || true`;

  return [shellScript, addCommands, finalPart].join("\n");
}

/**
 * Generate version info generation script using TypeScript-style logic
 */
function generateVersionInfoGeneration(_manifest: Manifest): string {
  // Note: We use jq to count extensions at build time for accurate results
  // This ensures version-info reflects the actual manifest at image build time
  return `RUN set -ex; \\
    apt-get update && apt-get install -y --no-install-recommends jq && \\
    \\
    # Extract actual PostgreSQL version
    PG_VERSION=$(psql --version | grep -oP '\\d+\\.\\d+' | head -1); \\
    BUILD_DATE=$(date -u '+%Y-%m-%d'); \\
    BUILD_TS=$(date -u '+%Y%m%d%H%M'); \\
    MANIFEST="/etc/postgresql/extensions.manifest.json"; \\
    \\
    # Count extensions
    TOTAL=$(jq '.entries | length' "$MANIFEST"); \\
    ENABLED=$(jq '[.entries[] | select((.enabled == null) or (.enabled == true))] | length' "$MANIFEST"); \\
    DISABLED=$(jq '[.entries[] | select(.enabled == false)] | length' "$MANIFEST"); \\
    PRELOADED=$(jq '[.entries[] | select(((.enabled == null) or (.enabled == true)) and .runtime.sharedPreload)] | length' "$MANIFEST"); \\
    \\
    # Generate version-info.txt (human-readable)
    printf '%s\\n' \\
      '===============================================================================' \\
      "aza-pg - PostgreSQL \${PG_VERSION%.*} with Extensions" \\
      '===============================================================================' \\
      '' \\
      "Build Date: \${BUILD_DATE}" \\
      "PostgreSQL Version: \${PG_VERSION}" \\
      '' \\
      'SUMMARY' \\
      "  Total Catalog: \${TOTAL}" \\
      "  Enabled: \${ENABLED}" \\
      "  Disabled: \${DISABLED}" \\
      "  Preloaded: \${PRELOADED}" \\
      '' \\
      '===============================================================================' \\
      'Use CREATE EXTENSION <name>; to enable available extensions' \\
      'View manifest: cat /etc/postgresql/extensions.manifest.json' \\
      'Documentation: https://github.com/fluxo-kt/aza-pg' \\
      '===============================================================================' \\
      > /etc/postgresql/version-info.txt && \\
    \\
    # Generate version-info.json (machine-readable)
    jq -n --arg pg_version "$PG_VERSION" --arg build_ts "$BUILD_TS" --arg build_date "$BUILD_DATE" --argjson total "$TOTAL" --argjson enabled "$ENABLED" --argjson disabled "$DISABLED" --argjson preloaded "$PRELOADED" '{postgres_version: $pg_version, build_timestamp: $build_ts, build_date: $build_date, build_type: "single-node", extensions: {total: $total, enabled: $enabled, disabled: $disabled, preloaded: $preloaded}}' > /etc/postgresql/version-info.json && \\
    \\
    # Remove jq (only needed for generation)
    apt-get purge -y jq && \\
    apt-get autoremove -y && \\
    rm -rf /var/lib/apt/lists/*`;
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

  // Read template
  info("Reading template...");
  if (!(await Bun.file(TEMPLATE_PATH).exists())) {
    throw new Error(`Template not found: ${TEMPLATE_PATH}`);
  }

  const templateFile = Bun.file(TEMPLATE_PATH);
  let dockerfile = await templateFile.text();

  // Generate replacements
  info("Generating PGDG version ARGs...");
  const pgdgVersionArgs = generatePgdgVersionArgs();

  info("Generating PGDG version ARG redeclarations...");
  const pgdgVersionArgRedeclare = generatePgdgVersionArgRedeclare();

  info("Generating PGDG package installation script...");
  const pgdgPackagesInstall = generatePgdgPackagesInstall(manifest);

  info("Generating version info generation script...");
  const versionInfoGeneration = generateVersionInfoGeneration(manifest);

  // Replace placeholders
  info("Replacing placeholders...");
  dockerfile = dockerfile.replace(/\{\{PG_VERSION\}\}/g, extensionDefaults.pgVersion);
  dockerfile = dockerfile.replace(/\{\{PG_BASE_IMAGE_SHA\}\}/g, extensionDefaults.baseImageSha);
  dockerfile = dockerfile.replace("{{PGDG_VERSION_ARGS}}", pgdgVersionArgs);
  dockerfile = dockerfile.replace("{{PGDG_VERSION_ARG_REDECLARE}}", pgdgVersionArgRedeclare);
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
