# PostgreSQL Extension Inventory

The `aza-pg` image ships a curated, SHA-pinned bundle of PostgreSQL extensions covering AI search, time-series analytics, geospatial processing, observability, security, and operations tooling. Every extension is compiled in the builder stage from an immutable source revision and listed in a single source of truth manifest.

Key principles:

- **Manifest driven.** Edit `scripts/extensions/manifest-data.ts` to change versions or metadata. Regenerate all derived assets with:
  ```bash
  bun scripts/extensions/generate-manifest.ts
  bun scripts/extensions/render-markdown.ts
  ```
- **Reproducibility.** The generated `docker/postgres/extensions.manifest.json` stores repo, tag, and commit for each entry. `docker/postgres/build-extensions.sh` consumes this manifest during the Docker build.
- **Runtime minimalism.** Only a small baseline is enabled automatically; everything else is installed but disabled by default so teams can opt in without rebuilding the image.

## Extension Matrix

The tables below are generated from `extensions.manifest.json`. Columns indicate default enablement and whether `shared_preload_libraries` is required.

<!-- extensions-table:start -->

### ai

| Extension                     | Version | Enabled by Default | Shared Preload | Notes                                                                  |
| ----------------------------- | ------- | ------------------ | -------------- | ---------------------------------------------------------------------- |
| `vector` (pgvector)           | v0.8.1  | Yes                | No             | Vector similarity search with IVF/HNSW indexes and distance operators. |
| `vectorscale` (pgvectorscale) | 0.9.0   | No                 | No             | DiskANN-inspired ANN index and quantization for pgvector embeddings.   |

### analytics

| Extension              | Version | Enabled by Default | Shared Preload | Notes                                         |
| ---------------------- | ------- | ------------------ | -------------- | --------------------------------------------- |
| `hll` (postgresql-hll) | v2.19   | No                 | No             | HyperLogLog probabilistic counting data type. |

### cdc

| Extension  | Version      | Enabled by Default | Shared Preload | Notes                                                       |
| ---------- | ------------ | ------------------ | -------------- | ----------------------------------------------------------- |
| `wal2json` | wal2json_2_6 | No                 | No             | Logical decoding output plugin streaming JSON data for CDC. |

### gis

| Extension   | Version | Enabled by Default | Shared Preload | Notes                                                             |
| ----------- | ------- | ------------------ | -------------- | ----------------------------------------------------------------- |
| `pgrouting` | v3.8.0  | No                 | No             | Routing algorithms (Dijkstra, A\*, TSP) on top of PostGIS graphs. |
| `postgis`   | 3.6.0   | No                 | No             | Spatial types, functions, raster, and topology for PostgreSQL.    |

### integration

| Extension                      | Version | Enabled by Default | Shared Preload | Notes                                                    |
| ------------------------------ | ------- | ------------------ | -------------- | -------------------------------------------------------- |
| `http` (pgsql-http)            | v1.7.0  | No                 | No             | Synchronous HTTP client for PostgreSQL built on libcurl. |
| `wrappers` (supabase-wrappers) | v0.5.6  | No                 | No             | Rust FDW framework powering Supabase foreign wrappers.   |

### maintenance

| Extension    | Version   | Enabled by Default | Shared Preload | Notes                                                              |
| ------------ | --------- | ------------------ | -------------- | ------------------------------------------------------------------ |
| `pg_partman` | v5.3.1    | No                 | Yes            | Declarative partition maintenance with optional background worker. |
| `pg_repack`  | ver_1.5.3 | No                 | No             | Online table/index reorganization without long locks.              |

### observability

| Extension         | Version  | Enabled by Default | Shared Preload | Notes                                                           |
| ----------------- | -------- | ------------------ | -------------- | --------------------------------------------------------------- |
| `pg_stat_monitor` | 4ac02b24 | No                 | Yes            | Enhanced query performance telemetry with bucketed metrics.     |
| `pgbadger`        | v13.1    | No                 | No             | High-speed PostgreSQL log analyzer producing HTML/JSON reports. |

### operations

| Extension    | Version        | Enabled by Default | Shared Preload | Notes                                                |
| ------------ | -------------- | ------------------ | -------------- | ---------------------------------------------------- |
| `pg_cron`    | v1.6.7         | Yes                | Yes            | Lightweight cron-based job runner inside PostgreSQL. |
| `pgbackrest` | release/2.57.0 | No                 | No             | Parallel, incremental backup and restore CLI.        |

### performance

| Extension       | Version | Enabled by Default | Shared Preload | Notes                                                               |
| --------------- | ------- | ------------------ | -------------- | ------------------------------------------------------------------- |
| `hypopg`        | 1.4.2   | No                 | No             | Simulate hypothetical indexes for planner what-if analysis.         |
| `index_advisor` | v0.2.0  | No                 | No             | Suggest indexes by pairing HypoPG simulations with cost heuristics. |

