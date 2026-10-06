# aza-pg: Production PostgreSQL with Auto-Config — AI Agent Guide (NO LOGS HERE! NO BS, ONLY FUTURE-PROOF VALUE!)

**PG 18 container**: Auto-tuned config, comprehensive extensions, SHA-pinned dependencies, Bun/TS-first tooling, Compose-only deployment, digest-based releases.

• **Bun-First**: All scripts use Bun TypeScript. Prefer Bun APIs to usuals from Node.js when possible and reasonable. See Development Standards below. **But NO Bun in the final images**. And DO NOT USE bunx, `bun x`, npm, npx, pnpm, pnpx, yarn or corepack — NEVER!! (`.claude/settings.json` denies each; run a `package.json` script or `./node_modules/.bin/<tool>` instead)
• **TS-First**: YAML workflows are orchestration only — all logic, verification, and diagnostics belong in TypeScript scripts that can be tested locally. Dockerfiles are auto-generation-only from manifest, should be as simple as possible — all logic and nuances belong in TypeScript scripts.

## CRITICAL RULES

- **ALWAYS COMPREHENSIVELY HOLYSTICALLY VERIFY/TEST/CHECK ALL PARTS OF YOUR WORK/CHANGES LOCALLY BEFORE COMMITTING**
- **DOUBLE CHECK & CONFIRM ALL TESTS AND VERIFICATIONS ARE COMPLETE AND SUCCESSFUL BEFORE PUSHING**

## Invariants

- **Manifest = single source of truth**: `manifest-data.ts` defines ALL versions (PG, base image SHA, apt pins, git tags)
- **Per-extension facts live on its manifest entry** (`pgdgPackage`, `perconaPackage`, `soFileName`, …) — NEVER add a side table keyed by extension name; generators/validators read the entry, so changing `install_via` stays a one-entry edit
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

| Extension        | Status                                                 |
| ---------------- | ------------------------------------------------------ |
| `pg_plan_filter` | v1.0.0 supports PG18; preload library is `plan_filter` |
| `citus`          | FAILS TO BUILD                                         |
| `periods`        | OBSOLETE - now in PG18 core                            |
| `pgvector`       | Still 0.8.x (0.9 NOT released)                         |
| `pgrx`           | Requires Rust 1.88.0+ (v0.16.1)                        |

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
bun run validate            # Fast: static checks + unit tests
bun run validate:all        # Full: + shellcheck, hadolint, yamllint
bun run validate:fix        # Auto-fix: prettier, oxlint, SQL formatting

# Aliases (conventional names)
bun run format              # Alias for validate:fix
bun run lint                # Alias for validate

# Testing
bun run test                # Optimized: uses existing build
bun run test:all            # Complete: rebuilds image + all tests
bun run test:unit           # Alias for validate (fast checks + unit tests, no Docker)

