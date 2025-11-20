# aza-pg Agent Guide (NO LOGS HERE, NO BS, ONLY FUTURE-PROOF VALUE)

PostgreSQL 18 | Compose-only | Bun-first | SHA-pinned | Auto-config

• **Bun-First**: All scripts use Bun TypeScript. Prefer Bun APIs to usuals from Node.js when possible and reasonable. See Development Standards below. **But NO Bun in the final images**
**TS-First**: YAML workflows are orchestration only — all logic, verification, and diagnostics belong in TypeScript scripts that can be tested locally. Dockerfiles are auto-generation-only from manifest, should be as simple as possible — all logic and nuances belong in TypeScript scripts.

## CRITICAL RULES

- ALWAYS COMPREHENSIVELY HOLYSTICALLY VERIFY/TEST/CHECK ALL PARTS OF YOUR WORK/CHANGES LOCALLY BEFORE COMMITTING
- DOUBLE CHECK & CONFIRM ALL TESTS AND VERIFICATIONS ARE COMPLETE AND SUCCESSFUL BEFORE PUSHING

## Invariants

- Manifest = single source of truth; encodes what's completely disabled (and not available), what's preloaded and/or enabled/created.
- Tools ≠ extensions (no CREATE EXTENSION)
- **No Bun in final image** (build-only dependency)
- **Image includes /etc/postgresql/version-info.{txt,json}** (self-documenting)
- **Dockerfile is auto-generated** from template + manifest (never edit directly)
- **Repository separation**: Production (`aza-pg`) vs Testing/Dev (`aza-pg-testing`)

## Paths

- `docker/postgres/` - Dockerfile, entrypoints, initdb scripts
- `scripts/` - Bun TS scripts (no absolute paths)
- `stacks/{primary,replica,single}` - Compose deployments
- `docs/.generated/docs-data.json` - Auto-generated reference

## CI/CD Scripts (TypeScript-First Architecture)

**Purpose**: All CI/CD logic in testable TypeScript scripts. YAML workflows = thin orchestration only.

**Core Scripts**:

- `scripts/ci/load-image-artifact.ts` - Load Docker tarball from artifacts, retag with 3 fallback methods
- `scripts/docker/setup-pgflow-container.ts` - Multi-stage pgflow container setup (5 stages: start → running → PostgreSQL → schema → verify)
  - Verifies pgflow schema: 7 tables + 13+ functions (fixes pg_isready race condition)
  - Modes: setup (default), --cleanup-only, --verify-only
  - Exit codes: 0=success, 1=setup failed, 2=schema timeout, 3=cleanup failed
- `scripts/debug/capture-test-failure-logs.ts` - Unified diagnostic capture for test failures
  - Modes: --containers "name1,name2" OR --all-containers
  - Captures: logs (stdout+stderr), state, config, health per container
  - Generates: README.txt summary with file list
- `scripts/release/promote-image.ts` - Digest-based image promotion with OCI metadata annotations
  - Supports multi-tag promotion (--tags comma-separated)
  - Metadata: version, pg-version, catalog stats, base image info, revision, source URL
  - Cryptographic verification via digest reference (not tag)

**Pattern**: `bun scripts/{category}/{script}.ts --help` shows usage. All scripts testable locally before CI.

## Fast Paths

