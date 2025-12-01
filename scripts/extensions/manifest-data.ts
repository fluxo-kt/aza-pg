/**
 * Canonical catalog of extensions and tools bundled with the aza-pg image.
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS FILE IS THE SINGLE SOURCE OF TRUTH FOR ALL VERSION INFORMATION.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Edit this file to upgrade/downgrade extensions. Run:
 *   bun run generate
 * to refresh all generated files (Dockerfile, extensions.manifest.json, extension-defaults.ts).
 *
 * IMPORTANT: Never edit scripts/extension-defaults.ts directly - it is auto-generated from this file.
 */

/**
 * PostgreSQL base configuration - SINGLE SOURCE OF TRUTH
 * Used by: Dockerfile generation, CI workflows, build scripts
 */
export const MANIFEST_METADATA = {
  /** PostgreSQL version (e.g., "18.1") */
  pgVersion: "18.1",
  /** Base image SHA256 digest for reproducible builds */
  baseImageSha: "sha256:5ec39c188013123927f30a006987c6b0e20f3ef2b54b140dfa96dac6844d883f",
} as const;

export type SourceSpec =
  | { type: "builtin" }
  | { type: "git"; repository: string; tag: string }
  | { type: "git-ref"; repository: string; ref: string };

export type BuildKind =
  | "pgxs"
  | "cargo-pgrx"
  | "timescaledb"
  | "autotools"
  | "cmake"
  | "meson"
  | "make"
  | "script";

export interface BuildSpec {
  type: BuildKind;
  /**
   * Optional relative path inside the repository to build.
   * Defaults to repository root.
   */
  subdir?: string;
  /**
   * When type === "cargo-pgrx", pass-through feature flags.
   */
  features?: string[];
  noDefaultFeatures?: boolean;
  /**
   * Optional script identifier for bespoke installers.
   */
  script?: string;
  /**
   * Optional sed command patterns to apply before building.
   * Each string is a sed expression (e.g., 's/old/new/').
   */
  patches?: string[];
}

export interface RuntimeSpec {
  sharedPreload?: boolean;
  defaultEnable?: boolean;
  preloadOnly?: boolean; // Extension has no .control file, cannot use CREATE EXTENSION
  excludeFromAutoTests?: boolean; // Exclude from automated test suite
  /**
   * If true, enable this shared preload library in regression test mode.
   * Only applicable when sharedPreload: true and defaultEnable: false.
   */
  preloadInComprehensiveTest?: boolean;
  /**
   * Override the library name for shared_preload_libraries.
   * Defaults to extension name if not specified.
   * Example: pg_partman extension uses pg_partman_bgw.so library
   */
  preloadLibraryName?: string;
  notes?: string[];
}

export interface ManifestEntry {
  name: string;
  displayName?: string;
  kind: "extension" | "tool" | "builtin";
  category: string;
  description: string;
  source: SourceSpec;
  build?: BuildSpec;
  runtime?: RuntimeSpec;
  dependencies?: string[];
  provides?: string[];
  aptPackages?: string[];
  notes?: string[];
  install_via?: "pgdg" | "percona" | "source";
  /**
   * Full PGDG Debian package version string for apt-installable extensions.
   * Only applicable when install_via === "pgdg".
   * Example: "2.8.4-1.pgdg13+1" for postgresql-18-plpgsql-check=2.8.4-1.pgdg13+1
   *
   * IMPORTANT: This is the SINGLE SOURCE OF TRUTH for PGDG versions.
   * The semantic version here should match the source.tag (e.g., tag "v2.8.4" → pgdgVersion "2.8.4-...")
   */
  pgdgVersion?: string;
  /**
   * Full Percona Debian package version string for Percona-installable extensions.
   * Only applicable when install_via === "percona".
   * Example: "2.3.1-1.noble" for percona-pg-stat-monitor18=2.3.1-1.noble
   *
   * Note: Percona package naming differs from PGDG (e.g., "percona-pg-stat-monitor18" vs "postgresql-18-...")
   */
  perconaVersion?: string;
  /**
   * Percona package name override. Required when install_via === "percona".
   * The full package name used by apt-get install.
   * Example: "percona-pg-stat-monitor18" or "percona-postgresql-18-wal2json"
   */
  perconaPackage?: string;
  enabled?: boolean;
  /**
   * Enable this extension in regression test mode even if disabled in production.
   * Useful for extensions disabled to reduce build time/size but still valuable to test.
   * Default: false (use `enabled` value in regression mode).
   */
  enabledInComprehensiveTest?: boolean;
  disabledReason?: string;
  /**
   * Direct URL to source code repository (e.g., GitHub, GitLab).
   * For extensions/tools: usually the git repository URL.
   * For builtins: PostgreSQL source tree or official extension page.
   */
  sourceUrl?: string;
  /**
   * URL to external documentation site if separate from repository.
   * Falls back to repository README if not provided.
   */
  docsUrl?: string;
}

