# aza-pg Agent Guide

PostgreSQL 18 | Compose-only | Bun-first | SHA-pinned | Auto-config

**Bun-First**: All scripts use Bun TypeScript. No Node.js compat. See Development Standards below.

## Invariants

- Preload (default): auto_explain, pg_cron, pg_stat_statements, pgaudit
- Extensions: 38 catalog total (36 enabled, 2 disabled: pgq, supautils)
- Tools ≠ extensions: 5 tools (no CREATE EXTENSION)
- No Bun in final image
- Manifest = single source of truth

## Paths

- `docker/postgres/` - Dockerfile, entrypoints, initdb scripts
- `scripts/` - Bun TS scripts (no absolute paths)
- `stacks/{primary,replica,single}` - Compose deployments
- `docs/.generated/docs-data.json` - Auto-generated reference

## Fast Paths

```bash
bun run build                         # Build image
bun run validate                      # Fast checks
bun run validate:full                 # Full suite
bun run generate                      # Generate configs
cd stacks/primary && docker compose up
```

## Gotchas

- **auto_explain**: Module (preload-only), NOT extension. NO CREATE EXTENSION needed (PostgreSQL design)
- PgBouncer .pgpass: escape only ":" and "\\" (NOT "@" or "&")
- Health check: 6432/postgres (not admin console)
- Cgroup missing → use POSTGRES_MEMORY or mem_limit
- Tools vs extensions: No CREATE EXTENSION on tools (6: pgbackrest, pgbadger, wal2json, pg_plan_filter, pg_safeupdate, supautils)
- PGDG-disabled: compiled extensions only (PGDG are install-or-skip)
- Auto-config: `-c` flags override postgresql.conf at runtime

## Extension System

Enable/disable: Edit `scripts/extensions/manifest-data.ts` → `bun run generate` → rebuild

**Classification:** Tools (5), Modules (1: auto_explain), Extensions (26), Preloaded (4: auto_explain, pg_cron, pg_stat_statements, pgaudit). See docs/EXTENSIONS.md for details.

## Auto-Config

RAM detect order: POSTGRES_MEMORY → cgroup v2 → /proc/meminfo (warn)
Caps: shared_buffers ≤ 32GB, work_mem ≤ 32MB, connections: 80/120/200

## Troubleshooting

- Extension missing: Check manifest enabled flag + Dockerfile build
- Preload error: Align shared_preload_libraries with manifest defaults
- RAM misdetection: Set POSTGRES_MEMORY explicitly
- Connection limit: Review max_connections in auto-config
- SHA staleness: Verify `https://github.com/<owner>/<repo>/commit/<SHA>` valid

## Development Standards

- **Bun-first** - All scripts use Bun, no Node.js compat
- **Linting** - oxlint, shellcheck, yamllint, hadolint, prettier
- **Git hooks** - pre-commit (validate) + pre-push (full checks)
- **CI/CD** - Fast workflow for PRs, release-only publish
- **Versioning** - `MM.mm-TS-TYPE` (e.g., `18.0-202511092330-single-node`)

See docs/TOOLING.md for details.

## References

- ARCHITECTURE.md - System design, flows
- TESTING.md - Test patterns, session isolation
- PRODUCTION.md - Deployment, security
- docs/BUILD.md - Build instructions, CI/CD workflows
- docs/TOOLING.md - Tech choices, locked decisions
