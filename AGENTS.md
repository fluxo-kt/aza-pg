# aza-pg: Production PostgreSQL with Auto-Config — AI Agent Guide (NO LOGS HERE! NO BS, ONLY FUTURE-PROOF VALUE!)

**PG 18 container**: Auto-tuned config, comprehensive extensions, SHA-pinned dependencies, Bun/TS-first tooling, Compose-only deployment, digest-based releases.

• **Bun-First**: All scripts use Bun TypeScript. Prefer Bun APIs to usuals from Node.js when possible and reasonable. See Development Standards below. **But NO Bun in the final images**. And DO NOT USE bunx, `bun x`, npm, or npmx — NEVER!!
• **TS-First**: YAML workflows are orchestration only — all logic, verification, and diagnostics belong in TypeScript scripts that can be tested locally. Dockerfiles are auto-generation-only from manifest, should be as simple as possible — all logic and nuances belong in TypeScript scripts.

## CRITICAL RULES

- **ALWAYS COMPREHENSIVELY HOLYSTICALLY VERIFY/TEST/CHECK ALL PARTS OF YOUR WORK/CHANGES LOCALLY BEFORE COMMITTING**
- **DOUBLE CHECK & CONFIRM ALL TESTS AND VERIFICATIONS ARE COMPLETE AND SUCCESSFUL BEFORE PUSHING**

## Invariants

- **Manifest = single source of truth**: `manifest-data.ts` defines ALL versions (PG, base image SHA, pgdgVersions, git tags)
- **extension-defaults.ts = auto-generated**: NEVER edit directly — regenerated from manifest
- **Tools ≠ extensions** (no CREATE EXTENSION)
- **No Bun in final image** (build-only dependency)
- **Dockerfile is auto-generated** from template + manifest (NEVER edit directly)
- **Repository separation**: Production (`aza-pg`) vs Testing/Dev (`aza-pg-testing`) — ⚠️ NEVER use testing images in production

## AI Agent Knowledge Updates (Post-Training Facts)

**Critical context for AI agents with training cutoffs before 2025:**

### Debian/PostgreSQL Timeline

| Fact                                 | Detail                              |
| ------------------------------------ | ----------------------------------- |
| Debian 13 "Trixie" = STABLE LTS      | Released Aug 9, 2025 (NOT testing!) |
| PostgreSQL 18 is RELEASED            | GA Sep 25, 2025; 18.1 Nov 13, 2025  |
| Bookworm (Debian 12) still supported | LTS until Jun 2028                  |
| i386 architecture DROPPED            | First time in Debian history        |

### Extension Compatibility (PG18)

| Extension        | Status                           |
| ---------------- | -------------------------------- |
| `pg_plan_filter` | INCOMPATIBLE - last updated PG13 |
| `citus`          | FAILS TO BUILD                   |
| `periods`        | OBSOLETE - now in PG18 core      |
| `pgvector`       | Still 0.8.x (0.9 NOT released)   |
| `pgrx`           | Requires Rust 1.88.0+ (v0.16.1)  |

### Version String Formats

| Format Type          | Example                | Notes                    |
| -------------------- | ---------------------- | ------------------------ |
| **Percona epochs**   | `1:2.3.1-2.trixie`     | The `1:` prefix matters! |
| **Timescale tildes** | `2.24.0~debian13-1801` | Uses a `~` separator     |
| **PGDG suffix**      | `0.8.1-2.pgdg13+1`     | Uses a `+` for revisions |

## Paths & Fast Commands

```bash
docker/postgres/       # Dockerfile, entrypoints, initdb
scripts/               # Bun TS scripts (no absolute paths)
stacks/{primary,replica,single}  # Compose deployments

# Essential Commands (organized by category)

# Validation & Fixing
bun run validate            # Fast: static checks + unit tests (~3s)
bun run validate:all        # Full: + shellcheck, hadolint, yamllint (~30s)
bun run validate:fix        # Auto-fix: prettier, oxlint, SQL formatting

# Aliases (conventional names)
bun run format              # Alias for validate:fix
bun run lint                # Alias for validate

# Testing
bun run test                # Optimized: uses existing build (~30min)
bun run test:all            # Complete: rebuilds image + all tests (~45min)
bun run test:unit           # Unit tests only (no Docker)

# Build/Generation
bun run build               # Build Docker image
bun run generate            # Regenerate all files from manifest
```

## Gotchas

