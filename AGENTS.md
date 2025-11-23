# aza-pg: Production PostgreSQL with Auto-Config — AI Agent Guide (NO LOGS HERE! NO BS, ONLY FUTURE-PROOF VALUE!)

**PG 18 container**: Auto-tuned config, 40+ extensions, SHA-pinned dependencies, Bun/TS-first tooling, Compose-only deployment, digest-based releases.

• **Bun-First**: All scripts use Bun TypeScript. Prefer Bun APIs to usuals from Node.js when possible and reasonable. See Development Standards below. **But NO Bun in the final images**
• **TS-First**: YAML workflows are orchestration only — all logic, verification, and diagnostics belong in TypeScript scripts that can be tested locally. Dockerfiles are auto-generation-only from manifest, should be as simple as possible — all logic and nuances belong in TypeScript scripts.

## CRITICAL RULES

- **ALWAYS VERIFY/TEST ALL CHANGES LOCALLY BEFORE COMMITTING**
- **DOUBLE CHECK ALL TESTS/VALIDATIONS COMPLETE & SUCCESSFUL BEFORE PUSHING**

## Core Principles

- **Manifest = truth**: `scripts/extensions/manifest-data.ts` defines all extensions/tools
- **TS-first**: All logic in testable Bun scripts, YAML = thin orchestration only
- **Dockerfile auto-gen**: NEVER edit directly - modify `Dockerfile.template` + `bun run generate`
- **Tools ≠ extensions**: 5 tools lack CREATE EXTENSION (pgbackrest, pgbadger, wal2json, pg_plan_filter, pg_safeupdate)
- **No Bun in final image** (build-only dependency)
- **Repos**: Production `ghcr.io/fluxo-kt/aza-pg` | Testing `ghcr.io/fluxo-kt/aza-pg-testing`
- ⚠️ **NEVER use aza-pg-testing images in production** (ephemeral, unvalidated)

## Paths

- `docker/postgres/` - Dockerfile, entrypoints, initdb scripts
- `scripts/` - Bun TS scripts (no absolute paths)
- `stacks/{primary,replica,single}` - Compose deployments
- `docs/.generated/docs-data.json` - Auto-generated reference

## Fast Paths

```bash
bun run build                  # Build image
bun run validate:full          # Full validation
bun run generate               # Regenerate Dockerfile + manifests + docs
cd stacks/primary && docker compose up

# Test any script locally:
bun scripts/{ci,docker,debug,release}/<script>.ts --help
```

## Critical Scripts

- `scripts/release/promote-image.ts` - Digest-based promotion w/ OCI metadata + metrics extraction → job outputs
- `scripts/docker/setup-pgflow-container.ts` - 5-stage setup, fixes pg_isready race (300-500ms lag before schema ready)
- `scripts/debug/capture-test-failure-logs.ts` - Unified diagnostics w/ --containers or --all-containers
- `scripts/ci/load-image-artifact.ts` - Load tarball w/ 3 fallback retagging methods

## Gotchas

- **auto_explain**: Module (shared_preload_libraries), NOT extension
- **Shell safety**: Use `set -euo pipefail` (not `-eu`) in all RUN commands
- **Versions**: Edit `extension-defaults.ts` → regenerate → rebuild (NO workflow input overrides)
- **Dockerfile ARGs**: Only BUILD_DATE + VCS_REF (passed at build time), all versions hardcoded
- **PgBouncer .pgpass**: Escape ONLY ":" and "\\" (NOT "@" or "&")
- **Health check**: Port 6432/postgres (not admin console)
- **Cgroup missing**: Set POSTGRES_MEMORY or mem_limit explicitly
- **PGDG-disabled**: Compiled extensions only (PGDG are install-or-skip)
- **Auto-config**: `-c` flags override postgresql.conf at runtime

## Extension System

Edit `scripts/extensions/manifest-data.ts` → `bun run generate` → rebuild

**Counts**: Modules: 1 (auto_explain) | Preloaded: 6 | Tools (no CREATE EXTENSION): 5 | See @docs/EXTENSIONS.md for full catalog

**Optional preload modules** (via `POSTGRES_SHARED_PRELOAD_LIBRARIES`):

- `safeupdate` (pg_safeupdate): Prevents UPDATE/DELETE without WHERE clause
- `pgsodium`: Encryption library (⚠️ REQUIRED for event triggers; full TCE needs pgsodium_getkey script)
- `set_user`: Audited SET ROLE for privilege escalation tracking
- `pg_partman`: Automated partition management background worker
- `pg_plan_filter`: Query plan safety filter

```bash
docker run -e POSTGRES_SHARED_PRELOAD_LIBRARIES="auto_explain,pg_cron,pg_stat_statements,pgaudit,timescaledb,safeupdate,pgsodium" ...
```

## Auto-Config

**Resource detection**: POSTGRES_MEMORY → cgroup v2 → /proc/meminfo (warn) | CPU: `nproc` (cgroup-aware)

**Workload** (`POSTGRES_WORKLOAD_TYPE`):

- `web` (default): max_conn=200, balanced OLTP+reads
- `oltp`: max_conn=300, high-concurrency txns
- `dw`: max_conn=100, analytics (statistics_target=500)
- `mixed`: max_conn=120, general-purpose

