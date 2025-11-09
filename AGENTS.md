# aza-pg Agent Guide

PostgreSQL 18 | Compose-only | Bun-first | SHA-pinned | Auto-config

## Invariants

- Preload (default): auto_explain, pg_cron, pg_stat_statements, pgaudit
- Extensions: 38 catalog total (36 enabled, 2 disabled: pgq, supautils)
- Tools ≠ extensions: 6 tools (no CREATE EXTENSION)
- No Bun in final image
- Manifest = single source of truth

## Paths

- `docker/postgres/` - Dockerfile, entrypoints, initdb scripts
- `scripts/` - Bun TS scripts (no absolute paths)
- `stacks/{primary,replica,single}` - Compose deployments
- `docs/.generated/docs-data.json` - Auto-generated reference

## Fast Paths

```bash
./scripts/build.sh                    # Build image
bun run validate                      # Fast checks
bun run validate:full                 # Full suite
bun run generate                      # Generate configs
cd stacks/primary && docker compose up
```

## Gotchas

- PgBouncer .pgpass: escape only ":" and "\\" (NOT "@" or "&")
- Health check: 6432/postgres (not admin console)
- Cgroup missing → use POSTGRES_MEMORY or mem_limit
- Tools vs extensions: avoid CREATE EXTENSION on tools (6: pgbackrest, pgbadger, wal2json, pg_plan_filter, pg_safeupdate, supautils)
- PGDG-disabled invariant: applies to compiled extensions only (PGDG are install-or-skip)
- Auto-config always active: `-c` flags override `postgresql.conf` at runtime

## Extension System

Enable/disable: Edit `scripts/extensions/manifest-data.ts` → `bun run generate` → rebuild
Preload warning: Disabling default-preload requires POSTGRES_SHARED_PRELOAD_LIBRARIES alignment

**Classification:**

- Tools (6): No CREATE EXTENSION needed
- Extensions (31): Require CREATE EXTENSION (6 auto-created: auto_explain, pg_cron, pg_stat_statements, pg_trgm, pgaudit, vector)
- Preloaded (4): auto_explain, pg_cron, pg_stat_statements, pgaudit

## Auto-Config

RAM detect order: POSTGRES_MEMORY → cgroup v2 → /proc/meminfo (warn)
Caps: shared_buffers ≤ 32GB, work_mem ≤ 32MB, connections: 80/120/200

## Troubleshooting

Extension missing: Check manifest enabled flag + Dockerfile build
Preload error: Align shared_preload_libraries with manifest defaults
RAM misdetection: Set POSTGRES_MEMORY explicitly
Connection limit: Review max_connections in auto-config
SHA staleness: Verify `https://github.com/<owner>/<repo>/commit/<SHA>` still valid

## References

- ARCHITECTURE.md - System design, flows
- TESTING.md - Test patterns, session isolation
- PRODUCTION.md - Deployment, security
- docs/TOOLING.md - Tech choices, locked decisions