```bash
bun run build                         # Build image
bun run validate                      # Fast checks
bun run validate:full                 # Full suite
bun run generate                      # Generate configs
cd stacks/primary && docker compose up

# Test CI/CD scripts locally
bun scripts/docker/setup-pgflow-container.ts --help
bun scripts/debug/capture-test-failure-logs.ts --help
bun scripts/ci/load-image-artifact.ts --help
bun scripts/release/promote-image.ts --help
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

**Key details:** Modules: 1 (auto_explain). Preloaded: 6 (auto_explain, pg_cron, pg_stat_monitor, pg_stat_statements, pgaudit, timescaledb). Tools (no CREATE EXTENSION): 5. See docs/EXTENSIONS.md for full catalog.

**Optional preload modules** (enable via `POSTGRES_SHARED_PRELOAD_LIBRARIES`):

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
- Use TypeScript Bun or Node.js APIs instead of bash calls when possible and reasonable
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
  - TypeScript-first: All complex logic in testable scripts (`scripts/{ci,docker,debug,release}/`)
  - YAML = orchestration only (thin layer calling TypeScript scripts)
  - All scripts testable locally: `bun scripts/...`
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

## Version Tagging

**Format**: `MM.mm-TS-TYPE` where:

- `MM`: PostgreSQL major version (e.g., `18`)
- `mm`: PostgreSQL minor version, actual from base image (e.g., `1` from 18.1)
- `TS`: Timestamp `YYYYMMDDHHmm` (UTC, 12-digit)
- `TYPE`: Image variant (`single-node` for current builds)

**Examples**:

- Full: `18.1-202511202137-single-node`
- Convenience: `18-single-node`, `18` (latest for major version)

**Version Extraction**:

- Pull base image BEFORE building (`docker pull postgres:18-trixie@sha256:...`)
- Extract actual version: `docker run --rm <base-image> psql --version | awk '{print $3}'`
- Use extracted version in tags (NOT hardcoded guesses)
- Version info embedded in image: `/etc/postgresql/version-info.{txt,json}`

**Tag Requirements**:

- Production tags: Full version + convenience tags (`18.1-...`, `18-single-node`, `18`)
- Testing/dev tags: Prefixed (`testing-*`, `dev-*`) + pushed to `aza-pg-testing` repo only
- NO `latest` tag from dev builds (publish.yml only)

## Dockerfile Generation

**Never edit Dockerfile directly** - it's auto-generated from template + manifest.

**Architecture**:

1. **Manifest as source**: `scripts/extensions/manifest-data.ts` defines all extensions/tools
2. **TypeScript generation**: `scripts/docker/generate-dockerfile.ts` transforms manifest → Dockerfile
3. **Pre-filtering**: PGXS and Cargo manifests filtered in TypeScript, NOT runtime jq
4. **Template expansion**: `Dockerfile.template` uses placeholders filled by generator

**Pre-filtered Manifests**:

- `extensions.pgxs.manifest.json`: 28 entries (pgxs, autotools, cmake, meson, make, timescaledb builds)
- `extensions.cargo.manifest.json`: 4 entries (cargo-pgrx builds only)
- Generated at build-time by TypeScript, committed to repo
- Eliminates jq dependency in Docker builds

**Key Principles**:

- **Logic in TypeScript** (testable): Manifest filtering, version extraction, placeholder replacement
- **Dockerfile for orchestration** (simple): Multi-stage builds, COPY artifacts, minimal RUN commands
- **Single source of truth**: Manifest defines what, generator defines how
- **Always regenerate**: Run `bun run generate` after manifest changes

**Workflow**:

```bash
# Edit manifest
vim scripts/extensions/manifest-data.ts

# Regenerate all artifacts (Dockerfile, manifests, docs)
bun run generate

# Rebuild image
bun run build
```

## Common Mistakes

**Forgetting Bun imports**:

- ❌ Using `$` without importing: `await $`docker ps` fails with "Cannot find name '$'"
- ✅ Always add: `import { $ } from "bun";` at top of file
- Common in: Scripts using Bun.$ for shell commands

**Hardcoding changeable data**:

- ❌ "PostgreSQL 18 with 34 enabled extensions" (count changes with manifest)
- ✅ "PostgreSQL 18 with comprehensive extensions" (timeless)
- ❌ Hardcoded dates, versions, counts anywhere in documentation
- ✅ Reference generated data: `docs/.generated/docs-data.json`

**Complex inline bash in YAML**:

- ❌ 30+ lines of bash with jq/curl/loops in workflow files
- ✅ Extract to TypeScript script: `scripts/{ci,docker,debug}/script-name.ts`
- Benefits: Testable locally, typed, better error handling, `--help` docs

**Using Node.js APIs instead of Bun**:

- ❌ `import { readFile, writeFile } from "fs/promises";`
- ✅ `await Bun.file(path).text()` and `await Bun.write(path, content)`
- ❌ `execSync("command")` from child_process
- ✅ `await $`command`` from Bun.$
- Exception: `statSync` for directories (Bun.file.exists only works for files)

**Not regenerating after manifest changes**:

- ❌ Edit manifest → commit → build → "extension missing"
- ✅ Edit manifest → `bun run generate` → verify diffs → commit all → build
- Pre-commit hook auto-regenerates, but verify manually for safety

**Editing Dockerfile directly**:

- ❌ Modify `docker/postgres/Dockerfile` → changes lost on next generation
- ✅ Edit `Dockerfile.template` → `bun run generate` → Dockerfile regenerated
- Remember: Dockerfile is an artifact, not source

**Skipping validation after changes**:

