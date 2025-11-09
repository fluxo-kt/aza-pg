# aza-pg Operations Guide

Production PG18 stack: auto-adaptive config, 38 extensions (SHA-pinned), PgBouncer pooling, multi-platform (amd64/arm64). Targets 2-128GB RAM, 1-64 cores, Compose-only.

## Core Architecture

**Image:** Multi-stage build → extensions compile from pinned SHAs → `.so` files copied to slim final (~450MB). ENTRYPOINT detects RAM/CPU at runtime → injects `-c` flags. One image adapts everywhere.

**Stacks:** `primary/` = PG + PgBouncer + exporter. `replica/` = streaming replication. `single/` = standalone. All env-driven.

**Extensions:** 38 total: 6 builtin + 14 PGDG (apt) + 18 compiled (source). Hybrid = PGDG speed + source flexibility. 7 baseline auto-created: `auto_explain, pg_cron, pg_stat_statements, pg_trgm, pgaudit, plpgsql, vector`. 4 preloaded: `auto_explain, pg_cron, pg_stat_statements, pgaudit`.

## Auto-Config (Runtime)

**Trigger:** Container start (NOT build). Detects cgroup v2 → `POSTGRES_MEMORY` override → `/proc/meminfo` fallback.

**Overrides:**

- `POSTGRES_MEMORY=<MB>` — Manual RAM
- `POSTGRES_SHARED_PRELOAD_LIBRARIES` — Override preload list (default: pg_stat_statements,auto_explain,pg_cron,pgaudit)

**Caps:** shared_buffers 32GB, maint_work_mem 2GB, work_mem 32MB, max_conn 80/120/200 (by RAM tier).

**Memory Allocation:**

| RAM   | shared_buf | eff_cache | maint_work | work_mem | max_conn |
| ----- | ---------- | --------- | ---------- | -------- | -------- |
| 512MB | 128MB      | 384MB     | 32MB       | 1MB      | 80       |
| 2GB   | 512MB      | 1536MB    | 64MB       | 4MB      | 120      |
| 4GB   | 1024MB     | 3072MB    | 128MB      | 5MB      | 200      |
| 8GB   | 2048MB     | 6144MB    | 256MB      | 10MB     | 200      |
| 32GB  | 6553MB     | 24576MB   | 1024MB     | 32MB     | 200      |
| 64GB  | 9830MB     | 49152MB   | 2048MB     | 32MB     | 200      |

Extension overhead ~100-250MB (pg_stat_statements, pgvector, timescaledb).

## PgBouncer Auth

- NO plaintext userlist: uses `auth_query = SELECT * FROM pgbouncer_lookup($1)`
- Function: SECURITY DEFINER reads `pg_shadow` (hashes)
- Bootstrap: `03-pgbouncer-auth.sh` creates `pgbouncer_auth` user
- Entry script: escapes password → writes `/tmp/.pgpass`, NOT inline `pgbouncer.ini`
- Health: connects via DB (`:6432/postgres`), NOT admin console

**Credential flow:** `PGBOUNCER_AUTH_PASS` → escape special chars (`:@&`) → `.pgpass`

## Extension Patterns

**Hybrid Strategy:** 14 PGDG (fast APT install) + 18 compiled (SHA-pinned). PGDG = stability, compiled = latest/specialized.

**PGDG:** pg_cron, pgaudit, pgvector, timescaledb, postgis, pg_partman, pg_repack, plpgsql_check, hll, http, hypopg, pgrouting, rum, set_user

**Compiled:** index_advisor, pg_hashids, pg_jsonschema, pg_stat_monitor, pgmq, pgq, pgroonga, pgsodium, supabase_vault, timescaledb_toolkit, vectorscale, wrappers

**Tools (6, no CREATE EXTENSION):** pgbackrest, pgbadger, pg_plan_filter, pg_safeupdate, supautils, wal2json

**Enable/Disable:** Manifest `enabled: false` → build+test → cleanup `.so` files → exclude from init SQL. Dependency validation at build (fail fast). 4 non-disableable (preloaded): auto_explain, pg_cron, pg_stat_statements, pgaudit.

## Init Script Order

**Critical:** Alphabetical from 2 sources: `docker/postgres/docker-entrypoint-initdb.d/` (shared) + `stacks/*/configs/initdb/` (stack-specific).

**Shared (all stacks):**

1. `01-extensions.sql` — Creates 7 baseline (auto_explain, pg_cron, pg_stat_statements, pg_trgm, pgaudit, plpgsql, vector)
2. `02-replication.sh` — `replicator` user + slot
3. `03-pgsodium-init.sh` — Encryption key (if `ENABLE_PGSODIUM_INIT=true`)

**Stack-specific:** Primary adds `03-pgbouncer-auth.sh`. Order matters: extensions before users, replication before auth.

## Compose Overrides

`compose.yml` (prod: private IPs, limits) + `compose.dev.yml` (dev: localhost, test mem). Merge: `docker compose -f compose.yml -f compose.dev.yml up`. Base config: `postgresql-base.conf` via `include` directive (DRY).

## PG18 Optimizations

- `io_method = 'worker'` (async I/O, 2-3x faster NVMe)
- LZ4 WAL compression (30-60% reduction vs pglz)
- Data checksums (default, opt-out via `DISABLE_DATA_CHECKSUMS=true`)
- `pgaudit.log_statement_once = on` (PG18 feature, reduces duplication)
- Idle replication slot timeout: 48h (prevents WAL bloat)

