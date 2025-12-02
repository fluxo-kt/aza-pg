#!/usr/bin/env bun
/**
 * Manifest validation script
 * Validates extensions.manifest.json against expected counts, consistency rules, and cross-references
 */

import { join } from "node:path";
import { validateManifest } from "./manifest-schema.ts";
import * as logger from "../utils/logger";

// Counts are auto-derived from manifest (no hardcoding - manifest is source of truth)
interface ManifestCounts {
  total: number;
  builtin: number;
  pgdg: number;
  percona: number;
  timescale: number;
  githubRelease: number;
  compiled: number;
  enabled: number;
  disabled: number;
}

// File paths - derive PROJECT_ROOT from import.meta.dir
const PROJECT_ROOT = join(import.meta.dir, "../..");
const MANIFEST_PATH = join(PROJECT_ROOT, "docker/postgres/extensions.manifest.json");
const DOCKERFILE_PATH = join(PROJECT_ROOT, "docker/postgres/Dockerfile");
const INIT_SQL_PATH = join(
  PROJECT_ROOT,
  "docker/postgres/docker-entrypoint-initdb.d/01-extensions.sql"
);
const ENTRYPOINT_PATH = join(PROJECT_ROOT, "docker/postgres/docker-auto-config-entrypoint.sh");

interface RuntimeSpec {
  sharedPreload: boolean;
  defaultEnable: boolean;
  preloadOnly?: boolean;
  preloadLibraryName?: string;
  notes?: string[];
}

interface ManifestEntry {
  name: string;
  displayName?: string;
  kind: "extension" | "builtin" | "tool";
  install_via?: "pgdg" | "percona" | "timescale" | "source" | "github-release";
  githubRepo?: string;
  githubReleaseTag?: string;
  githubAssetPattern?: string;
  soFileName?: string;
  runtime?: RuntimeSpec;
  dependencies?: string[];
  enabled?: boolean;
}

interface Manifest {
  generatedAt: string;
  entries: ManifestEntry[];
}

const errors: string[] = [];
const warnings: string[] = [];

function error(msg: string): void {
  errors.push(msg);
}

function warn(msg: string): void {
  warnings.push(msg);
}

async function readManifest(): Promise<Manifest> {
  const file = Bun.file(MANIFEST_PATH);
  if (!(await file.exists())) {
    throw new Error(`Manifest not found: ${MANIFEST_PATH}`);
  }
  const content = await file.text();
  const rawData = JSON.parse(content);

  // Runtime validation with ArkType
  try {
    validateManifest(rawData.entries);
  } catch (validationError) {
    const message =
      validationError instanceof Error ? validationError.message : String(validationError);
    throw new Error(`Manifest schema validation failed: ${message}`, { cause: validationError });
  }

  return rawData;
}

async function readFile(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`File not found: ${path}`);
  }
  return await file.text();
}

