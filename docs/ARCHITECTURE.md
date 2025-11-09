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
│     (~450MB)                    │                                   │
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
│  │  4. Inject -c flags                 │                            │
│  │     └─ Override postgresql.conf     │                            │
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

**Output:** Single multi-arch image (~450MB) with SBOM/provenance

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
   - `01-extensions.sql` → Creates 6 baseline extensions (auto_explain, pg_cron, pg_stat_statements, pg_trgm, pgaudit, vector). plpgsql is builtin and always available.
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
**Network Access:** Change `POSTGRES_BIND_IP=0.0.0.0` (requires firewall)

## Configuration Hierarchy

```
┌────────────────────────────────────────────────────────────┐
│  1. Runtime -c Flags (HIGHEST PRIORITY)                    │
│     └─ From auto-config entrypoint                         │
│        (shared_buffers, max_connections, etc.)             │
└────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────┐
│  2. Stack-Specific postgresql.conf                         │
│     └─ stacks/*/configs/postgresql-*.conf                  │
│        (replication, pg_cron, hot_standby)                 │
└────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────┐
│  3. Shared Base Configuration                              │
│     └─ docker/postgres/configs/postgresql-base.conf        │
│        (I/O, logging, extensions, autovacuum)              │
└────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────┐
│  4. PostgreSQL Defaults                                    │
│     └─ Built-in defaults from postgres binary              │
└────────────────────────────────────────────────────────────┘
```

**Key Principle:** Runtime flags override everything. Auto-config is always enabled and cannot be disabled.

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
│                     Auditing                               │
│  - pgAudit: DDL, writes, role changes                      │
│  - pg_stat_statements: Query performance                   │
│  - auto_explain: Slow query plans                          │
└────────────────────────────────────────────────────────────┘
```

## Extension Loading

```
Build Time                Runtime                  Usage
─────────────────────────────────────────────────────────────
pgvector 0.8.1            CREATE EXTENSION         Vector
(compiled .so) ────────► vector; ──────────────► similarity
                                                   search

pg_cron 1.6.7             CREATE EXTENSION         Job
(compiled .so) ────────► pg_cron; ─────────────► scheduling
                          (in postgresql.conf)

pgAudit 18.0              shared_preload_libraries Audit
(compiled .so) ────────► pgaudit; ─────────────► logging
                          (in postgresql.conf)

pg_trgm (contrib)         CREATE EXTENSION         Fuzzy
(built-in) ────────────► pg_trgm; ──────────────► text search

pg_stat_statements        shared_preload_libraries Query
(contrib) ─────────────► pg_stat_statements; ──► monitoring
                          (in postgresql.conf)
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

**Baseline Ratio (2GB):**

- shared_buffers: 25% (512MB)
- effective_cache: ~75% (1536MB)
- maintenance_work_mem: ~3% (64MB, capped at 2GB)
- work_mem: total RAM / (connections×4) → 2MB with 120 connections

**Caps:**

- shared_buffers: max 32GB
- max_connections: 80 (≤512MB), 120 (<4GB), 200 (≥4GB)
- maintenance_work_mem: max 2GB
- work_mem: max 32MB

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

**Location:** `examples/backup/` directory (not included in main stacks)

**Restore:** `pgbackrest restore` from backup volume

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