### quality

| Extension       | Version | Enabled by Default | Shared Preload | Notes                                                |
| --------------- | ------- | ------------------ | -------------- | ---------------------------------------------------- |
| `plpgsql_check` | v2.8.3  | No                 | No             | Static analyzer for PL/pgSQL functions and triggers. |

### queueing

| Extension   | Version | Enabled by Default | Shared Preload | Notes                                                                                             |
| ----------- | ------- | ------------------ | -------------- | ------------------------------------------------------------------------------------------------- |
| `pgmq`      | v1.7.0  | No                 | No             | Lightweight message queue for Postgres leveraging LISTEN/NOTIFY.                                  |
| `pgq` (PgQ) | v3.5.1  | No                 | No             | Generic high-performance lockless queue with simple SQL function API (supports PostgreSQL 10-18). |

### safety

| Extension        | Version  | Enabled by Default | Shared Preload | Notes                                                                |
| ---------------- | -------- | ------------------ | -------------- | -------------------------------------------------------------------- |
| `pg_plan_filter` | 5081a7b5 | No                 | Yes            | Block high-cost plans or disallowed operations using planner hooks.  |
| `pg_safeupdate`  | 1.5      | No                 | No             | Guards UPDATE/DELETE without WHERE clause or LIMIT.                  |
| `supautils`      | v3.0.2   | No                 | Yes            | Shared superuser guards and hooks for managed Postgres environments. |

### search

| Extension  | Version | Enabled by Default | Shared Preload | Notes                                                           |
| ---------- | ------- | ------------------ | -------------- | --------------------------------------------------------------- |
| `pgroonga` | 4.0.4   | No                 | No             | Full-text search powered by Groonga for multilingual workloads. |
| `rum`      | 1.3.15  | No                 | No             | RUM GiST access method for ranked full-text search.             |

### security

| Extension                     | Version  | Enabled by Default | Shared Preload | Notes                                                                |
| ----------------------------- | -------- | ------------------ | -------------- | -------------------------------------------------------------------- |
| `pgaudit`                     | 18.0     | Yes                | Yes            | Detailed auditing for DDL/DML activity with class-level granularity. |
| `pgsodium`                    | v3.1.9   | No                 | No             | Modern cryptography and envelope encryption with libsodium.          |
| `set_user` (pgaudit_set_user) | REL4_2_0 | No                 | Yes            | Audited SET ROLE helper complementing pgaudit.                       |
| `supabase_vault` (vault)      | v0.3.1   | No                 | No             | Supabase secret store for encrypted application credentials.         |

### timeseries

| Extension             | Version | Enabled by Default | Shared Preload | Notes                                                                          |
| --------------------- | ------- | ------------------ | -------------- | ------------------------------------------------------------------------------ |
| `timescaledb`         | 2.23.0  | No                 | Yes            | Hypertables, compression, and continuous aggregates for time-series workloads. |
| `timescaledb_toolkit` | 1.22.0  | No                 | No             | Analytical hyperfunctions and sketches extending TimescaleDB.                  |

### utilities

| Extension    | Version | Enabled by Default | Shared Preload | Notes                                                          |
| ------------ | ------- | ------------------ | -------------- | -------------------------------------------------------------- |
| `pg_hashids` | v1.2.1  | No                 | No             | Encode integers into short hashids for obfuscated identifiers. |

### validation

| Extension       | Version  | Enabled by Default | Shared Preload | Notes                                                        |
| --------------- | -------- | ------------------ | -------------- | ------------------------------------------------------------ |
| `pg_jsonschema` | e7834142 | No                 | No             | JSON Schema validation for JSONB documents on INSERT/UPDATE. |

<!-- extensions-table:end -->

> **Tip:** The Markdown table is auto-generated. After modifying the manifest, rerun `bun scripts/extensions/render-markdown.ts` to refresh this section.

## Runtime Defaults

- `pg_stat_statements`, `pg_trgm`, `pgaudit`, `pg_cron`, and `vector` (pgvector) are created automatically during cluster bootstrap.
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
   ./scripts/build.sh
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

See [docs/development/EXTENSION-ENABLE-DISABLE.md](development/EXTENSION-ENABLE-DISABLE.md) for complete implementation details, testing strategy, and advanced customization scenarios.

## Upgrade Workflow

1. Update the desired entry in `scripts/extensions/manifest-data.ts` (new tag or metadata).
2. Regenerate derived artifacts:
   ```bash
   bun scripts/extensions/generate-manifest.ts
   bun scripts/extensions/render-markdown.ts
   ```
3. Build the Docker image locally to verify (`./scripts/build.sh`).
4. Run smoke tests (at minimum `CREATE EXTENSION` for the updated module).
5. Commit both the manifest/data changes and the regenerated docs.
