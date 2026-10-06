# aza-pg Architecture

High-level overview of the aza-pg PostgreSQL deployment system.

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         BUILD TIME (CI/CD)                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Dockerfile (Multi-stage)                                           │
│  ┌──────────────────────┐                                           │
│  │  Stage 1: Builder    │                                           │
│  │  - Clone pgvector    │ ──SHA──┐                                  │
│  │  - Clone pg_cron     │   Pin  │                                  │
│  │  - Clone pgAudit     │ ──────┤                                   │
│  │  - Compile extensions│       │                                   │
│  └──────────────────────┘       │                                   │
│           │                     │                                   │
│           ▼                     │                                   │
│  ┌──────────────────────┐       │                                   │
│  │  Stage 2: Final      │       │                                   │
│  │  - postgres:18       │       │ Supply Chain                      │
│  │  - Copy .so files    │◄──────┤ Security                          │
│  │  - Copy control files│       │ (Immutable)                       │
│  │  - Copy entrypoint   │       │                                   │
│  └──────────────────────┘       │                                   │
│           │                     │                                   │
│           ▼                     │                                   │
│     aza-pg:pg18 Image           │                                   │
│     (~900MB)                    │                                   │
│     + SBOM/Provenance           │                                   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

                              │
                              ▼

┌─────────────────────────────────────────────────────────────────────┐
│                    RUNTIME (Container Start)                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  docker-auto-config-entrypoint.sh                                   │
│  ┌─────────────────────────────────────┐                            │
│  │  1. Detect RAM (cgroup v2/manual)   │                            │
│  │     ├─ POSTGRES_MEMORY? → Use it    │                            │
│  │     ├─ Memory limit? → Use cgroup   │                            │
│  │     └─ Else → Read /proc/meminfo    │                            │
│  │                                     │                            │
│  │  2. Detect CPU (nproc)              │                            │
│  │     └─ Scale workers/parallelism    │                            │
│  │                                     │                            │
│  │  3. Calculate Settings              │                            │
│  │     ├─ shared_buffers (max 32GB)    │                            │
│  │     ├─ effective_cache              │                            │
│  │     ├─ maintenance_work_mem         │                            │
│  │     ├─ work_mem                     │                            │
│  │     └─ max_connections (80/120/200) │                            │
│  │                                     │                            │
│  │  4. Write aza-auto-config.conf      │                            │
│  │     └─ Above postgresql.conf only   │                            │
│  └─────────────────────────────────────┘                            │
│                  │                                                  │
│                  ▼                                                  │
│         PostgreSQL Server                                           │
│         Listening on 5432                                           │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

                              │
                              ▼

┌─────────────────────────────────────────────────────────────────────┐
│                      DEPLOYMENT STACKS                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  SINGLE STACK                PRIMARY STACK               REPLICA   │
│  ┌──────────┐               ┌──────────┐                ┌────────┐ │
│  │ Postgres │               │ Postgres │◄───streaming───│Postgres│ │
│  │   :5432  │               │   :5432  │   replication  │  :5432 │ │
│  └──────────┘               └──────────┘                └────────┘ │
│                                   │                                │
│                                   │                                │
│                             ┌──────────┐                            │
│                             │PgBouncer │                            │
│                             │   :6432  │                            │
│                             └──────────┘                            │
│                                   │                                │
│                                   │                                │
│                             ┌──────────┐                            │
│                             │ Exporter │                            │
│                             │   :9187  │                            │
│                             └──────────┘                            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Component Flow

### 1. Build Time (Image Creation)

**Input:** Dockerfile + SHA-pinned extension sources

**Process:**

- Multi-stage build compiles extensions from source
- Stage 1 (builder): Clones repos at specific commit SHAs, compiles C extensions
- Stage 2 (final): Copies only `.so` files and control files to slim image
- Embeds auto-config entrypoint script

**Output:** Single multi-arch image (~900MB uncompressed, ~250MB compressed wire) with SBOM/provenance

**Docker Layer Caching Strategy:**

The Dockerfile is optimized for maximum cache efficiency through careful layer ordering and builder stage design:

_Cache Ordering Principles:_

- Layers ordered from most stable (rare changes) to most volatile (frequent changes)
- STABLE first → creates foundation cache layers that survive frequent rebuilds
- VOLATILE last → minimizes cache invalidation impact when updated

