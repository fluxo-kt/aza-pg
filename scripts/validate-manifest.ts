#!/usr/bin/env bun
/**
 * Extension Manifest Validator
 *
 * Validates extensions.manifest.json for conflicts and issues:
 * - Checks for pg_stat_monitor and pg_stat_statements dual defaultEnable
 * - Validates manifest structure and schema
 *
 * Usage:
 *   bun scripts/validate-manifest.ts
 *   ALLOW_PG_STAT_MONITOR_DUAL=1 bun scripts/validate-manifest.ts  # Allow dual enable
 */

import { join } from "path";
import { error, info, section, success, warning } from "./utils/logger.ts";

const PROJECT_ROOT = join(import.meta.dir, "..");
const MANIFEST_PATH = join(PROJECT_ROOT, "docker/postgres/extensions.manifest.json");

interface Extension {
  name: string;
  runtime?: {
    sharedPreload?: boolean;
    defaultEnable?: boolean;
  };
  enabled?: boolean;
}

interface Manifest {
  generatedAt: string;
  entries: Extension[];
}

/**
 * Check for conflicting pg_stat extensions
 */
function checkPgStatConflict(manifest: Manifest): boolean {
  const pgStatMonitor = manifest.entries.find((e) => e.name === "pg_stat_monitor");
  const pgStatStatements = manifest.entries.find((e) => e.name === "pg_stat_statements");

  if (!pgStatMonitor || !pgStatStatements) {
    return true; // One or both not present, no conflict possible
  }

  const monitorDefaultEnable = pgStatMonitor.runtime?.defaultEnable === true;
  const statementsDefaultEnable = pgStatStatements.runtime?.defaultEnable === true;

  if (monitorDefaultEnable && statementsDefaultEnable) {
    const allowDual = Bun.env.ALLOW_PG_STAT_MONITOR_DUAL === "1";

    if (allowDual) {
      warning(
        "Both pg_stat_monitor and pg_stat_statements have defaultEnable=true (allowed via ALLOW_PG_STAT_MONITOR_DUAL)"
      );
      info("Note: pg_stat_monitor in PG18 uses pgsm aggregation mode for compatibility");
      return true;
    } else {
      error("CONFLICT: Both pg_stat_monitor and pg_stat_statements have defaultEnable=true");
      error(
        "These extensions conflict in older PostgreSQL versions. While PG18 supports both via pgsm aggregation, only one should be enabled by default."
      );
      error("");
      error("Options:");
      error("  1. Set pg_stat_monitor.runtime.defaultEnable=false (recommended)");
      error("  2. Set pg_stat_statements.runtime.defaultEnable=false");
      error("  3. Set ALLOW_PG_STAT_MONITOR_DUAL=1 to override this check");
      return false;
    }
  }

  return true;
}

/**
 * Validate manifest structure
 */
function validateManifestStructure(manifest: Manifest): boolean {
  let valid = true;

  if (!manifest.generatedAt) {
    error("Manifest missing 'generatedAt' field");
    valid = false;
  }

  if (!Array.isArray(manifest.entries)) {
    error("Manifest missing 'entries' array");
    valid = false;
  }

  // Check each entry has required fields
  for (const entry of manifest.entries) {
    if (!entry.name) {
      error("Extension entry missing 'name' field");
      valid = false;
    }
  }

  return valid;
}

/**
 * Check for duplicate extension names
 */
function checkDuplicateNames(manifest: Manifest): boolean {
  const names = manifest.entries.map((e) => e.name);
  const duplicates = names.filter((name, idx) => names.indexOf(name) !== idx);

  if (duplicates.length > 0) {
    error(`Duplicate extension names found: ${[...new Set(duplicates)].join(", ")}`);
    return false;
  }

  return true;
}

async function main() {
  section("Extension Manifest Validation");

  // Load manifest
  const manifestFile = Bun.file(MANIFEST_PATH);
  if (!(await manifestFile.exists())) {
    error(`Manifest not found at ${MANIFEST_PATH}`);
    process.exit(1);
  }

  let manifest: Manifest;
  try {
    manifest = await manifestFile.json();
    info(`Loaded manifest: ${manifest.entries.length} extensions`);
  } catch (err) {
    error(`Failed to parse manifest JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Run validation checks
  let allValid = true;

  // Structure validation
  if (!validateManifestStructure(manifest)) {
    allValid = false;
  }

  // Duplicate name check
  if (!checkDuplicateNames(manifest)) {
    allValid = false;
  }

  // pg_stat conflict check
  if (!checkPgStatConflict(manifest)) {
    allValid = false;
  }

  console.log("");
  if (allValid) {
    success("All manifest validation checks passed!");
  } else {
    error("Manifest validation failed");
    process.exit(1);
  }
}

main().catch((err) => {
  error(`Validation error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
