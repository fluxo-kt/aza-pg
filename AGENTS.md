# aza-pg Agent Guide

PostgreSQL 18 | Compose-only | Bun-first | SHA-pinned | Auto-config

**Bun-First**: All scripts use Bun TypeScript. No Node.js compat. See Development Standards below.

## CRITCICAL RULES

- ALWAYS COMPREHENSIVELY HOLYSTICALLY VERIFY/TEST/CHECK ALL PARTS OF YOUR WORK/CHANGES LOCALLY BEFORE COMMITTING
- DOUBLE CHECK & CONFIRM ALL TESTS AND VERIFICATIONS ARE COMPLETE AND SUCCESSFUL BEFORE PUSHING

## Invariants

- Preload (default): auto_explain, pg_cron, pg_stat_monitor, pg_stat_statements, pgaudit
- Extensions: 38 catalog total (34 enabled, 4 disabled: pgq, postgis, pgrouting, supautils)
- Tools ≠ extensions: 5 tools (no CREATE EXTENSION)
- **No Bun in final image** (build-only dependency)
- **Image includes /etc/postgresql/version-info.{txt,json}** (self-documenting)
- Manifest = single source of truth
- **Dockerfile is auto-generated** from template + manifest (never edit directly)
- Private repo | Public images (free, no guarantees)
- **Repository separation**: Production (`aza-pg`) vs Testing/Dev (`aza-pg-testing`)

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
- **Dockerfile editing**: NEVER edit Dockerfile directly - edit Dockerfile.template and run `bun run generate`
- PgBouncer .pgpass: escape only ":" and "\\" (NOT "@" or "&")
- Health check: 6432/postgres (not admin console)
- Cgroup missing → use POSTGRES_MEMORY or mem_limit
- Tools vs extensions: No CREATE EXTENSION on tools (5: pgbackrest, pgbadger, wal2json, pg_plan_filter, pg_safeupdate)
- PGDG-disabled: compiled extensions only (PGDG are install-or-skip)
- Auto-config: `-c` flags override postgresql.conf at runtime

## Extension System

Enable/disable: Edit `scripts/extensions/manifest-data.ts` → `bun run generate` → rebuild

**Key details:** Modules: 1 (auto_explain). Preloaded: 5 (auto_explain, pg_cron, pg_stat_monitor, pg_stat_statements, pgaudit). Tools (no CREATE EXTENSION): 5. See docs/EXTENSIONS.md for full catalog.

**Optional preload modules** (enable via `POSTGRES_SHARED_PRELOAD_LIBRARIES`):

- `timescaledb`: Time-series database features (hypertables, compression)
- `safeupdate` (pg_safeupdate): Prevents UPDATE/DELETE without WHERE clause
- `pgsodium`: Encryption library (requires pgsodium_getkey script)
- `set_user`: Audited SET ROLE for privilege escalation tracking
- `pg_partman`: Automated partition management background worker
- `pg_plan_filter`: Query plan safety filter

**Example:**

```bash
docker run -e POSTGRES_SHARED_PRELOAD_LIBRARIES="auto_explain,pg_cron,pg_stat_monitor,pg_stat_statements,pgaudit,timescaledb,safeupdate" ...
```

## Auto-Config

**Resource Detection**:

- RAM: POSTGRES_MEMORY → cgroup v2 → /proc/meminfo (warn)
- CPU: `nproc` (cgroup-aware)

**Workload Optimization** (`POSTGRES_WORKLOAD_TYPE`):

- `web` (default): max_connections=200, balanced for OLTP + read-heavy queries
- `oltp`: max_connections=300, optimized for high-concurrency transactions
- `dw`: max_connections=100, optimized for analytics/data warehouse (high statistics_target=500)
- `mixed`: max_connections=120, balanced general-purpose workload

**Storage Tuning** (`POSTGRES_STORAGE_TYPE`):

- `ssd` (default): random_page_cost=1.1, effective_io_concurrency=200
- `hdd`: random_page_cost=4.0, effective_io_concurrency=2 (mechanical drives)
- `san`: random_page_cost=1.1, effective_io_concurrency=1 (network storage with low iops variance)

**Scaling Caps**:

