#!/usr/bin/env bun
/**
 * Generate extension-defaults.ts from manifest-data.ts
 *
 * This script ensures extension-defaults.ts is always derived from the
 * single source of truth (manifest-data.ts), preventing version drift.
 *
 * Usage:
 *   bun scripts/extensions/generate-extension-defaults.ts
 */

import { join } from "node:path";
import { MANIFEST_ENTRIES, MANIFEST_METADATA } from "./manifest-data";

const REPO_ROOT = join(import.meta.dir, "../..");
const OUTPUT_PATH = join(REPO_ROOT, "scripts/extension-defaults.ts");

/**
 * Mapping from manifest extension name to camelCase key name for ExtensionDefaults interface.
 * This maintains backward compatibility with existing consumers.
 */
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

/**
 * Get PGDG extensions from manifest (only extensions with install_via: "pgdg" AND pgdgVersion)
 * Excludes tools - those use PGDG but are handled separately in Dockerfile generation
 */
function getPgdgExtensions(): Array<{ name: string; key: string; version: string }> {
  const pgdgExtensions: Array<{ name: string; key: string; version: string }> = [];

  for (const entry of MANIFEST_ENTRIES) {
    // Only include extensions (not tools or builtins) with PGDG installation
    if (entry.kind === "extension" && entry.install_via === "pgdg" && entry.pgdgVersion) {
      const key = NAME_TO_KEY[entry.name];
      if (!key) {
        throw new Error(
          `Missing NAME_TO_KEY mapping for PGDG extension: ${entry.name}\n` +
            `Add it to the NAME_TO_KEY object in generate-extension-defaults.ts`
        );
      }
      pgdgExtensions.push({
        name: entry.name,
        key,
        version: entry.pgdgVersion,
      });
    }
  }

  // Sort by key for consistent output
  return pgdgExtensions.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Generate the TypeScript file content
 */
function generateFileContent(): string {
  const pgdgExtensions = getPgdgExtensions();

  // Generate interface properties
  const interfaceProps = pgdgExtensions.map((ext) => `    ${ext.key}: string;`).join("\n");

  // Generate object properties
  const objectProps = pgdgExtensions.map((ext) => `    ${ext.key}: "${ext.version}",`).join("\n");

  // Generate shell export lines with proper SCREAMING_SNAKE_CASE
  const shellExports = pgdgExtensions
    .map((ext) => {
      // Convert camelCase to SCREAMING_SNAKE_CASE properly
      // e.g., "plpgsqlCheck" -> "PLPGSQL_CHECK", "pgcron" -> "PGCRON"
      const envVar = ext.key
        .replace(/([a-z])([A-Z])/g, "$1_$2") // Insert underscore before uppercase
        .toUpperCase();
      return `    console.log(\`${envVar}_VERSION="\${extensionDefaults.pgdgVersions.${ext.key}}"\`);`;
    })
    .join("\n");

  return `/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  AUTO-GENERATED FILE - DO NOT EDIT MANUALLY                               ║
 * ╠═══════════════════════════════════════════════════════════════════════════╣
 * ║  Source: scripts/extensions/manifest-data.ts                              ║
 * ║  Generator: scripts/extensions/generate-extension-defaults.ts             ║
 * ║  To regenerate: bun run generate                                          ║
 * ╠═══════════════════════════════════════════════════════════════════════════╣
 * ║  To update versions, edit manifest-data.ts and run: bun run generate      ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

export interface ExtensionDefaults {
  /** PostgreSQL version (e.g., "18.1") */
  pgVersion: string;
  /** Base image SHA256 digest for reproducible builds */
  baseImageSha: string;
  /** PGDG pre-compiled extension versions */
  pgdgVersions: {
${interfaceProps}
  };
}

/**
 * Default versions for PostgreSQL and extensions
 * Generated from MANIFEST_METADATA and MANIFEST_ENTRIES in manifest-data.ts
 */
export const extensionDefaults: ExtensionDefaults = {
  pgVersion: "${MANIFEST_METADATA.pgVersion}",
  baseImageSha: "${MANIFEST_METADATA.baseImageSha}",
  pgdgVersions: {
${objectProps}
  },
};

/**
 * Extract just the semantic version (without PGDG suffix)
 * Example: "1.6.7-2.pgdg13+1" → "1.6.7"
 */
export function extractSemanticVersion(fullVersion: string): string {
  const match = fullVersion.match(/^([\\d.]+)/);
  return match?.[1] ?? fullVersion;
}

/**
 * Export defaults for CLI usage
 */
if (import.meta.main) {
  const format = Bun.argv[2] || "json";

  if (format === "json") {
    console.log(JSON.stringify(extensionDefaults, null, 2));
  } else if (format === "shell") {
    console.log(\`PG_VERSION="\${extensionDefaults.pgVersion}"\`);
    console.log(\`PG_BASE_IMAGE_SHA="\${extensionDefaults.baseImageSha}"\`);
${shellExports}
  } else {
    console.error(\`Unknown format: \${format}\`);
    console.error("Usage: bun scripts/extension-defaults.ts [json|shell]");
    process.exit(1);
  }
}
`;
}

/**
 * Main execution
 */
async function main(): Promise<void> {
  console.log("Generating extension-defaults.ts from manifest-data.ts...");

  const pgdgExtensions = getPgdgExtensions();
  console.log(`Found ${pgdgExtensions.length} PGDG extensions in manifest`);

  const content = generateFileContent();

  // Write the file
  await Bun.write(OUTPUT_PATH, content);
  console.log(`✓ Generated ${OUTPUT_PATH}`);

  // Format with Prettier
  try {
    await Bun.$`bun run prettier:write ${OUTPUT_PATH}`.quiet();
    console.log("✓ Formatted with Prettier");
  } catch {
    console.log("Note: Could not format with Prettier (non-critical)");
  }

  console.log("✓ extension-defaults.ts generation complete");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Error generating extension-defaults.ts:", err);
    process.exit(1);
  });
}