## Key Workflows

**Build:** `./scripts/build.sh` → Buildx + remote cache → ~12min first, ~2min cached. Multi-platform: `--push` flag.

**Test:** CREATE EXTENSION + functional query → grep logs (RAM/CPU) → PgBouncer :6432 → `SHOW POOLS`. Memory tests: 512MB, manual 1GB, 2GB, 64GB.

**CI/CD:** Manual trigger, multi-platform + SBOM/provenance, arm64 via QEMU.

## Gotchas

1. **PgBouncer .pgpass:** Must exist in container. Check: `docker exec pgbouncer-primary ls -l /tmp/.pgpass`
2. **Auto-config always on:** `-c` flags override `postgresql.conf`. Cannot disable.
3. **SHA staleness:** Force-push to tag breaks. Verify: `https://github.com/<owner>/<repo>/commit/<SHA>`
4. **No cgroup limit:** Reads `/proc/meminfo` (may = host RAM). Set `mem_limit` or `POSTGRES_MEMORY`.
5. **Health check:** Use DB connection (`:6432/postgres`), NOT admin DB (`:6432/pgbouncer`).
6. **Build vs runtime:** Extension versions = build ARGs (baked). RAM/CPU = runtime (adapts to VPS).
7. **arm64 QEMU slow:** CI emulated (2-3x slower). Prod arm64 = native (no overhead).

## Monitoring

`postgres_exporter` → `:9187/metrics` → `pg_stat_database_*`, custom queries (`postgres_exporter_queries.yaml`: replication lag, memory settings, uptime). Prometheus scrapes → Grafana dashboards.

## Security

- Extensions: SHA-pinned (immutable, prevent tag poisoning)
- Auth: SCRAM-SHA-256 (no MD5/plaintext)
- PgBouncer: SECURITY DEFINER auth_query (no plaintext userlist)
- Networks: 127.0.0.1 default (prod: 0.0.0.0 + firewall)
- Secrets: env vars only (dev test password safe for local)

## Upgrading

**PG Major:** Update `PG_VERSION` ARG → check ext compat → update ext SHAs → rebuild → pg_upgrade.

**Ext Minor:** Find SHA from release → update `*_COMMIT_SHA` ARGs → rebuild → `ALTER EXTENSION <name> UPDATE;`

## Contributing

1. Local test: `./scripts/build.sh` → deploy primary → verify
2. Auto-config test: `./scripts/test/test-auto-config.sh` (manual/512MB/2GB/64GB)
3. Regen configs: `bun run generate` or `./scripts/generate-configs.sh`
4. No secrets: `grep -ri "password\|secret" . | grep -v .env.example`
5. Update CHANGELOG.md
6. PR with clear description

## Design Constraints

**Target:** 2-16GB optimal, scales 2-128GB. 1-64 CPU. Compose-only (no K8s).

**Limits:**

- Max connections: 80/120/200 tiers (prevent OOM, PgBouncer multiplexes)
- PgBouncer transaction mode: NO prepared statements/advisory locks/LISTEN/NOTIFY (use session mode if needed)
- Auto-config: cgroup v2 → manual → /proc/meminfo (set limit for deterministic)
- PG18 only (no multi-version)

**Why transaction mode:** Stateless pooling maximizes efficiency. Session features break pooling. Direct :5432 if needed, :6432 for apps.

**Why SHA pinning:** Tags mutable (attacker repush), SHAs immutable. Trade-off: manual updates vs supply chain security.

## Dev Tooling

**Runtime:** Bun 1.3.0+ (primary), TypeScript 5.9.3 strict, Node 24.0.0+ (engines). Bun-native APIs (`$`, bunx). NO Node-compat.

**Quality:**

- Oxlint 0.11.1 (Rust, 50-100x faster ESLint) — `bun run lint`
- Prettier 3.6.2 — `bun run format`
- TypeScript strict — `bun run type-check`
- shellcheck — `bun run lint:shell`
- hadolint — `bun run lint:docker`
- yaml-lint — `bun run lint:yaml`

**Validation:**

- `bun run validate` — Oxlint + Prettier + TS (fast, pre-commit)
- `bun run validate:full` — All linters (comprehensive, pre-push)

**Git Hooks:**

- Pre-commit: lint + format check
- Pre-push: validate:full
- Managed by bun-git-hooks (`git-hooks.config.ts`), installed as bash in `.git/hooks/`
- Install: `bun run hooks:install`

**Package:** bun.lock (binary, committed). All devDeps (infra project). ArkType validation (NOT Zod, locked in TOOLING.md).

**Testing:** 4,185 lines integration tests (Docker, no mocks). `./scripts/test/*.ts` using Bun `$`. 11 scenarios: ext loading, auto-config, replication, stacks, multi-arch.

**Critical files:** package.json, tsconfig.json (strict ES2024), .oxlintrc.json, .prettierrc.json, git-hooks.config.ts, .editorconfig, bunfig.toml

**Commands:**

```bash
bun install                 # Deps
bun run validate           # Fast (lint+format+types)
bun run validate:full      # All linters
bun run lint:fix           # Auto-fix
bun run format             # Format
./scripts/build.sh         # Build image
```

**Philosophy:** Bun-first, strict TS (no `any`), fast linters (Oxlint/Rust), comprehensive validation (shell/docker/yaml), immutable deps (bun.lock).

---

**One image, minimal config. Auto-adapts to hardware. SHA-pinned for reproducibility. Env-driven for universality.**