_Final Stage Layer Order:_

1. Base image (postgres:18.3-trixie@sha256) - immutable
2. Runtime package list COPY - rare changes
3. Runtime apt-get install - only invalidates on package list changes
4. PGDG packages (ordered by stability) - STABLE extensions first, VOLATILE last
5. Builder artifacts (compiled extensions) - moderate changes
6. Base PostgreSQL config - rarely modified
7. Runtime scripts (healthcheck, entrypoint) - occasional changes
8. Metadata files (manifest, version-info) - frequent changes with manifest updates
9. USER, LABELs, metadata - always last

_Builder Stage Optimizations (CI/CD focused):_

- builder-base: manifests copied AFTER the Rust and Bun toolchain installs, so a manifest edit does not reinstall them
  - Impact: +20-40% cache hits when manifests change (~20% of builds)
  - Before: manifests → Rust → Bun
  - After: Rust → Bun → manifests
- builder-cargo: Inline env vars (-3 layers), cargo registry cache mount (-15-30% build time)
- Both stages: Parallelized strip operations (xargs -P, -30-50% strip time on multi-core)

_Cache Mount Usage:_

```dockerfile
# General build cache (all stages)
RUN --mount=type=cache,target=/root/.cache \
    bun build-extensions.ts

# Cargo dependency cache (builder-cargo only)
RUN --mount=type=cache,target=/root/.cargo/registry \
    cargo build
```

_Performance Impact:_

- Measured improvement: 70% faster warm rebuilds (17s cold → 5s warm)
- CI/CD cache hit rate: Improved from ~20% to estimated 50-60%
- Combined optimizations: -20-30% build time on cache misses, +25-40% on cache hits

**Security:** SHA pinning prevents tag mutation attacks (immutable commits)

### 2. Runtime (Container Start)

**Input:** Image + deployment environment (RAM/CPU)

**Process:**

- Entrypoint script runs BEFORE postgres starts
- Detects actual hardware of deployment environment:
  - cgroup v2 memory limit (if set)
  - Manual override via `POSTGRES_MEMORY`
  - CPU cores via `nproc`
- Calculates proportional settings (baseline: 25% RAM to shared_buffers, capped at 32GB)
- Falls back to `/proc/meminfo` when no limit/override is present
- Injects settings as `-c` command-line flags

**Output:** PostgreSQL process with auto-tuned configuration

**Override:** `POSTGRES_MEMORY=<MB>` to manually specify available RAM

### 3. Initialization (First Start Only)

**Input:** Init scripts from two sources

**Process:**

1. Shared scripts (all stacks): `docker/postgres/docker-entrypoint-initdb.d/`
   - `01-extensions.sql` → Creates the baseline extensions listed in its `v_expected_exts` array (`01b-pg_cron.sh` creates pg_cron). Note: auto_explain is a preload-only module, not created via CREATE EXTENSION.
   - `02-replication.sh` → Creates replicator user (if enabled)

2. Stack-specific scripts: `stacks/*/configs/initdb/`
   - Primary: `03-pgbouncer-auth.sh` → Creates pgbouncer_auth user + function
   - Replica/Single: (empty, use shared scripts only)

**Output:** Initialized database with extensions and users

### 4. Stack Deployment

**Single Stack:**

- Minimal setup: Just PostgreSQL
- Use case: Development, small apps
- Services: 1 (postgres)

**Primary Stack:**

- Full production setup
- Services: 3
  - PostgreSQL (data storage)
  - PgBouncer (connection pooling, transaction mode)
  - postgres_exporter (Prometheus metrics)
- Use case: Production with connection pooling and monitoring

**Replica Stack:**

- Streaming replication follower
- Connects to primary via replication slot
- Use case: Read replicas, HA setup
- Services: 1 (postgres replica)

## Network Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Layer                        │
└─────────────────────────────────────────────────────────────┘
                       │                │
                       │                │
         Direct DB     │                │  Pooled
         Connection    │                │  Connection
                       ▼                ▼
              ┌──────────────┐  ┌──────────────┐
              │  PostgreSQL  │  │  PgBouncer   │
              │    :5432     │◄─│    :6432     │
              └──────────────┘  └──────────────┘
                       │                │
                       │                │
                       └────────┬───────┘
                                │
                                ▼
                    ┌────────────────────────┐
                    │  postgres_exporter     │
                    │      :9187/metrics     │
                    └────────────────────────┘
                                │
                                ▼
                    ┌────────────────────────┐
                    │      Prometheus        │
                    │   (scrapes metrics)    │
                    └────────────────────────┘
