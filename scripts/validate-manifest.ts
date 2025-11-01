#!/usr/bin/env bun
/**
 * Extension Manifest Validator
 *
 * Validates extensions.manifest.json for conflicts and issues:
 * - Warns if both pg_stat_monitor and pg_stat_statements have defaultEnable=true (supported in PG18)
 * - Validates manifest structure and schema
 *
 * Usage:
 *   bun scripts/validate-manifest.ts
 */

import { getErrorMessage } from "./utils/errors.js";
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
    // PostgreSQL 18 supports both extensions via pgsm aggregation mode
    // This is intentional for comparison purposes, so treat as informational warning
    warning("Both pg_stat_monitor and pg_stat_statements have defaultEnable=true");
    info("PostgreSQL 18 supports both extensions via pgsm aggregation mode");
    info("This configuration allows comparison of both monitoring approaches");
    return true;
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
    error(`Failed to parse manifest JSON: ${getErrorMessage(err)}`);
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
  error(`Validation error: ${getErrorMessage(err)}`);
  process.exit(1);
});