**Storage** (`POSTGRES_STORAGE_TYPE`):

- `ssd` (default): random_page_cost=1.1, eff_io_conc=200
- `hdd`: random_page_cost=4.0, eff_io_conc=2
- `san`: random_page_cost=1.1, eff_io_conc=1

**Caps**: shared_buffers ≤32GB (25% RAM) | work_mem ≤32MB | Connections: RAM-scaled across 4 tiers

## Development

**Bun-native APIs** (prefer over Node.js):

- `Bun.file()`, `Bun.write()` vs `fs/promises`
- `Bun.$` vs `child_process.exec`
- `Bun.env` vs `process.env`
- Exception: `path` module (no Bun equiv yet), `statSync` for dirs

**Linting**: oxlint (50-100x faster) + prettier + shellcheck + hadolint + yamllint

**Git hooks** (`bun-git-hooks`): pre-commit auto-fixes lint/format + regenerates manifests if changed

**CI/CD**:

- `ci.yml`: PRs only (lint, manifest sync, ~5min)
- `build-postgres-image.yml`: Manual dev builds (dev-\* tags, no push default)
- `publish.yml`: Release branch only (versioned tags, Cosign sign, SLSA provenance)

**Tags**: `MM.mm-YYYYMMDDHHmm-TYPE` (e.g., `18.1-202511142330-single-node`) + convenience (`18-single-node`, `18`)

## Dockerfile Generation

**NEVER edit Dockerfile directly** - auto-generated from template + manifest

**Architecture**: `manifest-data.ts` → TypeScript generator → pre-filtered manifests (pgxs/cargo JSONs) → template expansion → Dockerfile

**Workflow**: Edit `manifest-data.ts` → `bun run generate` → verify diffs → rebuild

**ARG Strategy**: Only 2 ARGs (BUILD_DATE, VCS_REF) without defaults, passed at build time. ALL versions hardcoded at generation time from `extension-defaults.ts`: PG_VERSION, PG_MAJOR, PG_BASE_IMAGE_SHA, PGDG package versions. NO version override via --build-arg or workflow inputs.

## Image Versioning & Release

**Version extraction**: Pull base image → `docker run psql --version` → extract actual version (not hardcoded guesses) → use in tags

**Build Provenance** (`actions/attest-build-provenance@v3.0.0`): Production images only, after promotion+signing, SLSA provenance binds digest to build params/runner/workflow. Verify: `gh attestation verify oci://ghcr.io/fluxo-kt/aza-pg@sha256:... --owner fluxo-kt` or `cosign verify-attestation`

**Promotion flow**: Build → Testing repo → Test → Scan → Promote (digest copy) → Production repo. Testing tags deleted after promotion or failure.

## Common Mistakes

- ❌ Using `$` without `import { $ } from "bun";`
- ❌ Hardcoding counts/versions in docs → ✅ Reference `docs/.generated/docs-data.json`
- ❌ 30+ line bash in YAML → ✅ Extract to `scripts/{category}/<name>.ts`
- ❌ `fs/promises` → ✅ `Bun.file().text()`
- ❌ Edit manifest → commit → build → ✅ Edit manifest → `bun run generate` → verify → commit all
- ❌ Edit Dockerfile → ✅ Edit `Dockerfile.template` + regenerate
- ❌ Skip validation → commit → CI fail → ✅ `bun run validate:full` before commit

## Troubleshooting

**Replication**: Slot verification needs pg_monitor role | CPU/mem limits must match primary/replica | `SELECT * FROM pg_replication_slots;`

**PgBouncer**: auth_user must exist in userlist.txt AND .pgpass | .pgpass format: `host:port:db:user:pass` | auth_query runs as auth_user

**Extensions**: Query `pg_available_extensions` before CREATE EXTENSION | Check manifest enabled flag | Verify shared_preload_libraries | Some need licenses (pgvector HNSW)

**Container startup**: Exit 125=daemon issue | 1=app error | Check logs, health check config, resource limits

**pgflow setup**: Exit 2=schema timeout | pg_isready succeeds 300-500ms BEFORE schema ready | Use `setup-pgflow-container.ts` for multi-stage verification | Must have 7 tables + 13+ functions in pgflow schema

## Learnings

- Docker Compose `env_file:` loads for container only, NOT child services (use explicit `environment:`)
- PG replication slots require pg_monitor or superuser
- PG 18: Error message wording changed (update test assertions)
- Docker exits: 0=success | 1=app error | 125=daemon error | 126=can't exec | 127=not found
- Extension types: Modules (preload-only) | Tools (no catalog) | Extensions (standard CREATE EXTENSION)

## References

- @ARCHITECTURE.md - System design
- @TESTING.md - Test patterns
- @PRODUCTION.md - Deployment
- @RELEASE-VALIDATION.md - Latest validation results
- @docs/BUILD.md - Build/CI details
- @docs/TOOLING.md - Tech choices
- @docs/VERSION-MANAGEMENT.md - Version declarations
- @docs/UPGRADING.md - Runtime upgrades
- @docs/EXTENSIONS.md - Full extension catalog

## Git

Conventional Commits + `Co-Authored-By: Claude <noreply@anthropic.com>` (or Codex/Qwen/Gemini/Copilot) | NEVER `--no-verify` | Commit granularly after each verified phase
