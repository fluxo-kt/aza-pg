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

| Extension | Version | Enabled by Default | Shared Preload | Notes |
|-----------|---------|--------------------|----------------|-------|
| `pgvector` | v0.8.1 | Yes | No | Vector similarity search with IVF/HNSW indexes and distance operators. |
| `pgvectorscale` | 0.9.0 | No | No | DiskANN-inspired ANN index and quantization for pgvector embeddings. |

### analytics

| Extension | Version | Enabled by Default | Shared Preload | Notes |
|-----------|---------|--------------------|----------------|-------|
| `postgresql-hll` | v2.19 | No | No | HyperLogLog probabilistic counting data type. |

### cdc

| Extension | Version | Enabled by Default | Shared Preload | Notes |
|-----------|---------|--------------------|----------------|-------|
| `wal2json` | wal2json_2_6 | No | No | Logical decoding output plugin streaming JSON data for CDC. |

### distributed

| Extension | Version | Enabled by Default | Shared Preload | Notes |
|-----------|---------|--------------------|----------------|-------|
| `citus` | v13.2.0 | No | Yes | Distributed sharding and parallel execution across worker nodes. |

### gis

| Extension | Version | Enabled by Default | Shared Preload | Notes |
|-----------|---------|--------------------|----------------|-------|
| `pgrouting` | v3.8.0 | No | No | Routing algorithms (Dijkstra, A*, TSP) on top of PostGIS graphs. |
| `postgis` | 3.6.0 | No | No | Spatial types, functions, raster, and topology for PostgreSQL. |

### integration

| Extension | Version | Enabled by Default | Shared Preload | Notes |
|-----------|---------|--------------------|----------------|-------|
| `pg_net` | v0.9.3 | No | No | Async HTTP client inside PostgreSQL for webhooks and callbacks. |
| `pgsql-http` | v1.7.0 | No | No | Synchronous HTTP client for PostgreSQL built on libcurl. |
| `supabase-wrappers` | v0.5.6 | No | No | Rust FDW framework powering Supabase foreign wrappers. |

### maintenance

| Extension | Version | Enabled by Default | Shared Preload | Notes |
|-----------|---------|--------------------|----------------|-------|
| `pg_partman` | v5.3.1 | No | Yes | Declarative partition maintenance with optional background worker. |
| `pg_repack` | ver_1.5.3 | No | No | Online table/index reorganization without long locks. |

### observability

| Extension | Version | Enabled by Default | Shared Preload | Notes |
|-----------|---------|--------------------|----------------|-------|
| `pg_stat_monitor` | v0.6.0 | No | Yes | Enhanced query performance telemetry with bucketed metrics. |
| `pgbadger` | v13.1 | No | No | High-speed PostgreSQL log analyzer producing HTML/JSON reports. |

### operations

| Extension | Version | Enabled by Default | Shared Preload | Notes |
|-----------|---------|--------------------|----------------|-------|
| `pg_cron` | v1.6.7 | Yes | Yes | Lightweight cron-based job runner inside PostgreSQL. |
| `pgbackrest` | release/2.57.0 | No | No | Parallel, incremental backup and restore CLI. |

### performance

| Extension | Version | Enabled by Default | Shared Preload | Notes |
|-----------|---------|--------------------|----------------|-------|
| `hypopg` | 1.4.2 | No | No | Simulate hypothetical indexes for planner what-if analysis. |
| `index_advisor` | v0.2.0 | No | No | Suggest indexes by pairing HypoPG simulations with cost heuristics. |

### quality

| Extension | Version | Enabled by Default | Shared Preload | Notes |
|-----------|---------|--------------------|----------------|-------|
| `plpgsql_check` | v2.8.3 | No | No | Static analyzer for PL/pgSQL functions and triggers. |

### queueing

| Extension | Version | Enabled by Default | Shared Preload | Notes |
|-----------|---------|--------------------|----------------|-------|
| `pgmq` | v1.7.0 | No | No | Lightweight message queue for Postgres leveraging LISTEN/NOTIFY. |

### safety

| Extension | Version | Enabled by Default | Shared Preload | Notes |
|-----------|---------|--------------------|----------------|-------|
| `pg_plan_filter` | 5081a7b5 | No | Yes | Block high-cost plans or disallowed operations using planner hooks. |
| `pg_safeupdate` | 1.5 | No | No | Guards UPDATE/DELETE without WHERE clause or LIMIT. |
| `supautils` | v3.0.2 | Yes | Yes | Shared superuser guards and hooks for managed Postgres environments. |

