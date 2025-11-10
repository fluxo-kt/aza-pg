# aza-pg Agent Guide

PostgreSQL 18 | Compose-only | Bun-first | SHA-pinned | Auto-config

**Bun-First**: All scripts use Bun TypeScript. No Node.js compat. See Development Standards below.

## Invariants

- Preload (default): auto_explain, pg_cron, pg_stat_statements, pgaudit
- Extensions: 38 catalog total (36 enabled, 2 disabled: pgq, supautils)
- Tools ≠ extensions: 5 tools (no CREATE EXTENSION)
- **No Bun in final image** (build-only dependency)
- **Image includes /etc/postgresql/version-info.{txt,json}** (self-documenting)
- Manifest = single source of truth
- Private repo | Public images (free, no guarantees)

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
- Tools vs extensions: No CREATE EXTENSION on tools (5: pgbackrest, pgbadger, wal2json, pg_plan_filter, pg_safeupdate)
- PGDG-disabled: compiled extensions only (PGDG are install-or-skip)
- Auto-config: `-c` flags override postgresql.conf at runtime

## Extension System

Enable/disable: Edit `scripts/extensions/manifest-data.ts` → `bun run generate` → rebuild

**Classification:** 6 builtin + 25 extensions + 5 tools = 36 enabled. Modules: 1 (auto_explain). Preloaded: 4 (auto_explain, pg_cron, pg_stat_statements, pgaudit). See docs/EXTENSIONS.md for details.

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

**Bun-Tailored TS (SOTA best practices)**:

- Use Bun APIs: `Bun.file()`, `Bun.spawn()`, `Bun.$`, `Bun.env` (NO `node:` imports)
- TypeScript strict mode, ES2024, bundler resolution
- Run via: `bun run <script>.ts` (never node/tsx)

**Linting (comprehensive)**:

- oxlint (50-100x faster, Rust-based, sufficient rules)
- prettier (battle-tested, will migrate to oxfmt when stable)
- shellcheck (extended analysis), hadolint (Dockerfile), yamllint (workflows/compose)
- TypeScript strict: noUnusedLocals, noImplicitAny, noUnusedParameters

**Git Hooks (bun-git-hooks, repo-wide)**:

- Installed via: `bun-git-hooks` (auto-runs on postinstall)
- pre-commit: `bun run validate --staged` (fast, staged files only)
- pre-push: `bun run validate:full` (complete validation)

**CI/CD Workflows**:

- `ci.yml`: ONLY workflow on PRs (fast: lint, manifest, sync checks, ~5min)
- `build-postgres-image.yml`: Manual dev/QA builds (NO push by default, dev-prefixed tags only)
- `publish.yml`: Release-only (push to `release` branch, single-node image, versioned tags, Cosign signing)
- Tags: `MM.mm-TS-TYPE` (e.g., `18.0-202511092330-single-node`) + convenience (`18-single-node`, `18`)
- NO 'latest' tag from dev builds (publish.yml only)

**Environment Files**:

- `.env`: NOT committed (gitignored, local test passwords OK)
- `.env.example`: Committed (placeholders, security warnings, defaults)
- chmod 600 .env (never commit real credentials)

**Image Versioning**:

- Format: `MM.mm-TS-TYPE` where MM=PG major, mm=PG minor, TS=YYYYMMDDHHmm, TYPE=single-node
- Example: `ghcr.io/fluxo-kt/aza-pg:18.0-202511092330-single-node`
- Version info: `docker run <image> cat /etc/postgresql/version-info.txt`

See docs/TOOLING.md, docs/BUILD.md for details.

## References

- ARCHITECTURE.md - System design, flows
- TESTING.md - Test patterns, session isolation
- PRODUCTION.md - Deployment, security
- docs/BUILD.md - Build instructions, CI/CD workflows
- docs/TOOLING.md - Tech choices, locked decisions
