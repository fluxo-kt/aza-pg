#!/usr/bin/env bun
/**
 * Validate manifest integrity across all mapping files
 *
 * Ensures NAME_TO_KEY and PGDG_MAPPINGS are complete and consistent with manifest-data.ts.
 * This prevents cryptic failures when adding new PGDG extensions without updating mappings.
 *
 * Validates:
 * 1. Every PGDG extension has a NAME_TO_KEY entry
 * 2. Every PGDG extension has a PGDG_MAPPINGS entry
 * 3. No orphan entries in mappings that don't exist in manifest
 * 4. enabledInComprehensiveTest is documented for disabled extensions
 *
 * Run from repository root:
 *   bun scripts/ci/validate-manifest-integrity.ts
 */

import { MANIFEST_ENTRIES } from "../extensions/manifest-data";

// Import NAME_TO_KEY by extracting from generate-extension-defaults.ts
// We inline it here to avoid circular dependencies and make validation self-contained
const NAME_TO_KEY: Record<string, string> = {
  pg_cron: "pgcron",
  pgaudit: "pgaudit",
  vector: "pgvector",
  postgis: "postgis",
  pg_partman: "partman",
  pg_repack: "repack",
  plpgsql_check: "plpgsqlCheck",
  hll: "hll",
  http: "http",
  hypopg: "hypopg",
  pgrouting: "pgrouting",
  rum: "rum",
  set_user: "setUser",
};

// PGDG_MAPPINGS manifestNames - must match generate-dockerfile.ts
const PGDG_MAPPING_NAMES = new Set([
  "pg_repack",
  "hll",
  "postgis",
  "vector",
  "rum",
  "hypopg",
  "http",
  "pg_cron",
  "set_user",
  "pgrouting",
  "pgaudit",
  "plpgsql_check",
  "pg_partman",
]);

interface ValidationError {
  type:
    | "missing_name_to_key"
    | "missing_pgdg_mapping"
    | "orphan_name_to_key"
    | "orphan_pgdg_mapping"
    | "missing_comprehensive_test_doc";
  extension: string;
  message: string;
}

function validateManifestIntegrity(): ValidationError[] {
  const errors: ValidationError[] = [];

  // Get all PGDG extensions from manifest (extensions only, not tools)
  const pgdgExtensions = MANIFEST_ENTRIES.filter(
    (entry) => entry.kind === "extension" && entry.install_via === "pgdg" && entry.pgdgVersion
  );

  const pgdgExtensionNames = new Set(pgdgExtensions.map((e) => e.name));

  // 1. Validate every PGDG extension has NAME_TO_KEY entry
  for (const ext of pgdgExtensions) {
    if (!(ext.name in NAME_TO_KEY)) {
      errors.push({
        type: "missing_name_to_key",
        extension: ext.name,
        message: `PGDG extension "${ext.name}" missing from NAME_TO_KEY in generate-extension-defaults.ts`,
      });
    }
  }

  // 2. Validate every PGDG extension has PGDG_MAPPINGS entry
  for (const ext of pgdgExtensions) {
    if (!PGDG_MAPPING_NAMES.has(ext.name)) {
      errors.push({
        type: "missing_pgdg_mapping",
        extension: ext.name,
        message: `PGDG extension "${ext.name}" missing from PGDG_MAPPINGS in generate-dockerfile.ts`,
      });
    }
  }

  // 3. Validate no orphan NAME_TO_KEY entries
  for (const name of Object.keys(NAME_TO_KEY)) {
    if (!pgdgExtensionNames.has(name)) {
      errors.push({
        type: "orphan_name_to_key",
        extension: name,
        message: `NAME_TO_KEY contains "${name}" but no matching PGDG extension in manifest`,
      });
    }
  }

  // 4. Validate no orphan PGDG_MAPPINGS entries
  for (const name of PGDG_MAPPING_NAMES) {
    if (!pgdgExtensionNames.has(name)) {
      errors.push({
        type: "orphan_pgdg_mapping",
        extension: name,
        message: `PGDG_MAPPINGS contains "${name}" but no matching PGDG extension in manifest`,
      });
    }
  }

  // 5. Validate enabledInComprehensiveTest is documented for disabled extensions
  const disabledExtensions = MANIFEST_ENTRIES.filter(
    (entry) => entry.kind === "extension" && entry.enabled === false
  );

  for (const ext of disabledExtensions) {
    if (ext.enabledInComprehensiveTest === undefined) {
      errors.push({
        type: "missing_comprehensive_test_doc",
        extension: ext.name,
        message: `Disabled extension "${ext.name}" missing enabledInComprehensiveTest property (should be true or false with reason)`,
      });
    }
  }

  return errors;
}

function main(): void {
  console.log("Validating manifest integrity...\n");

  const errors = validateManifestIntegrity();

  // Count PGDG extensions
  const pgdgCount = MANIFEST_ENTRIES.filter(
    (e) => e.kind === "extension" && e.install_via === "pgdg" && e.pgdgVersion
  ).length;

  console.log(`PGDG extensions in manifest: ${pgdgCount}`);
  console.log(`NAME_TO_KEY entries: ${Object.keys(NAME_TO_KEY).length}`);
  console.log(`PGDG_MAPPINGS entries: ${PGDG_MAPPING_NAMES.size}\n`);

  if (errors.length === 0) {
    console.log("✅ Manifest integrity validation PASSED");
    console.log("   - All PGDG extensions have NAME_TO_KEY entries");
    console.log("   - All PGDG extensions have PGDG_MAPPINGS entries");
    console.log("   - No orphan mapping entries");
    console.log("   - All disabled extensions have enabledInComprehensiveTest documented");
    process.exit(0);
  }

  console.error("❌ Manifest integrity validation FAILED\n");

  // Group errors by type
  const byType = new Map<string, ValidationError[]>();
  for (const error of errors) {
    const list = byType.get(error.type) || [];
    list.push(error);
    byType.set(error.type, list);
  }

  for (const [type, typeErrors] of byType) {
    console.error(`\n${type.toUpperCase()} (${typeErrors.length}):`);
    for (const error of typeErrors) {
      console.error(`  - ${error.message}`);
    }
  }

  console.error(`\nTotal errors: ${errors.length}`);
  console.error("\nTo fix:");
  console.error(
    "  1. For missing NAME_TO_KEY: Add entry to scripts/extensions/generate-extension-defaults.ts"
  );
  console.error(
    "  2. For missing PGDG_MAPPINGS: Add entry to scripts/docker/generate-dockerfile.ts"
  );
  console.error("  3. For orphan entries: Remove from the mapping file or add to manifest");
  console.error(
    "  4. For missing comprehensive test doc: Add enabledInComprehensiveTest to manifest entry"
  );

  process.exit(1);
}

main();