# Build/Generation
bun run build               # Build Docker image
bun run generate            # Regenerate all files from manifest
bun run cleanup             # Reclaim aza-pg Docker artifacts (cleanup:dry to preview)
```

## Gotchas

- **auto_explain**: Module (shared_preload_libraries), NOT extension — NO CREATE EXTENSION needed
- **Dockerfile**: NEVER edit directly — edit Dockerfile.template → `bun run generate`
- **Shell safety**: ALL RUN commands MUST use `set -euo pipefail` (not just `set -eu`)
- **Version changes**: Update `manifest-data.ts` (MANIFEST_METADATA + pgdgVersion) → regenerate → rebuild. Regression expected files (`tests/regression/extensions/*/expected/basic.out`) hold no version strings — `scripts/test/test-extension-versions.ts` checks versions — so never add one
- **PGDG versions**: `pgdgVersion` must be the version the PGDG repo serves — `scripts/extensions/validate-pgdg-versions.ts` (in `bun run validate`) checks it, preventing silent apt-get failures. Keep `source.tag` at the same upstream version by hand: check-updates compares it with upstream tags, and nothing checks the pair
- **PgBouncer .pgpass**: Escape ONLY ":" and "\\" (NOT "@" or "&")
- **Tools vs extensions**: No CREATE EXTENSION on tools (pgbackrest, pgbadger, wal2json, pg_safeupdate)
- **Container teardown**: remove containers with `docker rm -f -v` — the `-v` drops PG18's anonymous `/var/lib/postgresql` PGDATA volume (named volumes always survive); omitting it orphans one per teardown → silent multi-GB bloat. An ad-hoc probe (`docker run <image> psql --version`, a smoke start) takes `--rm`, or its stopped container keeps that volume. Enforced by `Subprocess Calls` in `validate`; reclaim accumulated artifacts with `bun run cleanup` (marker-scoped via `app.aza_pg_custom` + OCI title, safe on shared hosts)
- **Auto-config override**: operator `-c` and `ALTER SYSTEM` win over auto-tuning; values in postgresql.conf files lose to it (initdb writes tuned settings into every data directory's postgresql.conf, so honouring files would switch tuning off). The startup log names each overridden or ignored value
- **`deployments/` hand-copies the stacks and no suite boots it**: a fix to `stacks/*/compose.yml`, the entrypoint's env contract or a documented command applies there too — `rg` the setting across `stacks/ deployments/ docs/` in the same change. `Image Runtime Contract` in `validate` checks the copies; proof rules in `deployments/AGENTS.md`
- **`/dev/shm` differs by host**: dockerd's default is 64 MB (CI runners, Linux VPSes), but a Docker Desktop daemon may hand out GBs, so a local pass proves nothing for anything using PostgreSQL dynamic shared memory (parallel index builds, parallel hash joins). Reproduce with `--shm-size=64m`. Auto-config sets `dynamic_shared_memory_type=sysv` so this memory never touches `/dev/shm` (reason at that setting); with `posix` a parallel hash join or HNSW build fails at 64 MB

## Extension System

Enable/disable: Edit `scripts/extensions/manifest-data.ts` → `bun run generate` → rebuild

**Install methods** (`install_via`): `pgdg` (apt) | `percona` (apt) | `timescale` (apt) | `source` (build from git; `build.patches` applies diffs from `docker/postgres/patches/`)

**Counts**: See `docs/.generated/docs-data.json` for live module/preload/tool counts

**Default preload**: auto_explain, pg_cron, pg_net, pg_stat_monitor, pg_stat_statements, pgaudit, pgsodium, safeupdate, supabase_vault, timescaledb

**Optional preload** (enable via `POSTGRES_SHARED_PRELOAD_LIBRARIES`): supautils, set_user, pg_partman_bgw, plan_filter

## Auto-Config

**Detection**: POSTGRES_MEMORY → cgroup v2 → /proc/meminfo | CPU via `nproc`

**Workload** (`POSTGRES_WORKLOAD_TYPE`): `mixed` (default, 120 conn) | `web` (200) | `oltp` (300) | `dw` (100)

**Storage** (`POSTGRES_STORAGE_TYPE`): `ssd` (default) | `hdd` | `san`

**Caps**: shared_buffers ≤32GB; work_mem ≤32MB for web/oltp, mixed/dw up to 64/128/256MB from 2/8/32GB RAM; connections RAM-scaled by tier. Formulas: `calculate_*` in the entrypoint (rules in README "Auto-Config")

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
- **Bun `$` throws on non-zero exit**: an `if (result.exitCode !== 0)` branch needs `.nothrow()` before `.quiet()`/`.text()`, or it is dead code and the command's output is lost
- **Bun `$` starts only when awaited or `.then`-ed**: `` void $`docker rm …` `` in a timer or cleanup never runs; fire-and-forget uses `Bun.spawn([...], { stdout: "ignore", stderr: "ignore" })`
- **DRY**: use `isDockerDaemonRunning()` from `utils/docker.ts` — NEVER reimplement local `isDockerAvailable()` variants

**Linting**: oxlint (fast) + prettier + shellcheck + hadolint + yamllint | TS strict mode

**Hooks**: bun-git-hooks — pre-commit auto-fixes + regenerates if manifest changed, then runs `bun run validate`; a failing check blocks the commit

**CI**: `ci.yml` (PRs) | `build-postgres-image.yml` (manual) | `publish.yml` (releases, Cosign signing)

**Tags**: `vMM.mm-TS` (e.g., `v18.1-202602082259`) — NO `latest` from dev builds

## Common Mistakes

- ❌ Editing `Dockerfile` directly → ✅ Edit `Dockerfile.template` + regenerate
- ❌ Using Node.js fs/child_process → ✅ Use Bun.file/Bun.$
- ❌ Hardcoded counts in docs → ✅ Reference `docs/.generated/docs-data.json`
- ❌ Complex bash in YAML → ✅ Extract to TypeScript script
- ❌ Skip validation → ✅ pre-commit runs `bun run validate`; run `bun run validate:all` (what CI runs) yourself when the change touches a `.sh`, YAML or Dockerfile template: ShellCheck (info level), yamllint and hadolint run only there
- ❌ Naming Docker-dependent tests `*.test.ts` → auto-discovered by unit test glob, runs without Docker, fails → ✅ Docker-dependent tests MUST use `test-*.ts` naming (NOT `*.test.ts`); add it to `SUITES` in `scripts/test-all.ts` with its group (`validate` fails until you do). All `*.test.ts` files are unconditionally unit-test safe.
- ❌ A suite giving a shipped input a value no real deployment writes (bigger memory limits, an explicit default preload list, a mounted getkey) → it hides the defect it works around → ✅ suites run shipped defaults; an override carries the reason inline (e.g. it is the subject under test)
- ❌ `$.env({ COMPOSE_PROJECT_NAME: name })` in test files — replaces the ENTIRE subprocess env (strips PATH, HOME, DOCKER_CONFIG), causing `docker-credential-osxkeychain: executable file not found` when Docker pulls uncached images → ✅ ALWAYS use `$.env({ ...Bun.env, COMPOSE_PROJECT_NAME: name })` to inherit the full process environment
- ❌ A workflow step running a suite file (`bun scripts/test/test-<name>.ts`) → ✅ `bun scripts/test-all.ts --group <g> --image <ref>`: `SUITES` is the only suite list, so a hand-listed step drifts (`validate` refuses it)

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
- **Commit only on the checked-out branch; never create, switch, merge, rebase or delete branches or worktrees unless Art asks for that exact operation**. Work parked on a side branch or worktree is invisible to Art and needs a later merge that is itself a branch operation. A long test reading the working tree is no exception: wait, or edit only files it does not read. Branches: `dev` = daily work (usually checked out), `dev` = GitHub default branch (scheduled and `workflow_run` workflows run its definitions), `main` = release mirror, `release` = triggers `publish.yml`; name one only after `git rev-parse --abbrev-ref HEAD`. `.claude/settings.json` makes Claude ask Art before each such command
- Should NEVER lose anything, be super careful with git reset/revert/rebase!
- **Commit with `git commit --only -m "…" -- <files>`, naming every file of the change (both paths of a rename)**: a plain `git commit`, even right after `git add <files>`, takes the WHOLE index — including whatever `git mv`, `git rm` or an earlier `git add` already staged. A new file needs `git add -- <file>` first: `--only` rejects a path git does not track yet. Then check `git show --stat HEAD` lists exactly those files.

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

**Replication**: a standby may be smaller than its primary — the entrypoint raises the five `pg_control` limits (max_connections, …) to the primary's; the replica stack clones before the image entrypoint (`stacks/replica/scripts/replica-entrypoint.sh`), never from `docker-entrypoint-initdb.d`

**PgBouncer**: auth_user must exist in BOTH userlist.txt AND .pgpass; connection params in DSN only

**Extensions**: Modules=preload-only (auto_explain) | Tools=no CREATE EXTENSION | Standard extensions=CREATE EXTENSION flow

**CI Workflow Resilience**: Informational steps (SARIF upload, diagnostics) MUST have `continue-on-error: true` — tool infrastructure failures must never block releases. The actual security gate is a separate independent blocking step with `exit-code: 1`. Same pattern for any step that is "nice-to-have" vs "must-pass".

**Security Scanner Resilience**: Use `docker run ghcr.io/aquasecurity/trivy:VERSION@sha256:… image TARGET` (Docker container approach; GHCR has the same digests as Docker Hub without its anonymous pull limit) for local scans — no GitHub release binary download, immune to supply-chain deletion attacks (Trivy incident 2026-03-01: attacker deleted v0.27-v0.69.1 binaries). Pin to v0.69.3+. Local/CI blocking gates fail on fixable CRITICAL/HIGH findings (`--ignore-unfixed`) and skip only `usr/local/bin/gosu` because su-exec shadows the base-layer binary. Avoid static CVE ignores; they hide future fixable regressions.

**Vendor apt repos**: Percona and Timescale sources trust only the keys committed in `docker/postgres/apt-keys/` (`signed-by=`); never install a vendor's repo-setup `.deb` or pipe its script into bash — that runs build-day bytes as root unchecked. The final image purges the base image's GnuPG CLI stack; Debian 13 apt verifies repos through `sqv`.

**PGroonga Build System**: PGroonga 4.0.6+ uses Meson, not PGXS Makefile. Manifest must use `build.type: "meson"`, include `meson` in `aptPackages`, and pass `mesonOptions: ["-Dtest=false"]` for production builds; upstream Meson test setup requires Ruby.

**SHA Pin Accuracy**: SHA pins go stale silently — run `actions-up` (see `/update` skill) to refresh both the SHA and the `# vX.Y.Z` tag on each `uses:` line. Also audit for version references in prose comments elsewhere in workflow files (`command grep -rn "@v[0-9]" .github/workflows/ .github/actions/ | command grep "#"`). Verify manually: `git ls-remote https://github.com/REPO.git refs/tags/TAG`.