// 1. Count derivation (no hardcoded validation - manifest is source of truth)
function deriveCounts(manifest: Manifest): ManifestCounts {
  const total = manifest.entries.length;
  const builtin = manifest.entries.filter((e) => e.kind === "builtin").length;
  const pgdg = manifest.entries.filter((e) => e.install_via === "pgdg").length;
  const percona = manifest.entries.filter((e) => e.install_via === "percona").length;
  const timescale = manifest.entries.filter((e) => e.install_via === "timescale").length;
  const githubRelease = manifest.entries.filter((e) => e.install_via === "github-release").length;

  // Compiled = extensions built from source (not PGDG, not builtin, not percona, not timescale, not github-release)
  const compiled = manifest.entries.filter(
    (e) =>
      e.kind !== "builtin" &&
      e.install_via !== "pgdg" &&
      e.install_via !== "percona" &&
      e.install_via !== "timescale" &&
      e.install_via !== "github-release"
  ).length;

  const enabled = manifest.entries.filter((e) => e.enabled !== false).length;
  const disabled = manifest.entries.filter((e) => e.enabled === false).length;

  logger.info("[MANIFEST COUNTS]");
  console.log(`  Total: ${total}`);
  console.log(`  Builtin: ${builtin}`);
  console.log(`  PGDG: ${pgdg}`);
  console.log(`  Percona: ${percona}`);
  console.log(`  Timescale: ${timescale}`);
  console.log(`  GitHub Release: ${githubRelease}`);
  console.log(`  Compiled: ${compiled}`);
  console.log(`  Enabled: ${enabled}`);
  console.log(`  Disabled: ${disabled}`);

  // Sanity check: counts should sum correctly
  if (builtin + pgdg + percona + timescale + githubRelease + compiled !== total) {
    error(
      `Count arithmetic mismatch: builtin(${builtin}) + pgdg(${pgdg}) + percona(${percona}) + timescale(${timescale}) + githubRelease(${githubRelease}) + compiled(${compiled}) = ${builtin + pgdg + percona + timescale + githubRelease + compiled}, but total = ${total}`
    );
  }

  if (enabled + disabled !== total) {
    error(
      `Enabled/disabled count mismatch: enabled(${enabled}) + disabled(${disabled}) = ${enabled + disabled}, but total = ${total}`
    );
  }

  return { total, builtin, pgdg, percona, timescale, githubRelease, compiled, enabled, disabled };
}

// 2. defaultEnable consistency
async function validateDefaultEnable(manifest: Manifest): Promise<void> {
  console.log(); // Empty line for spacing
  logger.info("[DEFAULT ENABLE VALIDATION]");

  // Parse 01-extensions.sql for baseline extensions
  const initSql = await readFile(INIT_SQL_PATH);
  const baselineExtensions = new Set<string>();

  // Match CREATE EXTENSION lines (handles both quoted and unquoted names)
  const createExtensionRegex = /CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+"?(\w+)"?/gi;
  let match;
  while ((match = createExtensionRegex.exec(initSql)) !== null) {
    const extName = match[1];
    if (extName) {
      baselineExtensions.add(extName.toLowerCase());
    }
  }

  console.log(
    `  Baseline extensions in 01-extensions.sql: ${Array.from(baselineExtensions).join(", ")}`
  );

  // Parse docker-auto-config-entrypoint.sh for DEFAULT_SHARED_PRELOAD_LIBRARIES
  const entrypoint = await readFile(ENTRYPOINT_PATH);
  const preloadMatch = entrypoint.match(/DEFAULT_SHARED_PRELOAD_LIBRARIES="([^"]+)"/);
  const preloadLibraries = new Set<string>();

  if (preloadMatch?.[1]) {
    preloadMatch[1].split(",").forEach((lib) => preloadLibraries.add(lib.trim()));
  }

  console.log(`  Default preload libraries: ${Array.from(preloadLibraries).join(", ")}`);

  // Check each extension with defaultEnable=true
  for (const entry of manifest.entries) {
    if (entry.runtime?.defaultEnable) {
      const inBaseline = baselineExtensions.has(entry.name.toLowerCase());
      // Check both the extension name and the custom preloadLibraryName if specified
      const preloadName = entry.runtime?.preloadLibraryName ?? entry.name;
      const inPreload = preloadLibraries.has(preloadName);

      // Builtin extensions that don't require CREATE EXTENSION (like plpgsql)
      // are always available, so we don't require them to be in baseline or preload
      const isAlwaysAvailableBuiltin = entry.kind === "builtin" && entry.name === "plpgsql"; // plpgsql is always available in PostgreSQL

      // SQL-only schemas with preloadOnly=true are enabled via other mechanisms (e.g., initdb scripts)
      // and don't need to be in baseline or preload
      const isPreloadOnlySQLSchema = entry.runtime?.preloadOnly === true;

      if (!inBaseline && !inPreload && !isAlwaysAvailableBuiltin && !isPreloadOnlySQLSchema) {
        error(
          `Extension '${entry.name}' has defaultEnable=true but is NOT in 01-extensions.sql baseline ` +
            `(${Array.from(baselineExtensions).join(", ")}) ` +
            `OR DEFAULT_SHARED_PRELOAD_LIBRARIES (${Array.from(preloadLibraries).join(", ")})`
        );
      }
    }
  }
}

