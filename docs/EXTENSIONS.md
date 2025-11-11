# PostgreSQL Extension Inventory

The `aza-pg` image ships a curated, SHA-pinned bundle of PostgreSQL extensions covering AI search, time-series analytics, geospatial processing, observability, security, and operations tooling. Every extension is compiled in the builder stage from an immutable source revision and listed in a single source of truth manifest.

Key principles:

- **Manifest driven.** Edit `scripts/extensions/manifest-data.ts` to change versions or metadata. Regenerate all derived assets with:
  ```bash
  bun scripts/extensions/generate-manifest.ts
  bun scripts/extensions/render-markdown.ts
  ```
- **Reproducibility.** The generated `docker/postgres/extensions.manifest.json` stores repo, tag, and commit for each entry. The Dockerfile consumes this manifest during the Docker build.
- **Runtime minimalism.** Only a small baseline is enabled automatically; everything else is installed but disabled by default so teams can opt in without rebuilding the image.

## Extension Classification

**This is the canonical reference for extension classification. Other docs reference this section.**

The aza-pg PostgreSQL extensions are classified into four categories:

- **Tools** (5 enabled): CLI utilities that do not require `CREATE EXTENSION`
  - Examples: pgbackrest, pgbadger, wal2json, pg_plan_filter, pg_safeupdate
  - Installed in `/usr/local/bin/` or configured via PostgreSQL hooks
  - Note: supautils is a tool but currently disabled

- **Builtins** (6): Core PostgreSQL extensions from contrib
  - Examples: auto_explain, pg_stat_statements, pg_trgm, plpgsql, btree_gin, btree_gist
  - Included in base PostgreSQL, require CREATE EXTENSION (except auto_explain module)

- **Extensions** (25 enabled): Additional extensions requiring `CREATE EXTENSION`
  - Installed in PostgreSQL extension directory
  - 6 auto-created by default: pg_cron, pg_stat_statements, pg_trgm, pgaudit, plpgsql, vector
  - 19 additional available on-demand
  - Total enabled catalog: 36 (6 builtin + 25 extensions + 5 tools)

- **Preloaded** (4): Extensions/modules loaded by default in `shared_preload_libraries`
  - auto_explain (module)
  - pg_cron (extension)
  - pg_stat_statements (extension)
  - pgaudit (extension)

## Extension Matrix

The tables below are generated from `extensions.manifest.json`. Columns indicate default enablement and whether `shared_preload_libraries` is required.

<!-- extensions-table:start -->

### ai

