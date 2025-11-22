/**
 * Extension Defaults - Single Source of Truth
 *
 * This file defines default versions for PGDG pre-compiled extensions.
 * Used by:
 * - Dockerfile ARG defaults
 * - GitHub workflow inputs
 * - Build scripts
 *
 * When updating versions:
 * 1. Update this file
 * 2. Run `bun run generate` to propagate to Dockerfile
 * 3. Workflow inputs will use these defaults
 */

export interface ExtensionDefaults {
  /** PostgreSQL major version */
  pgVersion: string;
  /** Base image SHA256 digest */
  baseImageSha: string;
  /** PGDG pre-compiled extension versions */
  pgdgVersions: {
    pgcron: string;
    pgaudit: string;
    pgvector: string;
    timescaledb: string;
    postgis: string;
    partman: string;
    repack: string;
    plpgsqlCheck: string;
    hll: string;
    http: string;
    hypopg: string;
    pgrouting: string;
    rum: string;
    setUser: string;
  };
}

/**
 * Default versions for PostgreSQL and extensions
 */
export const extensionDefaults: ExtensionDefaults = {
  pgVersion: "18.1",
  baseImageSha: "sha256:5ec39c188013123927f30a006987c6b0e20f3ef2b54b140dfa96dac6844d883f",
  pgdgVersions: {
    pgcron: "1.6.7-2.pgdg13+1",
    pgaudit: "18.0-2.pgdg13+1",
    pgvector: "0.8.1-2.pgdg13+1",
    timescaledb: "2.23.1+dfsg-1.pgdg13+1",
    postgis: "3.6.1+dfsg-1.pgdg13+1",
    partman: "5.3.1-2.pgdg13+1",
    repack: "1.5.3-1.pgdg13+1",
    plpgsqlCheck: "2.8.3-1.pgdg13+1",
    hll: "2.19-1.pgdg13+1",
    http: "1.7.0-3.pgdg13+1",
    hypopg: "1.4.2-2.pgdg13+1",
    pgrouting: "4.0.0-1.pgdg12+1",
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
    console.log(`PGCRON_VERSION="${extensionDefaults.pgdgVersions.pgcron}"`);
    console.log(`PGAUDIT_VERSION="${extensionDefaults.pgdgVersions.pgaudit}"`);
    console.log(`PGVECTOR_VERSION="${extensionDefaults.pgdgVersions.pgvector}"`);
    console.log(`TIMESCALEDB_VERSION="${extensionDefaults.pgdgVersions.timescaledb}"`);
    console.log(`POSTGIS_VERSION="${extensionDefaults.pgdgVersions.postgis}"`);
    console.log(`PARTMAN_VERSION="${extensionDefaults.pgdgVersions.partman}"`);
    console.log(`REPACK_VERSION="${extensionDefaults.pgdgVersions.repack}"`);
    console.log(`PLPGSQL_CHECK_VERSION="${extensionDefaults.pgdgVersions.plpgsqlCheck}"`);
    console.log(`HLL_VERSION="${extensionDefaults.pgdgVersions.hll}"`);
    console.log(`HTTP_VERSION="${extensionDefaults.pgdgVersions.http}"`);
    console.log(`HYPOPG_VERSION="${extensionDefaults.pgdgVersions.hypopg}"`);
    console.log(`PGROUTING_VERSION="${extensionDefaults.pgdgVersions.pgrouting}"`);
    console.log(`RUM_VERSION="${extensionDefaults.pgdgVersions.rum}"`);
    console.log(`SET_USER_VERSION="${extensionDefaults.pgdgVersions.setUser}"`);
  } else if (format === "dockerfile") {
    console.log(`ARG PG_VERSION=${extensionDefaults.pgVersion}`);
    console.log(`ARG PG_BASE_IMAGE_SHA=${extensionDefaults.baseImageSha}`);
    console.log(`ARG PGCRON_VERSION=${extensionDefaults.pgdgVersions.pgcron}`);
    console.log(`ARG PGAUDIT_VERSION=${extensionDefaults.pgdgVersions.pgaudit}`);
    console.log(`ARG PGVECTOR_VERSION=${extensionDefaults.pgdgVersions.pgvector}`);
    console.log(`ARG TIMESCALEDB_VERSION=${extensionDefaults.pgdgVersions.timescaledb}`);
    console.log(`ARG POSTGIS_VERSION=${extensionDefaults.pgdgVersions.postgis}`);
    console.log(`ARG PARTMAN_VERSION=${extensionDefaults.pgdgVersions.partman}`);
    console.log(`ARG REPACK_VERSION=${extensionDefaults.pgdgVersions.repack}`);
    console.log(`ARG PLPGSQL_CHECK_VERSION=${extensionDefaults.pgdgVersions.plpgsqlCheck}`);
    console.log(`ARG HLL_VERSION=${extensionDefaults.pgdgVersions.hll}`);
    console.log(`ARG HTTP_VERSION=${extensionDefaults.pgdgVersions.http}`);
    console.log(`ARG HYPOPG_VERSION=${extensionDefaults.pgdgVersions.hypopg}`);
    console.log(`ARG PGROUTING_VERSION=${extensionDefaults.pgdgVersions.pgrouting}`);
    console.log(`ARG RUM_VERSION=${extensionDefaults.pgdgVersions.rum}`);
    console.log(`ARG SET_USER_VERSION=${extensionDefaults.pgdgVersions.setUser}`);
  } else {
    console.error(`Unknown format: ${format}`);
    console.error("Usage: bun scripts/extension-defaults.ts [json|shell|dockerfile]");
    process.exit(1);
  }
}