```

**Default Binding:** 127.0.0.1 (localhost only)
**Network Access:** In the stacks PostgreSQL listens on the stack's Docker networks; `POSTGRES_BIND_IP=0.0.0.0` publishes its host port on every interface (requires firewall). For a lone `docker run`, `POSTGRES_BIND_IP` is PostgreSQL's listen address.

## Configuration Hierarchy

Highest wins:

1. Operator `-c name=value` on the command line (compose `command:`).
2. `ALTER SYSTEM` (`postgresql.auto.conf` in the data directory; reloadable settings apply on `SELECT pg_reload_conf()`).
3. Auto-tuned values, written at every start to `/var/run/postgresql/aza-auto-config.conf`, which first includes the two files below.
4. The config file: a stack's `postgresql-*.conf`, or the data directory's `postgresql.conf`.
5. aza-pg's base settings, `/etc/postgresql/postgresql-base.conf` (logging, `pg_stat_statements`, `auto_explain`, autovacuum, TimescaleDB telemetry off), in every container.
6. PostgreSQL built-in defaults.

Config files rank below auto-tuning because initdb writes `max_connections`, `shared_buffers`, `max_wal_size`, `min_wal_size` and `listen_addresses = '*'` into every data directory's `postgresql.conf`; letting the file win would switch auto-tuning off for every database. The shipped config files therefore never set a tuned setting.

Nothing is overridden silently: at start the entrypoint logs one `[AUTO-CONFIG] <setting>:` line per tuned setting that a `-c` or `ALTER SYSTEM` value overrides, or whose config-file value is ignored. `SELECT name, setting, sourcefile FROM pg_settings` shows where each value came from. Auto-tuning itself is always on.

## Security Model

```
┌────────────────────────────────────────────────────────────┐
│                    Supply Chain                            │
│  - Extensions: SHA-pinned (immutable commits)              │
│  - Base image: postgres:18-trixie (official)             │
│  - SBOM/Provenance: Attestation via GitHub Actions         │
└────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────┐
│                  Authentication                            │
│  - SCRAM-SHA-256 (no MD5/plaintext)                        │
│  - PgBouncer: auth_query via SECURITY DEFINER function     │
│  - No plaintext userlist.txt                               │
└────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────┐
│                    Network                                 │
│  - Default: localhost (127.0.0.1) binding                  │
│  - TLS: Not enabled by default (requires certs)            │
│  - Production: Change bind IP + enable TLS + firewall      │
└────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────┐
│                     Auditing / Observability               │
│  - pgAudit: DDL, writes, role changes                      │
│  - pg_stat_monitor / pg_stat_statements: Query performance │
│  - auto_explain: Slow query plans                          │
└────────────────────────────────────────────────────────────┘
```

## Extension Loading

```
Build Time                Runtime                  Usage
─────────────────────────────────────────────────────────────
pgvector                  CREATE EXTENSION         Vector
(compiled .so) ────────► vector; ──────────────► similarity
                                                   search

pg_cron                   CREATE EXTENSION         Job
(compiled .so) ────────► pg_cron; ─────────────► scheduling
                          (in postgresql.conf)

pgAudit                   shared_preload_libraries Audit
(compiled .so) ────────► pgaudit; ─────────────► logging
                          (in postgresql.conf)

pg_trgm (contrib)         CREATE EXTENSION         Fuzzy
(built-in) ────────────► pg_trgm; ──────────────► text search

pg_stat_monitor +         shared_preload_libraries Query
pg_stat_statements  ───► monitor + statements; ─► monitoring
                          (runtime preload)
```

**Load Order:** `shared_preload_libraries` → `01-extensions.sql` → Application CREATE EXTENSION

## Memory Allocation

```
Deployment Environment
       │
       ├─ cgroup v2 memory limit SET
       │  └─► Use limit value
       │     Example: 4GB → shared_buffers=1024MB
       │
       └─ cgroup v2 memory limit NOT SET
          ├─ POSTGRES_MEMORY set? ─► Use override
          │    Example: 1024 → shared_buffers=256MB
          └─► Read /proc/meminfo (host RAM)
               Example: 64GB host → shared_buffers≈9830MB
