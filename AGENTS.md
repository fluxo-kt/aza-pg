# aza-pg: Production PostgreSQL with Auto-Config — AI Agent Guide (NO LOGS HERE! NO BS, ONLY FUTURE-PROOF VALUE!)

**PG 18 container**: Auto-tuned config, comprehensive extensions, SHA-pinned dependencies, Bun/TS-first tooling, Compose-only deployment, digest-based releases.

Before an update round, read [.claude/commands/update.md](.claude/commands/update.md) and complete its full update matrix; one clean dependency surface does not close the round.

• **Bun-First**: All scripts use Bun TypeScript. Prefer Bun APIs to usuals from Node.js when possible and reasonable. See Development Standards below. **But NO Bun in the final images**. And DO NOT USE bunx, `bun x`, npm, npx, pnpm, pnpx, yarn or corepack — NEVER!! (`.claude/settings.json` denies each; run a `package.json` script or `./node_modules/.bin/<tool>` instead)
• **TS-First**: YAML workflows are orchestration only — all logic, verification, and diagnostics belong in TypeScript scripts that can be tested locally. Nix files (`flake.nix`, `nix/`) build what the manifest declares and stay as simple as possible — logic and nuances belong in TypeScript scripts.

## CRITICAL RULES

- **Run affected local checks before each focused commit; commit before long verification, then repair any failure in a follow-up commit. Complete the full update procedure's committed-code gate before presenting the update.**
- **DOUBLE CHECK & CONFIRM ALL TESTS AND VERIFICATIONS ARE COMPLETE AND SUCCESSFUL BEFORE PUSHING**

## Invariants

- **Manifest = image-version source of truth**: `manifest-data.ts` defines the PG version label and bundled git tags; `flake.lock` pins nixpkgs (server, glibc, every library). Companion images use the canonical Compose defaults and propagation check in `/update` §5.6.
- **Per-extension facts live on its manifest entry** (`nix`, `soFileName`, `build`, …) — NEVER add a side table keyed by extension name; generators, validators and `nix/extensions.nix` read the entry, so changing how one builds stays a one-entry edit
- **Tools ≠ extensions** (no CREATE EXTENSION)
- **No Bun in final image** (build-only dependency)
- **Repository separation**: Production (`aza-pg`) vs Testing/Dev (`aza-pg-testing`) — ⚠️ NEVER use testing images in production
- **Nothing ships that no shipped feature uses at runtime** (Nix image): every package, plugin, data file and server build option must name the feature and consumer needing it inside a container; anything else is attack surface and size, so remove it. Reasons for each kept or dropped option sit at the option (`flake.nix`, `nix/*.nix`). `testNoBuildOnlyStorePaths` fails when a stray reference drags build-only outputs in (`pg_config` once added 2.3 GB unnoticed). Inspect the closure by size: `docker run --rm --entrypoint sh <image> -c 'du -sk /nix/store/* | sort -rn | head'`
- **Exactly one published image, ever**: no companion, helper or intermediate images of ours. Whatever the release needs is built into it; upstream companion images the stacks pin are upstream's releases, not ours
- **Build it ourselves when that is what fixes it**: a shipped component carrying fixable CVEs because upstream has not rebuilt it (e.g. an old Go or crate set) is rebuilt from nixpkgs or source with fixed dependencies, not waited for or ignored. An agent maintains the builds, so ownership cost lies only in what we publish
- **Latest stable versions everywhere; we own the updates**: never hold a component back for convenience
- **One implementation per job**: never ship two components doing the same thing (two coreutils, two TLS stacks); duplication is the worst outcome. Choose by consumers' real needs, behaviour compatibility and open CVEs
- **Choosing or keeping a component includes checking its open CVEs for the exact version** (OSV, NVD, upstream advisories and NEWS), never features or size alone
- **CVE scope is what we release**: the image and its runtime closure (`bun run security:scan`). Build-only dev tooling gets reasonable updates through `/update` and the install-time OSV gate, nothing more: no extra gates, scans or process for it
- **Local builds and checks run under CI's conditions** (Nix sandbox in `scripts/nix/nix.ts`): a local pass under looser conditions proves nothing about CI
- **Everything we build compiles as optimally as we can control.** The floor is upstream's own release build: a packaging default below it is a defect to fix on the entry (nixpkgs' Meson hook passes `--buildtype=plain`, which drops upstream's release level and any flags upstream adds only there; a Makefile's `-O0`). Read what a build type means from the build system itself (Meson `release` = optimization 3; the configure summary prints `optimization : N`), never from memory. C code uses upstream's own release level (PostgreSQL and PGXS extensions `-O2`; pgBackRest and CMake `Release` builds `-O3`), because that is the build upstream tests: a miscompile at an untested level is a silent wrong result, which costs more than the speed. A component moves to `-O3` only when it measures faster on this workload and passes the full suite at `-O3`; record the measurement at the setting. `-march=native` stays forbidden: the image must run on any CPU meeting the baseline in `flake.nix` (x86-64-v3, Armv8.2-A with dot product), which the entrypoint checks at start
- **Data directories made by older images are migrated at the first start on a new image, before clients connect** (entrypoint block above `_main`): an image change must never leave a database failing or silently wrong. Only proven-safe steps run unattended (e.g. a bare collation version refresh only between glibc versions `scripts/nix/compare-en-us-order.ts` measured to sort en_US the same; any other glibc change rebuilds the libc-collated indexes first); anything unrepairable stops the container naming the fix
- **A check runs in the lane only if it fits the lane's budget and guards something a routine change can break**; evidence for a rare event is gathered in that event's `/update` step, not paid on every run