- ❌ Make changes → commit → push → CI fails
- ✅ Make changes → `bun run validate:full` → fix issues → test → commit
- Use `bun run validate` for fast checks during development

## Git Workflow

- Write brief thoughtfull no BS Conventional Commits + "Co-Authored-By: Claude <noreply@anthropic.com>"
  - For Codex/OpenAI CLI change the name to "Codex <codex@openai.com>"
  - For Qwen: "Qwen <code@qwen.ai>"
  - For Gemini: "Gemini <gemini@google.com>"
  - For Copilot: "Copilot <copilot@github.com>"
- Don’t bypass pre‑commit hooks!
- **NEVER use --no-verify or bypass hooks/checks**: Fix the actual root issue instead
- **If SSH fail, ask user start SSH agent** — NEVER touch git config! NEVER skip commit signing!
- Commit granularly, after every finished/verified phase or work part
- Should NEVER lose anything, be super careful with git reset/revert/rebase!
- Verify what do you commit

## References

- ARCHITECTURE.md - System design, flows
- TESTING.md - Test patterns, session isolation
- PRODUCTION.md - Deployment, security
- docs/BUILD.md - Build instructions, CI/CD workflows
- docs/TOOLING.md - Tech choices, locked decisions

## Key Technical Learnings

**Docker Compose Environment Variables**:

- `env_file:` loads vars for container process, NOT child services
- Dependent services need explicit `environment:` declarations
- Use `environment:` for inter-service communication vars

**PostgreSQL Replication**:

- Slot verification requires pg_monitor role or superuser
- CPU/memory limits must match between primary and replica
- Use `pg_replication_slots` catalog to verify slot creation

**PgBouncer Authentication**:

- auth_query is SQL executed against target database
- Connection parameters (sslmode, host, port) go in DSN only
- auth_user must exist in BOTH userlist.txt AND .pgpass
- .pgpass escape rules: ONLY ":" and "\\" (NOT "@", "&", or other special chars)

**PostgreSQL 18 Changes**:

- Error message wording updated (test assertions must adapt)
- Extension availability via pg_available_extensions catalog
- No breaking changes in core functionality

**Docker Exit Codes**:

- 0: Success
- 1: Application error (inside container)
- 125: Docker daemon error (before container starts)
- 126: Command invoked cannot execute
- 127: Command not found

**Extension Architecture**:

- Modules (auto_explain): Preload-only, no CREATE EXTENSION
- Tools (5 total): No catalog entry, no CREATE EXTENSION
- Extensions: Standard CREATE EXTENSION flow (counts in manifest)
- License restrictions: pgvector basic ops free, HNSW requires pgvector_rs license

## Troubleshooting Patterns

**Replication Issues**:

1. Verify slot creation: `SELECT * FROM pg_replication_slots;`
2. Check permissions: User needs pg_monitor or superuser role
3. Validate environment vars: Use `docker compose config` to verify interpolation
4. Match resource limits: Primary and replica must have symmetric CPU/memory

**PgBouncer Connection Failures**:

1. Check auth_user setup: Must exist in userlist.txt with password
2. Verify .pgpass format: `hostname:port:database:username:password` (escape ":" and "\\")
3. Test auth_query manually: Connect as auth_user and run query
4. Validate database list: pgbouncer.ini [databases] section must match target DB

**Extension Test Failures**:

1. Query pg_available_extensions before CREATE EXTENSION
2. Check manifest enabled flag: `scripts/extensions/manifest-data.ts`
3. Verify preload modules: `SHOW shared_preload_libraries;`
4. License requirements: Some extensions (pgvector HNSW) need activation keys

**Container Startup Failures**:

1. Exit code 125: Docker daemon issue (check compose syntax, volume mounts)
2. Exit code 1: Application error (check PostgreSQL logs)
3. Health check timeouts: Verify port, credentials, and database name
4. Resource constraints: Ensure sufficient memory/CPU allocated

**pgflow Container Setup Failures**:

1. Exit code 2 (schema timeout): pgflow schema not initialized after timeout
   - Check container logs: `docker logs <container>`
   - Verify pgmq extension enabled in manifest
   - Increase --timeout if needed (default: 120s)
2. Schema verification: Must have 7 tables + 13+ functions in pgflow schema
3. Race condition: pg_isready returns success 300-500ms BEFORE schema ready
   - Solution: Use setup-pgflow-container.ts (multi-stage verification)
4. Diagnostic capture: Use --diagnostic-dir for setup failure diagnostics
