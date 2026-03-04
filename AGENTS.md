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
bun run test:unit           # Alias for validate (fast checks + unit tests, no Docker)

# Build/Generation
bun run build               # Build Docker image
bun run generate            # Regenerate all files from manifest
```

## Gotchas

- **auto_explain**: Module (shared_preload_libraries), NOT extension — NO CREATE EXTENSION needed
- **Dockerfile**: NEVER edit directly — edit Dockerfile.template → `bun run generate`
- **extension-defaults.ts**: NEVER edit directly — auto-generated from `manifest-data.ts`
- **Shell safety**: ALL RUN commands MUST use `set -euo pipefail` (not just `set -eu`)
- **Version changes**: Update `manifest-data.ts` (MANIFEST_METADATA + pgdgVersion) → regenerate → rebuild → **also update `tests/regression/extensions/EXTNAME/expected/basic.out`** for any extension whose version string is hard-coded in that file (e.g., `extname | 1.2.3` lines); stale expected outputs cause nightly regression failures
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
- ❌ Naming Docker-dependent tests `*.test.ts` → auto-discovered by unit test glob, runs without Docker, fails → ✅ Docker-dependent tests MUST use `test-*.ts` naming (NOT `*.test.ts`); register in `test-all.ts` for CI inclusion (standalone on-demand tests are fine — just document intent at top of file). All `*.test.ts` files are unconditionally unit-test safe.

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

**SHA Pin Accuracy**: SHA pins go stale silently — run `actions-up` (see `/update` skill) to refresh both the SHA and the `# vX.Y.Z` tag on each `uses:` line. Also audit for version references in prose comments elsewhere in workflow files (`command grep -rn "@v[0-9]" .github/workflows/ .github/actions/ | command grep "#"`). Verify manually: `git ls-remote https://github.com/REPO.git refs/tags/TAG`.

**Annotated Tags Have TWO SHAs**: `git ls-remote ... refs/tags/vX.Y` returns the tag OBJECT SHA (not usable for `rev-parse HEAD`). Use `refs/tags/vX.Y^{}` (caret-brace) to get the peeled COMMIT SHA — this is what `HEAD` resolves to after `git clone --branch vX.Y`. Always verify with both: `git ls-remote URL 'refs/tags/TAG' 'refs/tags/TAG^{}'`.

**test-image-lib.ts `toolBinaries`**: Keys MUST match manifest entry `name` (kind: "tool") exactly — wrong keys silently skip checks (classic false-confidence bug). `.so` paths hardcode PG major version (`/usr/lib/postgresql/18/lib/`); update ALL when bumping PG major. Disabled tools filtered by `entry.enabled !== false` before the loop; unknown enabled tools fail loudly.

**Test Architecture**: `test-all.ts` calls `scripts/docker/test-image.ts` (thin wrapper, ~350 lines). All 39 test functions live exclusively in `test-image-lib.ts` — `test-image.ts` imports and calls them, so divergence is structurally impossible. Standalone scripts (`test-image-core.ts`, `test-image-functional-1/2/3.ts`) also use `test-image-lib.ts` and are NOT in CI — they run on-demand only.

**Test Shared-Container Contamination**: All tests in `test-image.ts` share one container. Event trigger changes (`ALTER EVENT TRIGGER ... DISABLE`) MUST be wrapped in try/finally with `ENABLE` in the finally block — missed re-enable poisons all subsequent tests in the suite.

**INSERT Idempotency**: Tests using `CREATE TABLE IF NOT EXISTS` + unconditional `INSERT` produce wrong counts on `--no-cleanup` container reuse. ALWAYS add `TRUNCATE tablename RESTART IDENTITY` before INSERTs when the test asserts exact row counts or id values.

**Custom AM Index Contamination**: For custom index AMs (PGroonga), `TRUNCATE` alone does NOT reliably clear the AM's external storage (Groonga files). The non-negotiable requirements are: (1) `DROP INDEX IF EXISTS` must occur to purge external storage, (2) `CREATE INDEX` must be unconditional (no `IF NOT EXISTS`), (3) `CREATE INDEX` must happen AFTER all INSERTs. The ORDER of DROP INDEX relative to TRUNCATE is flexible — both `DROP → TRUNCATE → INSERT → CREATE` and `TRUNCATE → DROP → INSERT → CREATE` are correct; what breaks things is `CREATE INDEX IF NOT EXISTS` after TRUNCATE (skips rebuild, stale external data accumulates). RUM uses standard PostgreSQL AM pages (no external storage); the same pattern is applied for consistency.

**psql Session Isolation**: Each `execSQL` spawns a new `docker exec ... psql -c` process — `SET` statements do NOT persist between calls. `SET enable_seqscan = OFF; SELECT ...` MUST be a single string in one `execSQL` call.

**precreatedExtensions list**: The 13 extensions created at initdb (`01-extensions.sql` + `01b-pg_cron.sh`) CANNOT be derived from the manifest — `runtime.defaultEnable` covers preload libs only (4 entries). Update the hardcoded list in `test-image-lib.ts` whenever `01-extensions.sql` changes (single source of truth — `test-image.ts` imports from lib).

**Multi-Stage Gosu Replacement: GHA Cache Ambiguity + Trivy Layer Scanning**: All multi-stage approaches (`COPY --from=`, bind-mounts, `apt-get install su-exec` — absent from postgres image repos, `COPY via builder-pgxs output dir` — COPY cache key matched stale GHA entry) fail due to GHA layer cache interference. `apt-get purge gosu` is a no-op because postgres:18.3-trixie installs gosu via direct binary download (not dpkg). **Root cause of Trivy persistence**: Trivy scans ALL image layers including immutable base image layers — gosu in the postgres base layer is reported even when `/usr/local/bin/gosu` is su-exec in the merged filesystem. **Definitive fix**: compile su-exec in the final stage, install at `/usr/local/bin/gosu` (shadows the base binary), add `CVE-2025-68121` to `.trivyignore` (gosu is unreachable at runtime), exclude gosu from builder-pgxs rsync (`--exclude='gosu'`). Add `[ SZ -lt 500000 ]` to FAIL build if wrong binary.

## Changelog

**File**: `CHANGELOG.md` — Keep a Changelog format, user-facing, integrated with GitHub releases

**Audience**: Image consumers (ops, developers deploying aza-pg). NOT developers of aza-pg tooling.

**Workflow**:

1. Track image-affecting changes in `[Unreleased]` section
2. Focus on: extension updates, base image changes, breaking changes, security fixes
3. After successful GitHub CI release: rename `[Unreleased]` → `[release-tag]` (e.g., `[v18.1-202602082259]`)
4. Start new `[Unreleased]` section for next changes
5. Non-image changes: 1-2 brief bullets max in `### Development` — omit if trivial

**What NEVER belongs in the changelog**:

- Agent commands (`.claude/commands/`), skills, tooling scripts — these are invisible to image consumers
- Individual kaizen/audit pass details, test assertion improvements, internal refactors
- Anything a user of the Docker image cannot observe or act on

**Development section rules** (when it's worth including at all):

- Max 1-2 bullets total, no technical detail, user-impact framing only
- OK: "Test coverage hardened; CI updated to Node.js 24 runners"
- NOT OK: "testPgStatStatements now executes a tracked query after reset and asserts count >= 1 because..."

**Categories**: Breaking | Security | Fixed | Changed | Added | Deprecated | Removed | Development

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