- **auto_explain**: Module (shared_preload_libraries), NOT extension — NO CREATE EXTENSION needed
- **Dockerfile**: NEVER edit directly — edit Dockerfile.template → `bun run generate`
- **extension-defaults.ts**: NEVER edit directly — auto-generated from `manifest-data.ts`
- **Shell safety**: ALL RUN commands MUST use `set -euo pipefail` (not just `set -eu`)
- **Version changes**: Update `manifest-data.ts` (MANIFEST_METADATA + pgdgVersion) → regenerate → rebuild
- **PGDG versions**: Both `source.tag` AND `pgdgVersion` must match semantically — validated against actual PGDG repository via `scripts/extensions/validate-pgdg-versions.ts` (runs in `bun run validate`, prevents silent apt-get failures)
- **PgBouncer .pgpass**: Escape ONLY ":" and "\\" (NOT "@" or "&")
- **Tools vs extensions**: No CREATE EXTENSION on tools (pgbackrest, pgbadger, wal2json, pg_safeupdate)
- **Auto-config override**: `-c` flags override postgresql.conf at runtime

## Extension System

Enable/disable: Edit `scripts/extensions/manifest-data.ts` → `bun run generate` → rebuild

**Install methods** (`install_via`): `pgdg` (apt) | `percona` (apt) | `github-release` (pre-built binaries) | `source` (build from git)

**Counts**: See `docs/.generated/docs-data.json` for live module/preload/tool counts

**Default preload**: auto_explain, pg_cron, pg_net, pg_stat_monitor, pg_stat_statements, pgaudit, pgsodium, safeupdate, timescaledb

**Optional preload** (enable via `POSTGRES_SHARED_PRELOAD_LIBRARIES`): supautils, set_user, pg_partman_bgw, pg_plan_filter

## Auto-Config

**Detection**: POSTGRES_MEMORY → cgroup v2 → /proc/meminfo | CPU via `nproc`

**Workload** (`POSTGRES_WORKLOAD_TYPE`): `mixed` (default, 120 conn) | `web` (200) | `oltp` (300) | `dw` (100)

**Storage** (`POSTGRES_STORAGE_TYPE`): `ssd` (default) | `hdd` | `san`

**Caps**: shared_buffers ≤32GB, work_mem ≤32MB, connections RAM-scaled by tier

## Development Standards

**Bun APIs (ALWAYS prefer)**:

- `Bun.file()`, `Bun.write()` over fs/promises
- `Bun.$` or `Bun.spawn()` over child_process
- `Bun.env` over process.env
- Exception: `path` module (no Bun alternative), `stat()` from node:fs for directory checks (Bun.file.exists only works for files)

**`Bun.spawn()` pipe deadlock rule** — OS pipe buffer is ~64KB; exceeding it blocks the child writing, deadlocking `proc.exited`. **Three mandatory patterns**:

- **Exit-code only**: `stdout: "ignore", stderr: "ignore"` — no pipe, no risk
- **One stream needed**: unused stream → `"ignore"`, use `Promise.all([new Response(proc.stdout).text(), proc.exited])`
- **Both streams needed**: `Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])`
- **NEVER**: `await proc.exited` THEN read streams — guaranteed deadlock for large output (docker info, docker logs, git ls-remote, etc.)
- **DRY**: use `isDockerDaemonRunning()` from `utils/docker.ts` — NEVER reimplement local `isDockerAvailable()` variants

**Linting**: oxlint (fast) + prettier + shellcheck + hadolint + yamllint | TS strict mode

**Hooks**: bun-git-hooks — pre-commit auto-fixes + regenerates if manifest changed

**CI**: `ci.yml` (PRs) | `build-postgres-image.yml` (manual) | `publish.yml` (releases, Cosign signing)

**Tags**: `vMM.mm-TS` (e.g., `v18.1-202602082259`) — NO `latest` from dev builds

## Common Mistakes

- ❌ Editing `Dockerfile` directly → ✅ Edit `Dockerfile.template` + regenerate
- ❌ Editing `extension-defaults.ts` directly → ✅ Edit `manifest-data.ts` + regenerate
- ❌ Using Node.js fs/child_process → ✅ Use Bun.file/Bun.$
- ❌ Hardcoded counts in docs → ✅ Reference `docs/.generated/docs-data.json`
- ❌ Complex bash in YAML → ✅ Extract to TypeScript script
- ❌ Skip validation → ✅ `bun run validate` before commit

## Git Workflow