// 3. Shared preload libraries synchronization
async function validateSharedPreloadLibraries(manifest: Manifest): Promise<void> {
  console.log(); // Empty line for spacing
  logger.info("[SHARED PRELOAD LIBRARIES VALIDATION]");

  // Parse docker-auto-config-entrypoint.sh for DEFAULT_SHARED_PRELOAD_LIBRARIES
  const entrypoint = await readFile(ENTRYPOINT_PATH);
  const preloadMatch = entrypoint.match(/DEFAULT_SHARED_PRELOAD_LIBRARIES="([^"]+)"/);
  const preloadLibraries = new Set<string>();

  if (preloadMatch?.[1]) {
    preloadMatch[1].split(",").forEach((lib) => preloadLibraries.add(lib.trim()));
  }

  console.log(`  Configured preload libraries: ${Array.from(preloadLibraries).join(", ")}`);

  // Find all extensions that SHOULD be in preload (sharedPreload: true AND defaultEnable: true)
  // Use preloadLibraryName if specified, otherwise use extension name
  const expectedPreloadEntries = manifest.entries.filter(
    (e) => e.runtime?.sharedPreload && e.runtime?.defaultEnable && e.enabled !== false
  );
  const expectedPreload = expectedPreloadEntries.map(
    (e) => e.runtime?.preloadLibraryName ?? e.name
  );

  console.log(`  Expected preload (from manifest): ${expectedPreload.join(", ")}`);

  // Check for libraries in DEFAULT_SHARED_PRELOAD_LIBRARIES that shouldn't be there
  // Look up by both name and preloadLibraryName
  for (const lib of preloadLibraries) {
    const entry = manifest.entries.find(
      (e) => e.name === lib || e.runtime?.preloadLibraryName === lib
    );

    if (!entry) {
      error(
        `Library '${lib}' is in DEFAULT_SHARED_PRELOAD_LIBRARIES but NOT in manifest. ` +
          `Either add to manifest or remove from preload list.`
      );
      continue;
    }

    if (!entry.runtime?.sharedPreload) {
      error(
        `Library '${lib}' is in DEFAULT_SHARED_PRELOAD_LIBRARIES but has sharedPreload=false in manifest. ` +
          `Either enable sharedPreload or remove from preload list.`
      );
    }

    if (!entry.runtime?.defaultEnable) {
      error(
        `Library '${lib}' is in DEFAULT_SHARED_PRELOAD_LIBRARIES but has defaultEnable=false in manifest. ` +
          `This should be opt-in via POSTGRES_SHARED_PRELOAD_LIBRARIES env var. ` +
          `Remove '${lib}' from DEFAULT_SHARED_PRELOAD_LIBRARIES.`
      );
    }

    if (entry.enabled === false) {
      error(
        `Library '${lib}' is in DEFAULT_SHARED_PRELOAD_LIBRARIES but is disabled in manifest. ` +
          `Either enable the extension or remove from preload list.`
      );
    }
  }

  // Check for extensions that should be preloaded but aren't
  for (const expectedLib of expectedPreload) {
    if (!preloadLibraries.has(expectedLib)) {
      error(
        `Extension '${expectedLib}' has sharedPreload=true and defaultEnable=true but is NOT in ` +
          `DEFAULT_SHARED_PRELOAD_LIBRARIES. Add '${expectedLib}' to the preload list.`
      );
    }
  }

  // Verification message
  if (errors.length === 0) {
    console.log(`  ✓ All preload libraries match manifest configuration`);
  }
}