## AI Agent Knowledge Updates (Post-Training Facts)

**Critical context for AI agents with training cutoffs before 2025:**

### PostgreSQL Timeline

| Fact                      | Detail                             |
| ------------------------- | ---------------------------------- |
| PostgreSQL 18 is RELEASED | GA Sep 25, 2025; 18.1 Nov 13, 2025 |

### Extension Compatibility (PG18)

| Extension        | Status                                                 |
| ---------------- | ------------------------------------------------------ |
| `pg_plan_filter` | v1.0.0 supports PG18; preload library is `plan_filter` |
| `citus`          | FAILS TO BUILD                                         |
| `periods`        | OBSOLETE - now in PG18 core                            |
| `pgvector`       | Still 0.8.x (0.9 NOT released)                         |
| `pgrx`           | Requires Rust 1.88.0+ (v0.16.1)                        |

### Version String Formats

Manifests of Debian-built releases (read them for a changelog's old versions) carry apt versions:

| Format Type          | Example                | Notes                    |
| -------------------- | ---------------------- | ------------------------ |
| **Percona epochs**   | `1:2.3.1-2.trixie`     | The `1:` prefix matters! |
| **Timescale tildes** | `2.24.0~debian13-1801` | Uses a `~` separator     |
| **PGDG suffix**      | `0.8.1-2.pgdg13+1`     | Uses a `+` for revisions |

## Paths & Fast Commands

```bash
flake.nix nix/         # Nix image build (server, extensions, image)
docker/postgres/       # entrypoints, initdb, configs, patches
scripts/               # Bun TS scripts (no absolute paths)
stacks/{primary,replica,single}  # Compose deployments

# Essential Commands (organized by category)

# Validation & Fixing
bun run validate            # Fast: static checks + unit tests
bun run validate:all        # Full: + shellcheck, yamllint
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
- **Shell safety**: ALL RUN commands MUST use `set -euo pipefail` (not just `set -eu`)
- **Version changes**: Update `manifest-data.ts` (`source.tag`; `pgVersion` follows nixpkgs, `flake.nix` refuses a mismatch) → regenerate → rebuild. Regression expected files (`tests/regression/extensions/*/expected/basic.out`) hold no version strings — `scripts/test/test-extension-versions.ts` checks versions — so never add one
- **PgBouncer .pgpass**: Escape ONLY ":" and "\\" (NOT "@" or "&")
- **Tools vs extensions**: No CREATE EXTENSION on tools (pgbackrest, wal2json, pg_safeupdate)
- **Container teardown**: remove containers with `docker rm -f -v` — the `-v` drops PG18's anonymous `/var/lib/postgresql` PGDATA volume (named volumes always survive); omitting it orphans one per teardown → silent multi-GB bloat. A test container that is never restarted puts PGDATA on tmpfs (`...EPHEMERAL_PGDATA`, `scripts/utils/docker.ts`; reasons and exceptions there): no volume exists to leak or to mistake for an operator's data. An ad-hoc probe (`docker run <image> psql --version`, a smoke start) takes `--rm`, or its stopped container keeps that volume. `-v` is enforced by `Subprocess Calls` in `validate`. Test leftovers clean themselves: test-all sweeps each suite, and both test-all (at start) and `bun run cleanup` remove any test container, volume or network whose creating process is gone (`sweepOrphanedTestResources`; generated names carry that pid), so name test resources only through `generateUnique*Name`. `bun run cleanup` also removes superseded aza-pg images and only lists unattached anonymous aza-pg data volumes, since one may hold an operator's database. `docker run -v <name>:…` creates a named volume that does not exist, so never probe for a volume that way (`docker volume inspect <name>` only reads)
- **Auto-config override**: operator `-c` and `ALTER SYSTEM` win over auto-tuning; values in postgresql.conf files lose to it (initdb writes tuned settings into every data directory's postgresql.conf, so honouring files would switch tuning off). The startup log names each overridden or ignored value
- **`deployments/` hand-copies the stacks and no suite boots it**: a fix to `stacks/*/compose.yml`, the entrypoint's env contract or a documented command applies there too — `rg` the setting across `stacks/ deployments/ docs/` in the same change. `Image Runtime Contract` in `validate` checks the copies; proof rules in `deployments/AGENTS.md`
- **`/dev/shm` differs by host**: dockerd's default is 64 MB (CI runners, Linux VPSes), but a Docker Desktop daemon may hand out GBs, so a local pass proves nothing for anything using PostgreSQL dynamic shared memory (parallel index builds, parallel hash joins). Reproduce with `--shm-size=64m`. Auto-config sets `dynamic_shared_memory_type=sysv` so this memory never touches `/dev/shm` (reason at that setting); with `posix` a parallel hash join or HNSW build fails at 64 MB

## Extension System

Enable/disable: Edit `scripts/extensions/manifest-data.ts` → `bun run generate` → rebuild

**Build**: every non-builtin entry builds from its pinned commit (`nix/extensions.nix`): `nix.package` reuses that nixpkgs recipe, else `build.type` with `nix.inputs`; `build.patches` applies diffs from `docker/postgres/patches/`

**Counts**: See `docs/.generated/docs-data.json` for live module/preload/tool counts

**Default preload**: `getDefaultSharedPreloadLibraries` in `scripts/config-generator/manifest-loader.ts` derives the list and order; Timescale precedes pgaudit's hooks.

**Optional preload** (enable via `POSTGRES_SHARED_PRELOAD_LIBRARIES`): supautils, set_user, pg_partman_bgw, plan_filter

## Auto-Config

**Detection**: POSTGRES_MEMORY → cgroup v2 → /proc/meminfo | CPU via `nproc`

**Workload** (`POSTGRES_WORKLOAD_TYPE`): `mixed` (default, 120 conn) | `web` (200) | `oltp` (300) | `dw` (100)

**Storage** (`POSTGRES_STORAGE_TYPE`): `ssd` (default) | `hdd` | `san`

**Caps**: shared_buffers ≤32GB; work_mem ≤32MB for web/oltp, mixed/dw up to 64/128/256MB from 2/8/32GB RAM; connections RAM-scaled by tier. Formulas: `calculate_*` in the entrypoint (rules in README "Auto-Config")

## Development Standards

**Writing any TS script or test check: read `scripts/AGENTS.md` first** (Bun API and `Bun.spawn` deadlock rules, test-container isolation rules); it auto-loads only when a file under `scripts/` is opened.

**Linting**: oxlint (fast) + prettier + shellcheck + yamllint | TS strict mode

**Hooks**: bun-git-hooks — pre-commit auto-fixes + regenerates if manifest changed, then runs `bun run validate`; a failing check blocks the commit

**CI**: `ci.yml` (pushes, PRs) | `publish.yml` (releases: amd64+arm64 build, test gate, Cosign signing; a failed gate publishes nothing)

**Tags**: `vMM.mm-TS` (e.g., `v18.1-202602082259`) — NO `latest` from dev builds

## Common Mistakes

- ❌ Using Node.js fs/child_process → ✅ Use Bun.file/Bun.$
- ❌ Hardcoded counts in docs → ✅ Reference `docs/.generated/docs-data.json`
- ❌ Complex bash in YAML → ✅ Extract to TypeScript script
- ❌ Skip validation → ✅ pre-commit runs `bun run validate`; run `bun run validate:all` (what CI runs) yourself when the change touches a `.sh` or YAML file: ShellCheck (info level) and yamllint run only there
- ❌ A suite giving a shipped input a value no real deployment writes (bigger memory limits, an explicit default preload list, a mounted getkey) → it hides the defect it works around → ✅ suites run shipped defaults; an override carries the reason inline (e.g. it is the subject under test)
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
- **Commit only on the checked-out branch; never create, switch, merge, rebase or delete branches or worktrees unless Art asks for that exact operation**. Work parked on a side branch or worktree is invisible to Art and needs a later merge that is itself a branch operation. A long test reading the working tree is no exception: wait, or edit only files it does not read. Branches: `dev` = daily work (usually checked out), `dev` = GitHub default branch (scheduled and `workflow_run` workflows run its definitions), `main` = release mirror, `release` = triggers `publish.yml`; name one only after `git rev-parse --abbrev-ref HEAD`. `.claude/settings.json` makes Claude ask Art before each such command, and Art's global hook refuses `git checkout` outright: plan any branch switch as Art's `! git checkout <branch>`, never as your own step
- Should NEVER lose anything, be super careful with git reset/revert/rebase!
- **Commit with `git commit --only -m "…" -- <files>`, naming every file of the change (both paths of a rename)**: a plain `git commit`, even right after `git add <files>`, takes the WHOLE index — including whatever `git mv`, `git rm` or an earlier `git add` already staged. A new file needs `git add -- <file>` first: `--only` rejects a path git does not track yet. Then check `git show --stat HEAD` lists exactly those files.

## Troubleshooting

| Issue                | Fix                                                   |
| -------------------- | ----------------------------------------------------- |
| Extension missing    | Check manifest enabled + `bun run generate` + rebuild |
| Generated file stale | `bun run generate`                                    |
| Preload error        | Align shared_preload_libraries with manifest defaults |
| RAM misdetection     | Set POSTGRES_MEMORY explicitly                        |
| Container exit 125   | Docker daemon issue (compose syntax, volumes)         |
| Container exit 1     | Application error (check PG logs)                     |

## Key Learnings

**Compose**: `env_file:` loads for container only — use `environment:` for inter-service vars

**Replication**: a standby may be smaller than its primary — the entrypoint raises the five `pg_control` limits (max_connections, …) to the primary's; the replica stack clones before the image entrypoint (`stacks/replica/scripts/replica-entrypoint.sh`), never from `docker-entrypoint-initdb.d`

**PgBouncer**: auth_user must exist in BOTH userlist.txt AND .pgpass; connection params in DSN only

**Extensions**: Modules=preload-only (auto_explain) | Tools=no CREATE EXTENSION | Standard extensions=CREATE EXTENSION flow

**CI Workflow Resilience**: Informational steps (SARIF upload, diagnostics) MUST have `continue-on-error: true` — tool infrastructure failures must never block releases. The actual security gate is a separate independent blocking step with `exit-code: 1`. Same pattern for any step that is "nice-to-have" vs "must-pass".

**Security Scanner Resilience**: Use `docker run ghcr.io/aquasecurity/trivy:VERSION@sha256:… image TARGET` (Docker container approach; GHCR has the same digests as Docker Hub without its anonymous pull limit) for local scans — no GitHub release binary download, immune to supply-chain deletion attacks (Trivy incident 2026-03-01: attacker deleted v0.27-v0.69.1 binaries). Pin to v0.69.3+. Local/CI blocking gates fail on fixable CRITICAL/HIGH findings (`--ignore-unfixed`) Trivy reads no package database in a Nix image, so it covers language packages only (Rust crates, bundled JS), never the C libraries. The C libraries are gated by `scripts/security/vulnix-gate.ts` (publish.yml, before the push): fix a hit by upgrading; list only a not-affected or accepted one in `vulnix-whitelist.toml`, with evidence (and `until` when accepted). `bun run security:scan [REF]` (default `origin/release`, what operators run) re-checks every surface against today's feeds: vulnix and Trivy on the released image; before a release, `security:scan HEAD aza-pg:pg18` points Trivy at the local build instead. Avoid static CVE ignores; they hide future fixable regressions.

**SHA Pin Accuracy**: SHA pins go stale silently — run `actions-up` (see `/update` skill) to refresh both the SHA and the `# vX.Y.Z` tag on each `uses:` line. Also audit for version references in prose comments elsewhere in workflow files (`command grep -rn "@v[0-9]" .github/workflows/ .github/actions/ | command grep "#"`). Verify manually: `git ls-remote https://github.com/REPO.git refs/tags/TAG`.

**PostgreSQL Minor Drift Guard**: the server is whatever `flake.lock`'s nixpkgs ships; `flake.nix` refuses to build when `MANIFEST_METADATA.pgVersion` differs, so tags and labels cannot name a version the image lacks. A new minor arrives only by bumping `flake.lock` (`/update`).

**git-ref Drift Guard**: `scripts/extensions/check-updates.ts --format=json` now reports `git-ref` `current` vs remote `HEAD` `latest`; treat any enabled `updateAvailable: true` as mandatory update work (not informational), and pair image-facing manifest updates with a `CHANGELOG.md` entry in the same round.

**Secret-Scan Heuristic Trap**: the secret scan (`validate:all`, blocking) can flag ordinary local vars when names look credential-like (e.g., `token = "..."`). In non-secret code paths, use precise neutral names (`versionChunk`, `segment`, etc.) and re-run tests; don't suppress the scan blindly.

**Annotated Tags Have TWO SHAs**: `git ls-remote ... refs/tags/vX.Y` returns the tag OBJECT SHA (not usable for `rev-parse HEAD`). Use `refs/tags/vX.Y^{}` (caret-brace) to get the peeled COMMIT SHA — this is what `HEAD` resolves to after `git clone --branch vX.Y`. Always verify with both: `git ls-remote URL 'refs/tags/TAG' 'refs/tags/TAG^{}'`.

**BuildKit SBOM Shape**: `docker/build-push-action sbom:true` emits per-platform SBOMs as `unknown/unknown` OCI attestation manifests with `application/vnd.in-toto+json` SPDX layers. Do NOT verify with deprecated `cosign download sbom`; verify every runnable platform has a matching attestation manifest.

**Bun OSV install gate**: a `bun install` exiting 1 on a CVE (even a transitive dev dep) is the `bunfig.toml` scanner: fix with `package.json` `overrides` first, an expiring `.bun-osv.json` ignore only when unfixable, never an env bypass — full procedure and the `validate-bun-osv.ts` contract in `docs/TOOLING.md#Bun OSV install gate`; read it before touching install sites or bumping the scanner.

## Changelog

**File**: `CHANGELOG.md` — Keep a Changelog format, user-facing, integrated with GitHub releases

The changelog covers operator-visible changes to the release Docker image and shipped Compose companion images.
**Audience**: Image consumers (ops, developers deploying aza-pg). NOT developers of aza-pg tooling.

**Workflow**:

1. Track image-affecting changes in `[Unreleased]` section
2. Focus on: extension updates, nixpkgs (server, glibc, library) changes, breaking changes, security fixes
3. The release commit dates itself: `/release` runs `bun scripts/release/date-changelog.ts`, which moves `[Unreleased]` under `## [v<pg>-<UTC timestamp>] - <date>`. publish.yml takes the tag name and the GitHub notes from that newest heading, so every branch shows the release dated the moment it ships and the anchor merge brings it to dev
4. Non-image changes: 1-2 brief bullets max in `### Development` — omit if trivial

**Entry rules** (`[Unreleased]` is read by someone upgrading from the last release):

- One entry per component: `<name> <version in the last release> → <current>`. Read the old version from the tag (`git show <tag>:docker/postgres/extensions.manifest.json`), never from changelog text. A second bump before release edits that entry. A patch-only change (a lockfile bump for a CVE) moves no version and still needs its entry; `Changelog Coverage` in `validate` refuses any component whose pinned commit or patches changed since the last release and whose manifest name `[Unreleased]` lacks
- A dated `## [<tag>]` section is what shipped: never edit it
- Every claim comes from the component's own release notes for exactly that range; a feature from an earlier release is not news. Name the concrete fix, never "bug fixes"
- A change that needs operator action is Breaking; state the action, and the setting that restores old behaviour when upstream offers one
- Every image change is stated with its cost as well as its gain: removed features, lost hardening (e.g. arm64 BTI), changed library versions, size. An operator must never discover a loss the changelog did not name

**The ONLY test that matters**: Would the change appear in `docker inspect`, `\dx`, extension behaviour, `psql --version`, or change a shipped Compose service's authentication, settings, metrics or operation? Yes → belongs. No → NEVER belongs.

**What NEVER belongs in the changelog**:

- Build fixes (`flake.nix`, `nix/*.nix`, generators) — even if they fixed a build bug, the fix itself is invisible; only the **resulting extension change** (if any) belongs
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