| Extension | Version | Enabled by Default | Shared Preload | Documentation | Notes |
|-----------|---------|--------------------|----------------|---------------|-------|
| [`vector (pgvector)`](https://github.com/pgvector/pgvector) | [v0.8.1](https://github.com/pgvector/pgvector/releases/tag/v0.8.1) | Yes | No | [Docs](https://github.com/pgvector/pgvector#readme) | Vector similarity search with IVF/HNSW indexes and distance operators. |
| [`vectorscale (pgvectorscale)`](https://github.com/timescale/pgvectorscale) | [0.9.0](https://github.com/timescale/pgvectorscale/releases/tag/0.9.0) | No | No | [Docs](https://github.com/timescale/pgvectorscale#readme) | DiskANN-inspired ANN index and quantization for pgvector embeddings. |

### analytics

| Extension | Version | Enabled by Default | Shared Preload | Documentation | Notes |
|-----------|---------|--------------------|----------------|---------------|-------|
| [`hll (postgresql-hll)`](https://github.com/citusdata/postgresql-hll) | [v2.19](https://github.com/citusdata/postgresql-hll/releases/tag/v2.19) | No | No | [Docs](https://github.com/citusdata/postgresql-hll#readme) | HyperLogLog probabilistic counting data type. |

### cdc

| Extension | Version | Enabled by Default | Shared Preload | Documentation | Notes |
|-----------|---------|--------------------|----------------|---------------|-------|
| [`wal2json`](https://github.com/eulerto/wal2json) | [wal2json_2_6](https://github.com/eulerto/wal2json/releases/tag/wal2json_2_6) | No | No | [Docs](https://github.com/eulerto/wal2json#readme) | Logical decoding output plugin streaming JSON data for CDC. |

### gis

| Extension | Version | Enabled by Default | Shared Preload | Documentation | Notes |
|-----------|---------|--------------------|----------------|---------------|-------|
| [`pgrouting`](https://github.com/pgRouting/pgrouting) | [v3.8.0](https://github.com/pgRouting/pgrouting/releases/tag/v3.8.0) | No | No | [Docs](https://docs.pgrouting.org) | Routing algorithms (Dijkstra, A*, TSP) on top of PostGIS graphs. |
| [`postgis`](https://github.com/postgis/postgis) | [3.6.0](https://github.com/postgis/postgis/releases/tag/3.6.0) | No | No | [Docs](https://postgis.net/documentation) | Spatial types, functions, raster, and topology for PostgreSQL. |

### integration

| Extension | Version | Enabled by Default | Shared Preload | Documentation | Notes |
|-----------|---------|--------------------|----------------|---------------|-------|
| [`http (pgsql-http)`](https://github.com/pramsey/pgsql-http) | [v1.7.0](https://github.com/pramsey/pgsql-http/releases/tag/v1.7.0) | No | No | [Docs](https://github.com/pramsey/pgsql-http#readme) | Synchronous HTTP client for PostgreSQL built on libcurl. |
| [`wrappers (supabase-wrappers)`](https://github.com/supabase/wrappers) | [fc63ad1f](https://github.com/supabase/wrappers/commit/fc63ad1fee7fcf94a84b7f5dfc6a1aa2124c7712) | No | No | [Docs](https://supabase.com/docs/guides/database/extensions/wrappers/overview) | Rust FDW framework powering Supabase foreign wrappers. |

### maintenance

| Extension | Version | Enabled by Default | Shared Preload | Documentation | Notes |
|-----------|---------|--------------------|----------------|---------------|-------|
| [`pg_partman`](https://github.com/pgpartman/pg_partman) | [v5.3.1](https://github.com/pgpartman/pg_partman/releases/tag/v5.3.1) | No | Yes | [Docs](https://github.com/pgpartman/pg_partman#readme) | Declarative partition maintenance with optional background worker. |
| [`pg_repack`](https://github.com/reorg/pg_repack) | [ver_1.5.3](https://github.com/reorg/pg_repack/releases/tag/ver_1.5.3) | No | No | [Docs](https://reorg.github.io/pg_repack) | Online table/index reorganization without long locks. |

### observability

| Extension | Version | Enabled by Default | Shared Preload | Documentation | Notes |
|-----------|---------|--------------------|----------------|---------------|-------|
| [`pg_stat_monitor`](https://github.com/percona/pg_stat_monitor) | [4ac02b24](https://github.com/percona/pg_stat_monitor/commit/4ac02b24433894b320b044ed30747d0c38e79fa5) | No | Yes | [Docs](https://docs.percona.com/pg-stat-monitor) | Enhanced query performance telemetry with bucketed metrics. |
| [`pgbadger`](https://github.com/darold/pgbadger) | [v13.1](https://github.com/darold/pgbadger/releases/tag/v13.1) | No | No | [Docs](https://pgbadger.darold.net/documentation.html) | High-speed PostgreSQL log analyzer producing HTML/JSON reports. |

### operations

| Extension | Version | Enabled by Default | Shared Preload | Documentation | Notes |
|-----------|---------|--------------------|----------------|---------------|-------|
| [`pg_cron`](https://github.com/citusdata/pg_cron) | [v1.6.7](https://github.com/citusdata/pg_cron/releases/tag/v1.6.7) | Yes | Yes | [Docs](https://github.com/citusdata/pg_cron#readme) | Lightweight cron-based job runner inside PostgreSQL. |
| [`pgbackrest`](https://github.com/pgbackrest/pgbackrest) | [release/2.57.0](https://github.com/pgbackrest/pgbackrest/releases/tag/release/2.57.0) | No | No | [Docs](https://pgbackrest.org/user-guide.html) | Parallel, incremental backup and restore CLI. |

### performance

| Extension | Version | Enabled by Default | Shared Preload | Documentation | Notes |
|-----------|---------|--------------------|----------------|---------------|-------|
| [`hypopg`](https://github.com/HypoPG/hypopg) | [1.4.2](https://github.com/HypoPG/hypopg/releases/tag/1.4.2) | No | No | [Docs](https://hypopg.readthedocs.io) | Simulate hypothetical indexes for planner what-if analysis. |
| [`index_advisor`](https://github.com/supabase/index_advisor) | [v0.2.0](https://github.com/supabase/index_advisor/releases/tag/v0.2.0) | No | No | [Docs](https://supabase.com/docs/guides/database/extensions/index_advisor) | Suggest indexes by pairing HypoPG simulations with cost heuristics. |

### quality

| Extension | Version | Enabled by Default | Shared Preload | Documentation | Notes |
|-----------|---------|--------------------|----------------|---------------|-------|
| [`plpgsql_check`](https://github.com/okbob/plpgsql_check) | [v2.8.3](https://github.com/okbob/plpgsql_check/releases/tag/v2.8.3) | No | No | [Docs](https://github.com/okbob/plpgsql_check#readme) | Static analyzer for PL/pgSQL functions and triggers. |

### queueing

| Extension | Version | Enabled by Default | Shared Preload | Documentation | Notes |
|-----------|---------|--------------------|----------------|---------------|-------|
| [`pgmq`](https://github.com/pgmq/pgmq) | [v1.7.0](https://github.com/tembo-io/pgmq/releases/tag/v1.7.0) | No | No | [Docs](https://github.com/pgmq/pgmq#readme) | Lightweight message queue for Postgres leveraging LISTEN/NOTIFY. |
| [`pgq (PgQ)`](https://github.com/pgq/pgq) | [v3.5.1](https://github.com/pgq/pgq/releases/tag/v3.5.1) | No | No | [Docs](https://wiki.postgresql.org/wiki/PGQ_Tutorial) | Generic high-performance lockless queue with simple SQL function API (supports PostgreSQL 10-18). |

### safety

| Extension | Version | Enabled by Default | Shared Preload | Documentation | Notes |
|-----------|---------|--------------------|----------------|---------------|-------|
| [`pg_plan_filter`](https://github.com/pgexperts/pg_plan_filter) | [5081a7b5](https://github.com/pgexperts/pg_plan_filter/commit/5081a7b5cb890876e67d8e7486b6a64c38c9a492) | No | Yes | [Docs](https://github.com/pgexperts/pg_plan_filter#readme) | Block high-cost plans or disallowed operations using planner hooks. |
| [`pg_safeupdate`](https://github.com/eradman/pg-safeupdate) | [1.5](https://github.com/eradman/pg-safeupdate/releases/tag/1.5) | No | No | [Docs](https://github.com/eradman/pg-safeupdate#readme) | Guards UPDATE/DELETE without WHERE clause or LIMIT. |
| [`supautils`](https://github.com/supabase/supautils) | [v3.0.2](https://github.com/supabase/supautils/releases/tag/v3.0.2) | No | Yes | [Docs](https://github.com/supabase/supautils#readme) | Shared superuser guards and hooks for managed Postgres environments. |

### search

| Extension | Version | Enabled by Default | Shared Preload | Documentation | Notes |
|-----------|---------|--------------------|----------------|---------------|-------|
| [`pgroonga`](https://github.com/pgroonga/pgroonga) | [4.0.4](https://github.com/pgroonga/pgroonga/releases/tag/4.0.4) | No | No | [Docs](https://pgroonga.github.io) | Full-text search powered by Groonga for multilingual workloads. |
| [`rum`](https://github.com/postgrespro/rum) | [1.3.15](https://github.com/postgrespro/rum/releases/tag/1.3.15) | No | No | [Docs](https://github.com/postgrespro/rum#readme) | RUM GiST access method for ranked full-text search. |

### security

| Extension | Version | Enabled by Default | Shared Preload | Documentation | Notes |
|-----------|---------|--------------------|----------------|---------------|-------|
| [`pgaudit`](https://github.com/pgaudit/pgaudit) | [18.0](https://github.com/pgaudit/pgaudit/releases/tag/18.0) | Yes | Yes | [Docs](https://www.pgaudit.org) | Detailed auditing for DDL/DML activity with class-level granularity. |
| [`pgsodium`](https://github.com/michelp/pgsodium) | [v3.1.9](https://github.com/michelp/pgsodium/releases/tag/v3.1.9) | No | No | [Docs](https://michelp.github.io/pgsodium) | Modern cryptography and envelope encryption with libsodium. |
| [`set_user (pgaudit_set_user)`](https://github.com/pgaudit/set_user) | [REL4_2_0](https://github.com/pgaudit/set_user/releases/tag/REL4_2_0) | No | Yes | [Docs](https://github.com/pgaudit/set_user#readme) | Audited SET ROLE helper complementing pgaudit. |
| [`supabase_vault (vault)`](https://github.com/supabase/vault) | [v0.3.1](https://github.com/supabase/vault/releases/tag/v0.3.1) | No | No | [Docs](https://supabase.com/docs/guides/database/vault) | Supabase secret store for encrypted application credentials. |

### timeseries

| Extension | Version | Enabled by Default | Shared Preload | Documentation | Notes |
|-----------|---------|--------------------|----------------|---------------|-------|
| [`timescaledb`](https://github.com/timescale/timescaledb) | [2.23.0](https://github.com/timescale/timescaledb/releases/tag/2.23.0) | No | Yes | [Docs](https://docs.tigerdata.com/use-timescale/latest/) | Hypertables, compression, and continuous aggregates for time-series workloads. |
| [`timescaledb_toolkit`](https://github.com/timescale/timescaledb-toolkit) | [1.22.0](https://github.com/timescale/timescaledb-toolkit/releases/tag/1.22.0) | No | No | [Docs](https://github.com/timescale/timescaledb-toolkit/tree/main/docs) | Analytical hyperfunctions and sketches extending TimescaleDB. |

### utilities

| Extension | Version | Enabled by Default | Shared Preload | Documentation | Notes |
|-----------|---------|--------------------|----------------|---------------|-------|
| [`pg_hashids`](https://github.com/iCyberon/pg_hashids) | [v1.2.1](https://github.com/iCyberon/pg_hashids/releases/tag/v1.2.1) | No | No | [Docs](https://github.com/iCyberon/pg_hashids#readme) | Encode integers into short hashids for obfuscated identifiers. |

### validation

| Extension | Version | Enabled by Default | Shared Preload | Documentation | Notes |
|-----------|---------|--------------------|----------------|---------------|-------|
| [`pg_jsonschema`](https://github.com/supabase/pg_jsonschema) | [e7834142](https://github.com/supabase/pg_jsonschema/commit/e7834142a3cce347b6082c5245de939810d3f9c4) | No | No | [Docs](https://supabase.com/docs/guides/database/extensions/pg_jsonschema) | JSON Schema validation for JSONB documents on INSERT/UPDATE. |

<!-- extensions-table:end -->

> **Tip:** The Markdown table is auto-generated. After modifying the manifest, rerun `bun scripts/extensions/render-markdown.ts` to refresh this section.

## Runtime Defaults

- `pg_stat_statements`, `pg_trgm`, `pgaudit`, `pg_cron`, `plpgsql`, and `vector` (pgvector) are created automatically during cluster bootstrap. Note: auto_explain is a preload-only module (not an extension) and does NOT require CREATE EXTENSION.
- Default `shared_preload_libraries` is `pg_stat_statements,auto_explain,pg_cron,pgaudit` (4 extensions preloaded by default). Override with `POSTGRES_SHARED_PRELOAD_LIBRARIES` if you need a different set.
- Optional extensions can be preloaded: `pg_stat_monitor`, `supautils`, `timescaledb`, `pgsodium` (requires pgsodium_getkey script for TCE), `pg_partman` (background worker), `set_user`, `pg_plan_filter`.
- Everything else is installed but disabled. Enable on demand with `CREATE EXTENSION ...` once `shared_preload_libraries` includes the required module (if needed).

## Installation Notes by Category

- **AI / Vector** – `vector` (pgvector) ships enabled; `vectorscale` (pgvectorscale) depends on `vector` and requires manual `CREATE EXTENSION vectorscale CASCADE`.
- **Time-series** – `timescaledb` is installed but not preloaded by default (enable via `POSTGRES_SHARED_PRELOAD_LIBRARIES` if needed); use `CREATE EXTENSION timescaledb` to initialize in user databases. `timescaledb_toolkit` should be created after TimescaleDB and does not require preload.
- **Distributed** – Citus does not yet support PostgreSQL 18 GA (see Compatibility Exceptions); clustering remains unavailable in this image until upstream releases PG18 support.
- **Security** – `pgaudit` runs by default (preloaded) to guard operations. `supautils` is installed but not preloaded by default (can be enabled via `POSTGRES_SHARED_PRELOAD_LIBRARIES`). `pgsodium` and `vault` remain optional.
- **Operations** – `pgbackrest` binary lives in `/usr/local/bin/pgbackrest`; configure repositories via environment or volume mounts. `pgbadger` is available for offline log analysis.
- **Partitioning** – enable `pg_partman` and optional background worker via `ALTER SYSTEM SET shared_preload_libraries = '...,pg_partman_bgw'` followed by `SELECT partman_bgw_add_job(...)`.

## Compatibility Exceptions

- **Citus** – The latest upstream release (Citus 13.0 on 2025-02-10) only supports PostgreSQL 17 and earlier, so the extension is intentionally omitted from the PostgreSQL 18 image to avoid shipping an incompatible build. We will add it once an official PG18-compatible release lands.
- **pg_net** – Supabase’s published metadata lists official support for PostgreSQL 13–17; the code currently fails to compile on PostgreSQL 18, so we exclude it until a PG18-compatible release is available.

## Enabling and Disabling Extensions

The aza-pg image uses a manifest-driven system that allows you to build custom images with only the extensions you need. This reduces build time and image size.

### How to Disable an Extension

1. **Edit the manifest:** Open `scripts/extensions/manifest-data.ts` and locate the extension entry.

2. **Set enabled to false:** Add `enabled: false` and optionally provide a reason:

   ```typescript
   {
     name: "pgq",
     kind: "extension",
     category: "queueing",
     enabled: false,  // Disable at build-time
     disabledReason: "Using pgmq instead - more features, same performance",
     // ... rest of entry
   }
   ```

3. **Regenerate artifacts:** Run the manifest generator to update derived files:

   ```bash
   bun scripts/extensions/generate-manifest.ts
   ```

4. **Build the image:** Build your custom image:
   ```bash
   bun run build
   ```

### Manifest Fields

- **`enabled`** (build-time): Controls whether extension is compiled and bundled into the image. Default: `true`.
- **`disabledReason`** (optional): Explanation for why extension is disabled. Shown in build logs.
- **`runtime.defaultEnable`** (runtime): Separate field controlling whether `CREATE EXTENSION` runs automatically in `01-extensions.sql`. Default: `false`.

### Core Extension Protection

The following extensions **cannot be disabled** because they are required by the system or are preloaded by default:

- `auto_explain` (preloaded for query diagnostics)
- `pg_cron` (preloaded for job scheduling)
- `pg_stat_statements` (preloaded for query monitoring)
- `pgaudit` (preloaded for audit logging)

The manifest validation will fail if you attempt to disable these extensions.

### Example: Creating a Minimal AI Image

```typescript
// scripts/extensions/manifest-data.ts

// Keep: Vector extensions
{ name: "vector", enabled: true, ... },
{ name: "vectorscale", enabled: true, ... },

// Disable: Time-series (not needed for AI workloads)
{ name: "timescaledb", enabled: false, disabledReason: "AI workload - no time-series data" },
{ name: "timescaledb_toolkit", enabled: false, disabledReason: "AI workload - no time-series data" },

// Disable: GIS (not needed for AI workloads)
{ name: "postgis", enabled: false, disabledReason: "AI workload - no geospatial data" },
{ name: "pgrouting", enabled: false, disabledReason: "AI workload - no geospatial data" },
```

**Result:** Smaller image (~900MB vs ~1.14GB), faster build (~7 min vs ~12 min).

### Dependency Validation

The system automatically validates dependencies. If you disable an extension that another enabled extension depends on, the build will fail with a clear error:

```
❌ Dependency validation failed:

  - Extension "index_advisor" depends on "hypopg", but "hypopg" is disabled

Fix: Either enable "hypopg" or disable "index_advisor"
```

Common dependency chains:

- `index_advisor` → `hypopg`
- `vectorscale` → `vector`
- `supabase_vault` → `pgsodium`
- `timescaledb_toolkit` → `timescaledb`
- `pgrouting` → `postgis`

To enable or disable extensions, edit `scripts/extensions/manifest-data.ts` and set the `enabled` field, then run `bun run generate` and rebuild the image.

## Upgrade Workflow

1. Update the desired entry in `scripts/extensions/manifest-data.ts` (new tag or metadata).
2. Regenerate derived artifacts:
   ```bash
   bun scripts/extensions/generate-manifest.ts
   bun scripts/extensions/render-markdown.ts
   ```
3. Build the Docker image locally to verify (`bun run build`).
4. Run smoke tests (at minimum `CREATE EXTENSION` for the updated module).
5. Commit both the manifest/data changes and the regenerated docs.

## Extension Source Decisions

**PIGSTY Repository Evaluation:**

PIGSTY (PostgreSQL extension repository with 420+ extensions) was evaluated as an alternative to the current SHA-pinned source compilation strategy but not adopted due to:

- **PostgreSQL 18 GA support:** PIGSTY v3.5.0/v3.6.0 only provide beta support for PG18; production-grade support is planned for v4.0 (timeline TBD, estimated Q1-Q2 2026)
- **Supply chain model:** Current SHA-pinned approach provides immutable source verification; PIGSTY introduces package maintainer as intermediary in trust chain
- **Maintenance strategy:** Single source approach (PGDG packages + selective source builds) maintains simplicity without added repository dependencies

This decision may be revisited as PIGSTY v4.0 matures and demonstrates stable PostgreSQL 18 support in production environments. See git history (`.archived/docs/analysis/PIGSTY-EVALUATION.md`) for detailed evaluation including security assessment, compatibility matrix, and migration considerations.