### search

| Extension | Version | Enabled by Default | Shared Preload | Notes |
|-----------|---------|--------------------|----------------|-------|
| `pgroonga` | 4.0.4 | No | No | Full-text search powered by Groonga for multilingual workloads. |
| `rum` | 1.3.15 | No | No | RUM GiST access method for ranked full-text search. |

### security

| Extension | Version | Enabled by Default | Shared Preload | Notes |
|-----------|---------|--------------------|----------------|-------|
| `pgaudit` | 18.0 | Yes | Yes | Detailed auditing for DDL/DML activity with class-level granularity. |
| `pgaudit_set_user` | REL4_2_0 | No | Yes | Audited SET ROLE helper complementing pgaudit. |
| `pgsodium` | v3.1.9 | No | No | Modern cryptography and envelope encryption with libsodium. |
| `vault` | v0.3.1 | No | No | Supabase secret store for encrypted application credentials. |

### timeseries

| Extension | Version | Enabled by Default | Shared Preload | Notes |
|-----------|---------|--------------------|----------------|-------|
| `timescaledb` | 2.23.0 | Yes | Yes | Hypertables, compression, and continuous aggregates for time-series workloads. |
| `timescaledb_toolkit` | 1.21.0 | No | No | Analytical hyperfunctions and sketches extending TimescaleDB. |

### utilities

| Extension | Version | Enabled by Default | Shared Preload | Notes |
|-----------|---------|--------------------|----------------|-------|
| `pg_hashids` | v1.2.1 | No | No | Encode integers into short hashids for obfuscated identifiers. |

### validation

| Extension | Version | Enabled by Default | Shared Preload | Notes |
|-----------|---------|--------------------|----------------|-------|
| `pg_jsonschema` | v0.3.3 | No | No | JSON Schema validation for JSONB documents on INSERT/UPDATE. |

<!-- extensions-table:end -->

> **Tip:** The Markdown table is auto-generated. After modifying the manifest, rerun `bun scripts/extensions/render-markdown.ts` to refresh this section.

## Runtime Defaults

- `pg_stat_statements`, `pg_trgm`, `pgaudit`, `pg_cron`, and `pgvector` are created automatically during cluster bootstrap.
- Default `shared_preload_libraries` is `pg_stat_statements,pg_stat_monitor,auto_explain,pg_cron,pgaudit,supautils,timescaledb,citus`. Override with `POSTGRES_SHARED_PRELOAD_LIBRARIES` if you need a slimmer set.
- Everything else is installed but disabled. Enable on demand with `CREATE EXTENSION ...` once `shared_preload_libraries` includes the required module.

## Installation Notes by Category

- **AI / Vector** – `pgvector` ships enabled; `pgvectorscale` depends on `pgvector` and requires manual `CREATE EXTENSION vectorscale CASCADE`.
- **Time-series** – `timescaledb` is preloaded; use `CREATE EXTENSION timescaledb` to initialize in user databases. `timescaledb_toolkit` should be created after TimescaleDB and does not require preload.
- **Distributed** – `citus` is preloaded but left disabled. Configure worker topology (`citus.enable_shared_responsibilities`) before running `CREATE EXTENSION citus`.
- **Security** – `supautils` and `pgaudit` run by default to guard superuser operations. `pgsodium` and `vault` remain optional.
- **Operations** – `pgbackrest` binary lives in `/usr/local/bin/pgbackrest`; configure repositories via environment or volume mounts. `pgbadger` is available for offline log analysis.
- **Partitioning** – enable `pg_partman` and optional background worker via `ALTER SYSTEM SET shared_preload_libraries = '...,pg_partman_bgw'` followed by `SELECT partman_bgw_add_job(...)`.

## Upgrade Workflow

1. Update the desired entry in `scripts/extensions/manifest-data.ts` (new tag or metadata).
2. Regenerate derived artifacts:
   ```bash
   bun scripts/extensions/generate-manifest.ts
   bun scripts/extensions/render-markdown.ts
   ```
3. Build the Docker image locally to verify (`docker build -f docker/postgres/Dockerfile .`).
4. Run smoke tests (at minimum `CREATE EXTENSION` for the updated module).
5. Commit both the manifest/data changes and the regenerated docs.
