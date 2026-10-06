/**
 * Canonical catalog of extensions and tools bundled with the aza-pg image.
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS FILE IS THE SINGLE SOURCE OF TRUTH FOR ALL VERSION INFORMATION.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Edit this file to upgrade/downgrade extensions. Run:
 *   bun run generate
 * to refresh all generated files (Dockerfile, extensions.manifest.json, docs).
 */

/**
 * PostgreSQL base configuration - SINGLE SOURCE OF TRUTH
 * Used by: Dockerfile generation, CI workflows, build scripts
 */
export const MANIFEST_METADATA = {
  /** PostgreSQL version (e.g., "18.1") */
  pgVersion: "18.6",
  /** Base image SHA256 digest for reproducible builds */
  baseImageSha: "sha256:fc973eb97c9fd04bfa1840e0f510719a584ccb3be8debfe6a4144637a9dfe8cf",
  /**
   * Rust toolchain for the source-built extensions (pgrx). Pinned rather than `stable` so a rebuild compiles with the
   * same compiler and a bump changes the Dockerfile (and with it CI's image key); check-updates.ts reports newer ones.
   */
  rustToolchain: "1.99.0",
  /** Multi-arch digest of rust:<rustToolchain>-slim-trixie, the builder's Rust toolchain; re-resolve on every bump. */
  rustImageSha: "sha256:24e632c09342c20abf8312cf4f61430a911c01ed3a5e4c02b87292b1c39c5273",
  /** Multi-arch digest of oven/bun:<.tool-versions bun>-debian, the builder's Bun; re-resolve on every Bun bump. */
  bunImageSha: "sha256:4f6e31d1a54d6a3dd312daef655fc998101b5043d52e12592ac293ef04b9bc73",
} as const;

/** A C library compiled from a release tarball because Debian trixie's package is too old. */
export interface SourceLibrary {
  /** GitHub repository and release tag; check-updates.ts compares `tag` with upstream's latest. */
  source: { type: "git"; repository: string; tag: string };
  /** Tarball attached to that release. The build downloads <repository>/releases/download/<tag>/<asset>,
   * so a tag/asset mismatch fails as a 404 and a stale sha256 as a checksum error, never silently. */
  asset: string;
  /** SHA-256 of the asset, recorded after verifying the upstream signature (see `notes`). */
  sha256: string;
  notes?: string[];
}

/**
 * Libraries built in the builder stage into /usr/local and shipped in the image, ahead of any
 * extension listing them in `sourceLibraries`. The image then carries ONE copy, which every consumer
 * links: two versions loaded into one backend would cross-bind symbols, because PostgreSQL loads
 * modules with RTLD_GLOBAL. Security updates for these are ours, not Debian's.
 */
export const SOURCE_LIBRARIES = {
  libsodium: {
    asset: "libsodium-1.0.22.tar.gz",
    sha256: "adbdd8f16149e81ac6078a03aca6fc03b592b89ef7b5ed83841c086191be3349",
    source: {
      type: "git",
      repository: "https://github.com/jedisct1/libsodium.git",
      tag: "1.0.22-RELEASE",
    },
    notes: [
      "pgsodium 3.1.11 needs libsodium >= 1.0.21; trixie ships 1.0.18.",
      "Before changing the pin, verify the tarball: minisign -VP RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3 -m <tarball> (key from https://doc.libsodium.org/installation), then record its sha256.",
      "Selects AVX2/AVX-512/AES-NI code paths at runtime, so the default configure (no --enable-opt, which adds -march=native) is both portable and fast.",
    ],
  },
} satisfies Record<string, SourceLibrary>;

/** Library keys; ManifestEntry.sourceLibraries accepts only these, so a typo fails type checking. */
export type SourceLibraryName = keyof typeof SOURCE_LIBRARIES;

export type SourceSpec =
  | { type: "builtin" }
  | { type: "git"; repository: string; tag: string }
  | { type: "git-ref"; repository: string; ref: string };

