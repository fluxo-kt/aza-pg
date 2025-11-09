/**
 * Canonical catalog of extensions and tools bundled with the aza-pg image.
 * Edit this file to upgrade/downgrade extensions. Run
 *   bun scripts/extensions/generate-manifest.ts
 * to refresh docker/postgres/extensions.manifest.json.
 */

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
  install_via?: "pgdg";
  enabled?: boolean;
  disabledReason?: string;
}

export const MANIFEST_ENTRIES: ManifestEntry[] = [
  {
    name: "vector",
    displayName: "pgvector",
    kind: "extension",
    install_via: "pgdg",
    category: "ai",
    description: "Vector similarity search with IVF/HNSW indexes and distance operators.",
    source: {
      type: "git",
      repository: "https://github.com/pgvector/pgvector.git",
      tag: "v0.8.1",
    },
    build: { type: "pgxs" },
    runtime: { sharedPreload: false, defaultEnable: true },
  },
  {
    name: "pg_cron",
    kind: "extension",
    install_via: "pgdg",
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
      notes: ["Enable via shared_preload_libraries to activate scheduler workers."],
    },
  },
  {
    name: "pgaudit",
    kind: "extension",
    install_via: "pgdg",
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
      notes: ["Tune pgaudit.log to control verbosity."],
    },
  },
  {
    name: "pg_stat_statements",
    kind: "builtin",
    category: "observability",
    description: "Tracks execution statistics for normalized SQL statements.",
    source: { type: "builtin" },
    runtime: { sharedPreload: true, defaultEnable: true },
  },
  {
    name: "auto_explain",
    kind: "builtin",
    category: "observability",
    description: "Logs plans for slow statements automatically.",
    source: { type: "builtin" },
    runtime: { sharedPreload: true, defaultEnable: true, preloadOnly: true },
  },
  {
    name: "pg_trgm",
    kind: "builtin",
    category: "search",
    description: "Trigram-based fuzzy matching indexes.",
    source: { type: "builtin" },
    runtime: { sharedPreload: false, defaultEnable: true },
  },
  {
    name: "btree_gin",
    kind: "builtin",
    category: "indexing",
    description: "Adds B-tree emulation operator classes for GIN indexes.",
    source: { type: "builtin" },
    runtime: { sharedPreload: false, defaultEnable: false },
  },
  {
    name: "btree_gist",
    kind: "builtin",
    category: "indexing",
    description: "Adds B-tree emulation operator classes for GiST indexes.",
    source: { type: "builtin" },
    runtime: { sharedPreload: false, defaultEnable: false },
  },
  {
    name: "plpgsql",
    kind: "builtin",
    category: "language",
    description: "Built-in procedural language for PostgreSQL.",
    source: { type: "builtin" },
    runtime: { sharedPreload: false, defaultEnable: true },
  },
  {
    name: "hypopg",
    kind: "extension",
    install_via: "pgdg",
    category: "performance",
    description: "Simulate hypothetical indexes for planner what-if analysis.",
    source: {
      type: "git",
      repository: "https://github.com/HypoPG/hypopg.git",
      tag: "1.4.2",
    },
    build: { type: "pgxs" },
    runtime: { sharedPreload: false, defaultEnable: false },
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
    runtime: { sharedPreload: false, defaultEnable: false },
  },
  {
    name: "plpgsql_check",
    kind: "extension",
    install_via: "pgdg",
    category: "quality",
    description: "Static analyzer for PL/pgSQL functions and triggers.",
    source: {
      type: "git",
      repository: "https://github.com/okbob/plpgsql_check.git",
      tag: "v2.8.3",
    },
    build: { type: "pgxs" },
    runtime: { sharedPreload: false, defaultEnable: false },
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
    runtime: { sharedPreload: false, defaultEnable: false },
  },
  {
    name: "supautils",
    kind: "tool",
    category: "safety",
    description: "Shared superuser guards and hooks for managed Postgres environments.",
    enabled: false,
    disabledReason:
      "Compilation requires patching that proved unreliable with sed. Variable declaration missing 'static' keyword; sed patterns failed to match reliably.",
    source: {
      type: "git",
      repository: "https://github.com/supabase/supautils.git",
      tag: "v3.0.2",
    },
    build: {
      type: "pgxs",
      patches: ["s/^bool[[:space:]]\\{1,\\}log_skipped_evtrigs/static bool log_skipped_evtrigs/"],
    },
    runtime: {
      sharedPreload: true,
      defaultEnable: false,
      notes: ["Creates supabase-managed roles which expect pg_cron and pg_net to be present."],
    },
  },
  {
    name: "http",
    displayName: "pgsql-http",
    kind: "extension",
    install_via: "pgdg",
    category: "integration",
    description: "Synchronous HTTP client for PostgreSQL built on libcurl.",
    source: {
      type: "git",
      repository: "https://github.com/pramsey/pgsql-http.git",
      tag: "v1.7.0",
    },
    build: { type: "pgxs" },
    aptPackages: ["libcurl4-openssl-dev", "libjson-c-dev"],
    runtime: { sharedPreload: false, defaultEnable: false },
  },
  {
    name: "wrappers",
    displayName: "supabase-wrappers",
    kind: "extension",
    category: "integration",
    description: "Rust FDW framework powering Supabase foreign wrappers.",
    source: {
      type: "git-ref",
      repository: "https://github.com/supabase/wrappers.git",
      ref: "fc63ad1fee7fcf94a84b7f5dfc6a1aa2124c7712",
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
    notes: ["Requires cargo-pgrx 0.16.1 aligned with PG18."],
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
      "NOT available in PGDG for PostgreSQL 18 (available only for PG 13-17 in third-party repos like Pigsty)",
      "Compiled from source due to lack of official PGDG package support for PG18",
    ],
  },
  {
    name: "rum",
    kind: "extension",
    install_via: "pgdg",
    category: "search",
    description: "RUM GiST access method for ranked full-text search.",
    source: {
      type: "git",
      repository: "https://github.com/postgrespro/rum.git",
      tag: "1.3.15",
    },
    build: { type: "pgxs" },
    runtime: { sharedPreload: false, defaultEnable: false },
  },
  {
    name: "postgis",
    kind: "extension",
    install_via: "pgdg",
    category: "gis",
    description: "Spatial types, functions, raster, and topology for PostgreSQL.",
    source: {
      type: "git",
      repository: "https://github.com/postgis/postgis.git",
      tag: "3.6.0",
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
    runtime: { sharedPreload: false, defaultEnable: false },
  },
  {
    name: "pgrouting",
    kind: "extension",
    install_via: "pgdg",
    category: "gis",
    description: "Routing algorithms (Dijkstra, A*, TSP) on top of PostGIS graphs.",
    source: {
      type: "git",
      repository: "https://github.com/pgRouting/pgrouting.git",
      tag: "v3.8.0",
    },
    build: { type: "cmake" },
    dependencies: ["postgis"],
    aptPackages: ["cmake", "libboost-graph-dev"],
    runtime: { sharedPreload: false, defaultEnable: false },
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
    runtime: { sharedPreload: false, defaultEnable: false },
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
    runtime: { sharedPreload: false, defaultEnable: false },
  },
  {
    name: "pg_jsonschema",
    kind: "extension",
    category: "validation",
    description: "JSON Schema validation for JSONB documents on INSERT/UPDATE.",
    source: {
      type: "git-ref",
      repository: "https://github.com/supabase/pg_jsonschema.git",
      ref: "e7834142a3cce347b6082c5245de939810d3f9c4",
    },
    build: {
      type: "cargo-pgrx",
      features: ["pg18"],
      noDefaultFeatures: true,
      patches: ['s/pgrx = "0\\.16\\.0"/pgrx = "=0.16.1"/'],
    },
    aptPackages: ["clang", "llvm", "pkg-config", "make"],
    runtime: { sharedPreload: false, defaultEnable: false },
  },
  {
    name: "pg_hashids",
    kind: "extension",
    category: "utilities",
    description: "Encode integers into short hashids for obfuscated identifiers.",
    source: {
      type: "git",
      repository: "https://github.com/iCyberon/pg_hashids.git",
      tag: "v1.2.1",
    },
    build: { type: "pgxs" },
    runtime: { sharedPreload: false, defaultEnable: false },
  },
  {
    name: "pgmq",
    kind: "extension",
    category: "queueing",
    description: "Lightweight message queue for Postgres leveraging LISTEN/NOTIFY.",
    source: {
      type: "git",
      repository: "https://github.com/tembo-io/pgmq.git",
      tag: "v1.7.0",
    },
    build: { type: "pgxs", subdir: "pgmq-extension" },
    runtime: { sharedPreload: false, defaultEnable: false },
  },
  {
    name: "pgq",
    displayName: "PgQ",
    kind: "extension",
    category: "queueing",
    description:
      "Generic high-performance lockless queue with simple SQL function API (supports PostgreSQL 10-18).",
    source: {
      type: "git",
      repository: "https://github.com/pgq/pgq.git",
      tag: "v3.5.1",
    },
    build: { type: "pgxs" },
    runtime: { sharedPreload: false, defaultEnable: false },
    notes: [
      "Compiled from source (NOT available in PGDG for PostgreSQL 18)",
      "Pure PLpgSQL extension with no external dependencies",
      "Installs into pg_catalog schema (non-relocatable)",
      "Build time: ~2-3 minutes",
    ],
  },
  {
    name: "pg_repack",
    kind: "extension",
    install_via: "pgdg",
    category: "maintenance",
    description: "Online table/index reorganization without long locks.",
    source: {
      type: "git",
      repository: "https://github.com/reorg/pg_repack.git",
      tag: "ver_1.5.3",
    },
    build: { type: "pgxs" },
    aptPackages: ["libreadline-dev", "libnuma-dev", "libzstd-dev"],
    runtime: { sharedPreload: false, defaultEnable: false },
  },
  {
    name: "pg_stat_monitor",
    kind: "extension",
    category: "observability",
    description: "Enhanced query performance telemetry with bucketed metrics.",
    source: {
      type: "git-ref",
      repository: "https://github.com/percona/pg_stat_monitor.git",
      ref: "4ac02b24433894b320b044ed30747d0c38e79fa5",
    },
    build: { type: "pgxs" },
    runtime: { sharedPreload: true, defaultEnable: false },
    notes: [
      "Mutually exclusive with pg_stat_statements in older versions—keep both enabled in PG18 using monitor's pgsm aggregation.",
      "Pinned to pg_stat_monitor 2.3.0 pre-release commit 4ac02b24433894b320b044ed30747d0c38e79fa5 for PostgreSQL 18 support.",
    ],
  },
  {
    name: "pg_plan_filter",
    kind: "tool",
    category: "safety",
    description: "Block high-cost plans or disallowed operations using planner hooks.",
    source: {
      type: "git-ref",
      repository: "https://github.com/pgexperts/pg_plan_filter.git",
      ref: "5081a7b5cb890876e67d8e7486b6a64c38c9a492",
    },
    build: { type: "pgxs" },
    runtime: { sharedPreload: true, defaultEnable: false },
  },
  {
    name: "timescaledb",
    kind: "extension",
    install_via: "pgdg",
    category: "timeseries",
    description: "Hypertables, compression, and continuous aggregates for time-series workloads.",
    source: {
      type: "git",
      repository: "https://github.com/timescale/timescaledb.git",
      tag: "2.23.0",
    },
    build: { type: "timescaledb" },
    aptPackages: ["cmake", "ninja-build", "llvm", "clang", "perl", "python3"],
    runtime: {
      sharedPreload: true,
      defaultEnable: false,
      notes: ["timescaledb.telemetry_level defaults to 'off' to avoid outbound telemetry."],
    },
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
    runtime: { sharedPreload: false, defaultEnable: false },
    notes: [
      "Pinned to timescaledb_toolkit 1.22.0 (commit af5519c282fa2716fd87c4d9b8a15b0d857e9f29) for PostgreSQL 18 compatibility.",
    ],
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
    build: { type: "pgxs" },
    runtime: { sharedPreload: false, defaultEnable: false },
  },
  {
    name: "pg_partman",
    kind: "extension",
    install_via: "pgdg",
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
      notes: ["Set pg_partman_bgw.role and interval to enable background worker."],
    },
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
    runtime: { sharedPreload: false, defaultEnable: false },
  },
  {
    name: "hll",
    displayName: "postgresql-hll",
    kind: "extension",
    install_via: "pgdg",
    category: "analytics",
    description: "HyperLogLog probabilistic counting data type.",
    source: {
      type: "git",
      repository: "https://github.com/citusdata/postgresql-hll.git",
      tag: "v2.19",
    },
    build: { type: "pgxs" },
    runtime: { sharedPreload: false, defaultEnable: false },
  },
  {
    name: "pgbackrest",
    kind: "tool",
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
    runtime: { sharedPreload: false, defaultEnable: false },
    notes: ["Installs /usr/bin/pgbackrest."],
  },
  {
    name: "pgbadger",
    kind: "tool",
    category: "observability",
    description: "High-speed PostgreSQL log analyzer producing HTML/JSON reports.",
    source: {
      type: "git",
      repository: "https://github.com/darold/pgbadger.git",
      tag: "v13.1",
    },
    build: { type: "make" },
    aptPackages: ["perl", "libtext-csv-xs-perl", "libjson-xs-perl"],
    runtime: { sharedPreload: false, defaultEnable: false },
    notes: ["Binary installed to /usr/local/bin/pgbadger."],
  },
  {
    name: "set_user",
    displayName: "pgaudit_set_user",
    kind: "extension",
    install_via: "pgdg",
    category: "security",
    description: "Audited SET ROLE helper complementing pgaudit.",
    source: {
      type: "git",
      repository: "https://github.com/pgaudit/set_user.git",
      tag: "REL4_2_0",
    },
    build: { type: "pgxs" },
    runtime: { sharedPreload: true, defaultEnable: false },
  },
];
