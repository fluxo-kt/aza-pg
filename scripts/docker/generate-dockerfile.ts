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
function generatePgdgPackagesInstall(manifest: Manifest): string {
  const enabledPgdgPackages: string[] = [];

  for (const mapping of PGDG_MAPPINGS) {
    const entry = manifest.entries.find((e) => e.name === mapping.manifestName);
    // Check if entry exists, is PGDG, and is enabled (default true)
    if (entry && entry.install_via === "pgdg" && (entry.enabled ?? true)) {
      // Package is enabled
      // We use ${PG_MAJOR} and ${ARG_NAME} which are Docker ARGs
      enabledPgdgPackages.push(
        `postgresql-\${PG_MAJOR}-${mapping.packageName}=\${${mapping.argName}}`
      );
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
    apt-get install -y ${packagesList} && \\
    # Verify expected PGDG extensions were installed (Phase 4.1 assertion)
    dpkg -l | grep "^ii.*postgresql-\${PG_MAJOR}-" | tee /tmp/installed-pgdg-exts.log && \\
    INSTALLED_COUNT=$(wc -l < /tmp/installed-pgdg-exts.log) && \\
    echo "Installed $INSTALLED_COUNT PGDG extension package(s)" && \\
    echo "Expected ${expectedCount} enabled PGDG packages from manifest" && \\
    # Allow some variance but ensure we have at least 1 package
    test "$INSTALLED_COUNT" -ge ${expectedCount} || (echo "ERROR: Installed count mismatch (expected >= ${expectedCount}, got $INSTALLED_COUNT)" && exit 1) && \\
    rm -f /tmp/installed-pgdg-exts.log && \\
    apt-get clean && \\
    rm -rf /var/lib/apt/lists/* /tmp/extensions.manifest.json && \\
    find /usr/lib/postgresql/\${PG_MAJOR}/lib -name "*.so" -type f -exec strip --strip-unneeded {} \\; 2>/dev/null || true`;
}

/**
 * Generate version info generation script using TypeScript-style logic
 */
function generateVersionInfoGeneration(manifest: Manifest): string {
  // Pre-calculate extension list and counts in TypeScript
  // This removes the need for 'jq' in the final image and moves logic to build time

  const enabledEntries = manifest.entries.filter((e) => e.enabled !== false);
  const disabledEntries = manifest.entries.filter((e) => e.enabled === false);
  const preloadedEntries = enabledEntries.filter((e) => e.runtime?.sharedPreload);

  const totalCount = manifest.entries.length;
  const enabledCount = enabledEntries.length;
  const disabledCount = disabledEntries.length;
  const preloadedCount = preloadedEntries.length;

  // Sort entries for deterministic output
  enabledEntries.sort((a, b) => a.name.localeCompare(b.name));

  // Generate the formatted list for version-info.txt
  const extensionList = enabledEntries
    .map((e) => {
      let version = "builtin";
      if (e.source.tag) {
        version = e.source.tag;
      } else if (e.source.ref) {
        version = e.source.ref;
      }
      return `${e.name} ${version}`;
    })
    .join("\\n");

  // Generate the JSON structure (partially pre-filled)
  // We use placeholders for runtime values like PG_VERSION
  const jsonStructure = {
    postgres_version: "${PG_VERSION}",
    build_timestamp: "${BUILD_TS}",
    build_date: "${BUILD_DATE}",
    build_type: "single-node",
    extensions: {
      total: totalCount,
      enabled: enabledCount,
      disabled: disabledCount,
      preloaded: preloadedCount,
    },
  };

  return `RUN set -ex; \\
    \\
    # Extract actual PostgreSQL version
    PG_VERSION=$(psql --version | grep -oP '\\d+\\.\\d+' | head -1); \\
    BUILD_DATE=$(date -u '+%Y-%m-%d'); \\
    BUILD_TS=$(date -u '+%Y%m%d%H%M'); \\
    \\
    # Generate version-info.txt (super lean and focused)
    { \\
      echo "aza-pg \${PG_VERSION} | \${BUILD_TS}"; \\
      echo "=================================================="; \\
      echo "PostgreSQL: \${PG_VERSION}"; \\
      echo "Build: \${BUILD_TS} (\${BUILD_DATE})"; \\
      echo ""; \\
      echo "Extensions & Tools:"; \\
      printf "%b\\n" "${extensionList}"; \\
    } > /etc/postgresql/version-info.txt && \\
    \\
    # Generate version-info.json (machine-readable)
    # Using heredoc with variable substitution for runtime values
    cat <<EOF > /etc/postgresql/version-info.json
${JSON.stringify(jsonStructure, null, 2)}
EOF
`;
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