export const MANIFEST_ENTRIES: ManifestEntry[] = [
  {
    name: "vector",
    displayName: "pgvector",
    kind: "extension",
    install_via: "pgdg",
    pgdgVersion: "0.8.1-2.pgdg13+1",
    category: "ai",
    description: "Vector similarity search with IVF/HNSW indexes and distance operators.",
    source: {
      type: "git",
      repository: "https://github.com/pgvector/pgvector.git",
      tag: "v0.8.1",
    },
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: false,
      defaultEnable: true,
      excludeFromAutoTests: false,
      notes: [
        "PGDG: postgresql-18-pgvector (v0.8.1-2.pgdg13+1)",
        "Alt: Pigsty v0.8.0 (1 patch behind)",
        "Regression test coverage includes vector columns, HNSW indexing, and similarity search",
      ],
    },
    sourceUrl: "https://github.com/pgvector/pgvector",
    docsUrl: "https://github.com/pgvector/pgvector#readme",
  },
  {
    name: "pg_cron",
    kind: "extension",
    install_via: "pgdg",
    pgdgVersion: "1.6.7-2.pgdg13+1",
    category: "operations",
    description: "Lightweight cron-based job runner inside PostgreSQL.",
    source: {
      type: "git",
      repository: "https://github.com/citusdata/pg_cron.git",
      tag: "v1.6.7",
    },
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: true,
      defaultEnable: true,
      excludeFromAutoTests: false,
      notes: [
        "PGDG: postgresql-18-cron (v1.6.7-2.pgdg13+1)",
        "Alt: Pigsty v1.6.7 (same version)",
        "Preloaded by default - background worker scheduling enabled",
        "Job scheduling tested in functional test suite",
      ],
    },
    sourceUrl: "https://github.com/citusdata/pg_cron",
    docsUrl: "https://github.com/citusdata/pg_cron#readme",
  },
  {
    name: "pgaudit",
    kind: "extension",
    install_via: "pgdg",
    pgdgVersion: "18.0-2.pgdg13+1",
    category: "security",
    description: "Detailed auditing for DDL/DML activity with class-level granularity.",
    source: {
      type: "git",
      repository: "https://github.com/pgaudit/pgaudit.git",
      tag: "18.0",
    },
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: true,
      defaultEnable: true,
      notes: [
        "PGDG: postgresql-18-pgaudit (v18.0-2.pgdg13+1)",
        "Alt: Pigsty v18.0 (same version)",
        "Tune pgaudit.log to control verbosity.",
      ],
    },
    sourceUrl: "https://github.com/pgaudit/pgaudit",
    docsUrl: "https://www.pgaudit.org",
  },
  {
    name: "pg_stat_statements",
    kind: "builtin",
    category: "observability",
    description: "Tracks execution statistics for normalized SQL statements.",
    source: { type: "builtin" },
    runtime: {
      sharedPreload: true,
      defaultEnable: true,
      notes: ["PostgreSQL 18 contrib module"],
    },
    sourceUrl: "https://www.postgresql.org/docs/18/pgstatstatements.html",
    docsUrl: "https://www.postgresql.org/docs/18/pgstatstatements.html",
  },
  {
    name: "auto_explain",
    kind: "builtin",
    category: "observability",
    description: "Logs plans for slow statements automatically.",
    source: { type: "builtin" },
    runtime: {
      sharedPreload: true,
      defaultEnable: true,
      preloadOnly: true,
      notes: ["PostgreSQL 18 contrib module"],
    },
    sourceUrl: "https://www.postgresql.org/docs/18/auto-explain.html",
    docsUrl: "https://www.postgresql.org/docs/18/auto-explain.html",
  },
  {
    name: "pg_trgm",
    kind: "builtin",
    category: "search",
    description: "Trigram-based fuzzy matching indexes.",
    source: { type: "builtin" },
    runtime: {
      sharedPreload: false,
      defaultEnable: true,
      notes: ["PostgreSQL 18 contrib module"],
    },
    sourceUrl: "https://www.postgresql.org/docs/18/pgtrgm.html",
    docsUrl: "https://www.postgresql.org/docs/18/pgtrgm.html",
  },
  {
    name: "btree_gin",
    kind: "builtin",
    category: "indexing",
    description: "Adds B-tree emulation operator classes for GIN indexes.",
    source: { type: "builtin" },
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: ["PostgreSQL 18 contrib module"],
    },
    sourceUrl: "https://www.postgresql.org/docs/18/btree-gin.html",
    docsUrl: "https://www.postgresql.org/docs/18/btree-gin.html",
  },
  {
    name: "btree_gist",
    kind: "builtin",
    category: "indexing",
    description: "Adds B-tree emulation operator classes for GiST indexes.",
    source: { type: "builtin" },
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: ["PostgreSQL 18 contrib module"],
    },
    sourceUrl: "https://www.postgresql.org/docs/18/btree-gist.html",
    docsUrl: "https://www.postgresql.org/docs/18/btree-gist.html",
  },
  {
    name: "plpgsql",
    kind: "builtin",
    category: "language",
    description: "Built-in procedural language for PostgreSQL.",
    source: { type: "builtin" },
    runtime: {
      sharedPreload: false,
      defaultEnable: true,
      notes: ["PostgreSQL 18 contrib module"],
    },
    sourceUrl: "https://www.postgresql.org/docs/18/plpgsql.html",
    docsUrl: "https://www.postgresql.org/docs/18/plpgsql.html",
  },
  {
    name: "hypopg",
    kind: "extension",
    install_via: "pgdg",
    pgdgVersion: "1.4.2-2.pgdg13+1",
    category: "performance",
    description: "Simulate hypothetical indexes for planner what-if analysis.",
    source: {
      type: "git",
      repository: "https://github.com/HypoPG/hypopg.git",
      tag: "1.4.2",
    },
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: [
        "PGDG: postgresql-18-hypopg (v1.4.2-2.pgdg13+1)",
        "Alt: Pigsty v1.4.2 (same version)",
      ],
    },
    sourceUrl: "https://github.com/HypoPG/hypopg",
    docsUrl: "https://hypopg.readthedocs.io",
  },
  {
    name: "index_advisor",
    kind: "extension",
    category: "performance",
    description: "Suggest indexes by pairing HypoPG simulations with cost heuristics.",
    source: {
      type: "git",
      repository: "https://github.com/supabase/index_advisor.git",
      tag: "v0.2.0",
    },
    build: { type: "pgxs" },
    dependencies: ["hypopg"],
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: ["NOT in PGDG or Pigsty (Supabase-specific extension)", "Source build required"],
    },
    sourceUrl: "https://github.com/supabase/index_advisor",
    docsUrl: "https://supabase.com/docs/guides/database/extensions/index_advisor",
  },
  {
    name: "plpgsql_check",
    kind: "extension",
    install_via: "pgdg",
    pgdgVersion: "2.8.4-1.pgdg13+1",
    category: "quality",
    description: "Static analyzer for PL/pgSQL functions and triggers.",
    source: {
      type: "git",
      repository: "https://github.com/okbob/plpgsql_check.git",
      tag: "v2.8.4",
    },
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: [
        "PGDG: postgresql-18-plpgsql-check (v2.8.4-1.pgdg13+1)",
        "Alt: Pigsty v2.8.4 (same version)",
      ],
    },
    sourceUrl: "https://github.com/okbob/plpgsql_check",
    docsUrl: "https://github.com/okbob/plpgsql_check#readme",
  },
  {
    name: "pg_safeupdate",
    kind: "tool",
    category: "safety",
    description: "Guards UPDATE/DELETE without WHERE clause or LIMIT.",
    source: {
      type: "git",
      repository: "https://github.com/eradman/pg-safeupdate.git",
      tag: "1.5",
    },
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: true,
      defaultEnable: true,
      preloadInComprehensiveTest: true,
      preloadLibraryName: "safeupdate",
      notes: [
        "NOT in PGDG. Alt: Pigsty v1.5 (same version)",
        "Requires shared_preload_libraries to intercept UPDATE/DELETE queries.",
      ],
    },
    sourceUrl: "https://github.com/eradman/pg-safeupdate",
    docsUrl: "https://github.com/eradman/pg-safeupdate#readme",
  },
  {
    name: "supautils",
    enabled: false,
    enabledInComprehensiveTest: false, // Build fails due to unresolved patch issues
    disabledReason:
      "Compilation requires patching for PG18 compatibility. Patch application system unable to apply sed-style patches reliably in Docker build environment despite multiple pattern attempts (POSIX [[:space:]], JS \\s+, literal space+). Issue requires investigation of patch application mechanism or upstream fix.",
    kind: "extension",
    category: "safety",
    description: "Shared superuser guards and hooks for managed Postgres environments.",
    source: {
      type: "git",
      repository: "https://github.com/supabase/supautils.git",
      tag: "v3.0.2",
    },
    build: {
      type: "pgxs",
      // Patch pattern works in isolation but fails to apply in Docker build
      // Attempted patterns: [[:space:]], \\s+, space+ - all failed
      // Root issue: applySedPatch() returns false (no match) despite correct pattern
      patches: ["s/bool +log_skipped_evtrigs/static bool log_skipped_evtrigs/"],
    },
    runtime: {
      sharedPreload: true,
      preloadOnly: true,
      defaultEnable: false,
      notes: ["Creates supabase-managed roles which expect pg_cron and pg_net to be present."],
    },
    sourceUrl: "https://github.com/supabase/supautils",
    docsUrl: "https://github.com/supabase/supautils#readme",
  },
  {
    name: "http",
    displayName: "pgsql-http",
    kind: "extension",
    install_via: "pgdg",
    pgdgVersion: "1.7.0-3.pgdg13+1",
    category: "integration",
    description: "Synchronous HTTP client for PostgreSQL built on libcurl.",
    source: {
      type: "git",
      repository: "https://github.com/pramsey/pgsql-http.git",
      tag: "v1.7.0",
    },
    build: { type: "pgxs" },
    aptPackages: ["libcurl4-openssl-dev", "libjson-c-dev"],
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: ["PGDG: postgresql-18-http (v1.7.0-3.pgdg13+1)", "Alt: Pigsty v1.7.0 (same version)"],
    },
    sourceUrl: "https://github.com/pramsey/pgsql-http",
    docsUrl: "https://github.com/pramsey/pgsql-http#readme",
  },
  {
    name: "pg_net",
    kind: "extension",
    category: "integration",
    description: "Async HTTP/HTTPS requests from PostgreSQL for webhooks and API calls.",
    source: {
      type: "git",
      repository: "https://github.com/supabase/pg_net.git",
      tag: "v0.20.2",
    },
    build: { type: "pgxs" },
    aptPackages: ["libcurl4-openssl-dev"],
    runtime: {
      sharedPreload: true,
      defaultEnable: false,
      preloadInComprehensiveTest: true,
      notes: [
        "NOT in PGDG (Supabase-specific). Source build required.",
        "Requires shared_preload_libraries for background worker",
        "Powers async HTTP webhooks from triggers",
        "Use net.http_post() for outbound API calls",
      ],
    },
    sourceUrl: "https://github.com/supabase/pg_net",
    docsUrl: "https://supabase.github.io/pg_net/",
  },
  {
    name: "wrappers",
    displayName: "supabase-wrappers",
    kind: "extension",
    category: "integration",
    description: "Rust FDW framework powering Supabase foreign wrappers.",
    source: {
      type: "git",
      repository: "https://github.com/supabase/wrappers.git",
      tag: "v0.5.7",
    },
    build: {
      type: "cargo-pgrx",
      features: ["pg18"],
      noDefaultFeatures: true,
      subdir: "wrappers",
    },
    aptPackages: ["clang", "llvm", "pkg-config", "make"],
    dependencies: ["pg_stat_statements"],
    runtime: { sharedPreload: false, defaultEnable: false },
    notes: [
      "Requires cargo-pgrx 0.16.1 aligned with PG18.",
      "v0.5.7: MotherDuck FDW, ClickHouse stream_buffer_size, Iceberg batch_size, S3 vectors embd→s3vec rename.",
      "NOT available in PGDG. Pigsty has v0.5.0 (2 versions behind). Building from source for latest.",
    ],
    sourceUrl: "https://github.com/supabase/wrappers",
    docsUrl: "https://supabase.com/docs/guides/database/extensions/wrappers/overview",
  },
  {
    name: "pgroonga",
    kind: "extension",
    category: "search",
    description: "Full-text search powered by Groonga for multilingual workloads.",
    source: {
      type: "git",
      repository: "https://github.com/pgroonga/pgroonga.git",
      tag: "4.0.4",
    },
    build: { type: "pgxs" },
    aptPackages: [
      "cmake",
      "ninja-build",
      "pkg-config",
      "libgroonga-dev",
      "liblz4-dev",
      "libmecab-dev",
      "libmsgpack-dev",
    ],
    runtime: { sharedPreload: false, defaultEnable: false },
    notes: [
      "NOT available in PGDG for PostgreSQL 18",
      "Alt: Pigsty v4.0.0 - PG13-17 only, NO PG18 packages",
      "Source build required for PG18",
    ],
    sourceUrl: "https://github.com/pgroonga/pgroonga",
    docsUrl: "https://pgroonga.github.io",
  },
  {
    name: "rum",
    kind: "extension",
    install_via: "pgdg",
    pgdgVersion: "1.3.15-1.pgdg13+1",
    category: "search",
    description: "RUM GiST access method for ranked full-text search.",
    source: {
      type: "git",
      repository: "https://github.com/postgrespro/rum.git",
      tag: "1.3.15",
    },
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: ["PGDG: postgresql-18-rum (v1.3.15-1.pgdg13+1)", "Alt: Pigsty v1.3.15 (same version)"],
    },
    sourceUrl: "https://github.com/postgrespro/rum",
    docsUrl: "https://github.com/postgrespro/rum#readme",
  },
  {
    name: "postgis",
    kind: "extension",
    install_via: "pgdg",
    pgdgVersion: "3.6.1+dfsg-1.pgdg13+1",
    category: "gis",
    description: "Spatial types, functions, raster, and topology for PostgreSQL.",
    enabled: false,
    enabledInComprehensiveTest: true,
    disabledReason:
      "Disabled to reduce build time and image size. GIS functionality not currently required. Enable when spatial data support is needed.",
    source: {
      type: "git",
      repository: "https://github.com/postgis/postgis.git",
      tag: "3.6.1",
    },
    build: { type: "autotools" },
    aptPackages: [
      "autoconf",
      "automake",
      "libtool",
      "g++",
      "libgeos-dev",
      "libproj-dev",
      "libjson-c-dev",
      "libprotobuf-c-dev",
      "protobuf-c-compiler",
      "libxml2-dev",
      "libgdal-dev",
      "liblz4-dev",
      "libzstd-dev",
      "bison",
      "flex",
    ],
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: [
        "PGDG: postgresql-18-postgis-3 (v3.6.1+dfsg-1.pgdg13+1)",
        "Alt: Pigsty v3.6.1 (same version)",
      ],
    },
    sourceUrl: "https://github.com/postgis/postgis",
    docsUrl: "https://postgis.net/documentation",
  },
  {
    name: "pgrouting",
    kind: "extension",
    install_via: "pgdg",
    pgdgVersion: "4.0.0-1.pgdg12+1",
    category: "gis",
    description: "Routing algorithms (Dijkstra, A*, TSP) on top of PostGIS graphs.",
    enabled: false,
    enabledInComprehensiveTest: true,
    disabledReason:
      "Disabled to reduce build time and image size. Depends on PostGIS which is also disabled. Enable when routing functionality is needed.",
    source: {
      type: "git",
      repository: "https://github.com/pgRouting/pgrouting.git",
      tag: "v4.0.0",
    },
    build: { type: "cmake" },
    dependencies: ["postgis"],
    aptPackages: ["cmake", "libboost-graph-dev"],
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: [
        "PGDG: postgresql-18-pgrouting (v4.0.0-1.pgdg12+1)",
        "Alt: Pigsty v4.0.0 (same version)",
      ],
    },
    sourceUrl: "https://github.com/pgRouting/pgrouting",
    docsUrl: "https://docs.pgrouting.org",
  },
  {
    name: "pgsodium",
    kind: "extension",
    category: "security",
    description: "Modern cryptography and envelope encryption with libsodium.",
    source: {
      type: "git",
      repository: "https://github.com/michelp/pgsodium.git",
      tag: "v3.1.9",
    },
    build: { type: "pgxs" },
    aptPackages: ["libsodium-dev"],
    runtime: {
      sharedPreload: true,
      defaultEnable: false,
      preloadInComprehensiveTest: true,
      notes: [
        "NOT in PGDG. Alt: Pigsty v3.1.9 (same version)",
        "Optional preload module - enable via POSTGRES_SHARED_PRELOAD_LIBRARIES",
        "Preloading required for event triggers to work (registers pgsodium.enable_event_trigger GUC)",
        "Full Transparent Column Encryption (TCE) requires pgsodium_getkey script",
        "Basic cryptography functions work without preload or getkey script",
      ],
    },
    sourceUrl: "https://github.com/michelp/pgsodium",
    docsUrl: "https://michelp.github.io/pgsodium",
  },
  {
    name: "supabase_vault",
    displayName: "vault",
    kind: "extension",
    category: "security",
    description: "Supabase secret store for encrypted application credentials.",
    source: {
      type: "git",
      repository: "https://github.com/supabase/vault.git",
      tag: "v0.3.1",
    },
    build: { type: "pgxs" },
    dependencies: ["pgsodium"],
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: [
        "NOT in PGDG (Supabase-specific). Alt: Pigsty v0.3.1 (same version)",
        "Source build required",
      ],
    },
    sourceUrl: "https://github.com/supabase/vault",
    docsUrl: "https://supabase.com/docs/guides/database/vault",
  },
  {
    name: "pg_jsonschema",
    kind: "extension",
    category: "validation",
    description: "JSON Schema validation for JSONB documents on INSERT/UPDATE.",
    source: {
      type: "git-ref",
      repository: "https://github.com/supabase/pg_jsonschema.git",
      ref: "5492c7d1a28c5a2c85b48f89c47f258acc93d241",
    },
    build: {
      type: "cargo-pgrx",
      features: ["pg18"],
      noDefaultFeatures: true,
    },
    aptPackages: ["clang", "llvm", "pkg-config", "make"],
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: [
        "NOT in PGDG (Rust pgrx extension). Alt: Pigsty v0.3.3 (older)",
        "Source build required for latest features",
      ],
    },
    sourceUrl: "https://github.com/supabase/pg_jsonschema",
    docsUrl: "https://supabase.com/docs/guides/database/extensions/pg_jsonschema",
  },
  {
    name: "pg_hashids",
    kind: "extension",
    category: "utilities",
    description: "Encode integers into short hashids for obfuscated identifiers.",
    source: {
      type: "git-ref",
      repository: "https://github.com/iCyberon/pg_hashids.git",
      ref: "8c404dd86408f3a987a3ff6825ac7e42bd618b98",
    },
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: [
        "NOT in PGDG. Pigsty has v1.2.1 only (no PG18 packages)",
        "Using v1.3 from master (unreleased, no git tag)",
        "Source build required",
      ],
    },
    sourceUrl: "https://github.com/iCyberon/pg_hashids",
    docsUrl: "https://github.com/iCyberon/pg_hashids#readme",
  },
  {
    name: "pgmq",
    kind: "extension",
    category: "queueing",
    description: "Lightweight message queue for Postgres leveraging LISTEN/NOTIFY.",
    source: {
      type: "git",
      repository: "https://github.com/tembo-io/pgmq.git",
      tag: "v1.8.0",
    },
    build: { type: "pgxs", subdir: "pgmq-extension" },
    runtime: {
      sharedPreload: false,
      defaultEnable: true,
      notes: [
        "NOT in PGDG. Alt: Pigsty v1.5.1 (3 minor versions behind)",
        "Source build for latest v1.8.0 with PG18 support",
      ],
    },
    sourceUrl: "https://github.com/pgmq/pgmq",
    docsUrl: "https://github.com/pgmq/pgmq#readme",
  },
  {
    name: "pgflow",
    displayName: "pgflow",
    kind: "extension",
    category: "workflow",
    description: "DAG-based workflow orchestration engine. Per-project installation required.",
    enabled: false,
    enabledInComprehensiveTest: false, // SQL-only schema, per-project installation
    disabledReason: "Per-project installation - see docs/PGFLOW.md for instructions",
    source: {
      type: "git",
      repository: "https://github.com/pgflow-dev/pgflow.git",
      tag: "pgflow@0.9.0",
    },
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      preloadOnly: true, // SQL-only schema, no .control file
      notes: [
        "NOT bundled in image - install per-project",
        "Requires pgmq 1.5.0+ (included in image)",
        "See docs/PGFLOW.md for installation",
        "v0.9.0 includes broadcast fixes, pgmq 1.5.1 compatibility, empty map handling",
      ],
    },
    dependencies: ["pgmq"],
    notes: [
      "SQL-only schema - no compiled components",
      "Use @pgflow/dsl and @pgflow/client npm packages",
      "Multi-project: Use separate databases for isolation",
      "Schema available in tests/fixtures/pgflow/ for testing",
    ],
    sourceUrl: "https://github.com/pgflow-dev/pgflow",
    docsUrl: "https://pgflow.dev",
  },
  {
    name: "pgq",
    displayName: "PgQ",
    kind: "extension",
    category: "queueing",
    description:
      "Generic high-performance lockless queue with simple SQL function API (supports PostgreSQL 10-18).",
    enabled: false,
    enabledInComprehensiveTest: true,
    disabledReason:
      "Disabled by default to reduce image size and build time (~2-3 minutes). Enable if queue functionality needed.",
    source: {
      type: "git",
      repository: "https://github.com/pgq/pgq.git",
      tag: "v3.5.1",
    },
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: [
        "NOT in PGDG. Alt: Pigsty v3.5.1 (same version)",
        "Pure PLpgSQL extension with no external dependencies",
        "Installs into pg_catalog schema (non-relocatable)",
      ],
    },
    sourceUrl: "https://github.com/pgq/pgq",
    docsUrl: "https://wiki.postgresql.org/wiki/PGQ_Tutorial",
  },
  {
    name: "pg_repack",
    kind: "extension",
    install_via: "pgdg",
    pgdgVersion: "1.5.3-1.pgdg13+1",
    category: "maintenance",
    description: "Online table/index reorganization without long locks.",
    source: {
      type: "git",
      repository: "https://github.com/reorg/pg_repack.git",
      tag: "ver_1.5.3",
    },
    build: { type: "pgxs" },
    aptPackages: ["libreadline-dev", "libnuma-dev", "libzstd-dev"],
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: [
        "PGDG: postgresql-18-repack (v1.5.3-1.pgdg13+1)",
        "Alt: Pigsty v1.5.3 (same version)",
      ],
    },
    sourceUrl: "https://github.com/reorg/pg_repack",
    docsUrl: "https://reorg.github.io/pg_repack",
  },
  {
    name: "pg_stat_monitor",
    kind: "extension",
    category: "observability",
    description: "Enhanced query performance telemetry with bucketed metrics.",
    source: {
      type: "git",
      repository: "https://github.com/percona/pg_stat_monitor.git",
      tag: "2.3.1",
    },
    install_via: "percona",
    perconaPackage: "percona-pg-stat-monitor18",
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: true,
      defaultEnable: true,
      notes: [
        "NOT in PGDG. Installed via Percona ppg-18 repository (v2.3.1)",
        "Mutually exclusive with pg_stat_statements in older versions—keep both enabled in PG18 using monitor's pgsm aggregation.",
      ],
    },
    sourceUrl: "https://github.com/percona/pg_stat_monitor",
    docsUrl: "https://docs.percona.com/pg-stat-monitor",
  },
  {
    name: "pg_plan_filter",
    kind: "tool",
    category: "safety",
    description: "Block high-cost plans or disallowed operations using planner hooks.",
    enabled: false,
    disabledReason:
      "Not compatible with PostgreSQL 18. Last updated for PG13 (2021). Maintainer inactive. Enable when updated upstream.",
    source: {
      type: "git-ref",
      repository: "https://github.com/pgexperts/pg_plan_filter.git",
      ref: "5081a7b5cb890876e67d8e7486b6a64c38c9a492",
    },
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: true,
      defaultEnable: false,
      notes: ["NOT in PGDG. Source build required."],
    },
    sourceUrl: "https://github.com/pgexperts/pg_plan_filter",
    docsUrl: "https://github.com/pgexperts/pg_plan_filter#readme",
  },
  {
    name: "timescaledb",
    kind: "extension",
    install_via: "source",
    category: "timeseries",
    description:
      "Hypertables, compression, and continuous aggregates for time-series workloads. Full version, Timescale License (TSL).",
    source: {
      type: "git",
      repository: "https://github.com/timescale/timescaledb.git",
      tag: "2.23.1",
    },
    build: { type: "timescaledb" },
    aptPackages: ["cmake", "ninja-build", "llvm", "clang", "perl", "python3"],
    runtime: {
      sharedPreload: true,
      defaultEnable: true,
      excludeFromAutoTests: false,
      notes: [
        "NOT in PGDG. Alt: Pigsty v2.20.0 (Apache 2.0 only, no TSL features)",
        "Alt: Timescale repo v2.23.1 (full TSL license) - timescaledb-2-postgresql-18",
        "Source build for TSL-licensed v2.23.1",
        "Preloaded for optimal hypertable performance",
        "timescaledb.telemetry_level defaults to 'off' to avoid outbound telemetry.",
      ],
    },
    sourceUrl: "https://github.com/timescale/timescaledb",
    docsUrl: "https://docs.tigerdata.com/use-timescale/latest/",
  },
  {
    name: "timescaledb_toolkit",
    kind: "extension",
    category: "timeseries",
    description: "Analytical hyperfunctions and sketches extending TimescaleDB.",
    source: {
      type: "git",
      repository: "https://github.com/timescale/timescaledb-toolkit.git",
      tag: "1.22.0",
    },
    build: { type: "cargo-pgrx", subdir: "extension", features: ["pg18"], noDefaultFeatures: true },
    aptPackages: ["clang", "llvm", "pkg-config", "make"],
    dependencies: ["timescaledb"],
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: [
        "NOT in PGDG (Rust pgrx extension). Alt: Pigsty v1.21.0 (1 version behind)",
        "Alt: Timescale repo v1.22.0 - timescaledb-toolkit-postgresql-18",
        "Source build for latest v1.22.0",
      ],
    },
    sourceUrl: "https://github.com/timescale/timescaledb-toolkit",
    docsUrl: "https://github.com/timescale/timescaledb-toolkit/tree/main/docs",
  },
  {
    name: "wal2json",
    kind: "tool",
    category: "cdc",
    description: "Logical decoding output plugin streaming JSON data for CDC.",
    source: {
      type: "git",
      repository: "https://github.com/eulerto/wal2json.git",
      tag: "wal2json_2_6",
    },
    install_via: "percona",
    perconaPackage: "percona-postgresql-18-wal2json",
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: [
        "NOT in PGDG. Installed via Percona ppg-18 repository (v2.6)",
        "Requires wal_level=logical in postgresql.conf for CDC functionality.",
      ],
    },
    sourceUrl: "https://github.com/eulerto/wal2json",
    docsUrl: "https://github.com/eulerto/wal2json#readme",
  },
  {
    name: "pg_partman",
    kind: "extension",
    install_via: "pgdg",
    pgdgVersion: "5.3.1-2.pgdg13+1",
    category: "maintenance",
    description: "Declarative partition maintenance with optional background worker.",
    source: {
      type: "git",
      repository: "https://github.com/pgpartman/pg_partman.git",
      tag: "v5.3.1",
    },
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: true,
      defaultEnable: false,
      preloadInComprehensiveTest: true,
      preloadLibraryName: "pg_partman_bgw",
      notes: [
        "PGDG: postgresql-18-partman (v5.3.1-2.pgdg13+1)",
        "Alt: Pigsty v5.3.1 (same version)",
        "Set pg_partman_bgw.role and interval to enable background worker.",
      ],
    },
    sourceUrl: "https://github.com/pgpartman/pg_partman",
    docsUrl: "https://github.com/pgpartman/pg_partman#readme",
  },
  {
    name: "vectorscale",
    displayName: "pgvectorscale",
    kind: "extension",
    category: "ai",
    description: "DiskANN-inspired ANN index and quantization for pgvector embeddings.",
    source: {
      type: "git",
      repository: "https://github.com/timescale/pgvectorscale.git",
      tag: "0.9.0",
    },
    build: { type: "cargo-pgrx", subdir: "pgvectorscale", features: ["pg18"] },
    aptPackages: ["clang", "llvm", "pkg-config", "make"],
    dependencies: ["vector"],
    runtime: {
      sharedPreload: false,
      defaultEnable: true,
      notes: [
        "NOT in PGDG (Rust pgrx extension). Alt: Pigsty v0.7.1 (2 versions behind)",
        "Alt: Timescale repo - NO PG18 packages available",
        "Source build required for v0.9.0",
      ],
    },
    sourceUrl: "https://github.com/timescale/pgvectorscale",
    docsUrl: "https://github.com/timescale/pgvectorscale#readme",
  },
  {
    name: "hll",
    displayName: "postgresql-hll",
    kind: "extension",
    install_via: "pgdg",
    pgdgVersion: "2.19-1.pgdg13+1",
    category: "analytics",
    description: "HyperLogLog probabilistic counting data type.",
    source: {
      type: "git",
      repository: "https://github.com/citusdata/postgresql-hll.git",
      tag: "v2.19",
    },
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: ["PGDG: postgresql-18-hll (v2.19-1.pgdg13+1)", "Alt: Pigsty v2.19 (same version)"],
    },
    sourceUrl: "https://github.com/citusdata/postgresql-hll",
    docsUrl: "https://github.com/citusdata/postgresql-hll#readme",
  },
  {
    name: "pgbackrest",
    kind: "tool",
    install_via: "pgdg",
    pgdgVersion: "2.57.0-1.pgdg13+1",
    category: "operations",
    description: "Parallel, incremental backup and restore CLI.",
    source: {
      type: "git",
      repository: "https://github.com/pgbackrest/pgbackrest.git",
      tag: "release/2.57.0",
    },
    build: { type: "meson" },
    aptPackages: [
      "meson",
      "ninja-build",
      "libssl-dev",
      "liblz4-dev",
      "libzstd-dev",
      "libbz2-dev",
      "libyaml-dev",
    ],
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: [
        "CLI tool installed from PGDG. NOT a PostgreSQL extension.",
        "PGDG: pgbackrest (v2.57.0-1.pgdg13+1). Alt: Pigsty. Alt: Percona (no PG18)",
        "Installs /usr/bin/pgbackrest.",
      ],
    },
    sourceUrl: "https://github.com/pgbackrest/pgbackrest",
    docsUrl: "https://pgbackrest.org/user-guide.html",
  },
  {
    name: "pgbadger",
    kind: "tool",
    install_via: "pgdg",
    pgdgVersion: "13.1-2.pgdg13+1",
    category: "observability",
    description: "High-speed PostgreSQL log analyzer producing HTML/JSON reports.",
    source: {
      type: "git",
      repository: "https://github.com/darold/pgbadger.git",
      tag: "v13.1",
    },
    build: { type: "make" },
    aptPackages: ["perl", "libtext-csv-xs-perl", "libjson-xs-perl"],
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: [
        "CLI tool installed from PGDG. NOT a PostgreSQL extension.",
        "PGDG: pgbadger (v13.1-2.pgdg13+1). Alt: Pigsty binary package.",
        "Binary installed to /usr/bin/pgbadger.",
      ],
    },
    sourceUrl: "https://github.com/darold/pgbadger",
    docsUrl: "https://pgbadger.darold.net/documentation.html",
  },
  {
    name: "set_user",
    displayName: "pgaudit_set_user",
    kind: "extension",
    install_via: "pgdg",
    pgdgVersion: "4.2.0-1.pgdg13+1",
    category: "security",
    description: "Audited SET ROLE helper complementing pgaudit.",
    source: {
      type: "git",
      repository: "https://github.com/pgaudit/set_user.git",
      tag: "REL4_2_0",
    },
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: true,
      defaultEnable: false,
      preloadInComprehensiveTest: true,
      notes: [
        "PGDG: postgresql-18-set-user (v4.2.0-1.pgdg13+1)",
        "Alt: Pigsty v4.2.0 (same version)",
      ],
    },
    sourceUrl: "https://github.com/pgaudit/set_user",
    docsUrl: "https://github.com/pgaudit/set_user#readme",
  },
];