**PostgreSQL Minor Drift Guard**: Release/publish gates MUST run `scripts/validate-base-image-sha.ts --require-latest-minor`; stale `MANIFEST_METADATA.pgVersion/baseImageSha` can pass same-tag SHA checks while PGDG/floating `postgres:N-trixie` has advanced, then fail built-image version verification. Update manifest, regenerate, validate.

**git-ref Drift Guard**: `scripts/extensions/check-updates.ts --format=json` now reports `git-ref` `current` vs remote `HEAD` `latest`; treat any enabled `updateAvailable: true` as mandatory update work (not informational), and pair image-facing manifest updates with a `CHANGELOG.md` entry in the same round.

**Secret-Scan Heuristic Trap**: the secret scan (`validate:all`, blocking) can flag ordinary local vars when names look credential-like (e.g., `token = "..."`). In non-secret code paths, use precise neutral names (`versionChunk`, `segment`, etc.) and re-run tests; don't suppress the scan blindly.

**Annotated Tags Have TWO SHAs**: `git ls-remote ... refs/tags/vX.Y` returns the tag OBJECT SHA (not usable for `rev-parse HEAD`). Use `refs/tags/vX.Y^{}` (caret-brace) to get the peeled COMMIT SHA — this is what `HEAD` resolves to after `git clone --branch vX.Y`. Always verify with both: `git ls-remote URL 'refs/tags/TAG' 'refs/tags/TAG^{}'`.