export type BuildKind =
  "pgxs" | "cargo-pgrx" | "timescaledb" | "autotools" | "cmake" | "meson" | "make" | "script";

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
   * When type === "meson", pass-through setup options. They follow the build's own --prefix=/usr/local,
   * and meson keeps the last --prefix given, so an entry can install elsewhere with "--prefix=/usr".
   */
  mesonOptions?: string[];
  /**
   * When type === "pgxs", extra make command-line assignments. Command-line variables override the
   * Makefile's own, so this can undo an upstream setting such as PG_CPPFLAGS = -O0.
   */
  makeOptions?: string[];
  /**
   * Optional script identifier for bespoke installers.
   */
  script?: string;
  /**
   * Unified-diff file names in docker/postgres/patches/, applied with `git apply` to the fresh clone before
   * building; one that no longer applies fails the build (refresh it on every upstream bump).
   */
  patches?: string[];
}

export interface RuntimeSpec {
  sharedPreload?: boolean;
  defaultEnable?: boolean;
  preloadOnly?: boolean; // Extension has no .control file, cannot use CREATE EXTENSION
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
  /** Keys of SOURCE_LIBRARIES this module links against; they are built before it. */
  sourceLibraries?: SourceLibraryName[];
  notes?: string[];
  install_via?: "pgdg" | "percona" | "timescale" | "source";
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
   * PGDG apt name suffix for an extension: installs postgresql-<major>-<pgdgPackage>.
   * Required when install_via === "pgdg" and kind is "extension" (tools install under their name).
   * Example: "pgvector" for vector, "cron" for pg_cron.
   */
  pgdgPackage?: string;
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
  /**
   * Shared object filename for .so file verification.
   * Required for every enabled extension installed from apt (pgdg, percona, timescale): the Dockerfile fails the build when the file is missing.
   * Example: "pg_stat_monitor.so" or "timescaledb.so"
   */
  soFileName?: string;
  /**
   * Absolute path of the executable a CLI tool (kind "tool") installs, e.g. "/usr/bin/pgbackrest".
   * A tool that ships a server library instead names it in soFileName. The image test requires
   * every enabled tool to declare one of the two and checks that file exists in the image.
   */
  binaryPath?: string;
  /**
   * Directories a tool writes by default (logs, repository, spool). The image creates them postgres-owned,
   * mode 0750, whether the tool is built from source or installed from a package whose own setup may
   * differ, so a named volume mounted on one starts writable by postgres instead of root-owned.
   */
  postgresOwnedDirs?: string[];
  /**
   * Timescale repository package name for timescale-installable extensions.
   * Required when install_via === "timescale".
   * Example: "timescaledb-2-postgresql-18"
   */
  timescalePackage?: string;
  /**
   * Timescale repository package version string.
   * Required when install_via === "timescale".
   * Example: "2.24.0~debian13-1801"
   */
  timescaleVersion?: string;
  enabled?: boolean;
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
    pgdgPackage: "pgvector",
    soFileName: "vector.so",
    pgdgVersion: "0.8.7-1.pgdg13+1",
    category: "ai",
    description: "Vector similarity search with IVF/HNSW indexes and distance operators.",
    source: {
      type: "git",
      repository: "https://github.com/pgvector/pgvector.git",
      tag: "v0.8.7",
    },
    runtime: {
      sharedPreload: false,
      defaultEnable: true,
      notes: [
        "Never below 0.8.7: older versions let a role that can build an IVFFlat index write out of bounds (CVE-2026-103484, arbitrary code execution).",
        "Regression test coverage includes vector columns, HNSW indexing, EXPLAIN, and similarity search",
      ],
    },
    sourceUrl: "https://github.com/pgvector/pgvector",
    docsUrl: "https://github.com/pgvector/pgvector#readme",
  },
  {
    name: "pg_cron",
    kind: "extension",
    install_via: "pgdg",
    pgdgPackage: "cron",
    soFileName: "pg_cron.so",
    pgdgVersion: "1.6.8-1.pgdg13+2",
    category: "operations",
    description: "Lightweight cron-based job runner inside PostgreSQL.",
    source: {
      type: "git",
      repository: "https://github.com/citusdata/pg_cron.git",
      tag: "v1.6.8",
    },
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: true,
      defaultEnable: true,
      notes: [
        "PGDG: postgresql-18-cron",
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
    pgdgPackage: "pgaudit",
    soFileName: "pgaudit.so",
    pgdgVersion: "18.0-3.pgdg13+1",
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
      notes: ["PGDG: postgresql-18-pgaudit", "Tune pgaudit.log to control verbosity."],
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
    pgdgPackage: "hypopg",
    soFileName: "hypopg.so",
    pgdgVersion: "1.4.3-1.pgdg13+2",
    category: "performance",
    description: "Simulate hypothetical indexes for planner what-if analysis.",
    source: {
      type: "git",
      repository: "https://github.com/HypoPG/hypopg.git",
      tag: "1.4.3",
    },
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: ["PGDG: postgresql-18-hypopg"],
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
    pgdgPackage: "plpgsql-check",
    soFileName: "plpgsql_check.so",
    pgdgVersion: "2.10.12-1.pgdg13+1",
    category: "quality",
    description: "Static analyzer for PL/pgSQL functions and triggers.",
    source: {
      type: "git",
      repository: "https://github.com/okbob/plpgsql_check.git",
      tag: "v2.10.12",
    },
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: [
        "PGDG: postgresql-18-plpgsql-check",
        "2.10 ships no 2.9 -> 2.10 upgrade script: in databases created on an older image the check and report functions error, and ALTER EXTENSION UPDATE fails too, until DROP EXTENSION plpgsql_check; CREATE EXTENSION plpgsql_check;",
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
      tag: "1.7",
    },
    soFileName: "safeupdate.so",
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: true,
      defaultEnable: true,
      preloadInComprehensiveTest: true,
      preloadLibraryName: "safeupdate",
      notes: [
        "NOT in PGDG.",
        "Requires shared_preload_libraries to intercept UPDATE/DELETE queries.",
      ],
    },
    sourceUrl: "https://github.com/eradman/pg-safeupdate",
    docsUrl: "https://github.com/eradman/pg-safeupdate#readme",
  },
  {
    name: "supautils",
    enabled: true,
    kind: "extension",
    category: "safety",
    description: "Shared superuser guards and hooks for managed Postgres environments.",
    source: {
      type: "git",
      repository: "https://github.com/supabase/supautils.git",
      tag: "v3.4.4",
    },
    build: { type: "pgxs" },
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
    pgdgPackage: "http",
    soFileName: "http.so",
    pgdgVersion: "1.7.2-2.pgdg13+2",
    category: "integration",
    description: "Synchronous HTTP client for PostgreSQL built on libcurl.",
    source: {
      type: "git",
      repository: "https://github.com/pramsey/pgsql-http.git",
      tag: "v1.7.2",
    },
    build: { type: "pgxs" },
    aptPackages: ["libcurl4-openssl-dev", "libjson-c-dev"],
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: ["PGDG: postgresql-18-http"],
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
      tag: "v0.20.5",
    },
    build: { type: "pgxs" },
    aptPackages: ["libcurl4-openssl-dev"],
    runtime: {
      sharedPreload: true,
      defaultEnable: true,
      notes: [
        "NOT in PGDG (Supabase-specific). Source build required.",
        "Requires shared_preload_libraries for background worker",
        "Powers async HTTP webhooks from triggers",
        "Use net.http_post() for outbound API calls",
        "Required for pgflow workflow orchestration",
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
      tag: "v0.6.3",
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
      "NOT available in PGDG. build-extensions.ts installs the cargo-pgrx version pinned in its Cargo.toml.",
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
      tag: "4.0.9",
    },
    build: { type: "meson", mesonOptions: ["-Dtest=false"] },
    aptPackages: [
      "cmake",
      "meson",
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
      "Builds with Meson (PGXS Makefile was dropped upstream in 4.0.6).",
      "Meson tests are disabled in the production build; upstream test setup requires Ruby.",
      "Source build required for PG18",
    ],
    sourceUrl: "https://github.com/pgroonga/pgroonga",
    docsUrl: "https://pgroonga.github.io",
  },
  {
    name: "rum",
    kind: "extension",
    install_via: "pgdg",
    pgdgPackage: "rum",
    soFileName: "rum.so",
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
      notes: ["PGDG: postgresql-18-rum"],
    },
    sourceUrl: "https://github.com/postgrespro/rum",
    docsUrl: "https://github.com/postgrespro/rum#readme",
  },
  {
    name: "postgis",
    kind: "extension",
    install_via: "pgdg",
    pgdgPackage: "postgis-3",
    pgdgVersion: "3.6.4+dfsg-2.pgdg13+1",
    category: "gis",
    description: "Spatial types, functions, raster, and topology for PostgreSQL.",
    enabled: false,
    disabledReason:
      "Disabled to reduce build time and image size. GIS functionality not currently required. Enable when spatial data support is needed.",
    source: {
      type: "git",
      repository: "https://github.com/postgis/postgis.git",
      tag: "3.6.4",
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
      notes: ["PGDG: postgresql-18-postgis-3"],
    },
    sourceUrl: "https://github.com/postgis/postgis",
    docsUrl: "https://postgis.net/documentation",
  },
  {
    name: "pgrouting",
    kind: "extension",
    install_via: "pgdg",
    pgdgPackage: "pgrouting",
    pgdgVersion: "4.0.1-1.pgdg13+1",
    category: "gis",
    description: "Routing algorithms (Dijkstra, A*, TSP) on top of PostGIS graphs.",
    enabled: false,
    disabledReason:
      "Disabled to reduce build time and image size. Depends on PostGIS which is also disabled. Enable when routing functionality is needed.",
    source: {
      type: "git",
      repository: "https://github.com/pgRouting/pgrouting.git",
      tag: "v4.0.1",
    },
    build: { type: "cmake" },
    dependencies: ["postgis"],
    aptPackages: ["cmake", "libboost-graph-dev"],
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: ["PGDG: postgresql-18-pgrouting"],
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
      tag: "v3.1.11",
    },
    // Upstream's Makefile sets PG_CPPFLAGS = -O0 (since 2017, no stated reason), which outranks
    // PostgreSQL's -O2. Secrets are wiped with sodium_memzero, which optimisation cannot remove.
    build: { type: "pgxs", makeOptions: ["PG_CPPFLAGS="] },
    sourceLibraries: ["libsodium"],
    runtime: {
      sharedPreload: true,
      defaultEnable: true,
      notes: [
        "NOT in PGDG.",
        "Preloaded by default for pgflow and supabase_vault support",
        "Preloading required for event triggers to work (registers pgsodium.enable_event_trigger GUC)",
        "Root key: random per data directory ($PGDATA/pgsodium_root.key) or the operator's PGSODIUM_KEY_FILE (docs/PGSODIUM-SETUP.md)",
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
    sourceLibraries: ["libsodium"],
    dependencies: ["pgsodium"],
    runtime: {
      // Preloaded by default: vault 0.3 loads its encryption key from pgsodium at preload time, and
      // without the preload vault.create_secret fails.
      sharedPreload: true,
      defaultEnable: true,
      notes: [
        "NOT in PGDG (Supabase-specific).",
        "Source build required",
        "Required for pgflow workflow orchestration",
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
      type: "git",
      repository: "https://github.com/supabase/pg_jsonschema.git",
      tag: "v0.3.4",
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
        "NOT in PGDG (Rust pgrx extension).",
        "Pinned to release tag v0.3.4 instead of a raw commit; HEAD contains unreleased changes.",
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
        "NOT in PGDG.",
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
      tag: "v1.13.0",
    },
    build: { type: "pgxs", subdir: "pgmq-extension" },
    runtime: {
      sharedPreload: false,
      defaultEnable: true,
      notes: ["NOT in PGDG."],
    },
    sourceUrl: "https://github.com/pgmq/pgmq",
    docsUrl: "https://github.com/pgmq/pgmq#readme",
  },
  {
    name: "pgflow",
    displayName: "pgflow",
    kind: "extension",
    category: "workflow",
    description: "DAG-based workflow orchestration engine with step-by-step task execution.",
    enabled: true,
    source: {
      type: "git",
      repository: "https://github.com/pgflow-dev/pgflow.git",
      tag: "pgflow@0.17.2",
    },
    runtime: {
      sharedPreload: false,
      defaultEnable: true,
      preloadOnly: true, // SQL-only schema, no .control file
      notes: [
        "SQL-only schema installed in postgres database during initdb",
        "For multi-database: reinstall schema in each database",
        "pg_cron schedules limited to postgres database by default",
        "Use @pgflow/dsl and @pgflow/client npm packages for TypeScript integration",
      ],
    },
    dependencies: ["pgmq", "pg_net", "pg_cron", "supabase_vault"],
    notes: [
      "SQL-only schema - no compiled components",
      "v0.17: pgflow_telemetry schema (daily usage report via pg_cron); aza-pg leaves it unscheduled, operators opt in with pgflow_telemetry.enable()",
      "v0.16: workers compile/verify their flow definition before polling; migration-based flow compilation removed",
      "v0.15: @pgflow/edge-worker published to npm with Node/Bun runtime support",
      "v0.14.1: Conditional step execution with skipped-state propagation",
      "v0.13.3: PGFLOW_AUTH_SECRET support, maxPgConnections fix (edge worker features)",
      "v0.13.2: Auto-requeue stalled tasks (crash resilience), requeued_count tracking",
      "v0.13.0: 2.17× faster Map→Map chains via atomic step output storage",
      "v0.12.0: Breaking handler signature change (root: flowInput, dependent: deps + ctx.flowInput)",
      "Schema installed by default in postgres database",
      "Multi-database: Use separate database installations for workflow isolation",
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
    disabledReason:
      "Disabled by default to reduce image size and build time (~2-3 minutes). Enable if queue functionality needed.",
    source: {
      type: "git",
      repository: "https://github.com/pgq/pgq.git",
      tag: "v3.5.2",
    },
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: [
        'PGDG ships postgresql-18-pgq3 but trails the upstream tag; switch to install_via pgdg (pgdgPackage "pgq3") once it matches.',
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
    pgdgPackage: "repack",
    soFileName: "pg_repack.so",
    pgdgVersion: "1.5.3-1.pgdg13+2",
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
      notes: ["PGDG: postgresql-18-repack"],
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
      tag: "2.4.0",
    },
    install_via: "percona",
    perconaPackage: "percona-pg-stat-monitor18",
    perconaVersion: "1:2.4.0-1.trixie",
    soFileName: "pg_stat_monitor.so",
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: true,
      defaultEnable: true,
      notes: [
        "NOT in PGDG. Installed via Percona ppg-18 repository",
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
    source: {
      type: "git",
      repository: "https://github.com/pgexperts/pg_plan_filter.git",
      tag: "v1.0.0",
    },
    soFileName: "plan_filter.so",
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: true,
      defaultEnable: false,
      preloadLibraryName: "plan_filter",
      notes: [
        "NOT in PGDG. Source build required.",
        "Optional: add plan_filter to POSTGRES_SHARED_PRELOAD_LIBRARIES, then set plan_filter.statement_cost_limit (superuser-only GUC).",
      ],
    },
    sourceUrl: "https://github.com/pgexperts/pg_plan_filter",
    docsUrl: "https://github.com/pgexperts/pg_plan_filter#readme",
  },
  {
    name: "timescaledb",
    kind: "extension",
    install_via: "timescale",
    timescalePackage: "timescaledb-2-postgresql-18",
    timescaleVersion: "2.30.2~debian13-1806",
    soFileName: "timescaledb.so",
    category: "timeseries",
    description:
      "Hypertables, compression, and continuous aggregates for time-series workloads. Full version, Timescale License (TSL).",
    source: {
      type: "git",
      repository: "https://github.com/timescale/timescaledb.git",
      tag: "2.30.2",
    },
    runtime: {
      sharedPreload: true,
      defaultEnable: true,
      notes: [
        "Timescale repo: timescaledb-2-postgresql-18 (TSL build). The ~debian13-18NN version suffix names the PostgreSQL minor it was built for, and the package Depends on postgresql-18 >= that minor: bump timescaleVersion together with pgVersion.",
        "Preloaded for optimal hypertable performance",
        "timescaledb.telemetry_level defaults to 'off' to avoid outbound telemetry.",
      ],
    },
    sourceUrl: "https://github.com/timescale/timescaledb",
    docsUrl: "https://docs.timescale.com/",
  },
  {
    name: "timescaledb_toolkit",
    kind: "extension",
    install_via: "timescale",
    timescalePackage: "timescaledb-toolkit-postgresql-18",
    timescaleVersion: "1:1.26.0~debian13",
    soFileName: "timescaledb_toolkit-1.26.0.so",
    category: "timeseries",
    description: "Analytical hyperfunctions and sketches extending TimescaleDB.",
    source: {
      type: "git",
      repository: "https://github.com/timescale/timescaledb-toolkit.git",
      tag: "1.26.0",
    },
    dependencies: ["timescaledb"],
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: [
        "Timescale repo: timescaledb-toolkit-postgresql-18",
        "Switched from cargo-pgrx source build to Timescale apt (faster install)",
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
    perconaVersion: "1:2.6-5.trixie",
    soFileName: "wal2json.so",
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: [
        "Installed via Percona ppg-18 repository; PGDG also packages wal2json, but Percona is already required for pg_stat_monitor.",
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
    pgdgPackage: "partman",
    soFileName: "pg_partman_bgw.so",
    pgdgVersion: "5.5.0-1.pgdg13+1",
    category: "maintenance",
    description: "Declarative partition maintenance with optional background worker.",
    source: {
      type: "git",
      repository: "https://github.com/pgpartman/pg_partman.git",
      tag: "v5.5.0",
    },
    runtime: {
      sharedPreload: true,
      defaultEnable: false,
      preloadInComprehensiveTest: true,
      preloadLibraryName: "pg_partman_bgw",
      notes: [
        "PGDG: postgresql-18-partman — ships the pg_partman_bgw background worker",
        "Set pg_partman_bgw.dbname, interval and role to enable the background worker; since 5.5.0 role defaults to partman_maintainer, which must exist (upstream advises a non-superuser role)",
      ],
    },
    sourceUrl: "https://github.com/pgpartman/pg_partman",
    docsUrl: "https://github.com/pgpartman/pg_partman#readme",
  },
  {
    name: "vectorscale",
    displayName: "pgvectorscale",
    kind: "extension",
    soFileName: "vectorscale-0.9.1.so",
    category: "ai",
    description: "DiskANN-inspired ANN index and quantization for pgvector embeddings.",
    source: {
      type: "git",
      repository: "https://github.com/timescale/pgvectorscale.git",
      tag: "0.9.1",
    },
    // Built from source, not timescale's release binary: that binary is compiled with AVX2/FMA on for
    // every function and kills the server (SIGILL) on x86-64 CPUs without them. The patch removes the
    // global target-feature flags and selects AVX2+FMA kernels at runtime; refresh it on every bump.
    // Features pinned (= upstream's defaults at 0.9.1) so an upstream default change cannot alter the build.
    build: {
      type: "cargo-pgrx",
      subdir: "pgvectorscale",
      features: ["pg18", "build_parallel"],
      noDefaultFeatures: true,
      patches: ["vectorscale-runtime-dispatch.patch", "vectorscale-cargo-lock.patch"],
    },
    dependencies: ["vector"],
    runtime: {
      sharedPreload: false,
      defaultEnable: true,
      notes: [
        "Built from source with runtime CPU dispatch: AVX2/FMA only when the CPU has them",
        "Supports both amd64 and arm64 architectures",
        "Alt: Timescale apt repo has NO Debian Trixie packages (checked 2025-01)",
        "Alt: PGDG has no package (Rust pgrx extension)",
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
    pgdgPackage: "hll",
    soFileName: "hll.so",
    pgdgVersion: "2.21-1.pgdg13+2",
    category: "analytics",
    description: "HyperLogLog probabilistic counting data type.",
    source: {
      type: "git",
      repository: "https://github.com/citusdata/postgresql-hll.git",
      tag: "v2.21",
    },
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: ["PGDG: postgresql-18-hll"],
    },
    sourceUrl: "https://github.com/citusdata/postgresql-hll",
    docsUrl: "https://github.com/citusdata/postgresql-hll#readme",
  },
  {
    name: "pgbackrest",
    kind: "tool",
    // Never below 2.59.3: it fixes weak encryption sub-keys and salts.
    install_via: "pgdg",
    pgdgVersion: "2.59.3-1.pgdg13+1",
    binaryPath: "/usr/bin/pgbackrest",
    postgresOwnedDirs: ["/var/lib/pgbackrest", "/var/log/pgbackrest", "/var/spool/pgbackrest"],
    category: "operations",
    description: "Parallel, incremental backup and restore CLI.",
    source: {
      type: "git",
      repository: "https://github.com/pgbackrest/pgbackrest.git",
      tag: "release/2.59.3",
    },
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: [
        "CLI tool installed from PGDG. NOT a PostgreSQL extension.",
        "Installs /usr/bin/pgbackrest. Since 2.59.0 only restore may run as root: run it as postgres (docker exec -u postgres) or set allow-root.",
      ],
    },
    sourceUrl: "https://github.com/pgbackrest/pgbackrest",
    docsUrl: "https://pgbackrest.org/user-guide.html",
  },
  {
    name: "pgbadger",
    kind: "tool",
    install_via: "pgdg",
    // A real package in PGDG; percona-pgbadger only Provides the name, so the pin resolves to PGDG
    // even with the Percona repo enabled.
    pgdgVersion: "13.2-1.pgdg13+1",
    binaryPath: "/usr/bin/pgbadger",
    category: "observability",
    description: "High-speed PostgreSQL log analyzer producing HTML/JSON reports.",
    source: {
      type: "git",
      repository: "https://github.com/darold/pgbadger.git",
      tag: "v13.2",
    },
    build: { type: "make" },
    aptPackages: ["perl", "libtext-csv-xs-perl", "libjson-xs-perl"],
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: [
        "CLI tool. NOT a PostgreSQL extension.",
        "Installed from PGDG as pinned pgbadger=<pgdgVersion>; with the Percona repo enabled apt still resolves the PGDG package.",
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
    pgdgPackage: "set-user",
    soFileName: "set_user.so",
    pgdgVersion: "4.2.0-1.pgdg13+2",
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
      notes: ["PGDG: postgresql-18-set-user"],
    },
    sourceUrl: "https://github.com/pgaudit/set_user",
    docsUrl: "https://github.com/pgaudit/set_user#readme",
  },
];