- Write brief thoughtfull no BS Conventional Commits + "Co-Authored-By: Claude <noreply@anthropic.com>"
  - For Codex/OpenAI CLI change the name to "Codex <codex@openai.com>"
  - For Qwen: "Qwen <code@qwen.ai>"
  - For Gemini: "Gemini <gemini@google.com>"
  - For Copilot: "Copilot <copilot@github.com>"
- Don't bypass pre‑commit hooks!
- **NEVER use --no-verify or bypass hooks/checks**: Fix the actual root issue instead
- **If SSH fail, ask user start SSH agent** — NEVER touch git config! NEVER skip commit signing!
- Commit granularly, after every finished/verified phase or work part
- Should NEVER lose anything, be super careful with git reset/revert/rebase!
- Verify what do you commit

## Troubleshooting

| Issue                  | Fix                                                   |
| ---------------------- | ----------------------------------------------------- |
| Extension missing      | Check manifest enabled + `bun run generate` + rebuild |
| Dockerfile out of date | `bun run generate`                                    |
| Preload error          | Align shared_preload_libraries with manifest defaults |
| RAM misdetection       | Set POSTGRES_MEMORY explicitly                        |
| Container exit 125     | Docker daemon issue (compose syntax, volumes)         |
| Container exit 1       | Application error (check PG logs)                     |

## Key Learnings

**Compose**: `env_file:` loads for container only — use `environment:` for inter-service vars

**Replication**: pg_monitor role required for slot verification; symmetric CPU/memory limits

**PgBouncer**: auth_user must exist in BOTH userlist.txt AND .pgpass; connection params in DSN only

**Extensions**: Modules=preload-only (auto_explain) | Tools=no CREATE EXTENSION | Standard extensions=CREATE EXTENSION flow

**CI Workflow Resilience**: Informational steps (SARIF upload, diagnostics) MUST have `continue-on-error: true` — tool infrastructure failures must never block releases. The actual security gate is a separate independent blocking step with `exit-code: 1`. Same pattern for any step that is "nice-to-have" vs "must-pass".

**Security Scanner Resilience**: Use `docker run aquasec/trivy:VERSION image TARGET` (Docker container approach) for local scans — no GitHub release binary download, immune to supply-chain deletion attacks (Trivy incident 2026-03-01: attacker deleted v0.27-v0.69.1 binaries). Pin to v0.69.3+ (immutable releases). Locally: `bun run security:scan`.

**SHA Pin Accuracy**: GitHub Actions SHA comments (`# v1.2.3`) rot silently — the resolved tag in CI logs may differ from the comment. Run `actions-up` (see `/update` skill) to keep all SHA pins current. Verify manually: `git ls-remote https://github.com/REPO.git refs/tags/TAG`.

**Annotated Tags Have TWO SHAs**: `git ls-remote ... refs/tags/vX.Y` returns the tag OBJECT SHA (not usable for `rev-parse HEAD`). Use `refs/tags/vX.Y^{}` (caret-brace) to get the peeled COMMIT SHA — this is what `HEAD` resolves to after `git clone --branch vX.Y`. Always verify with both: `git ls-remote URL 'refs/tags/TAG' 'refs/tags/TAG^{}'`.

## Changelog

**File**: `CHANGELOG.md` — Keep a Changelog format, integrated with GitHub releases

**Workflow**:

1. Track image-affecting changes in `[Unreleased]` section
2. Focus on: extension updates, base image changes, breaking changes
3. After successful GitHub CI release: rename `[Unreleased]` → `[release-tag]` (e.g., `[v18.1-202602082259]`)
4. Start new `[Unreleased]` section for next changes
5. Non-image changes (tests, tooling, CI): mention briefly in "Development" subsection

**Categories**: Changed (updates) | Added (new features) | Fixed (bug fixes) | Removed | Security | Breaking

## References

- CHANGELOG.md — Release history (image-affecting changes)
- ARCHITECTURE.md — System design
- docs/TESTING.md — Test patterns
- docs/BUILD.md — CI/CD workflows
- docs/TOOLING.md — Tech decisions
- docs/VERSION-MANAGEMENT.md — Version procedures
- docs/.generated/docs-data.json — Live counts (auto-generated)

---

## Maintaining This File

**Principles** (this doc appears in EVERY AI conversation):

- **Token efficiency**: Use abbrs (TS, PG, GH, env), strip filler, dense formatting
- **Self-sufficient**: Out-of-context agents must understand without external docs
- **Imperative voice**: Commands, not descriptions ("Edit X" not "You should edit X")
- **No bloat**: Every line must earn its tokens — if removing doesn't lose value, remove it
- **Update, don't expand**: Replace outdated info; don't add sections for temporary issues