**Bun Shell `rm -rf` Fails on Deep Directories**: Bun's shell `$` built-in `rm` fails with "Directory not empty" on deeply nested directories (e.g. pgroonga regression test trees with 7+ levels like `expected/full-text-search/text/single/compatibility/v2`). Do NOT use `$\`rm -rf dir\``for directories that may contain deep trees. Use`import { rm } from "node:fs/promises"; await rm(dir, { recursive: true, force: true })`instead — this is reliable on Linux.

**Tool checks**: `testToolsPresent` finds each enabled tool by its manifest entry's `binaryPath` (executable) or `soFileName` (library under `pg_config --pkglibdir`); `validate-manifest.ts` rejects a tool naming neither, so a new tool cannot ship unchecked. Paths containing the PG major come from the running server (`pg_config`, `SHOW server_version_num`) — NEVER hardcode `postgresql/18/`.

**Test Architecture**: `test-all.ts` runs `scripts/docker/test-image.ts`, whose checks are all defined in `scripts/docker/test-image-lib.ts` — one definition per check, so no copy can drift. Add an image check there, not in a new standalone script.

**Test Shared-Container Contamination**: All tests in `test-image.ts` share one container. Event trigger changes (`ALTER EVENT TRIGGER ... DISABLE`) MUST be wrapped in try/finally with `ENABLE` in the finally block — missed re-enable poisons all subsequent tests in the suite.

