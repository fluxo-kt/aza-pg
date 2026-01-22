/**
 * Shared PGDG package mappings used across validation and Dockerfile generation.
 *
 * This is the single source of truth for PGDG extension metadata.
 * Any changes here automatically propagate to:
 * - scripts/extensions/validate-pgdg-versions.ts (validation)
 * - scripts/docker/generate-dockerfile.ts (Dockerfile generation)
 */

export interface PgdgMapping {
  /** Extension name as it appears in manifest-data.ts */
  manifestName: string;
  /** PGDG apt package name (e.g., "repack" for postgresql-18-repack) */
  packageName: string;
  /** Dockerfile ARG name for version pinning */
  argName: string;
  /** TypeScript key for accessing version in manifest metadata */
  versionKey: string;
}

/**
 * PGDG package mappings sorted by Docker build cache stability scores.
 *
 * Based on comprehensive analysis: manifest history + upstream repo activity.
 * Stable extensions first create cache layers that survive frequent rebuilds.
 * Analysis: /tmp/combined-stability-ranking.json (2025-11-23)
 *
 * TIER 1 (STABLE - scores 24-46): Install first for foundation cache layers
 * TIER 2 (MODERATE - scores 54-84): Install middle
 * TIER 3 (VOLATILE - scores 102-118): Install LAST to prevent cache invalidation
 */
export const PGDG_MAPPINGS: readonly PgdgMapping[] = [
  // STABLE tier (scores 24-46)
  {
    manifestName: "pg_repack",
    packageName: "repack",
    argName: "REPACK_VERSION",
    versionKey: "repack",
  }, // score 24
  { manifestName: "hll", packageName: "hll", argName: "HLL_VERSION", versionKey: "hll" }, // score 30
  {
    manifestName: "postgis",
    packageName: "postgis-3",
    argName: "POSTGIS_VERSION",
    versionKey: "postgis",
  }, // score 33
  {
    manifestName: "vector",
    packageName: "pgvector",
    argName: "PGVECTOR_VERSION",
    versionKey: "pgvector",
  }, // score 34
  { manifestName: "rum", packageName: "rum", argName: "RUM_VERSION", versionKey: "rum" }, // score 40
  {
    manifestName: "hypopg",
    packageName: "hypopg",
    argName: "HYPOPG_VERSION",
    versionKey: "hypopg",
  }, // score 46

  // MODERATE tier (scores 54-84)
  { manifestName: "http", packageName: "http", argName: "HTTP_VERSION", versionKey: "http" }, // score 54
  { manifestName: "pg_cron", packageName: "cron", argName: "PGCRON_VERSION", versionKey: "pgcron" }, // score 54
  {
    manifestName: "set_user",
    packageName: "set-user",
    argName: "SET_USER_VERSION",
    versionKey: "setUser",
  }, // score 55
  {
    manifestName: "pgrouting",
    packageName: "pgrouting",
    argName: "PGROUTING_VERSION",
    versionKey: "pgrouting",
  }, // score 84

  // VOLATILE tier (scores 102-118): Install LAST to minimize cache invalidation
  {
    manifestName: "pgaudit",
    packageName: "pgaudit",
    argName: "PGAUDIT_VERSION",
    versionKey: "pgaudit",
  }, // score 102
] as const;

/**
 * Simple mapping of manifest names to PGDG apt package names.
 * Derived from PGDG_MAPPINGS for convenience in validation scripts.
 */
export const PACKAGE_NAME_MAP: Readonly<Record<string, string>> = Object.fromEntries(
  PGDG_MAPPINGS.map((m) => [m.manifestName, m.packageName])
);
