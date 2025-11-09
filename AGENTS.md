# aza-pg Operations Guide

PG18 stack: auto-adaptive config, 38 exts (SHA-pinned), PgBouncer pooling, amd64/arm64. 2-128GB RAM, 1-64 cores, Compose-only.

## Core Architecture

**Image:** Multi-stage → exts compile from SHAs → `.so` (~450MB). ENTRYPOINT detects RAM/CPU → `-c` flags.

**Stacks:** primary (PG + PgBouncer + exporter), replica (replication), single (standalone). Env-driven.

**Extensions:** 38 total: 6 builtin + 14 PGDG (apt) + 18 compiled. 6 baseline: auto_explain, pg_cron, pg_stat_statements, pg_trgm, pgaudit, vector. 4 preloaded: auto_explain, pg_cron, pg_stat_statements, pgaudit.

## Auto-Config (Runtime)

**Trigger:** Container start. cgroup v2 → `POSTGRES_MEMORY` → `/proc/meminfo`.

**Overrides:** `POSTGRES_MEMORY=<MB>`, `POSTGRES_SHARED_PRELOAD_LIBRARIES`.

**Caps:** shared_buffers 32GB, maint_work_mem 2GB, work_mem 32MB, max_conn 80/120/200.

**Memory Allocation:**

| RAM   | shared_buf | eff_cache | maint_work | work_mem | max_conn |
| ----- | ---------- | --------- | ---------- | -------- | -------- |
| 512MB | 128MB      | 384MB     | 32MB       | 1MB      | 80       |
| 2GB   | 512MB      | 1536MB    | 64MB       | 4MB      | 120      |
| 4GB   | 1024MB     | 3072MB    | 128MB      | 5MB      | 200      |
| 8GB   | 2048MB     | 6144MB    | 256MB      | 10MB     | 200      |
| 32GB  | 6553MB     | 24576MB   | 1024MB     | 32MB     | 200      |
| 64GB  | 9830MB     | 49152MB   | 2048MB     | 32MB     | 200      |

Ext overhead ~100-250MB (pg_stat_statements, pgvector, timescaledb).

## PgBouncer Auth

- `auth_query = SELECT * FROM pgbouncer_lookup($1)` (SECURITY DEFINER, reads pg_shadow)
- Bootstrap: `03-pgbouncer-auth.sh` creates user
- Escapes password → `/tmp/.pgpass`, NOT inline
- Health: DB `:6432/postgres`, NOT admin
- Flow: `PGBOUNCER_AUTH_PASS` → escape `:@&` → `.pgpass`

## Extension Patterns

**14 PGDG (apt):** pg_cron, pgaudit, pgvector, timescaledb, postgis, pg_partman, pg_repack, plpgsql_check, hll, http, hypopg, pgrouting, rum, set_user

**18 Compiled (SHA-pinned):** index_advisor, pg_hashids, pg_jsonschema, pg_stat_monitor, pgmq, pgq, pgroonga, pgsodium, supabase_vault, timescaledb_toolkit, vectorscale, wrappers

**6 Tools (no CREATE EXTENSION):** pgbackrest, pgbadger, pg_plan_filter, pg_safeupdate, supautils, wal2json

**Enable/Disable:** Manifest `enabled: false` → build+cleanup `.so` → exclude init. 4 non-disableable: auto_explain, pg_cron, pg_stat_statements, pgaudit.

## Init Script Order

**Shared:** `01-extensions.sql` (6 baseline) → `02-replication.sh` (replicator user+slot) → `03-pgsodium-init.sh` (if enabled)

**Stack-specific:** Primary adds `03-pgbouncer-auth.sh`. Order: exts before users, replication before auth.

## Compose Overrides

`compose.yml` (prod: private IPs, limits) + `compose.dev.yml` (dev: localhost). Base: `postgresql-base.conf` via include.

## PG18 Optimizations

- `io_method = 'worker'` (async I/O, 2-3x NVMe)
- LZ4 WAL compression (30-60% vs pglz)
- Data checksums (default, opt-out: `DISABLE_DATA_CHECKSUMS`)
- `pgaudit.log_statement_once = on` (PG18)
- Idle slot timeout: 48h

## Workflows

**Build:** `./scripts/build.sh` → ~12min first, ~2min cached. `--push` for multi-platform.

**Test:** CREATE EXTENSION → functional → logs (RAM/CPU) → PgBouncer :6432 SHOW POOLS. Mem: 512MB/1GB/2GB/64GB.

**CI/CD:** Manual, multi-platform, arm64 via QEMU.

## Gotchas

1. **PgBouncer .pgpass:** `docker exec pgbouncer-primary ls -l /tmp/.pgpass`
2. **Auto-config always on:** `-c` overrides `postgresql.conf`
3. **SHA staleness:** Verify `https://github.com/<owner>/<repo>/commit/<SHA>`
4. **No cgroup limit:** `/proc/meminfo` = host RAM. Set `mem_limit` or `POSTGRES_MEMORY`
5. **Health check:** DB `:6432/postgres`, NOT `:6432/pgbouncer`
6. **Build vs runtime:** Exts = ARGs (baked). RAM/CPU = runtime (adapts)
7. **arm64 QEMU slow:** CI (2-3x). Prod = native

## Monitoring

`postgres_exporter` `:9187/metrics` → `pg_stat_database_*`, custom queries. Prometheus → Grafana.

## Security

- SHA-pinned exts (immutable)
- SCRAM-SHA-256 auth (no MD5)
- SECURITY DEFINER auth_query
- 127.0.0.1 default (prod: firewall)
- Env vars only

## Upgrading

**PG Major:** `PG_VERSION` → check compat → SHAs → rebuild → pg_upgrade.

**Ext Minor:** SHA → `*_COMMIT_SHA` → rebuild → `ALTER EXTENSION UPDATE;`

## Contributing

1. `./scripts/build.sh` → deploy → verify
2. `./scripts/test/test-auto-config.sh` (512MB/2GB/64GB)
3. `bun run generate` or `./scripts/generate-configs.sh`
4. `grep -ri "password\|secret" . | grep -v .env.example`
5. Update CHANGELOG.md, PR

## Design Constraints

**Target:** 2-16GB optimal, 2-128GB range. 1-64 CPU. Compose-only.

**Limits:**

- Max conn: 80/120/200 tiers
- PgBouncer txn mode: NO prepared/advisory/LISTEN/NOTIFY
- Auto-config: cgroup v2 → manual → /proc/meminfo
- PG18 only

**Why transaction mode:** Stateless pooling. Session breaks pooling. :5432 direct, :6432 for apps.

**Why SHA pinning:** Tags mutable, SHAs immutable. Manual updates vs supply chain security.

## Dev Tooling

**Runtime:** Bun 1.3.0+, TS 5.9.3 strict, Node 24.0.0+. Bun-native (`$`, bunx).

**Quality:** Oxlint (`bun run lint`), Prettier (`bun run format`), TS (`bun run type-check`), shellcheck, hadolint, yaml-lint.

**Validation:**

- `bun run validate` (fast, pre-commit)
- `bun run validate:full` (all, pre-push)

**Git Hooks:** Pre-commit (lint+format), pre-push (validate:full). Install: `bun run hooks:install`

**Testing:** 4,185 lines integration. 11 scenarios: exts, auto-config, replication, stacks, multi-arch.

**Commands:**

```bash
bun install          # Deps
bun run validate    # Fast
bun run validate:full  # All
./scripts/build.sh  # Build
```

---

One image, minimal config. Auto-adapts hardware. SHA-pinned. Env-driven.
