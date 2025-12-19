#!/usr/bin/env bun
/**
 * Validate vendor version consistency in manifest-data.ts
 *
 * This script ensures:
 * PGDG:
 * 1. All extensions with install_via: "pgdg" have a pgdgVersion field
 * 2. pgdgVersion follows the expected Debian package format
 * 3. Semantic version from pgdgVersion matches the source.tag
 *
 * Percona:
 * 1. All extensions with install_via: "percona" have a perconaVersion field
 * 2. perconaVersion follows the expected Debian package format
 * 3. Semantic version from perconaVersion matches the source.tag
 *
 * Timescale:
 * 1. All extensions with install_via: "timescale" have a timescaleVersion field
 * 2. timescaleVersion follows the expected Debian package format
 * 3. Semantic version from timescaleVersion matches the source.tag
 *
 * Usage:
 *   bun scripts/extensions/validate-pgdg-versions.ts
 */

import { MANIFEST_ENTRIES, MANIFEST_METADATA } from "./manifest-data";

/**
 * Extract semantic version from various tag formats
 * Examples:
 *   "v2.8.4" -> "2.8.4"
 *   "2.8.4" -> "2.8.4"
 *   "18.0" -> "18.0"
 *   "REL4_2_0" -> "4.2.0"
 *   "ver_1.5.3" -> "1.5.3"
 *   "v4.0.0" -> "4.0.0"
 *   "release/2.57.0" -> "2.57.0"
 *   "wal2json_2_6" -> "2.6"
 *   "pgflow@0.7.2" -> "0.7.2"
 */
function extractSemanticVersionFromTag(tag: string): string {
  // Handle "v1.2.3" format
  if (tag.startsWith("v") && /^v[\d.]+$/.test(tag)) {
    return tag.slice(1);
  }

  // Handle "REL4_2_0" format (PostgreSQL-style)
  if (tag.startsWith("REL")) {
    const match = tag.match(/REL(\d+)_(\d+)_(\d+)/);
    if (match) {
      return `${match[1]}.${match[2]}.${match[3]}`;
    }
  }

  // Handle "ver_1.5.3" format
  if (tag.startsWith("ver_")) {
    return tag.slice(4);
  }

  // Handle "release/2.57.0" format
  if (tag.startsWith("release/")) {
    return tag.slice(8);
  }

  // Handle "wal2json_2_6" format (underscore-separated)
  const underscoreMatch = tag.match(/[\w]+_([\d]+)_([\d]+)/);
  if (underscoreMatch) {
    return `${underscoreMatch[1]}.${underscoreMatch[2]}`;
  }

  // Handle "pgflow@0.7.2" format
  const atMatch = tag.match(/@([\d.]+)$/);
  if (atMatch?.[1]) {
    return atMatch[1];
  }

  // Already a plain version
  if (/^[\d.]+$/.test(tag)) {
    return tag;
  }

  // Try to extract version from tag with prefix
  const versionMatch = tag.match(/v?([\d.]+)/);
  if (versionMatch?.[1]) {
    return versionMatch[1];
  }

  return tag;
}

/**
 * Extract semantic version from PGDG version string
 * Example: "2.8.4-1.pgdg13+1" -> "2.8.4"
 */
function extractSemanticVersionFromPgdg(pgdgVersion: string): string {
  // Handle versions with +dfsg suffix like "2.23.1+dfsg-1.pgdg13+1"
  const match = pgdgVersion.match(/^([\d.]+)/);
  return match?.[1] ?? pgdgVersion;
}

/**
 * Extract semantic version from Percona version string
 * Examples:
 *   "1:2.3.1-1.trixie" -> "2.3.1"
 *   "1:2.6-2.trixie" -> "2.6"
 */
function extractSemanticVersionFromPercona(perconaVersion: string): string {
  // Strip epoch prefix (1:) if present, then extract version before dash
  const withoutEpoch = perconaVersion.replace(/^\d+:/, "");
  const match = withoutEpoch.match(/^([\d.]+)/);
  return match?.[1] ?? perconaVersion;
}

/**
 * Extract semantic version from Timescale version string
 * Examples:
 *   "2.24.0~debian13-1801" -> "2.24.0"
 *   "1:1.22.0~debian13" -> "1.22.0"
 */
