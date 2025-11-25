#!/usr/bin/env bun
/**
 * Validate PGDG version consistency in manifest-data.ts
 *
 * This script ensures:
 * 1. All extensions with install_via: "pgdg" have a pgdgVersion field
 * 2. pgdgVersion follows the expected Debian package format
 * 3. Semantic version from pgdgVersion matches the source.tag
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
 * Main execution
 */
function main(): void {
  console.log("Validating PGDG versions in manifest-data.ts...\n");

  const result = validatePgdgVersions();

  // Print results
  console.log(`PGDG extensions found: ${result.pgdgExtensionCount}`);
  console.log(`Successfully validated: ${result.validatedCount}`);
  console.log("");

  if (result.warnings.length > 0) {
    console.log("⚠️  Warnings:");
    for (const warning of result.warnings) {
      console.log(`   ${warning.extension}: ${warning.error}`);
      if (warning.details) {
        console.log(`      ${warning.details}`);
      }
    }
    console.log("");
  }

  if (result.errors.length > 0) {
    console.log("❌ Errors:");
    for (const error of result.errors) {
      console.log(`   ${error.extension}: ${error.error}`);
      if (error.details) {
        console.log(`      ${error.details}`);
      }
    }
    console.log("");
    console.log("PGDG version validation FAILED");
    process.exit(1);
  }

  console.log("✅ PGDG version validation PASSED");
}

if (import.meta.main) {
  main();
}

// Export for testing
export { validatePgdgVersions, extractSemanticVersionFromTag, extractSemanticVersionFromPgdg };