// 4. PGDG consistency
async function validatePgdgConsistency(manifest: Manifest): Promise<void> {
  console.log(); // Empty line for spacing
  logger.info("[PGDG CONSISTENCY VALIDATION]");

  const dockerfile = await readFile(DOCKERFILE_PATH);
  const pgdgExtensions = manifest.entries.filter((e) => e.install_via === "pgdg");

  // Extract PGDG package names from apt-get install commands
  // Pattern: postgresql-${PG_MAJOR}-<package>=<version>
  // Example: postgresql-${PG_MAJOR}-cron=1.6.7-2.pgdg13+1
  const packageRegex = /postgresql-\$\{PG_MAJOR\}-([a-z0-9-]+)=[0-9.+a-z-]+/g;
  const dockerfilePgdgPackages = new Set<string>();

  let match;
  while ((match = packageRegex.exec(dockerfile)) !== null) {
    const packageName = match[1];
    if (packageName) {
      dockerfilePgdgPackages.add(packageName);
    }
  }

  console.log(`  PGDG packages in Dockerfile: ${Array.from(dockerfilePgdgPackages).join(", ")}`);

  // The Dockerfile uses TypeScript-generated package lists with hardcoded versions
  // Validate that enabled PGDG extensions have corresponding package installations
  for (const entry of pgdgExtensions) {
    // Map extension name to Dockerfile package name (e.g., "pg_cron" -> "cron")
    const packageName = getDockerfilePackageName(entry.name);

    if (!dockerfilePgdgPackages.has(packageName)) {
      // This is expected for enabled=false entries, so only warn
      if (entry.enabled !== false) {
        warn(
          `Extension '${entry.name}' has install_via="pgdg" but no corresponding package in Dockerfile ` +
            `(expected: postgresql-\${PG_MAJOR}-${packageName}=...). This may be intentional for dynamic installation.`
        );
      }
    }
  }
}

// Map manifest extension name to Dockerfile package name (as used in apt-get install)
function getDockerfilePackageName(extensionName: string): string {
  const mapping: Record<string, string> = {
    vector: "pgvector",
    pg_cron: "cron",
    pgaudit: "pgaudit",
    timescaledb: "timescaledb",
    postgis: "postgis-3",
    pg_partman: "partman",
    pg_repack: "repack",
    plpgsql_check: "plpgsql-check",
    hll: "hll",
    http: "http",
    hypopg: "hypopg",
    pgrouting: "pgrouting",
    rum: "rum",
    set_user: "set-user",
  };

  return mapping[extensionName] || extensionName;
}

// 5. Runtime spec completeness
async function validateRuntimeSpec(manifest: Manifest): Promise<void> {
  console.log(); // Empty line for spacing
  logger.info("[RUNTIME SPEC VALIDATION]");

  const toolExtensions = manifest.entries.filter((e) => e.kind === "tool");

  for (const entry of toolExtensions) {
    if (!entry.runtime) {
      warn(`Tool '${entry.name}' (kind="tool") is missing 'runtime' object`);
    }
  }
}

// 6. Dependency validation
function validateDependencies(manifest: Manifest): void {
  console.log(); // Empty line for spacing
  logger.info("[DEPENDENCY VALIDATION]");

  const extensionNames = new Set(manifest.entries.map((e) => e.name));

  for (const entry of manifest.entries) {
    if (entry.dependencies) {
      for (const dep of entry.dependencies) {
        if (!extensionNames.has(dep)) {
          error(
            `Extension '${entry.name}' has dependency on '${dep}' which does NOT exist in manifest`
          );
        }
      }
    }
  }
}

