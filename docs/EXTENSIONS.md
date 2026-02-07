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

**Canonical classification; counts derived from `docs/.generated/docs-data.json`.**

aza-pg classifies bundled functionality into four buckets:

- **Tools** (4): CLI / hook utilities that do not require `CREATE EXTENSION`
  - Examples: pgbackrest, pgbadger, wal2json, pg_safeupdate
  - Installed in `/usr/local/bin/` or wired via PostgreSQL hooks
  - Note: pg_plan_filter is currently disabled (manifest-controlled)

- **Builtins** (6): Core PostgreSQL contrib extensions
  - Examples: auto_explain, pg_stat_statements, pg_trgm, plpgsql, btree_gin, btree_gist
  - Shipped with PostgreSQL; require `CREATE EXTENSION` (except auto_explain module)

- **Extensions**: Additional catalog entries requiring `CREATE EXTENSION`
  - Installed in the PostgreSQL extension directory
  - Multiple extensions auto-created by default during cluster bootstrap (see `autoCreated` in `docs/.generated/docs-data.json`)
  - Remaining enabled entries are available on demand via `CREATE EXTENSION`
  - Some extensions are disabled by default (tracked in manifest with `disabledReason`)

- **Preloaded** (9): Modules/extensions loaded by default via `shared_preload_libraries`
  - auto_explain (module)
  - pg_cron (extension)
  - pg_net (extension)
  - pg_stat_monitor (extension)
  - pg_stat_statements (extension)
  - pgaudit (extension)
  - pgsodium (extension)
  - safeupdate (tool)
  - timescaledb (extension)

## Extension Matrix

The tables below are generated from `extensions.manifest.json`. Columns indicate default enablement and whether `shared_preload_libraries` is required.

- Default `shared_preload_libraries` (from manifest) is:
  `auto_explain,pg_cron,pg_net,pg_stat_monitor,pg_stat_statements,pgaudit,pgsodium,safeupdate,timescaledb`
  (9 entries preloaded by default). Override with `POSTGRES_SHARED_PRELOAD_LIBRARIES` if you need a different set.

<!-- extensions-table:start -->

### ai