**INSERT Idempotency**: Tests using `CREATE TABLE IF NOT EXISTS` + unconditional `INSERT` produce wrong counts when a container is reused (`test-image.ts --container=<name>`). ALWAYS add `TRUNCATE tablename RESTART IDENTITY` before INSERTs when the test asserts exact row counts or id values.

**Custom AM Index Contamination**: For custom index AMs (PGroonga), `TRUNCATE` alone does NOT reliably clear the AM's external storage (Groonga files). The non-negotiable requirements are: (1) `DROP INDEX IF EXISTS` must occur to purge external storage, (2) `CREATE INDEX` must be unconditional (no `IF NOT EXISTS`), (3) `CREATE INDEX` must happen AFTER all INSERTs. The ORDER of DROP INDEX relative to TRUNCATE is flexible — both `DROP → TRUNCATE → INSERT → CREATE` and `TRUNCATE → DROP → INSERT → CREATE` are correct; what breaks things is `CREATE INDEX IF NOT EXISTS` after TRUNCATE (skips rebuild, stale external data accumulates). RUM uses standard PostgreSQL AM pages (no external storage); the same pattern is applied for consistency.

**psql Session Isolation**: Each `psql()`/`sqlOk()` call (`test-image-lib.ts`) spawns a new `docker exec ... psql` process — `SET` statements do NOT persist between calls. `SET enable_seqscan = OFF` and the `SELECT` it affects MUST go in one call (one string, or an array: its `-c` statements share one session).

**Postgres Entrypoint Readiness**: `pg_isready` can pass during the official image's temporary initdb server, right before entrypoint shutdown/restart. Fresh-container smoke tests MUST wait for `PostgreSQL init process complete; ready for start up.` in logs, then re-check `pg_isready` + `SELECT 1` against the final server.

**DROP TABLE CASCADE ≠ DROP FUNCTION**: `DROP TABLE x CASCADE` removes the table's triggers, indexes, constraints, and sequences — but NOT the trigger functions they reference. Functions are standalone objects reusable across multiple tables. Any function a check creates must be explicitly dropped (as `testPlpgsqlCheck` does) or it persists until the container is removed.

**Auto-config Verification**: Testing that a GUC was written by auto-config uses `SELECT name FROM pg_settings WHERE name IN (...) AND sourcefile IS DISTINCT FROM '/var/run/postgresql/aza-auto-config.conf'` — any row returned means auto-config did not set it (default, a config file, or an operator `-c`/`ALTER SYSTEM`, which outrank auto-config). `SHOW setting` is useless for this: PostgreSQL always returns a value (the default), so SHOW cannot distinguish "configured" from "at default". A non-empty result from `SHOW shared_buffers` proves nothing.

**`enabled: false` vs `defaultEnable: false`**: `enabled: false` = extension absent from image (select from `MANIFEST_ENTRIES` with `enabled !== false`, as `enabledEntries()` in `test-image-lib.ts` does, before calling CREATE EXTENSION — it will fail). `runtime.defaultEnable: false` = extension installed but NOT precreated in public schema (no guard needed — CREATE EXTENSION works in tests fine). Conflating these either makes tests meaningless (no guard on absent ext) or adds useless guards on installed exts.

**Precreated extensions**: `testPrecreatedExtensions` reads the expected list from the `v_expected_exts` array in `01-extensions.sql` (plus pg_cron, created by `01b-pg_cron.sh`); edit that file, never a copy in a test — the manifest cannot derive it (`runtime.defaultEnable` covers preload libraries only).