// 7. GitHub release entry validation
function validateGithubReleaseEntries(manifest: Manifest): void {
  console.log(); // Empty line for spacing
  logger.info("[GITHUB RELEASE VALIDATION]");

  const githubReleaseEntries = manifest.entries.filter(
    (e) => e.install_via === "github-release" && e.enabled !== false
  );

  if (githubReleaseEntries.length === 0) {
    console.log("  No enabled GitHub release entries to validate");
    return;
  }

  for (const entry of githubReleaseEntries) {
    // Check required fields
    if (!entry.githubRepo) {
      error(`GitHub release entry '${entry.name}' is missing required 'githubRepo' field`);
    }
    if (!entry.githubReleaseTag) {
      error(`GitHub release entry '${entry.name}' is missing required 'githubReleaseTag' field`);
    }
    if (!entry.githubAssetPattern) {
      error(`GitHub release entry '${entry.name}' is missing required 'githubAssetPattern' field`);
    }
    if (!entry.soFileName) {
      error(`GitHub release entry '${entry.name}' is missing required 'soFileName' field`);
    }

    // Validate githubRepo format (owner/repo)
    if (entry.githubRepo && !/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(entry.githubRepo)) {
      error(
        `GitHub release entry '${entry.name}' has invalid githubRepo format: '${entry.githubRepo}'. Expected: owner/repo`
      );
    }

    // Validate soFileName format
    if (entry.soFileName && !/^[a-z0-9_-]+\.so$/i.test(entry.soFileName)) {
      error(
        `GitHub release entry '${entry.name}' has invalid soFileName: '${entry.soFileName}'. Expected: name.so`
      );
    }

    // Validate asset pattern has required placeholders
    if (entry.githubAssetPattern) {
      const hasVersion =
        entry.githubAssetPattern.includes("{version}") ||
        entry.githubAssetPattern.includes(entry.githubReleaseTag || "");
      const hasArch = entry.githubAssetPattern.includes("{arch}");

      if (!hasArch) {
        warn(
          `GitHub release entry '${entry.name}' asset pattern may not support multi-arch (missing {arch} placeholder)`
        );
      }
      if (!hasVersion) {
        warn(
          `GitHub release entry '${entry.name}' asset pattern may not include version information`
        );
      }
    }
  }

  console.log(`  Validated ${githubReleaseEntries.length} GitHub release entries`);
}

// Main validation
async function main(): Promise<void> {
  logger.separator();
  console.log("  MANIFEST VALIDATION");
  logger.separator();

  try {
    const manifest = await readManifest();

    // Run all validations
    const counts = deriveCounts(manifest);
    await validateDefaultEnable(manifest);
    await validateSharedPreloadLibraries(manifest);
    await validatePgdgConsistency(manifest);
    await validateRuntimeSpec(manifest);
    validateDependencies(manifest);
    validateGithubReleaseEntries(manifest);

    // Store counts for success message
    const manifestCounts = counts;

    // Print results
    console.log();
    logger.separator();
    console.log("  VALIDATION RESULTS");
    logger.separator();

    if (errors.length > 0) {
      console.log();
      logger.error(`ERRORS (${errors.length}):`);
      errors.forEach((err, i) => console.log(`  ${i + 1}. ${err}`));
    }

    if (warnings.length > 0) {
      console.log();
      logger.warning(`WARNINGS (${warnings.length}):`);
      warnings.forEach((warn, i) => console.log(`  ${i + 1}. ${warn}`));
    }

    if (errors.length === 0 && warnings.length === 0) {
      console.log();
      logger.success(
        `Manifest validation passed (${manifestCounts.total} extensions: ` +
          `${manifestCounts.builtin} builtin + ${manifestCounts.pgdg} PGDG + ${manifestCounts.percona} Percona + ` +
          `${manifestCounts.timescale} Timescale + ${manifestCounts.githubRelease} GitHub + ${manifestCounts.compiled} compiled, ` +
          `${manifestCounts.enabled} enabled)`
      );
      process.exit(0);
    } else if (errors.length === 0) {
      console.log();
      logger.success(`Manifest validation passed with ${warnings.length} warning(s)`);
      process.exit(0);
    } else {
      console.log();
      logger.error(`Manifest validation failed with ${errors.length} error(s)`);
      process.exit(1);
    }
  } catch (err) {
    logger.error(`FATAL ERROR: ${err}`);
    process.exit(1);
  }
}

main();
