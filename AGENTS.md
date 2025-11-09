# aza-pg Agent Guide

PostgreSQL 18 | Compose-only | Bun-first | SHA-pinned | Auto-config

**Bun-First Philosophy**: All scripting and configuration uses Bun-tailored TypeScript. No Node.js compatibility needed. Use Bun-specific APIs with latest best practices. See "Development Standards" below.

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

- **auto_explain is a module, not an extension**: Loaded via shared_preload_libraries, NO CREATE EXTENSION needed (PostgreSQL design)
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

- Tools (6): No CREATE EXTENSION needed (CLI utilities)
- Modules (1): auto_explain - preload-only, NO CREATE EXTENSION (PostgreSQL core module)
- Extensions (31): Require CREATE EXTENSION (5 auto-created: pg_cron, pg_stat_statements, pg_trgm, pgaudit, vector)
- Preloaded (4): auto_explain (module), pg_cron, pg_stat_statements, pgaudit

## Auto-Config

RAM detect order: POSTGRES_MEMORY → cgroup v2 → /proc/meminfo (warn)
Caps: shared_buffers ≤ 32GB, work_mem ≤ 32MB, connections: 80/120/200

## Troubleshooting

Extension missing: Check manifest enabled flag + Dockerfile build
Preload error: Align shared_preload_libraries with manifest defaults
RAM misdetection: Set POSTGRES_MEMORY explicitly
Connection limit: Review max_connections in auto-config
SHA staleness: Verify `https://github.com/<owner>/<repo>/commit/<SHA>` still valid

## Development Standards

**Bun-First TypeScript**:

- Use Bun runtime for all scripts (no Node.js)
- Leverage Bun-specific APIs (Bun.file, Bun.sleep, etc.)
- No Node.js compatibility shims needed
- Latest SOTA best practices for Bun

**Linting & Formatting**:

- Oxlint for TypeScript/JavaScript (supports all file types)
- Shellcheck for bash scripts
- yamllint for YAML files
- hadolint for Dockerfiles
- Prettier for code formatting

**Git Hooks**:

- Use bun-git-hooks (full-repo-wise from root)
- Pre-commit: validate, lint, format
- Pre-push: comprehensive checks

**GitHub Workflows**:

- `.github/workflows/ci.yml` - Fast CI for all commits/PRs (single workflow)
- `.github/workflows/publish.yml` - Release to ghcr.io (release branch only)
- Optimized for speed and cost-efficiency
- No redundant workflows for PRs

**Image Versioning**:

- Format: `MM.mm-TS-TYPE` (e.g., `18.0-202511092330-single-node`)
  - MM = PostgreSQL major (18)
  - mm = PostgreSQL minor (0)
  - TS = build timestamp YYYYMMDDHHmm
  - TYPE = image type (single-node)
- Convenience tags: `18.0-single-node`, `18-single-node`, `18.0`, `18`
- Registry: `ghcr.io/fluxo-kt/aza-pg`

## References

- ARCHITECTURE.md - System design, flows
- TESTING.md - Test patterns, session isolation
- PRODUCTION.md - Deployment, security
- docs/TOOLING.md - Tech choices, locked decisions
