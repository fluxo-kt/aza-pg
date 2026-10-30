/**
 * Canonical catalog of extensions and tools bundled with the aza-pg image.
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS FILE IS THE SINGLE SOURCE OF TRUTH FOR BUNDLED-IMAGE VERSION INFORMATION.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Edit this file to upgrade/downgrade extensions. Run:
 *   bun run generate
 * to refresh all generated files (extensions.manifest.json, which flake.nix builds from, and the docs).
 */

/**
 * PostgreSQL base configuration - SINGLE SOURCE OF TRUTH
 * Used by: flake.nix (through the generated manifest), CI workflows, release scripts
 */
export const MANIFEST_METADATA = {
  /** PostgreSQL version (e.g., "18.1") */
  pgVersion: "18.6",
  /** Multi-arch digest of oven/bun:<.tool-versions bun>-debian, the pg_net test's echo server; re-resolve on every Bun bump. */
  bunImageSha: "sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e",
  /**
   * glibc locales the image ships (UTF-8), so a session can `SET lc_monetary|lc_numeric|lc_time = '<name>.utf8'`.
   * PostgreSQL reads these from glibc, never from ICU, for to_char's L/D/G/TM patterns and the money type. New
   * clusters do not collate with them (builtin provider, ICU per column). All of glibc's locales take 223 MB; this
   * list covers the widely used languages and currencies in 49 MB, 45 MB of it glibc collation tables. They stay:
   * clusters created by earlier images collate with en_US.utf8, and initdb imports every locale as a collation, so
   * locales without those tables would make their indexes and COLLATE "de_DE.utf8" sort as POSIX without an error.
   * Add a locale here when a project formats in it.
   */
  locales: [
    "en_US",
    "en_GB",
    "en_CA",
    "en_AU",
    "en_IN",
    "de_DE",
    "de_AT",
    "de_CH",
    "fr_FR",
    "fr_CA",
    "fr_CH",
    "it_IT",
    "es_ES",
    "es_MX",
    "es_AR",
    "pt_PT",
    "pt_BR",
    "nl_NL",
    "pl_PL",
    "cs_CZ",
    "sv_SE",
    "da_DK",
    "nb_NO",
    "fi_FI",
    "ru_RU",
    "uk_UA",
    "kk_KZ",
    "be_BY",
    "ka_GE",
    "hy_AM",
    "tr_TR",
    "el_GR",
    "he_IL",
    "ar_AE",
    "hi_IN",
    "zh_CN",
    "zh_TW",
    "ja_JP",
    "ko_KR",
    "th_TH",
    "vi_VN",
    "id_ID",
  ],
} as const;

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
   * When type === "pgxs", extra make command-line assignments. Command-line variables override the
   * Makefile's own, so this can undo an upstream setting such as PG_CPPFLAGS = -O0.
   */
  makeOptions?: string[];
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
  notes?: string[];
  /**
   * Shared object file name when it differs from `<name>.so` (e.g. "timescaledb.so"): the size check measures it,
   * and a tool that ships a server library names it here instead of binaryPath.
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
   * mode 0750, so a named volume mounted on one starts writable by postgres instead of root-owned.
   */
  postgresOwnedDirs?: string[];
  /**
   * How the Nix image (flake.nix) builds this entry, always from `source.commit`, so versions stay ours.
   * `package`: attribute in nixpkgs' postgresql_<major>.pkgs (or top-level nixpkgs for a tool) whose build recipe is
   * reused with our source swapped in. Omitted: built from `build.type` with `inputs`, the nixpkgs attributes it
   * links. `nativeInputs`: build-time tools, never in the image. `mesonFlags`: appended
   * to the recipe's, last one winning. `bin`: the executables the entry ships (default: binaryPath's); the rest of
   * its bin/ goes, since nothing uses them (pg_partman's Python helpers, PGroonga's systemd-timer scripts).
   * `postInstall`: shell run after install with `$out` the entry's output, for fixes to what the recipe installs;
   * `@pgMajor@` becomes the PostgreSQL major.
   */
  nix?: {
    package?: string;
    inputs?: string[];
    nativeInputs?: string[];
    mesonFlags?: string[];
    bin?: string[];
    postInstall?: string;
  };
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
    nix: { package: "pgvector" },
    displayName: "pgvector",
    kind: "extension",
    soFileName: "vector.so",
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
    nix: { package: "pg_cron" },
    kind: "extension",
    soFileName: "pg_cron.so",
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
        "Preloaded by default - background worker scheduling enabled",
        "Job scheduling tested in functional test suite",
      ],
    },
    sourceUrl: "https://github.com/citusdata/pg_cron",
    docsUrl: "https://github.com/citusdata/pg_cron#readme",
  },
  {
    name: "pgaudit",
    nix: { package: "pgaudit" },
    kind: "extension",
    soFileName: "pgaudit.so",
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
    nix: { package: "hypopg" },
    kind: "extension",
    soFileName: "hypopg.so",
    category: "performance",
    description: "Simulate hypothetical indexes for planner what-if analysis.",
    source: {
      type: "git",
      repository: "https://github.com/HypoPG/hypopg.git",
      tag: "1.4.4",
    },
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
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
      tag: "v0.2.1",
    },
    build: { type: "pgxs" },
    dependencies: ["hypopg"],
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: ["Supabase-specific extension"],
    },
    sourceUrl: "https://github.com/supabase/index_advisor",
    docsUrl: "https://supabase.com/docs/guides/database/extensions/index_advisor",
  },
  {
    name: "plpgsql_check",
    nix: { package: "plpgsql_check" },
    kind: "extension",
    soFileName: "plpgsql_check.so",
    category: "quality",
    description: "Static analyzer for PL/pgSQL functions and triggers.",
    source: {
      type: "git",
      repository: "https://github.com/okbob/plpgsql_check.git",
      tag: "v2.10.16",
    },
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: [
        "2.10 ships no 2.9 -> 2.10 upgrade script: in databases created on an older image the check and report functions error, and ALTER EXTENSION UPDATE fails too, until DROP EXTENSION plpgsql_check; CREATE EXTENSION plpgsql_check;",
      ],
    },
    sourceUrl: "https://github.com/okbob/plpgsql_check",
    docsUrl: "https://github.com/okbob/plpgsql_check#readme",
  },
  {
    name: "pg_safeupdate",
    nix: { package: "pg_safeupdate" },
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
      notes: ["Requires shared_preload_libraries to intercept UPDATE/DELETE queries."],
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
      tag: "v4.0.0",
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
    nix: { package: "pgsql-http" },
    displayName: "pgsql-http",
    kind: "extension",
    soFileName: "http.so",
    category: "integration",
    description: "Synchronous HTTP client for PostgreSQL built on libcurl.",
    source: {
      type: "git",
      repository: "https://github.com/pramsey/pgsql-http.git",
      tag: "v1.7.2",
    },
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
    },
    sourceUrl: "https://github.com/pramsey/pgsql-http",
    docsUrl: "https://github.com/pramsey/pgsql-http#readme",
  },
  {
    name: "pg_net",
    nix: { package: "pg_net" },
    kind: "extension",
    category: "integration",
    description: "Async HTTP/HTTPS requests from PostgreSQL for webhooks and API calls.",
    source: {
      type: "git",
      repository: "https://github.com/supabase/pg_net.git",
      tag: "v0.20.5",
    },
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: true,
      defaultEnable: true,
      notes: [
        "Supabase-specific.",
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
    nix: { inputs: ["openssl", "pkg-config"] },
    displayName: "supabase-wrappers",
    kind: "extension",
    category: "integration",
    description: "Rust FDW framework powering Supabase foreign wrappers.",
    source: {
      type: "git",
      repository: "https://github.com/supabase/wrappers.git",
      tag: "v0.6.4",
    },
    build: {
      type: "cargo-pgrx",
      features: ["pg18"],
      noDefaultFeatures: true,
      subdir: "wrappers",
      // Cargo.lock moved by `cargo update -p rustls@0.23.37 --precise 0.23.46` at the pinned commit: rustls 0.23.46,
      // rustls-webpki 0.103.16 and the aws-lc-rs 1.19 / aws-lc-sys 0.47 they require fix GHSA-82j2-j2ch-gfr8 (HIGH),
      // GHSA-2mjx-qc3c-rqvc and GHSA-c8m5-c952-6cm4 in the TLS that wrappers' HTTPS FDWs use. Regenerate the same way
      // on a bump; drop it once a release locks these; a stale one fails the build.
      patches: ["wrappers-cargo-lock.patch"],
    },
    dependencies: ["pg_stat_statements"],
    runtime: { sharedPreload: false, defaultEnable: false },
    sourceUrl: "https://github.com/supabase/wrappers",
    docsUrl: "https://supabase.com/docs/guides/database/extensions/wrappers/overview",
  },
  {
    name: "pgroonga",
    nix: { package: "pgroonga" },
    kind: "extension",
    category: "search",
    description: "Full-text search powered by Groonga for multilingual workloads.",
    source: {
      type: "git",
      repository: "https://github.com/pgroonga/pgroonga.git",
      tag: "4.1.0",
    },
    build: { type: "meson" },
    runtime: { sharedPreload: false, defaultEnable: false },
    notes: [
      "Builds with Meson (PGXS Makefile was dropped upstream in 4.0.6).",
      "Meson tests are disabled in the production build; upstream test setup requires Ruby.",
    ],
    sourceUrl: "https://github.com/pgroonga/pgroonga",
    docsUrl: "https://pgroonga.github.io",
  },
  {
    name: "rum",
    nix: { package: "rum" },
    kind: "extension",
    soFileName: "rum.so",
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
    },
    sourceUrl: "https://github.com/postgrespro/rum",
    docsUrl: "https://github.com/postgrespro/rum#readme",
  },
  {
    name: "postgis",
    kind: "extension",
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
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
    },
    sourceUrl: "https://github.com/postgis/postgis",
    docsUrl: "https://postgis.net/documentation",
  },
  {
    name: "pgrouting",
    kind: "extension",
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
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
    },
    sourceUrl: "https://github.com/pgRouting/pgrouting",
    docsUrl: "https://docs.pgrouting.org",
  },
  {
    name: "pgsodium",
    nix: {
      package: "pgsodium",
      // With pgsodium.getkey_script unset, pgsodium runs <sharedir>/extension/pgsodium_getkey. Every server the
      // image starts sets it (auto-config file), but one an operator starts without that file would run nixpkgs'
      // sample there, which writes an unchecked key into PGDATA; the link sends it to the image's script, or to the
      // operator's mounted at that path. Upstream's example getkey scripts (AWS, GCP, Doppler…): nothing runs them,
      // and they pull in a second Bash.
      postInstall:
        "ln -sf /usr/share/postgresql/@pgMajor@/extension/pgsodium_getkey $out/share/postgresql/extension/pgsodium_getkey\n" +
        "rm -r $out/share/pgsodium/getkey_scripts",
    },
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
    runtime: {
      sharedPreload: true,
      defaultEnable: true,
      notes: [
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
    nix: { inputs: ["libsodium"] },
    displayName: "vault",
    kind: "extension",
    category: "security",
    description: "Supabase secret store for encrypted application credentials.",
    source: {
      type: "git",
      repository: "https://github.com/supabase/vault.git",
      tag: "v0.3.2",
    },
    build: { type: "pgxs" },
    runtime: {
      // Vault reads pgsodium_getkey independently at startup; both extensions need the same retained
      // root key for existing ciphertext to remain readable across restart and restore.
      sharedPreload: true,
      defaultEnable: true,
      notes: ["Supabase-specific.", "Required for pgflow workflow orchestration"],
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
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: [
        "Rust pgrx extension.",
        "Pinned to release tag v0.3.4 instead of a raw commit; HEAD contains unreleased changes.",
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
      notes: ["Using v1.3 from master (unreleased, no git tag)"],
    },
    sourceUrl: "https://github.com/iCyberon/pg_hashids",
    docsUrl: "https://github.com/iCyberon/pg_hashids#readme",
  },
  {
    name: "pgmq",
    nix: { package: "pgmq" },
    kind: "extension",
    category: "queueing",
    description: "Lightweight message queue for Postgres leveraging LISTEN/NOTIFY.",
    source: {
      type: "git",
      repository: "https://github.com/tembo-io/pgmq.git",
      tag: "v1.13.1",
    },
    build: { type: "pgxs", subdir: "pgmq-extension" },
    runtime: {
      sharedPreload: false,
      defaultEnable: true,
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
        "Pure PLpgSQL extension with no external dependencies",
        "Installs into pg_catalog schema (non-relocatable)",
      ],
    },
    sourceUrl: "https://github.com/pgq/pgq",
    docsUrl: "https://wiki.postgresql.org/wiki/PGQ_Tutorial",
  },
  {
    name: "pg_repack",
    // The client the pg_repack wrapper (docker/postgres/pg_repack-wrapper.sh) runs.
    nix: { package: "pg_repack", bin: ["pg_repack"] },
    kind: "extension",
    soFileName: "pg_repack.so",
    category: "maintenance",
    description: "Online table/index reorganization without long locks.",
    source: {
      type: "git",
      repository: "https://github.com/reorg/pg_repack.git",
      tag: "ver_1.5.3",
    },
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
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
    soFileName: "pg_stat_monitor.so",
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: true,
      defaultEnable: true,
      notes: [
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
        "Optional: add plan_filter to POSTGRES_SHARED_PRELOAD_LIBRARIES, then set plan_filter.statement_cost_limit (superuser-only GUC).",
      ],
    },
    sourceUrl: "https://github.com/pgexperts/pg_plan_filter",
    docsUrl: "https://github.com/pgexperts/pg_plan_filter#readme",
  },
  {
    name: "timescaledb",
    nix: { package: "timescaledb" },
    kind: "extension",
    soFileName: "timescaledb.so",
    category: "timeseries",
    description:
      "Hypertables, compression, and continuous aggregates for time-series workloads. Full version, Timescale License (TSL).",
    source: {
      type: "git",
      repository: "https://github.com/timescale/timescaledb.git",
      tag: "2.31.0",
    },
    runtime: {
      sharedPreload: true,
      defaultEnable: true,
      notes: [
        "Preloaded for optimal hypertable performance",
        "timescaledb.telemetry_level defaults to 'off' to avoid outbound telemetry.",
      ],
    },
    sourceUrl: "https://github.com/timescale/timescaledb",
    docsUrl: "https://docs.timescale.com/",
  },
  {
    name: "timescaledb_toolkit",
    nix: { package: "timescaledb_toolkit" },
    kind: "extension",
    soFileName: "timescaledb_toolkit-1.26.0.so",
    category: "timeseries",
    description: "Analytical hyperfunctions and sketches extending TimescaleDB.",
    source: {
      type: "git",
      repository: "https://github.com/timescale/timescaledb-toolkit.git",
      tag: "1.26.0",
    },
    build: {
      type: "cargo-pgrx",
      // Cargo.lock moved with `cargo update -p <crate> --precise <version>` at the pinned commit: hashbrown 0.15.1
      // (GHSA-wwq9-3cpr-mm53, HIGH) and rand 0.8.8 (GHSA-cq8v-f236-94qc). Regenerate the same way on a bump; drop it
      // once a release locks these; a stale one fails the build.
      patches: ["timescaledb_toolkit-cargo-lock.patch"],
    },
    dependencies: ["timescaledb"],
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
    },
    sourceUrl: "https://github.com/timescale/timescaledb-toolkit",
    docsUrl: "https://github.com/timescale/timescaledb-toolkit/tree/main/docs",
  },
  {
    name: "wal2json",
    nix: { package: "wal2json" },
    kind: "tool",
    category: "cdc",
    description: "Logical decoding output plugin streaming JSON data for CDC.",
    source: {
      type: "git",
      repository: "https://github.com/eulerto/wal2json.git",
      tag: "wal2json_2_7",
    },
    soFileName: "wal2json.so",
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: ["Requires wal_level=logical in postgresql.conf for CDC functionality."],
    },
    sourceUrl: "https://github.com/eulerto/wal2json",
    docsUrl: "https://github.com/eulerto/wal2json#readme",
  },
  {
    name: "pg_partman",
    nix: { package: "pg_partman" },
    kind: "extension",
    // Upstream also installs three optional Python helper scripts, which would pull Python and its CVEs into the image;
    // the image ships none (nix.bin: no binaryPath, so no bin/), since the extension and its background worker need no Python.
    soFileName: "pg_partman_bgw.so",
    category: "maintenance",
    description: "Declarative partition maintenance with optional background worker.",
    source: {
      type: "git",
      repository: "https://github.com/pgpartman/pg_partman.git",
      tag: "v5.5.0",
    },
    build: { type: "pgxs" },
    runtime: {
      sharedPreload: true,
      defaultEnable: false,
      preloadInComprehensiveTest: true,
      preloadLibraryName: "pg_partman_bgw",
      notes: [
        "Ships the pg_partman_bgw background worker; the Python helper scripts are not included",
        "Set pg_partman_bgw.dbname, interval and role to enable the background worker; since 5.5.0 role defaults to partman_maintainer, which must exist (upstream advises a non-superuser role)",
      ],
    },
    sourceUrl: "https://github.com/pgpartman/pg_partman",
    docsUrl: "https://github.com/pgpartman/pg_partman#readme",
  },
  {
    name: "vectorscale",
    nix: { package: "pgvectorscale" },
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
      ],
    },
    sourceUrl: "https://github.com/timescale/pgvectorscale",
    docsUrl: "https://github.com/timescale/pgvectorscale#readme",
  },
  {
    name: "hll",
    nix: { package: "pg_hll" },
    displayName: "postgresql-hll",
    kind: "extension",
    soFileName: "hll.so",
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
    },
    sourceUrl: "https://github.com/citusdata/postgresql-hll",
    docsUrl: "https://github.com/citusdata/postgresql-hll#readme",
  },
  {
    name: "pgbackrest",
    // systemd notify has no use in a container. SFTP repositories are off: no stack or deployment uses one (they
    // back up to S3), and libssh2 1.11.1, still its newest release, has unfixed CVEs a malicious SSH server can
    // reach (CVE-2026-66032 double free, CVE-2026-55200 out-of-bounds write); turn it back on with a libssh2
    // release carrying the fixes. zstd stays for compress-type=zst. Since 2.60 its build script (Python,
    // build-time only) reads YAML. nixpkgs configures Meson with --buildtype=plain (optimization "plain"), and
    // upstream's release build adds -funroll-loops -ftree-vectorize only at optimization 2 or 3, so
    // optimization=2 restores upstream's release flags (debug stays off, so its DEBUG-only code stays out).
    nix: {
      package: "pgbackrest",
      mesonFlags: [
        "-Dlibsystemd=disabled",
        "-Dlibssh2=disabled",
        "-Dlibzstd=enabled",
        "-Doptimization=2",
      ],
      nativeInputs: ["python3Packages.pyyaml"],
    },
    kind: "tool",
    // Never below 2.59.3: it fixes weak encryption sub-keys and salts.
    binaryPath: "/usr/bin/pgbackrest",
    postgresOwnedDirs: ["/var/lib/pgbackrest", "/var/log/pgbackrest", "/var/spool/pgbackrest"],
    category: "operations",
    description: "Parallel, incremental backup and restore CLI.",
    source: {
      type: "git",
      repository: "https://github.com/pgbackrest/pgbackrest.git",
      tag: "release/2.60.0",
    },
    runtime: {
      sharedPreload: false,
      defaultEnable: false,
      notes: [
        "CLI tool. NOT a PostgreSQL extension.",
        "Installs /usr/bin/pgbackrest. Since 2.59.0 only restore may run as root: run it as postgres (docker exec -u postgres) or set allow-root.",
      ],
    },
    sourceUrl: "https://github.com/pgbackrest/pgbackrest",
    docsUrl: "https://pgbackrest.org/user-guide.html",
  },
  {
    name: "set_user",
    displayName: "pgaudit_set_user",
    kind: "extension",
    soFileName: "set_user.so",
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
    },
    sourceUrl: "https://github.com/pgaudit/set_user",
    docsUrl: "https://github.com/pgaudit/set_user#readme",
  },
];