function extractSemanticVersionFromTimescale(timescaleVersion: string): string {
  // Strip epoch prefix (1:) if present, then extract version before tilde
  const withoutEpoch = timescaleVersion.replace(/^\d+:/, "");
  const match = withoutEpoch.match(/^([\d.]+)/);
  return match?.[1] ?? timescaleVersion;
}

interface ValidationError {
  extension: string;
  error: string;
  details?: string;
}

interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
  pgdgExtensionCount: number;
  validatedCount: number;
}

interface PerconaValidationResult {
  valid: boolean;
  errors: ValidationError[];
  perconaExtensionCount: number;
  validatedCount: number;
}

interface TimescaleValidationResult {
  valid: boolean;
  errors: ValidationError[];
  timescaleExtensionCount: number;
  validatedCount: number;
}

/**
 * Validate all PGDG extensions in the manifest
 */
function validatePgdgVersions(): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  let pgdgExtensionCount = 0;
  let validatedCount = 0;

  // PGDG version format: version-build.pgdgNN+N
  // Examples: "1.6.7-2.pgdg13+1", "2.23.1+dfsg-1.pgdg13+1"
  const pgdgVersionPattern = /^[\d.]+(\+\w+)?-\d+\.pgdg\d+\+\d+$/;

  for (const entry of MANIFEST_ENTRIES) {
    if (entry.install_via !== "pgdg") continue;

    pgdgExtensionCount++;

    // Check 1: pgdgVersion must be defined
    if (!entry.pgdgVersion) {
      errors.push({
        extension: entry.name,
        error: "Missing pgdgVersion field",
        details: `Extensions with install_via: "pgdg" MUST have a pgdgVersion field`,
      });
      continue;
    }

    // Check 2: pgdgVersion format
    if (!pgdgVersionPattern.test(entry.pgdgVersion)) {
      errors.push({
        extension: entry.name,
        error: "Invalid pgdgVersion format",
        details: `Got "${entry.pgdgVersion}", expected format like "1.6.7-2.pgdg13+1"`,
      });
      continue;
    }

    // Check 3: Semantic version match with source.tag (only for git sources)
    if (entry.source.type === "git" && "tag" in entry.source) {
      const tagVersion = extractSemanticVersionFromTag(entry.source.tag);
      const pgdgSemanticVersion = extractSemanticVersionFromPgdg(entry.pgdgVersion);

      if (tagVersion !== pgdgSemanticVersion) {
        errors.push({
          extension: entry.name,
          error: "Version mismatch between source.tag and pgdgVersion",
          details: `source.tag "${entry.source.tag}" (semantic: ${tagVersion}) != pgdgVersion "${entry.pgdgVersion}" (semantic: ${pgdgSemanticVersion})`,
        });
        continue;
      }
    }

    validatedCount++;
  }

  // Validate MANIFEST_METADATA
  if (!MANIFEST_METADATA.pgVersion) {
    errors.push({
      extension: "MANIFEST_METADATA",
      error: "Missing pgVersion",
      details: "MANIFEST_METADATA must have a pgVersion field",
    });
  } else if (!/^\d+\.\d+$/.test(MANIFEST_METADATA.pgVersion)) {
    warnings.push({
      extension: "MANIFEST_METADATA",
      error: "Unusual pgVersion format",
      details: `Got "${MANIFEST_METADATA.pgVersion}", expected format like "18.1"`,
    });
  }

  if (!MANIFEST_METADATA.baseImageSha) {
    errors.push({
      extension: "MANIFEST_METADATA",
      error: "Missing baseImageSha",
      details: "MANIFEST_METADATA must have a baseImageSha field",
    });
  } else if (!/^sha256:[a-f0-9]{64}$/.test(MANIFEST_METADATA.baseImageSha)) {
    errors.push({
      extension: "MANIFEST_METADATA",
      error: "Invalid baseImageSha format",
      details: `Got "${MANIFEST_METADATA.baseImageSha}", expected sha256:HASH format`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    pgdgExtensionCount,
    validatedCount,
  };
}

/**
 * Validate all Percona extensions in the manifest
 */
function validatePerconaVersions(): PerconaValidationResult {
  const errors: ValidationError[] = [];
  let perconaExtensionCount = 0;
  let validatedCount = 0;

  // Percona version format: [epoch:]version-build.distro
  // Examples: "1:2.3.1-1.trixie", "1:2.6-2.trixie"
  const perconaVersionPattern = /^(\d+:)?[\d.]+-\d+\.\w+$/;

  for (const entry of MANIFEST_ENTRIES) {
    if (entry.install_via !== "percona") continue;

    perconaExtensionCount++;

    // Check 1: perconaVersion must be defined
    if (!entry.perconaVersion) {
      errors.push({
        extension: entry.name,
        error: "Missing perconaVersion field",
        details: `Extensions with install_via: "percona" MUST have a perconaVersion field`,
      });
      continue;
    }

    // Check 2: perconaVersion format
    if (!perconaVersionPattern.test(entry.perconaVersion)) {
      errors.push({
        extension: entry.name,
        error: "Invalid perconaVersion format",
        details: `Got "${entry.perconaVersion}", expected format like "1:2.3.1-1.trixie"`,
      });
      continue;
    }

    // Check 3: Semantic version match with source.tag (only for git sources)
    if (entry.source.type === "git" && "tag" in entry.source) {
      const tagVersion = extractSemanticVersionFromTag(entry.source.tag);
      const perconaSemanticVersion = extractSemanticVersionFromPercona(entry.perconaVersion);

      if (tagVersion !== perconaSemanticVersion) {
        errors.push({
          extension: entry.name,
          error: "Version mismatch between source.tag and perconaVersion",
          details: `source.tag "${entry.source.tag}" (semantic: ${tagVersion}) != perconaVersion "${entry.perconaVersion}" (semantic: ${perconaSemanticVersion})`,
        });
        continue;
      }
    }

    validatedCount++;
  }

  return {
    valid: errors.length === 0,
    errors,
    perconaExtensionCount,
    validatedCount,
  };
}

/**
 * Validate all Timescale extensions in the manifest
 */
function validateTimescaleVersions(): TimescaleValidationResult {
  const errors: ValidationError[] = [];
  let timescaleExtensionCount = 0;
  let validatedCount = 0;

  // Timescale version format: [epoch:]version~distro[-build]
  // Examples: "2.24.0~debian13-1801", "1:1.22.0~debian13"
  const timescaleVersionPattern = /^(\d+:)?[\d.]+~\w+(-\d+)?$/;

  for (const entry of MANIFEST_ENTRIES) {
    if (entry.install_via !== "timescale") continue;

    timescaleExtensionCount++;

    // Check 1: timescaleVersion must be defined
    if (!entry.timescaleVersion) {
      errors.push({
        extension: entry.name,
        error: "Missing timescaleVersion field",
        details: `Extensions with install_via: "timescale" MUST have a timescaleVersion field`,
      });
      continue;
    }

    // Check 2: timescaleVersion format
    if (!timescaleVersionPattern.test(entry.timescaleVersion)) {
      errors.push({
        extension: entry.name,
        error: "Invalid timescaleVersion format",
        details: `Got "${entry.timescaleVersion}", expected format like "2.24.0~debian13-1801" or "1:1.22.0~debian13"`,
      });
      continue;
    }

    // Check 3: Semantic version match with source.tag (only for git sources)
    if (entry.source.type === "git" && "tag" in entry.source) {
      const tagVersion = extractSemanticVersionFromTag(entry.source.tag);
      const timescaleSemanticVersion = extractSemanticVersionFromTimescale(entry.timescaleVersion);

      if (tagVersion !== timescaleSemanticVersion) {
        errors.push({
          extension: entry.name,
          error: "Version mismatch between source.tag and timescaleVersion",
          details: `source.tag "${entry.source.tag}" (semantic: ${tagVersion}) != timescaleVersion "${entry.timescaleVersion}" (semantic: ${timescaleSemanticVersion})`,
        });
        continue;
      }
    }

    validatedCount++;
  }

  return {
    valid: errors.length === 0,
    errors,
    timescaleExtensionCount,
    validatedCount,
  };
}

/**
 * Main execution
 */
function main(): void {
  console.log("Validating vendor versions in manifest-data.ts...\n");

  // Run all validations
  const pgdgResult = validatePgdgVersions();
  const perconaResult = validatePerconaVersions();
  const timescaleResult = validateTimescaleVersions();

  // Print PGDG results
  console.log("[PGDG Version Validation]");
  console.log(`PGDG extensions found: ${pgdgResult.pgdgExtensionCount}`);
  if (pgdgResult.pgdgExtensionCount > 0) {
    for (const entry of MANIFEST_ENTRIES) {
      if (
        entry.install_via === "pgdg" &&
        entry.pgdgVersion &&
        entry.source.type === "git" &&
        "tag" in entry.source
      ) {
        const tagVersion = extractSemanticVersionFromTag(entry.source.tag);
        const pgdgVersion = extractSemanticVersionFromPgdg(entry.pgdgVersion);
        console.log(`✅ ${entry.name}: ${pgdgVersion} matches tag ${tagVersion}`);
      }
    }
  }
  console.log("");

  // Print Percona results
  console.log("[Percona Version Validation]");
  console.log(`Percona extensions found: ${perconaResult.perconaExtensionCount}`);
  if (perconaResult.perconaExtensionCount > 0) {
    for (const entry of MANIFEST_ENTRIES) {
      if (
        entry.install_via === "percona" &&
        entry.perconaVersion &&
        entry.source.type === "git" &&
        "tag" in entry.source
      ) {
        const tagVersion = extractSemanticVersionFromTag(entry.source.tag);
        const perconaVersion = extractSemanticVersionFromPercona(entry.perconaVersion);
        console.log(`✅ ${entry.name}: ${perconaVersion} matches tag ${tagVersion}`);
      }
    }
  }
  console.log("");

  // Print Timescale results
  console.log("[Timescale Version Validation]");
  console.log(`Timescale extensions found: ${timescaleResult.timescaleExtensionCount}`);
  if (timescaleResult.timescaleExtensionCount > 0) {
    for (const entry of MANIFEST_ENTRIES) {
      if (
        entry.install_via === "timescale" &&
        entry.timescaleVersion &&
        entry.source.type === "git" &&
        "tag" in entry.source
      ) {
        const tagVersion = extractSemanticVersionFromTag(entry.source.tag);
        const timescaleVersion = extractSemanticVersionFromTimescale(entry.timescaleVersion);
        console.log(`✅ ${entry.name}: ${timescaleVersion} matches tag ${tagVersion}`);
      }
    }
  }
  console.log("");

  // Collect all errors and warnings
  const allErrors = [...pgdgResult.errors, ...perconaResult.errors, ...timescaleResult.errors];
  const allWarnings = [...pgdgResult.warnings];

  if (allWarnings.length > 0) {
    console.log("⚠️  Warnings:");
    for (const warning of allWarnings) {
      console.log(`   ${warning.extension}: ${warning.error}`);
      if (warning.details) {
        console.log(`      ${warning.details}`);
      }
    }
    console.log("");
  }

  if (allErrors.length > 0) {
    console.log("❌ Errors:");
    for (const error of allErrors) {
      console.log(`   ${error.extension}: ${error.error}`);
      if (error.details) {
        console.log(`      ${error.details}`);
      }
    }
    console.log("");
    console.log("Vendor version validation FAILED");
    process.exit(1);
  }

  console.log("✅ All vendor version validations PASSED");
  console.log(`   PGDG: ${pgdgResult.validatedCount}/${pgdgResult.pgdgExtensionCount}`);
  console.log(`   Percona: ${perconaResult.validatedCount}/${perconaResult.perconaExtensionCount}`);
  console.log(
    `   Timescale: ${timescaleResult.validatedCount}/${timescaleResult.timescaleExtensionCount}`
  );
}

if (import.meta.main) {
  main();
}

// Export for testing
export {
  validatePgdgVersions,
  validatePerconaVersions,
  validateTimescaleVersions,
  extractSemanticVersionFromTag,
  extractSemanticVersionFromPgdg,
  extractSemanticVersionFromPercona,
  extractSemanticVersionFromTimescale,
};
