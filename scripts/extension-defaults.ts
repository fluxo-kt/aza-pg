/**
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
    hll: string;
    http: string;
    hypopg: string;
    partman: string;
    pgaudit: string;
    pgcron: string;
    pgrouting: string;
    pgvector: string;
    plpgsqlCheck: string;
    postgis: string;
    repack: string;
    rum: string;
    setUser: string;
  };
}

/**
 * Default versions for PostgreSQL and extensions
 * Generated from MANIFEST_METADATA and MANIFEST_ENTRIES in manifest-data.ts
 */
export const extensionDefaults: ExtensionDefaults = {
  pgVersion: "18.1",
  baseImageSha: "sha256:38d5c9d522037d8bf0864c9068e4df2f8a60127c6489ab06f98fdeda535560f9",
  pgdgVersions: {
    hll: "2.19-1.pgdg13+1",
    http: "1.7.0-3.pgdg13+1",
    hypopg: "1.4.2-2.pgdg13+1",
    partman: "5.3.1-2.pgdg13+1",
    pgaudit: "18.0-2.pgdg13+1",
    pgcron: "1.6.7-2.pgdg13+1",
    pgrouting: "4.0.0-1.pgdg12+1",
    pgvector: "0.8.1-2.pgdg13+1",
    plpgsqlCheck: "2.8.5-1.pgdg13+1",
    postgis: "3.6.1+dfsg-1.pgdg13+1",
    repack: "1.5.3-1.pgdg13+1",
    rum: "1.3.15-1.pgdg13+1",
    setUser: "4.2.0-1.pgdg13+1",
  },
};

/**
 * Extract just the semantic version (without PGDG suffix)
 * Example: "1.6.7-2.pgdg13+1" → "1.6.7"
 */
export function extractSemanticVersion(fullVersion: string): string {
  const match = fullVersion.match(/^([\d.]+)/);
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
    console.log(`PG_VERSION="${extensionDefaults.pgVersion}"`);
    console.log(`PG_BASE_IMAGE_SHA="${extensionDefaults.baseImageSha}"`);
    console.log(`HLL_VERSION="${extensionDefaults.pgdgVersions.hll}"`);
    console.log(`HTTP_VERSION="${extensionDefaults.pgdgVersions.http}"`);
    console.log(`HYPOPG_VERSION="${extensionDefaults.pgdgVersions.hypopg}"`);
    console.log(`PARTMAN_VERSION="${extensionDefaults.pgdgVersions.partman}"`);
    console.log(`PGAUDIT_VERSION="${extensionDefaults.pgdgVersions.pgaudit}"`);
    console.log(`PGCRON_VERSION="${extensionDefaults.pgdgVersions.pgcron}"`);
    console.log(`PGROUTING_VERSION="${extensionDefaults.pgdgVersions.pgrouting}"`);
    console.log(`PGVECTOR_VERSION="${extensionDefaults.pgdgVersions.pgvector}"`);
    console.log(`PLPGSQL_CHECK_VERSION="${extensionDefaults.pgdgVersions.plpgsqlCheck}"`);
    console.log(`POSTGIS_VERSION="${extensionDefaults.pgdgVersions.postgis}"`);
    console.log(`REPACK_VERSION="${extensionDefaults.pgdgVersions.repack}"`);
    console.log(`RUM_VERSION="${extensionDefaults.pgdgVersions.rum}"`);
    console.log(`SET_USER_VERSION="${extensionDefaults.pgdgVersions.setUser}"`);
  } else {
    console.error(`Unknown format: ${format}`);
    console.error("Usage: bun scripts/extension-defaults.ts [json|shell]");
    process.exit(1);
  }
}