**Bidirectional Membership Checks**: Any test that validates "expected ⊆ actual" must also validate the reverse — "actual ⊆ allowable" — or unexpected entries go undetected. IMPORTANT: the reverse check must use the **allowable** superset, not the **required** set. Example: `testPreloadedExtensions` checks (1) all `defaultEnable:true` libs ARE in `shared_preload_libraries` (forward) and (2) everything IN `shared_preload_libraries` IS a `sharedPreload:true` lib (reverse). Using `required` for the reverse would flag legitimate optional preloads as rogue entries.

**Fail-Fast for Behaviour Prerequisites**: `testPostgresConfiguration` (the "Startup state" batch of `test-image.ts`) asserts the settings later behaviour checks need. If `wal_level != logical`, `testWal2jsonReplication` fails with a cryptic "slot creation failed" error; the config assertion names the cause. Rule: any GUC whose wrong value would make a behaviour check fail obscurely belongs in `testPostgresConfiguration`.

**cleanupTestData Must Cover ALL Failure Paths**: The cleanup function is a safety net — it must drop every resource ANY test can create, regardless of whether tests clean up after themselves on the happy path. Tests that create resources only drop them on the success path (early failure returns skip cleanup). If `cleanupTestData` doesn't also drop them, they accumulate on failed runs. Example: `testPgmqQueue` creates `test_queue`, so `cleanupTestData` drops it too.

**Multi-Stage Gosu Replacement: GHA Cache Ambiguity + Trivy Layer Scanning**: All multi-stage approaches (`COPY --from=`, bind-mounts, `apt-get install su-exec` — absent from postgres image repos, `COPY via builder-pgxs output dir` — COPY key matched stale GHA entry) fail due to GHA layer cache interference. `apt-get purge gosu` is a no-op because postgres:18.3-trixie installs gosu via direct binary download (not dpkg). **Root cause of Trivy persistence**: Trivy scans ALL image layers including immutable base layers — gosu in the postgres base layer is reported even when `/usr/local/bin/gosu` is su-exec in the merged filesystem. **Definitive fix**: compile su-exec in the final stage, install at `/usr/local/bin/gosu` (shadows the base binary), skip only that path in Trivy gates; builders copy only each source tool's `binaryPath`, so the base gosu never crosses stages. Add `[ SZ -lt 500000 ]` to FAIL build if wrong binary.

**Digest-Pinned Base Security Drift**: A valid/latest PostgreSQL base digest can still contain stale Debian packages after Debian publishes security updates. Final image builds MUST run `apt-get upgrade -y --no-install-recommends` after `apt-get update`; the merged-image PostgreSQL version check guards against accidental PG minor drift.

**BuildKit SBOM Shape**: `docker/build-push-action sbom:true` emits per-platform SBOMs as `unknown/unknown` OCI attestation manifests with `application/vnd.in-toto+json` SPDX layers. Do NOT verify with deprecated `cosign download sbom`; verify every runnable platform has a matching attestation manifest.