- shared_buffers ≤ 32GB (25% of RAM)
- work_mem ≤ 32MB (prevents OOM on complex queries)
- Connections: RAM-scaled (50%/70%/85%/100% across 4 tiers: <2GB, 2-4GB, 4-8GB, ≥8GB)

## Troubleshooting

- Extension missing: Check manifest enabled flag + run `bun run generate` + rebuild
- Dockerfile out of date: Run `bun run generate` to regenerate from template
- Preload error: Align shared_preload_libraries with manifest defaults
- RAM misdetection: Set POSTGRES_MEMORY explicitly
- Connection limit: Review max_connections in auto-config
- SHA staleness: Verify `https://github.com/<owner>/<repo>/commit/<SHA>` valid

## Development Standards

**Bun-Tailored TS (SOTA best practices)**:

- **ALWAYS prefer Bun native APIs** when available: `Bun.file()`, `Bun.spawn()`, `Bun.$`, `Bun.env`
- File I/O: Use `Bun.file()`, `Bun.write()` instead of `fs`/`fs/promises`
- Process execution: Use `Bun.spawn()` or `Bun.$` instead of `child_process.exec/execSync`
- Environment: Use `Bun.env` instead of `process.env`
- Node stdlib ONLY when Bun lacks equivalent: `path` module acceptable (no Bun alternative yet)
- TypeScript strict mode enabled (tsconfig.json), ES2024, bundler resolution
- Run via: `bun run <script>.ts` (never node/tsx)
- **Extension defaults**: `scripts/extension-defaults.ts` is single source of truth for PGDG versions

**Linting (comprehensive)**:

- oxlint (50-100x faster, Rust-based, sufficient rules)
- prettier (battle-tested, will migrate to oxfmt when stable)
- shellcheck (extended analysis), hadolint (Dockerfile), yamllint (workflows/compose)
- TypeScript strict: noUnusedLocals, noImplicitAny, noUnusedParameters

**Git Hooks (bun-git-hooks, repo-wide)**:

- Installed via: `bun-git-hooks` (auto-runs on postinstall)
- pre-commit: Auto-fixes linting/formatting, regenerates artifacts if manifest changed, auto-stages fixes
- pre-push: Disabled (CI enforces validation instead)

**CI/CD Workflows**:

- `ci.yml`: ONLY workflow on PRs (fast: lint, manifest, sync checks, ~5min)
- `build-postgres-image.yml`: Manual dev/QA builds (NO push by default, dev-prefixed tags only)
- `publish.yml`: Release-only (push to `release` branch, single-node image, versioned tags, Cosign signing)
- Tags: `MM.mm-TS-TYPE` (e.g., `18.1-202511142330-single-node`) + convenience (`18-single-node`, `18`)
- NO 'latest' tag from dev builds (publish.yml only)

**Environment Files**:

- `.env`: NOT committed (gitignored, local test passwords OK)
- `.env.example`: Committed (placeholders, security warnings, defaults)
- chmod 600 .env (never commit real credentials)

**Image Versioning**:

- Format: `MM.mm-TS-TYPE` where MM=PG major, mm=PG minor (actual), TS=YYYYMMDDHHmm, TYPE=single-node
- Example: `ghcr.io/fluxo-kt/aza-pg:18.1-202511142330-single-node`
- Version extracted from base image BEFORE tagging (publish.yml pulls base, runs psql --version)
- Version info generated in final stage with actual PostgreSQL version: `docker run <image> cat /etc/postgresql/version-info.txt`

**Repository Separation**:

- **Production**: `ghcr.io/fluxo-kt/aza-pg` (release tags only: `18.1-...`, `18`, etc.)
- **Testing/Dev**: `ghcr.io/fluxo-kt/aza-pg-testing` (`testing-*`, `dev-*` tags)
- ⚠️ **NEVER use aza-pg-testing images in production** (ephemeral, unvalidated artifacts)
- Promotion flow: Build → Testing repo → Test → Scan → Promote (digest copy) → Production repo
- Testing tags deleted after successful promotion or workflow failure

See docs/TOOLING.md, docs/BUILD.md for details.

## References

- ARCHITECTURE.md - System design, flows
- TESTING.md - Test patterns, session isolation
- PRODUCTION.md - Deployment, security
- docs/BUILD.md - Build instructions, CI/CD workflows
- docs/TOOLING.md - Tech choices, locked decisions