| Extension                                                                   | Version                                                                | Enabled by Default | Shared Preload | Documentation                                             | Notes                                                                  |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------ | -------------- | --------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`vector (pgvector)`](https://github.com/pgvector/pgvector)                 | [v0.8.1](https://github.com/pgvector/pgvector/releases/tag/v0.8.1)     | Yes                | No             | [Docs](https://github.com/pgvector/pgvector#readme)       | Vector similarity search with IVF/HNSW indexes and distance operators. |
| [`vectorscale (pgvectorscale)`](https://github.com/timescale/pgvectorscale) | [0.9.0](https://github.com/timescale/pgvectorscale/releases/tag/0.9.0) | Yes                | No             | [Docs](https://github.com/timescale/pgvectorscale#readme) | DiskANN-inspired ANN index and quantization for pgvector embeddings.   |

### analytics

| Extension                                                             | Version                                                                 | Enabled by Default | Shared Preload | Documentation                                              | Notes                                         |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------ | -------------- | ---------------------------------------------------------- | --------------------------------------------- |
| [`hll (postgresql-hll)`](https://github.com/citusdata/postgresql-hll) | [v2.19](https://github.com/citusdata/postgresql-hll/releases/tag/v2.19) | No                 | No             | [Docs](https://github.com/citusdata/postgresql-hll#readme) | HyperLogLog probabilistic counting data type. |

### cdc

| Extension                                         | Version                                                                       | Enabled by Default | Shared Preload | Documentation                                      | Notes                                                       |
| ------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------ | -------------- | -------------------------------------------------- | ----------------------------------------------------------- |
| [`wal2json`](https://github.com/eulerto/wal2json) | [wal2json_2_6](https://github.com/eulerto/wal2json/releases/tag/wal2json_2_6) | No                 | No             | [Docs](https://github.com/eulerto/wal2json#readme) | Logical decoding output plugin streaming JSON data for CDC. |

### gis

| Extension                                             | Version                                                              | Enabled by Default | Shared Preload | Documentation                             | Notes                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------- | ------------------ | -------------- | ----------------------------------------- | ----------------------------------------------------------------- |
| [`pgrouting`](https://github.com/pgRouting/pgrouting) | [v4.0.0](https://github.com/pgRouting/pgrouting/releases/tag/v4.0.0) | No                 | No             | [Docs](https://docs.pgrouting.org)        | Routing algorithms (Dijkstra, A\*, TSP) on top of PostGIS graphs. |
| [`postgis`](https://github.com/postgis/postgis)       | [3.6.1](https://github.com/postgis/postgis/releases/tag/3.6.1)       | No                 | No             | [Docs](https://postgis.net/documentation) | Spatial types, functions, raster, and topology for PostgreSQL.    |

### integration

| Extension                                                              | Version                                                             | Enabled by Default | Shared Preload | Documentation                                                                  | Notes                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------ | -------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| [`http (pgsql-http)`](https://github.com/pramsey/pgsql-http)           | [v1.7.0](https://github.com/pramsey/pgsql-http/releases/tag/v1.7.0) | No                 | No             | [Docs](https://github.com/pramsey/pgsql-http#readme)                           | Synchronous HTTP client for PostgreSQL built on libcurl.              |
| [`pg_net`](https://github.com/supabase/pg_net)                         | [v0.20.2](https://github.com/supabase/pg_net/releases/tag/v0.20.2)  | Yes                | Yes            | [Docs](https://supabase.github.io/pg_net/)                                     | Async HTTP/HTTPS requests from PostgreSQL for webhooks and API calls. |
| [`wrappers (supabase-wrappers)`](https://github.com/supabase/wrappers) | [v0.5.7](https://github.com/supabase/wrappers/releases/tag/v0.5.7)  | No                 | No             | [Docs](https://supabase.com/docs/guides/database/extensions/wrappers/overview) | Rust FDW framework powering Supabase foreign wrappers.                |

### maintenance

| Extension                                               | Version                                                                | Enabled by Default | Shared Preload | Documentation                                          | Notes                                                              |
| ------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------ | -------------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| [`pg_partman`](https://github.com/pgpartman/pg_partman) | [v5.4.0](https://github.com/pgpartman/pg_partman/releases/tag/v5.4.0)  | No                 | Yes            | [Docs](https://github.com/pgpartman/pg_partman#readme) | Declarative partition maintenance with optional background worker. |
| [`pg_repack`](https://github.com/reorg/pg_repack)       | [ver_1.5.3](https://github.com/reorg/pg_repack/releases/tag/ver_1.5.3) | No                 | No             | [Docs](https://reorg.github.io/pg_repack)              | Online table/index reorganization without long locks.              |

### observability

| Extension                                                       | Version                                                                | Enabled by Default | Shared Preload | Documentation                                          | Notes                                                           |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------ | -------------- | ------------------------------------------------------ | --------------------------------------------------------------- |
| [`pg_stat_monitor`](https://github.com/percona/pg_stat_monitor) | [2.3.1](https://github.com/percona/pg_stat_monitor/releases/tag/2.3.1) | Yes                | Yes            | [Docs](https://docs.percona.com/pg-stat-monitor)       | Enhanced query performance telemetry with bucketed metrics.     |
| [`pgbadger`](https://github.com/darold/pgbadger)                | [v13.2](https://github.com/darold/pgbadger/releases/tag/v13.2)         | No                 | No             | [Docs](https://pgbadger.darold.net/documentation.html) | High-speed PostgreSQL log analyzer producing HTML/JSON reports. |

### operations

| Extension                                                | Version                                                                                | Enabled by Default | Shared Preload | Documentation                                       | Notes                                                |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------ | -------------- | --------------------------------------------------- | ---------------------------------------------------- |
| [`pg_cron`](https://github.com/citusdata/pg_cron)        | [v1.6.7](https://github.com/citusdata/pg_cron/releases/tag/v1.6.7)                     | Yes                | Yes            | [Docs](https://github.com/citusdata/pg_cron#readme) | Lightweight cron-based job runner inside PostgreSQL. |
| [`pgbackrest`](https://github.com/pgbackrest/pgbackrest) | [release/2.58.0](https://github.com/pgbackrest/pgbackrest/releases/tag/release/2.58.0) | No                 | No             | [Docs](https://pgbackrest.org/user-guide.html)      | Parallel, incremental backup and restore CLI.        |

### performance

| Extension                                                    | Version                                                                 | Enabled by Default | Shared Preload | Documentation                                                              | Notes                                                               |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- | ------------------ | -------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [`hypopg`](https://github.com/HypoPG/hypopg)                 | [1.4.2](https://github.com/HypoPG/hypopg/releases/tag/1.4.2)            | No                 | No             | [Docs](https://hypopg.readthedocs.io)                                      | Simulate hypothetical indexes for planner what-if analysis.         |
| [`index_advisor`](https://github.com/supabase/index_advisor) | [v0.2.0](https://github.com/supabase/index_advisor/releases/tag/v0.2.0) | No                 | No             | [Docs](https://supabase.com/docs/guides/database/extensions/index_advisor) | Suggest indexes by pairing HypoPG simulations with cost heuristics. |

### quality

| Extension                                                 | Version                                                              | Enabled by Default | Shared Preload | Documentation                                         | Notes                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------- | ------------------ | -------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| [`plpgsql_check`](https://github.com/okbob/plpgsql_check) | [v2.8.8](https://github.com/okbob/plpgsql_check/releases/tag/v2.8.8) | No                 | No             | [Docs](https://github.com/okbob/plpgsql_check#readme) | Static analyzer for PL/pgSQL functions and triggers. |

### queueing

| Extension                                 | Version                                                          | Enabled by Default | Shared Preload | Documentation                                         | Notes                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------- | ------------------ | -------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [`pgmq`](https://github.com/pgmq/pgmq)    | [v1.10.0](https://github.com/tembo-io/pgmq/releases/tag/v1.10.0) | Yes                | No             | [Docs](https://github.com/pgmq/pgmq#readme)           | Lightweight message queue for Postgres leveraging LISTEN/NOTIFY.                                  |
| [`pgq (PgQ)`](https://github.com/pgq/pgq) | [v3.5.1](https://github.com/pgq/pgq/releases/tag/v3.5.1)         | No                 | No             | [Docs](https://wiki.postgresql.org/wiki/PGQ_Tutorial) | Generic high-performance lockless queue with simple SQL function API (supports PostgreSQL 10-18). |

### safety

| Extension                                                       | Version                                                                                                 | Enabled by Default | Shared Preload | Documentation                                              | Notes                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------ | -------------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| [`pg_plan_filter`](https://github.com/pgexperts/pg_plan_filter) | [5081a7b5](https://github.com/pgexperts/pg_plan_filter/commit/5081a7b5cb890876e67d8e7486b6a64c38c9a492) | No                 | Yes            | [Docs](https://github.com/pgexperts/pg_plan_filter#readme) | Block high-cost plans or disallowed operations using planner hooks.  |
| [`pg_safeupdate`](https://github.com/eradman/pg-safeupdate)     | [1.5](https://github.com/eradman/pg-safeupdate/releases/tag/1.5)                                        | Yes                | Yes            | [Docs](https://github.com/eradman/pg-safeupdate#readme)    | Guards UPDATE/DELETE without WHERE clause or LIMIT.                  |
| [`supautils`](https://github.com/supabase/supautils)            | [v3.1.0](https://github.com/supabase/supautils/releases/tag/v3.1.0)                                     | No                 | Yes            | [Docs](https://github.com/supabase/supautils#readme)       | Shared superuser guards and hooks for managed Postgres environments. |

### search

| Extension                                          | Version                                                          | Enabled by Default | Shared Preload | Documentation                                     | Notes                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------- | ------------------ | -------------- | ------------------------------------------------- | --------------------------------------------------------------- |
| [`pgroonga`](https://github.com/pgroonga/pgroonga) | [4.0.5](https://github.com/pgroonga/pgroonga/releases/tag/4.0.5) | No                 | No             | [Docs](https://pgroonga.github.io)                | Full-text search powered by Groonga for multilingual workloads. |
| [`rum`](https://github.com/postgrespro/rum)        | [1.3.15](https://github.com/postgrespro/rum/releases/tag/1.3.15) | No                 | No             | [Docs](https://github.com/postgrespro/rum#readme) | RUM GiST access method for ranked full-text search.             |

### security

| Extension                                                            | Version                                                               | Enabled by Default | Shared Preload | Documentation                                           | Notes                                                                |
| -------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------ | -------------- | ------------------------------------------------------- | -------------------------------------------------------------------- |
| [`pgaudit`](https://github.com/pgaudit/pgaudit)                      | [18.0](https://github.com/pgaudit/pgaudit/releases/tag/18.0)          | Yes                | Yes            | [Docs](https://www.pgaudit.org)                         | Detailed auditing for DDL/DML activity with class-level granularity. |
| [`pgsodium`](https://github.com/michelp/pgsodium)                    | [v3.1.9](https://github.com/michelp/pgsodium/releases/tag/v3.1.9)     | Yes                | Yes            | [Docs](https://michelp.github.io/pgsodium)              | Modern cryptography and envelope encryption with libsodium.          |
| [`set_user (pgaudit_set_user)`](https://github.com/pgaudit/set_user) | [REL4_2_0](https://github.com/pgaudit/set_user/releases/tag/REL4_2_0) | No                 | Yes            | [Docs](https://github.com/pgaudit/set_user#readme)      | Audited SET ROLE helper complementing pgaudit.                       |
| [`supabase_vault (vault)`](https://github.com/supabase/vault)        | [v0.3.1](https://github.com/supabase/vault/releases/tag/v0.3.1)       | Yes                | No             | [Docs](https://supabase.com/docs/guides/database/vault) | Supabase secret store for encrypted application credentials.         |

### timeseries

| Extension                                                                 | Version                                                                        | Enabled by Default | Shared Preload | Documentation                                                           | Notes                                                                                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------ | -------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [`timescaledb`](https://github.com/timescale/timescaledb)                 | [2.25.0](https://github.com/timescale/timescaledb/releases/tag/2.25.0)         | Yes                | Yes            | [Docs](https://docs.timescale.com/)                                     | Hypertables, compression, and continuous aggregates for time-series workloads. Full version, Timescale License (TSL). |
| [`timescaledb_toolkit`](https://github.com/timescale/timescaledb-toolkit) | [1.22.0](https://github.com/timescale/timescaledb-toolkit/releases/tag/1.22.0) | No                 | No             | [Docs](https://github.com/timescale/timescaledb-toolkit/tree/main/docs) | Analytical hyperfunctions and sketches extending TimescaleDB.                                                         |

### utilities

| Extension                                              | Version                                                                                            | Enabled by Default | Shared Preload | Documentation                                         | Notes                                                          |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------ | -------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| [`pg_hashids`](https://github.com/iCyberon/pg_hashids) | [8c404dd8](https://github.com/iCyberon/pg_hashids/commit/8c404dd86408f3a987a3ff6825ac7e42bd618b98) | No                 | No             | [Docs](https://github.com/iCyberon/pg_hashids#readme) | Encode integers into short hashids for obfuscated identifiers. |

### validation

| Extension                                                    | Version                                                                                               | Enabled by Default | Shared Preload | Documentation                                                              | Notes                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------ | -------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [`pg_jsonschema`](https://github.com/supabase/pg_jsonschema) | [7c8603f1](https://github.com/supabase/pg_jsonschema/commit/7c8603f14d8d20ea84435b0b8409a4e1a40147b0) | No                 | No             | [Docs](https://supabase.com/docs/guides/database/extensions/pg_jsonschema) | JSON Schema validation for JSONB documents on INSERT/UPDATE. |

### workflow

| Extension                                        | Version                                                                          | Enabled by Default | Shared Preload | Documentation              | Notes                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------ | -------------- | -------------------------- | ------------------------------------------------------------------------- |
| [`pgflow`](https://github.com/pgflow-dev/pgflow) | [pgflow@0.13.3](https://github.com/pgflow-dev/pgflow/releases/tag/pgflow@0.13.3) | Yes                | No             | [Docs](https://pgflow.dev) | DAG-based workflow orchestration engine with step-by-step task execution. |

<!-- extensions-table:end -->

> **Tip:** The Markdown table is auto-generated. After modifying the manifest, rerun `bun scripts/extensions/render-markdown.ts` to refresh this section.

## Runtime Defaults

- Baseline auto-created extensions during cluster bootstrap:
  - `pg_cron`, `pg_stat_monitor`, `pg_stat_statements`, `pg_trgm`, `pgaudit`, `pgmq`, `plpgsql`, `timescaledb`, `vector`, `vectorscale`
  - Note: `auto_explain` is a preload-only module (not an extension) and does NOT require CREATE EXTENSION.
- Default `shared_preload_libraries` is `auto_explain,pg_cron,pg_net,pg_stat_monitor,pg_stat_statements,pgaudit,pgsodium,safeupdate,timescaledb` (9 entries preloaded by default). Override with `POSTGRES_SHARED_PRELOAD_LIBRARIES` if you need a different set.
- Optional extensions can be preloaded: `supautils`, `pg_partman_bgw` (background worker), `set_user`, `pg_plan_filter`.
- Everything else is installed but disabled. Enable on demand with `CREATE EXTENSION ...` once `shared_preload_libraries` includes the required module (if needed).

## Installation Notes by Category

- **AI / Vector** – `vector` (pgvector) ships enabled; `vectorscale` (pgvectorscale) depends on `vector` and requires manual `CREATE EXTENSION vectorscale CASCADE`.
- **Time-series** – `timescaledb` is preloaded by default for optimal time-series performance; auto-created during cluster bootstrap. `timescaledb_toolkit` should be created after TimescaleDB and does not require preload.
- **Distributed** – Citus does not yet support PostgreSQL 18 GA (see Compatibility Exceptions); clustering remains unavailable in this image until upstream releases PG18 support.
- **Security** – `pgaudit` and `pgsodium` run by default (preloaded). `supautils` is installed but not preloaded by default (can be enabled via `POSTGRES_SHARED_PRELOAD_LIBRARIES`). `vault` (supabase_vault) is auto-created but requires pgsodium preload for encryption.
- **Operations** – `pgbackrest` binary lives in `/usr/bin/pgbackrest` (PGDG package); configure repositories via environment or volume mounts. `pgbadger` is available at `/usr/bin/pgbadger` for offline log analysis.
- **Partitioning** – enable `pg_partman` and optional background worker via `ALTER SYSTEM SET shared_preload_libraries = '...,pg_partman_bgw'` followed by `SELECT partman_bgw_add_job(...)`.

## HTTP Extensions Comparison: pg_net vs pgsql-http

Both extensions enable HTTP requests from PostgreSQL but serve different use cases:

| Aspect          | **pg_net**                            | **pgsql-http**                      |
| --------------- | ------------------------------------- | ----------------------------------- |
| **Execution**   | Asynchronous (background worker)      | Synchronous (blocking)              |
| **Transaction** | Fires AFTER commit                    | Executes DURING transaction         |
| **Methods**     | GET, POST (JSON only), DELETE         | GET, POST, PUT, PATCH, DELETE, HEAD |
| **Preload**     | Required (`shared_preload_libraries`) | Not required                        |
| **Response**    | Poll `net._http_response` table       | Immediate return                    |
| **Durability**  | Unlogged tables (crash risk)          | ACID-compliant                      |
| **Config**      | GUC only (batch_size, ttl)            | Per-session cURL options            |

### When to Use Each

**Use pg_net for:**

- Fire-and-forget webhooks
- Event notifications after successful commits
- High-throughput async integrations
- Cases where you don't need the response in the transaction

```sql
-- Webhook fires only if transaction commits
BEGIN;
  INSERT INTO orders (customer_id, total) VALUES (123, 99.99);
  SELECT net.http_post(
    'https://webhook.example.com/order-created',
    '{"order_id": 456}'::jsonb
  );
COMMIT;  -- Request sent NOW
```

**Use pgsql-http for:**

- API calls requiring response data in transaction
- Conditional logic based on HTTP result
- PUT/PATCH/HEAD methods
- Non-JSON POST bodies
- Fine-grained cURL control (timeouts, SSL, auth)

```sql
-- Response available immediately for conditional logic
SELECT CASE
  WHEN (http_get('https://api.example.com/inventory/123')).status = 200
  THEN 'In stock'
  ELSE 'Unavailable'
END;
```

### Configuration Examples

**pg_net** (postgresql.conf):

```
pg_net.batch_size = 200      # Requests per worker iteration
pg_net.ttl = '6 hours'       # Response retention
pg_net.database_name = 'mydb'
```

**pgsql-http** (session):

```sql
SELECT http_set_curlopt('CURLOPT_TIMEOUT', '30');
SELECT http_set_curlopt('CURLOPT_USERPWD', 'user:pass');
SELECT http_set_curlopt('CURLOPT_SSL_VERIFYPEER', '1');
```

## Compatibility Exceptions

- **Citus** – The latest upstream release (Citus 13.0 on 2025-02-10) only supports PostgreSQL 17 and earlier, so the extension is intentionally omitted from the PostgreSQL 18 image to avoid shipping an incompatible build. We will add it once an official PG18-compatible release lands.

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
- `pg_stat_monitor` (preloaded for advanced query telemetry)
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

**Result:** Smaller customized image (reduction proportional to disabled extensions), faster build (~7 min vs ~12 min).

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

## Disabled Extensions

The following extensions are currently disabled in the default build for optimization or technical reasons. They can be re-enabled by setting `enabled: true` in `scripts/extensions/manifest-data.ts` and rebuilding the image.

### postgis (Geospatial Extension)

**Status:** Disabled
**Version:** 3.6.1
**Category:** gis

**Why disabled:**

Build time and image size optimization. PostGIS adds significant build complexity and size:

- **Build time impact:** +8-10 minutes (compiling GEOS, PROJ, GDAL dependencies)
- **Image size impact:** +200-300MB (includes 14 APT dependencies: libgeos-dev, libproj-dev, libgdal-dev, etc.)
- **Use case specificity:** Geospatial features are not needed by most users

**Technical status:**

- ✅ Fully functional on PostgreSQL 18
- ✅ No compilation issues
- ✅ Can be enabled without code changes

**How to re-enable:**

```bash
# Edit scripts/extensions/manifest-data.ts
# Find postgis entry and set: enabled: true

bun run generate
bun run build
```

**Trade-offs:**

- ✅ Enables: Spatial data types, geographic queries, raster processing, topology
- ✅ Use cases: GIS applications, location-based services, spatial analytics
- ❌ Cost: +8-10 minutes build time, +200-300MB image size
- ⚠️ Note: pgrouting depends on PostGIS and must also be enabled

---

### pgrouting (Routing/Network Analysis)

**Status:** Disabled
**Version:** v4.0.0
**Category:** gis

**Why disabled:**

Cascading dependency on disabled PostGIS extension. pgrouting requires PostGIS to function.

**Technical status:**

- ✅ Fully functional on PostgreSQL 18 (major release with breaking changes from v3.x)
- ✅ No compilation issues
- ⚠️ **Hard dependency:** Requires PostGIS to be enabled first

**How to re-enable:**

```bash
# MUST enable PostGIS first
# Edit scripts/extensions/manifest-data.ts
# 1. Set postgis: enabled: true
# 2. Set pgrouting: enabled: true

bun run generate
bun run build
```

**Trade-offs:**

- ✅ Enables: Graph routing algorithms (Dijkstra, A\*, TSP), network analysis
- ✅ Use cases: Logistics optimization, route planning, transportation networks
- ❌ Cost: +4-5 minutes build time (on top of PostGIS), +50-100MB image size
- ⚠️ Requires: PostGIS must be enabled (adds +200-300MB)

---

### pgq (Queue Extension)

**Status:** Disabled
**Version:** v3.5.1
**Category:** queueing

**Why disabled:**

Build optimization - not critical for most users. The project includes pgmq (enabled by default) which provides similar queue functionality with more features and active development.

**Technical status:**

- ✅ Pure PL/pgSQL implementation (PostgreSQL 10-18 compatible)
- ✅ Fast build (~2-3 minutes)
- ✅ No external dependencies
- ℹ️ **Alternative available:** pgmq is enabled by default and recommended

**How to re-enable:**

```bash
# Edit scripts/extensions/manifest-data.ts
# Find pgq entry and set: enabled: true

bun run generate
bun run build
```

**Trade-offs:**

- ✅ Enables: Generic high-performance queue with SQL function API
- ✅ Minimal impact: ~2-3 minutes build time, ~10-20MB image size
- ⚠️ Consider: pgmq (enabled by default) is a more modern alternative with:
  - Better documentation and community support
  - More features (visibility timeout, message retention)
  - Active development and maintenance

**When to enable pgq:**

- Migrating from existing pgq deployments
- Specific compatibility requirements with pgq API
- Preference for pure PL/pgSQL implementation

---

### supautils (Supabase Utilities)

**Status:** Disabled
**Version:** v3.1.0
**Category:** safety

**Why disabled:**

Build failure due to unreliable sed patching. The extension source code is missing a `static` keyword that causes compilation errors. Current sed-based patching is fragile and may break with upstream changes.

**Technical issue:**

```c
// Source code has:
bool log_skipped_evtrigs;  // Missing 'static' keyword - causes compilation error

// Needs to be:
static bool log_skipped_evtrigs;
```

**Current workaround (unreliable):**

The Dockerfile attempts to patch this with sed, but the pattern is fragile:

```bash
s/^bool[[:space:]]\{1,\}log_skipped_evtrigs/static bool log_skipped_evtrigs/
```

**Fix options:**

1. **Wait for upstream fix** (RECOMMENDED)
   - File issue with `supabase/supautils` repository
   - Monitor for official patch in future releases
   - Timeline: Uncertain (Supabase focus on managed services)

2. **Manual Git patch** (for custom builds)
   - Replace sed with `git apply` + patch file
   - More robust than regex substitution
   - Complexity: Medium
   - Maintenance: Must update patch if upstream changes

3. **Fork and maintain patch** (for production use)
   - Fork supautils repository
   - Apply fix directly to source
   - Use forked version in manifest
   - Maintenance: Must sync with upstream releases

**How to attempt re-enable (advanced users only):**

```bash
# Edit scripts/extensions/manifest-data.ts
# 1. Set supautils: enabled: true
# 2. Update sed pattern or switch to git apply patch
# 3. Test build thoroughly

bun run generate
bun run build
```

**Trade-offs:**

- ✅ Enables: Shared superuser guards, hooks for managed PostgreSQL environments
- ✅ Use cases: Supabase compatibility, multi-tenant security controls
- ❌ Cost: Maintenance burden, fragile build, upstream dependency
- ⚠️ Risk: Sed pattern may break with upstream changes

**Recommendation:** Leave disabled until upstream fix or use alternative security extensions (pgaudit, set_user are enabled).

---

**Note:** All disabled extensions can be tracked in the manifest at `scripts/extensions/manifest-data.ts` with `enabled: false` and `disabledReason` field. See `docs/.generated/docs-data.json` for current catalog statistics.

## Manifest Validation

The `validate-manifest.ts` script performs comprehensive preflight validation of `docker/postgres/extensions.manifest.json` to ensure consistency across the codebase before Docker builds.

### Validation Types

**1. Count Validation**

Ensures manifest is well-formed and consistent:

- Catalog structure (all required fields/categories present)
- Classification by kind (builtin, extension, tool, module)
- Installation method (PGDG, compiled, builtin)

**2. defaultEnable Consistency**

For extensions with `runtime.defaultEnable=true`, verifies they are either:

- Listed in `01-extensions.sql` baseline (CREATE EXTENSION statements), OR
- Included in `DEFAULT_SHARED_PRELOAD_LIBRARIES` in `docker-auto-config-entrypoint.sh`

Special case: `plpgsql` is always available and doesn't require explicit creation.

**3. PGDG Consistency**

For all extensions with `install_via: "pgdg"`, verifies:

- Corresponding `postgresql-${PG_MAJOR}-<name>=<version>` entry exists in Dockerfile
- Package name mappings are handled correctly (see Package Name Mappings below)

**4. Runtime Spec Completeness**

Warns if `kind: "tool"` entries are missing `runtime` object.

**5. Dependency Validation**

Ensures all `dependencies` reference valid extension names in the manifest.

### Usage

**Standalone:**

```bash
bun run scripts/extensions/validate-manifest.ts
```

**Integrated in Build:**
The script automatically runs as a preflight check in `scripts/build.ts`:

```bash
bun run build  # Validation runs before Docker build
```

### Exit Codes

- **0**: Validation passed (or passed with warnings only)
- **1**: Validation failed with errors

### Output Format

```
=== MANIFEST VALIDATION ===

[COUNT VALIDATION]
  Total extensions: 38 (expected: 38)
  Builtin: 6 (expected: 6)
  PGDG: 14 (expected: 14)
  Compiled: 18 (expected: 18)

[DEFAULT ENABLE VALIDATION]
  Baseline extensions in 01-extensions.sql: pg_stat_statements, pg_trgm, pgaudit, pg_cron, vector
  Default preload libraries: pg_stat_statements, auto_explain, pg_cron, pgaudit

[PGDG CONSISTENCY VALIDATION]
  PGDG packages in Dockerfile: cron, pgaudit, pgvector, ...

[RUNTIME SPEC VALIDATION]

[DEPENDENCY VALIDATION]

=== VALIDATION RESULTS ===

✅ Manifest validation passed
```

### Common Error Examples

**Count Mismatch:**

```
ERROR: Total extension count mismatch: got 37, expected 38
```

**defaultEnable Inconsistency:**

```
ERROR: Extension 'foo' has defaultEnable=true but is NOT in 01-extensions.sql baseline
       OR DEFAULT_SHARED_PRELOAD_LIBRARIES
```

**PGDG Missing:**

```
ERROR: Extension 'bar' has install_via="pgdg" but is NOT installed in Dockerfile
       (expected package: postgresql-${PG_MAJOR}-bar)
```

**Invalid Dependency:**

```
ERROR: Extension 'baz' has dependency on 'missing_ext' which does NOT exist in manifest
```

### Package Name Mappings

Some extensions have different Dockerfile package names:

| Manifest Name   | Dockerfile Package                     |
| --------------- | -------------------------------------- |
| `vector`        | `postgresql-${PG_MAJOR}-pgvector`      |
| `postgis`       | `postgresql-${PG_MAJOR}-postgis-3`     |
| `pg_partman`    | `postgresql-${PG_MAJOR}-partman`       |
| `plpgsql_check` | `postgresql-${PG_MAJOR}-plpgsql-check` |
| `pg_repack`     | `postgresql-${PG_MAJOR}-repack`        |
| `pgrouting`     | `postgresql-${PG_MAJOR}-pgrouting`     |
| `set_user`      | `postgresql-${PG_MAJOR}-set-user`      |
| `pg_cron`       | `postgresql-${PG_MAJOR}-cron`          |

These mappings are defined in `getDockerfilePackageName()` function in the validation script.

### Integration Points

The validator cross-references:

1. **Manifest**: `docker/postgres/extensions.manifest.json`
2. **Dockerfile**: `docker/postgres/Dockerfile` (PGDG packages)
3. **Init SQL**: `docker/postgres/docker-entrypoint-initdb.d/01-extensions.sql` (baseline extensions)
4. **Entrypoint**: `docker/postgres/docker-auto-config-entrypoint.sh` (preload libraries)

### Troubleshooting Validation

**Validation Fails During Build:**

```bash
# Run standalone to see detailed error messages
bun run scripts/extensions/validate-manifest.ts

# Check exit code
echo $?  # 0 = success, 1 = failure
```

**False Positives:**

If validation fails incorrectly:

1. Check package name mappings in `getDockerfilePackageName()`
2. Verify baseline extension list parsing regex
3. Check for case sensitivity issues (manifest uses lowercase, SQL might differ)

### Updating Expected Counts

If you add/remove extensions, update `EXPECTED_COUNTS` in `validate-manifest.ts`:

```typescript
const EXPECTED_COUNTS = {
  total: 38, // Total extensions
  builtin: 6, // kind: "builtin"
  pgdg: 14, // install_via: "pgdg"
  compiled: 18, // Source-built (neither builtin nor PGDG)
};
```

### Design Decisions

**Why TypeScript/Bun?**

- Type safety for manifest structure
- Fast execution (Bun native JSON parsing)
- Consistent with config-generator tooling

**Why Preflight vs Post-Build?**

- Catch errors BEFORE 12-minute Docker build
- Immediate feedback loop
- Prevents CI/CD failures late in pipeline

**Why Not JSON Schema?**

- Need cross-file validation (Dockerfile, SQL, entrypoint)
- Custom logic for package name mappings
- Detailed error messages with context

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

This decision may be revisited as PIGSTY v4.0 matures and demonstrates stable PostgreSQL 18 support in production environments. For detailed evaluation including security assessment, compatibility matrix, and migration considerations, see git history (archived 2025-11).