```

The ratios, caps and workload limits are listed in [README.md "Auto-Config"](../README.md#auto-config); the `calculate_*` functions in `docker/postgres/docker-auto-config-entrypoint.sh` own them.

## Monitoring Data Flow

```
PostgreSQL
    │
    │ SQL Queries
    │
    ▼
postgres_exporter
    │ (queries pg_stat_* views)
    │ (reads custom queries YAML)
    │
    ▼
Prometheus Metrics (:9187/metrics)
    │
    │ HTTP Scrape
    │
    ▼
Prometheus Server
    │
    │ PromQL Queries
    │
    ▼
Grafana Dashboards
```

**Custom Queries:**

- Replication lag (for primary)
- Memory settings (auto-config verification)
- Postmaster uptime
- Database size
- Connection counts

## Backup Strategy

```
Primary PostgreSQL
    │
    │ WAL Archiving
    │
    ▼
/backup volume
    │
    │ pgBackRest
    │
    ├─► Full Backup (weekly)
    ├─► Differential Backup (daily)
    └─► Incremental Backup (hourly)
```

**Setup:** `examples/backup/compose.yml` adds pgBackRest's settings to a stack's postgres service, where pgBackRest runs (archive_command runs there, and it reaches PostgreSQL through the local socket); guide: [BACKUP-PGBACKREST.md](BACKUP-PGBACKREST.md)

**Restore:** `pgbackrest restore` from the backup volume

## Design Philosophy

**One Image, Many Environments:**

- Build once at compile time (extensions baked in)
- Auto-configure at runtime (adapt to deployment environment)
- No rebuild needed for different RAM/CPU allocations

**Minimal Config Surface:**

- Auto-config handles memory/CPU tuning
- Shared base config for common settings
- Stack-specific configs only for deployment differences
- Env vars for secrets and deployment-specific values

**Supply Chain Security:**

- SHA pinning prevents tag mutation
- SBOM tracks all dependencies
- Provenance proves build authenticity
- Multi-platform builds (amd64/arm64)

**Operational Simplicity:**

- Single docker compose command deploys stack
- No init scripts to run manually
- No manual memory tuning required
- Monitoring included (not bolted on)

---

**Key Takeaway:** Build once (extensions), deploy anywhere (auto-config), secure by default (SHA pins + SCRAM-SHA-256).

## Future Optimizations

The following optimizations have been identified for potential implementation based on prior analysis:

**Build Time Reduction:**

- **Quick wins identified:** Remove LLVM bitcode directory (36MB, 0% runtime impact), strip debug symbols from `.so` files (10-20MB savings), cleanup static libraries and build headers (1-2MB)
- **cargo-pgrx builds:** symbols are stripped (`CARGO_PROFILE_RELEASE_STRIP=symbols`); otherwise each crate keeps its upstream release profile (opt-level 3, fat LTO). A global `opt-level=s`/thin-LTO override once shrank timescaledb_toolkit (186MB → 13MB together with stripping) and was dropped once toolkit moved to the Timescale apt repo.
- **Applicable techniques:** Similar bitcode/symbol stripping can be applied to other large extensions (pg_jsonschema: 4.4MB, pgroonga: 2.1MB)

**Potential Image Variant Strategy (Future Consideration):**

- **Core variant:** Minimal image with essential extensions only (estimated 35% size reduction)
- **Specialized variants:** Analytics-focused (timescaledb suite), search-focused (pgroonga, vectorscale), geospatial-focused (PostGIS suite)
- **User benefit:** Faster deployment pulls, reduced storage requirements, clearer workload intentions
- **Status:** Not yet implemented; currently maintaining single comprehensive image

**Long-term Considerations:**

- **Rust compilation optimization:** tune the cargo-pgrx source builds (`build.type: "cargo-pgrx"` in the manifest), vectorscale among them: it is built from source with `vectorscale-runtime-dispatch.patch`, so its AVX2/FMA code runs only on CPUs that have them
- **Conditional builds:** Build-time arguments to skip large optional extensions for specific use cases
- **Alpine base evaluation:** Potential 40% size reduction but requires extensive glibc vs musl compatibility testing

See git history for detailed analysis reports including extension size breakdowns, layer analysis, and implementation roadmaps.
