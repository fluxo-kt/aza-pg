# aza-pg Architecture

High-level overview of the aza-pg PostgreSQL deployment system.

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         BUILD TIME (CI/CD)                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  flake.nix (Nix)                                                    │
│  ┌──────────────────────────────┐                                   │
│  │  PostgreSQL + JIT (nixpkgs)  │ flake.lock pins nixpkgs           │
│  │  extensions at their commit  │ resolved from each manifest tag   │
│  └──────────────────────────────┘                                   │
│           │                                                         │
│           ▼                                                         │
│  ┌──────────────────────────────┐                                   │
│  │  nix/image.nix (layered)     │                                   │
│  │  - runtime closure only      │ no package manager or compiler    │
│  │  - entrypoint, configs       │                                   │
│  └──────────────────────────────┘                                   │
│           │                                                         │
│           ▼                                                         │
│     aza-pg:pg18 Image + SBOM/Provenance                             │
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
│  │     └─ max_connections (by workload)│                            │
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

**Input:** `flake.nix` + `flake.lock` (the nixpkgs revision) + the generated manifest (each extension's commit)

**Process:**

- nixpkgs builds PostgreSQL with JIT and without the features no container uses (reasons at each option in `flake.nix`); its install check runs PostgreSQL's own suite (`make check-world`)
- `nix/extensions.nix` builds every enabled extension from its pinned commit, reusing a nixpkgs recipe where the entry names one
- `nix/image.nix` streams a layered image (`dockerTools.streamLayeredImage`) whose closure is only what runs; `testNoBuildOnlyStorePaths` fails when a build-only path leaks in
- Embeds auto-config entrypoint script

**Output:** One image per architecture (amd64, arm64, each built natively), joined into a multi-arch tag with an SBOM of its exact closure

**Caching:** every package is its own store path keyed by its inputs, so a manifest edit rebuilds only that extension and the image. On a host without Nix the store lives in a Docker volume (`aza-pg-nix-<arch>`, `scripts/nix/nix.ts`), and in `.github/actions/setup-nix`'s cache in CI.

**Security:** SHA pinning prevents tag mutation attacks (immutable commits)

### 2. Runtime (Container Start)

**Input:** Image + deployment environment (RAM/CPU)

**Process:**

- Entrypoint script runs BEFORE postgres starts
- Detects RAM in this order: `POSTGRES_MEMORY` override, cgroup v2 memory limit, `/proc/meminfo`; CPU cores via `nproc`
- Calculates proportional settings (baseline: 25% RAM to shared_buffers, capped at 32GB)
- Writes them to `/var/run/postgresql/aza-auto-config.conf` and starts PostgreSQL with `-c config_file=` pointing at it (precedence in [Configuration Hierarchy](#configuration-hierarchy))

**Output:** PostgreSQL process with auto-tuned configuration

**Override:** `POSTGRES_MEMORY=<MB>` to manually specify available RAM

### 3. Initialization (First Start Only)

**Input:** Init scripts from two sources

**Process:**

1. Shared scripts (all stacks): `docker/postgres/docker-entrypoint-initdb.d/`
   - `01-extensions.sql` → Creates the baseline extensions listed in its `v_expected_exts` array (`01b-pg_cron.sh` creates pg_cron). Note: auto_explain is a preload-only module, not created via CREATE EXTENSION.
   - `02-replication.sh` → Creates replicator user (if enabled)
   - The other scripts there (run in filename order) set up the pgsodium key, pg_partman and pgflow

2. Stack-specific scripts: `stacks/*/configs/initdb/`
   - Primary: `03-pgbouncer-auth.sh` → Creates pgbouncer_auth user + function
   - Replica/Single: (empty, use shared scripts only)

**Output:** Initialized database with extensions and users

### 4. Stack Deployment

**Single Stack:**

- Minimal setup: PostgreSQL plus postgres_exporter
- Use case: Development, small apps
- Services: 2 (postgres, postgres_exporter)

**Primary Stack:**

- Full production setup
- Services: 4
  - PostgreSQL (data storage)
  - PgBouncer (connection pooling, transaction mode)
  - postgres_exporter (Prometheus metrics)
  - pgbouncer_exporter (PgBouncer metrics)
- Use case: Production with connection pooling and monitoring

**Replica Stack:**

- Streaming replication follower
- Connects to primary via replication slot
- Use case: Read replicas, HA setup
- Services: 2 (postgres-replica, postgres_exporter)

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
│  - Server and libraries: nixpkgs, pinned by flake.lock     │
│  - SBOM/Provenance: Attestation via GitHub Actions         │
└────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────┐
│                  Authentication                            │
│  - SCRAM-SHA-256 (no MD5/plaintext)                        │
│  - PgBouncer: auth_query via SECURITY DEFINER function     │
│  - userlist.txt: auth_user only, generated at start (600)  │
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
│  - pgAudit: DDL, writes, roles (primary; others: none)     │
│  - pg_stat_monitor / pg_stat_statements: Query performance │
│  - auto_explain: Slow query plans                          │
└────────────────────────────────────────────────────────────┘
```

## Extension Loading

```
Build Time                Runtime                  Usage
─────────────────────────────────────────────────────────────
pgvector                  CREATE EXTENSION         Vector
(source build) ────────► vector; ──────────────► similarity
                                                   search

pg_cron                   CREATE EXTENSION         Job
(source build) ────────► pg_cron; ─────────────► scheduling
                          (default preload)

pgAudit                   shared_preload_libraries Audit
(source build) ────────► pgaudit; ─────────────► logging
                          (default preload)

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
       ├─ POSTGRES_MEMORY set? ─► Use override
       │    Example: 1024 → shared_buffers=256MB
       │
       ├─ cgroup v2 memory limit SET
       │  └─► Use limit value
       │     Example: 4GB → shared_buffers=1024MB
       │
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

Defined in `docker/postgres/configs/postgres_exporter_queries.yaml`, among them:

- Replication lag
- Memory settings (auto-config verification)
- Postmaster uptime
- WAL directory size, temp files, `pg_stat_io`, `pg_stat_wal`
- Connection usage

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
    ├─► Full Backup (e.g. weekly)
    ├─► Differential Backup (e.g. daily)
    └─► Incremental Backup (e.g. every 6 hours)
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

Candidates for later work, and why some size/speed changes were not taken:

**Build Time Reduction:**

- **cargo-pgrx builds:** Nix strips them; otherwise each crate keeps its upstream release profile. A global `opt-level=s`/thin-LTO override shrank timescaledb_toolkit from 186 MB to 13 MB together with stripping; measure it on the Nix build before adopting it.
- **PostgreSQL stays at nixpkgs' release flags (`-O2`):** PostgreSQL 18 already picks CRC-32C and popcount CPU instructions at runtime, and a pgbench comparison of `-O2` and `-O3 -flto` builds showed no gain above the ±25 % run-to-run spread.

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