**Bun OSV Install Gate (transitive-CVE remediation)**: `bunfig.toml` runs `scanner = "bun-osv-scanner-extended"` on every `bun install`. A newly-published `warn`-level CVE in a transitive (even dev) dep makes the non-TTY install **exit 1** (`bun install` cancels; no diff changed locally — externally-triggered). Remediate **in this order**: (1) **`overrides`** in `package.json` to a patched version (first resort — actually removes the vuln); regenerate `bun.lock` (CI uses `--frozen-lockfile`). (2) Only when **unfixable** (no patched version exists), add to `.bun-osv.json` `{"ignore":[{"advisory":"CVE-…"|"package"+"range","reason":"…","expires":"<future ISO>"}]}` — `reason` + a **future** `expires` are mandatory (scanner treats missing/unparseable `expires` as permanent silent suppression). Every install site needs `BUN_OSV_SHOW_IGNORED="0"` in env (default re-emits ignored advisories as warn → cancels); already wired at `setup-bun`, the inline-install workflows, and `.1code/worktree.json` (non-CI worktree setup — inline `env BUN_OSV_SHOW_IGNORED=0 bun install`, since a JSON command array has no layered env). `scripts/security/validate-bun-osv.ts` (fast `validate` check) enforces: canonical `{ignore:[…]}` shape + reason/future-expires (both `.bun-osv.json` and `package.json#bunOsv.ignore`), scanner pin (bunfig name **and** that it's a declared dep), SHOW_IGNORED wiring at every `bun install` site (CI files by env-precedence resolution, `.1code/worktree.json` by inline prefix), and forbids the `BUN_OSV_IGNORE_FILE`/`OSV_IGNORE_FILE`/`BUN_OSV_IGNORE_PKG`/`BUN_OSV_IGNORE_ADVISORY` env bypass. **Caveat**: the scanner is fail-open (OSV outage → install proceeds unscanned); the per-site `BUN_CONFIG_INSTALL_MINIMUM_RELEASE_AGE=86400` release-age delay is the backstop. The guard encodes scanner-internal behaviour — re-verify it against the scanner source on any `bun-osv-scanner-extended` bump (lockfile-hash-pinned, so a bump is a reviewable diff).

## Changelog

**File**: `CHANGELOG.md` — Keep a Changelog format, user-facing, integrated with GitHub releases

The changelog focuses changes affecting the **release Docker image** only!
**Audience**: Image consumers (ops, developers deploying aza-pg). NOT developers of aza-pg tooling.

**Workflow**:

1. Track image-affecting changes in `[Unreleased]` section
2. Focus on: extension updates, base image changes, breaking changes, security fixes
3. After successful GitHub CI release: rename `[Unreleased]` → `[release-tag]` (e.g., `[v18.1-202602082259]`)
4. Start new `[Unreleased]` section for next changes
5. Non-image changes: 1-2 brief bullets max in `### Development` — omit if trivial

**The ONLY test that matters**: Would the change appear in `docker inspect`, `\dx`, extension behaviour, `psql --version`, or otherwise change what the image **does** for an operator? Yes → belongs. No → NEVER belongs.

**What NEVER belongs in the changelog**:

- Build script fixes (`build-extensions.ts`, `generate-dockerfile.ts`, etc.) — even if they fixed a build bug, the fix itself is invisible; only the **resulting extension change** (if any) belongs
- Agent commands (`.claude/commands/`), skills, test scripts — invisible to image consumers
- Individual kaizen/audit passes, validate check improvements, internal refactors
- CI infra fixes (timeouts, retry logic, credentials) — operators can't see these
- Anything a user running `docker run` cannot observe or act on

**Development section rules** (when it's worth including at all):

- Max 1-2 bullets total, no technical detail, user-impact framing only
- OK: "Test coverage hardened; CI updated to Node.js 24 runners"
- NOT OK: "testPgStatStatements now executes a tracked query after reset..."
- NOT OK: "Fixed ensureCleanDir to use node:fs instead of Bun shell rm..."

**Categories**: Breaking | Security | Fixed | Changed | Added | Deprecated | Removed | Development

## References

- CHANGELOG.md — Release history (image-affecting changes)
- docs/ARCHITECTURE.md — System design
- docs/TESTING.md — Test patterns
- docs/BUILD.md — CI/CD workflows
- docs/TOOLING.md — Tech decisions
- docs/VERSION-MANAGEMENT.md — Version procedures
- docs/.generated/docs-data.json — Live counts (auto-generated)
- ROADMAP.md — Known defects and missing work by severity; remove an entry in the commit that fixes it

---

## Maintaining This File

**Principles** (this doc appears in EVERY AI conversation):

- **Token efficiency**: Use abbrs (TS, PG, GH, env), strip filler, dense formatting
- **Self-sufficient**: Out-of-context agents must understand without external docs
- **Imperative voice**: Commands, not descriptions ("Edit X" not "You should edit X")
- **No bloat**: Every line must earn its tokens — if removing doesn't lose value, remove it
- **Update, don't expand**: Replace outdated info; don't add sections for temporary issues
