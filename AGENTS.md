# Agent Operations Guide

PG18 stack: auto-adaptive config, 37 extensions (SHA-pinned), PgBouncer pooling, amd64/arm64. 2-128GB RAM, 1-64 cores, Compose-only.

## Invariants

- 4 preload core extensions must stay enabled unless `POSTGRES_SHARED_PRELOAD_LIBRARIES` adjusted
- Disabled extensions still built+tested then `.so` removed from final image
- No Bun in final image (build-time only)
- Compose-only target; Kubernetes out-of-scope
- Manifest (`extensions.manifest.json`) is source of truth

## Directory Map

- `docker/postgres/` - Dockerfile, configs, entrypoint, init scripts
- `stacks/{primary,replica,single}/` - Compose stacks with .env examples
- `scripts/` - Build, test, validation, config generation (Bun-first)
- `docs/` - Architecture, extensions, testing, production guides
- `docs/.generated/docs-data.json` - Generated extension/memory data (don't edit manually)

## Fast Paths

```bash
./scripts/build.sh              # Build image (~12min first, ~2min cached)
bun run validate                # Fast checks (lint, type, format)
bun run check:docs              # Verify docs match manifest
cd stacks/primary && docker compose up  # Deploy stack
```

## Pitfalls

1. **PgBouncer .pgpass escaping**: Only `:` and `\` need escaping (NOT `@` or `&`)
2. **Auto-config always active**: `-c` flags override `postgresql.conf` at runtime
3. **No cgroup limit**: Falls back to `/proc/meminfo` (host RAM). Set `mem_limit` or `POSTGRES_MEMORY`
4. **Health check port**: Use `:6432/postgres` (DB), NOT `:6432/pgbouncer` (admin)
5. **Tool vs Extension**: Tools (pgbackrest, pgbadger, wal2json) = no `CREATE EXTENSION` needed
6. **PgBouncer image**: Must contain bash; pin Debian-based images only

## Extension System

**37 total** (6 builtin + 25 extensions + 6 tools). See `docs/.generated/docs-data.json` for complete lists.

**Classification:**

- **Tools** (6): pgbackrest, pgbadger, wal2json, pg_plan_filter, pg_safeupdate, supautils - no CREATE EXTENSION
- **Extensions** (31): Require CREATE EXTENSION (auto-created: auto_explain, pg_cron, pg_stat_statements, pg_trgm, pgaudit, vector)
- **Preloaded** (4): auto_explain, pg_cron, pg_stat_statements, pgaudit (via shared_preload_libraries)

**Manifest flow:** `scripts/extensions/manifest-data.ts` → `generate-manifest.ts` → `extensions.manifest.json` → Dockerfile → init scripts

**Enable/Disable:** Edit `manifest-data.ts` → `bun scripts/extensions/generate-manifest.ts` → rebuild. Core preloaded extensions cannot be disabled.

## PgBouncer Auth

- `auth_query = SELECT * FROM pgbouncer_lookup($1)` (SECURITY DEFINER, reads pg_shadow)
- Bootstrap: `03-pgbouncer-auth.sh` creates lookup function
- Password escaping: `:` and `\` only for `.pgpass` format (NOT `:@&` - common mistake)
- Health check: `:6432/postgres` (NOT admin console)
- Flow: `PGBOUNCER_AUTH_PASS` env → escape → `/tmp/.pgpass` → auth_query

## Auto-Config (Runtime)

**Trigger:** Container start. Detects cgroup v2 → `POSTGRES_MEMORY` env → `/proc/meminfo` fallback.

**Knobs:** `POSTGRES_MEMORY=<MB>`, `POSTGRES_SHARED_PRELOAD_LIBRARIES=ext1,ext2`

**Caps:** shared_buffers 32GB, maintenance_work_mem 2GB, work_mem 32MB, max_connections 80/120/200

**Memory tiers:** See `docs/.generated/docs-data.json` for 2GB/4GB/8GB/16GB/32GB allocations.

**Extension overhead:** ~100-250MB (pg_stat_statements, pgvector, timescaledb).

## Troubleshooting

1. **Build fails**: Verify `docker build -f docker/postgres/Dockerfile .` from repo root
2. **Connection refused**: Check `POSTGRES_BIND_IP` in .env (default: 127.0.0.1 = localhost only)
3. **Extension missing**: Check preload logs: `docker logs <container> | grep shared_preload`
4. **High memory**: Override with `POSTGRES_MEMORY=<MB>` (auto-config may detect wrong value)
5. **PgBouncer auth fails**: Verify `.pgpass` exists: `docker exec pgbouncer-primary cat /tmp/.pgpass`
6. **SHA staleness**: Verify `https://github.com/<owner>/<repo>/commit/<SHA>` still valid

## Reference

- Extension counts, tools list, preload libraries: `docs/.generated/docs-data.json`
- Memory allocation tables: `docs/.generated/docs-data.json`
- Full architecture: `docs/ARCHITECTURE.md`
- Extension management: `docs/EXTENSIONS.md`
- Testing guide: `docs/TESTING.md`
- Production deployment: `docs/PRODUCTION.md`

---

**Single image, minimal config. Auto-adapts hardware. SHA-pinned. Env-driven.**
