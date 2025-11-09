#!/usr/bin/env bun
/**
 * Manifest validation script
 * Validates extensions.manifest.json against expected counts, consistency rules, and cross-references
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { validateManifest } from "./manifest-schema.js";
import * as logger from "../utils/logger.js";

// Expected counts (from extensions.manifest.json, validated dynamically)
const EXPECTED_COUNTS = {
  total: 38,
  builtin: 6,
  pgdg: 14,
  compiled: 18,
};

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
  notes?: string[];
}

interface ManifestEntry {
  name: string;
  displayName?: string;
  kind: "extension" | "builtin" | "tool";
  install_via?: "pgdg";
  runtime?: RuntimeSpec;
  dependencies?: string[];
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

function readManifest(): Manifest {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`Manifest not found: ${MANIFEST_PATH}`);
  }
  const content = readFileSync(MANIFEST_PATH, "utf-8");
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

function readFile(path: string): string {
  if (!existsSync(path)) {
    throw new Error(`File not found: ${path}`);
  }
  return readFileSync(path, "utf-8");
}

// 1. Count validation
function validateCounts(manifest: Manifest): void {
  const total = manifest.entries.length;
  const builtin = manifest.entries.filter((e) => e.kind === "builtin").length;
  const pgdg = manifest.entries.filter((e) => e.install_via === "pgdg").length;

  // Compiled = extensions built from source (not PGDG, not builtin, and either "extension" or "tool" kind)
  // This excludes builtin extensions since they're not compiled
  const compiled = manifest.entries.filter(
    (e) => e.kind !== "builtin" && e.install_via !== "pgdg"
  ).length;

  logger.info("[COUNT VALIDATION]");
  console.log(`  Total extensions: ${total} (expected: ${EXPECTED_COUNTS.total})`);
  console.log(`  Builtin: ${builtin} (expected: ${EXPECTED_COUNTS.builtin})`);
  console.log(`  PGDG: ${pgdg} (expected: ${EXPECTED_COUNTS.pgdg})`);
  console.log(`  Compiled: ${compiled} (expected: ${EXPECTED_COUNTS.compiled})`);

  if (total !== EXPECTED_COUNTS.total) {
    error(`Total extension count mismatch: got ${total}, expected ${EXPECTED_COUNTS.total}`);
  }
  if (builtin !== EXPECTED_COUNTS.builtin) {
    error(`Builtin extension count mismatch: got ${builtin}, expected ${EXPECTED_COUNTS.builtin}`);
  }
  if (pgdg !== EXPECTED_COUNTS.pgdg) {
    error(`PGDG extension count mismatch: got ${pgdg}, expected ${EXPECTED_COUNTS.pgdg}`);
  }
  if (compiled !== EXPECTED_COUNTS.compiled) {
    error(
      `Compiled extension count mismatch: got ${compiled}, expected ${EXPECTED_COUNTS.compiled}`
    );
  }
}

// 2. defaultEnable consistency
function validateDefaultEnable(manifest: Manifest): void {
  console.log(); // Empty line for spacing
  logger.info("[DEFAULT ENABLE VALIDATION]");

  // Parse 01-extensions.sql for baseline extensions
  const initSql = readFile(INIT_SQL_PATH);
  const baselineExtensions = new Set<string>();

  // Match CREATE EXTENSION lines
  const createExtensionRegex = /CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi;
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
  const entrypoint = readFile(ENTRYPOINT_PATH);
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
      const inPreload = preloadLibraries.has(entry.name);

      // Builtin extensions that don't require CREATE EXTENSION (like plpgsql)
      // are always available, so we don't require them to be in baseline or preload
      const isAlwaysAvailableBuiltin = entry.kind === "builtin" && entry.name === "plpgsql"; // plpgsql is always available in PostgreSQL

      if (!inBaseline && !inPreload && !isAlwaysAvailableBuiltin) {
        error(
          `Extension '${entry.name}' has defaultEnable=true but is NOT in 01-extensions.sql baseline ` +
            `(${Array.from(baselineExtensions).join(", ")}) ` +
            `OR DEFAULT_SHARED_PRELOAD_LIBRARIES (${Array.from(preloadLibraries).join(", ")})`
        );
      }
    }
  }
}

// 3. PGDG consistency
function validatePgdgConsistency(manifest: Manifest): void {
  console.log(); // Empty line for spacing
  logger.info("[PGDG CONSISTENCY VALIDATION]");

  const dockerfile = readFile(DOCKERFILE_PATH);
  const pgdgExtensions = manifest.entries.filter((e) => e.install_via === "pgdg");

  // Extract PGDG package names from Dockerfile
  // Pattern: postgresql-${PG_MAJOR}-<name>=<version>
  const pgdgPackageRegex = /postgresql-\$\{PG_MAJOR\}-(\S+?)=/g;
  const dockerfilePgdgPackages = new Set<string>();

  let match;
  while ((match = pgdgPackageRegex.exec(dockerfile)) !== null) {
    const pkgName = match[1];
    if (pkgName) {
      dockerfilePgdgPackages.add(pkgName.toLowerCase());
    }
  }

  console.log(`  PGDG packages in Dockerfile: ${Array.from(dockerfilePgdgPackages).join(", ")}`);

  for (const entry of pgdgExtensions) {
    // Map extension name to Dockerfile package name
    // Some extensions have different package names (e.g., "vector" -> "pgvector")
    const packageName = getDockerfilePackageName(entry.name);

    if (!dockerfilePgdgPackages.has(packageName.toLowerCase())) {
      error(
        `Extension '${entry.name}' has install_via="pgdg" but is NOT installed in Dockerfile ` +
          `(expected package: postgresql-\${PG_MAJOR}-${packageName})`
      );
    }
  }
}

// Map manifest extension name to Dockerfile package name
function getDockerfilePackageName(extensionName: string): string {
  const mapping: Record<string, string> = {
    vector: "pgvector",
    postgis: "postgis-3",
    pg_partman: "partman",
    plpgsql_check: "plpgsql-check",
    pg_repack: "repack",
    pgrouting: "pgrouting",
    set_user: "set-user",
    pg_cron: "cron",
  };

  return mapping[extensionName] || extensionName;
}

// 4. Runtime spec completeness
function validateRuntimeSpec(manifest: Manifest): void {
  console.log(); // Empty line for spacing
  logger.info("[RUNTIME SPEC VALIDATION]");

  const toolExtensions = manifest.entries.filter((e) => e.kind === "tool");

  for (const entry of toolExtensions) {
    if (!entry.runtime) {
      warn(`Tool '${entry.name}' (kind="tool") is missing 'runtime' object`);
    }
  }
}

// 5. Dependency validation
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

// Main validation
async function main(): Promise<void> {
  logger.separator();
  console.log("  MANIFEST VALIDATION");
  logger.separator();

  try {
    const manifest = readManifest();

    // Run all validations
    validateCounts(manifest);
    validateDefaultEnable(manifest);
    validatePgdgConsistency(manifest);
    validateRuntimeSpec(manifest);
    validateDependencies(manifest);

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
        `Manifest validation passed (${EXPECTED_COUNTS.total} extensions: ` +
          `${EXPECTED_COUNTS.builtin} builtin + ${EXPECTED_COUNTS.pgdg} PGDG + ${EXPECTED_COUNTS.compiled} compiled)`
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
