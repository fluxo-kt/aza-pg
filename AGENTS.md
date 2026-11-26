# aza-pg agent guide

**PG 18 container**: Auto-tuned config, comprehensive extensions, SHA-pinned dependencies, Bun/TS-first tooling, Compose-only deployment, digest-based releases.

Before an update, read [.claude/commands/update.md](.claude/commands/update.md) and close its full matrix. Fix missing, wrong or hidden guidance BEFORE the affected work. Put the trigger, act, reason and proof where the next agent needs them.

• **Bun-First**: All scripts use Bun TypeScript. Prefer Bun APIs to usuals from Node.js when possible and reasonable. See Development Standards below. **But NO Bun in the final images**. And DO NOT USE bunx, `bun x`, npm, npx, pnpm, pnpx, yarn or corepack — NEVER!! (`.claude/settings.json` denies each; run a `package.json` script or `./node_modules/.bin/<tool>` instead)
• **TS-First**: YAML workflows are orchestration only — all logic, verification, and diagnostics belong in TypeScript scripts that can be tested locally. Nix files (`flake.nix`, `nix/`) build what the manifest declares and stay as simple as possible — logic and nuances belong in TypeScript scripts.

## CRITICAL RULES

- **Run affected local checks before each focused commit; commit before long verification, then repair any failure in a follow-up commit. Finish every edit a long run reads (build inputs, entrypoint, suites) BEFORE starting it: an edit landing after the start voids that run and costs another full round. A defect found while a run is going is fixed now anyway: the run is then void, and keeping a known defect to save a run is never an option. Complete the full update procedure's committed-code gate before presenting the update.**
- **Run the full committed gate.** Before that, name the failure each probe can distinguish and what each result changes. Reuse evidence for the same inputs and decision.
- **A pin, override or setting changed only when the running artifact reports the new value.** Read it back from what runs (the binary's `--version`, `nix derivation show` references, `pg_settings`), never from the edit or a green build: a Docker volume filled by an older image keeps its binaries, and `overrideAttrs` cannot replace a value a nixpkgs recipe takes as a call argument, while every check stays green.
- **A warning on the release candidate is this round's defect.** Fix the code or the check that raises it, never let it repeat: a check that warns on every run (e.g. one measuring a loader stub instead of the library) teaches readers to skip it, so the run where it means something goes unread.
- **Report the revision or artifact tested.** Distinguish completed checks, failed checks and gaps. A tool failure leaves the underlying state unknown.
- **DOUBLE CHECK & CONFIRM ALL TESTS AND VERIFICATIONS ARE COMPLETE AND SUCCESSFUL BEFORE PUSHING**

## Invariants

- **Manifest = image-version source of truth**: `manifest-data.ts` defines the PG version label and bundled git tags; `flake.lock` pins nixpkgs (server, glibc, every library). Companion images use the canonical Compose defaults and propagation check in `/update` §5.6.
- **Per-extension facts live on its manifest entry** (`nix`, `soFileName`, `build`, …) — NEVER add a side table keyed by extension name; generators, validators and `nix/extensions.nix` read the entry, so changing how one builds stays a one-entry edit
- **Tools ≠ extensions** (no CREATE EXTENSION)
- **No Bun in final image** (build-only dependency)
- **Repository separation**: Production (`aza-pg`) vs Testing/Dev (`aza-pg-testing`) — ⚠️ NEVER use testing images in production
- **Nothing ships that no shipped feature uses at runtime** (Nix image): every package, plugin, data file and server build option must name the feature and consumer needing it inside a container; anything else is attack surface and size, so remove it. The consumer is the aza-pg container itself (server, extensions, entrypoint, health check, backup tools): another Compose service running our image for its own program (pooler, exporter) is no consumer, and CVEs, tests, checks or maintenance convenience never justify adding anything. **Adding any component to the image is Art's decision**, except what the automatic major upgrade runs (invariant "Data directories made by older images…"; it still names that consumer): bring him the runtime use case and wait for his explicit pick; a reply that picks no option approves nothing, so nothing gets built meanwhile. Reasons for each kept or dropped option sit at the option (`flake.nix`, `nix/*.nix`). `testNoBuildOnlyStorePaths` fails when a stray reference drags build-only outputs in (`pg_config` once added 2.3 GB unnoticed). Inspect the closure by size: `docker run --rm --entrypoint sh <image> -c 'du -sk /nix/store/* | sort -rn | head'`
- **Exactly one published image, ever**: no companion, helper or intermediate images of ours. Whatever the release needs is built into it; upstream companion images the stacks pin are upstream's releases, not ours, and stay separate: this rule never moves a companion into our image ("CVE effort follows what we release" below says how to handle a vulnerable one)
- **Build it ourselves when that is what fixes it**: a component already inside our image carrying fixable CVEs because upstream has not rebuilt it (e.g. an old Go or crate set) is rebuilt from nixpkgs or source with fixed dependencies, not waited for or ignored. An agent maintains the builds, so ownership cost lies only in what we publish
- **Latest stable versions everywhere; we own the updates**: never hold a component back, for convenience or for caution. A new version that breaks something we ship is this round's work, not a reason to wait: upgrade or patch the broken dependant (an upstream fix merged but not yet tagged ships as `build.patches` until the tag lands) and plan the migration existing databases need. Keeping an old pin is never an option to offer; a hold that still looks unavoidable after that work goes to Art as a question, with the evidence
- **One implementation per job**: never ship two components doing the same thing (two coreutils, two TLS stacks); duplication is the worst outcome. Choose by consumers' real needs, behaviour compatibility and open CVEs
- **Choosing or keeping a component includes checking its open CVEs for the exact version** (OSV, NVD, upstream advisories and NEWS), never features or size alone
- **CVE effort follows what we release**: the image and its runtime closure are gated, so a fixable HIGH/CRITICAL there is fixed before release. Every companion image our `stacks/` and `deployments/` pin, and everything our tests, checks and CI run, is ours to keep clean within reason but blocks nothing: `bun run security:scan` scans them all (the checkers' flake outputs, `scripts/nix/tools.ts`; tool images pinned in `scripts/` and `.github/`; the Bun packages via the install-time OSV gate), and every `/update` round updates them. A fixable finding there takes its reasonable route this round: upstream's fixed tag, or another maintained image or build with the fix (`/update` §5.6). With no such route, list the findings in the round's report and wait for upstream's fix; open no upstream issue or request unless Art asks. NEVER fix it by building that component into our image ("Nothing ships…" says what may enter it and who decides)
- **Local builds and checks run under CI's conditions** (Nix sandbox in `scripts/nix/nix.ts`): a local pass under looser conditions proves nothing about CI. The sandbox matches; the host does not: a CI runner is fresh Linux (a checkout owned by the runner's uid, empty volumes and caches, checks started in parallel), while a Mac reuses warm Docker volumes and Docker Desktop shows bind mounts as root-owned. A Mac pass therefore never proves a change to how scripts start Nix, containers or tools: for each workflow job that runs the changed script, name the path it takes there (CI jobs run native Nix via `setup-nix`; `nix.ts` refuses its Mac container fallback under `CI=true`), prove local behaviour from an empty volume with concurrent callers, and call it done only when the next CI run is green with job durations (`gh run view <id> --json jobs`) matching the run before. A job that suddenly needs a higher `timeout-minutes` is a regression to explain, never a knob to turn
- **Everything we build compiles as optimally as we can control.** The floor is upstream's own release build: a packaging default below it is a defect to fix on the entry (nixpkgs' Meson hook passes `--buildtype=plain`, which drops upstream's release level and any flags upstream adds only there; a Makefile's `-O0`). Read what a build type means from the build system itself (Meson `release` = optimization 3; the configure summary prints `optimization : N`), never from memory. C code uses upstream's own release level (PostgreSQL and PGXS extensions `-O2`; pgBackRest and CMake `Release` builds `-O3`), because that is the build upstream tests: a miscompile at an untested level is a silent wrong result, which costs more than the speed. A component moves to `-O3` only when it measures faster on this workload and passes the full suite at `-O3`; record the measurement at the setting. `-march=native` stays forbidden: the image must run on any CPU meeting the baseline in `flake.nix` (x86-64-v3, Armv8.2-A with dot product), which the entrypoint checks at start
- **Data directories made by older images are migrated at the first start on a new image, before clients connect** (entrypoint block above `_main`): an image change must never leave a database failing or silently wrong. This includes every PostgreSQL major change, with no operator step (design: ROADMAP "Major upgrades are not automatic yet"). Designing and building that upgrade, including what it runs inside the image, is the maintaining agent's job, never a question for Art. Every migration step keeps state the operator changed (a paused or re-timed job, a setting, a grant): a step re-applied on every upgrade carries definitions only, and one-time effects (scheduling, seeding) run once, where upstream runs them. Every installed extension whose shipped version changed is brought up to it there (`ALTER EXTENSION … UPDATE`; with no upstream update path, recreated when it owns no tables), and one the image no longer ships is dropped when its own tables are empty, so a CHANGELOG never tells operators to run extension updates. Only proven-safe steps run unattended (e.g. a bare collation version refresh only between glibc versions `scripts/nix/compare-en-us-order.ts` measured to sort en_US the same; any other glibc change rebuilds the libc-collated indexes first); anything unrepairable stops the container naming the fix
- **A check runs in the lane only if it fits the lane's budget and guards something a routine change can break**; evidence for a rare event is gathered in that event's `/update` step, not paid on every run

## AI Agent Knowledge Updates (Post-Training Facts)

**Critical context for AI agents with training cutoffs before 2025:**

### PostgreSQL Timeline

| Fact                      | Detail                                                                  |
| ------------------------- | ----------------------------------------------------------------------- |
| PostgreSQL 18 is RELEASED | GA Sep 25, 2025; the shipped minor is `pgVersion` in `manifest-data.ts` |

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
bun scripts/test-all.ts scripts/test/test-x.ts  # one suite: never `bun <suite>`, bun:test suites crash outside this runner
# Suite runs are evidence only with nothing else loading the host: run builds, scans (security:scan, vulnix) and other
# test runs before or after, never beside. A starved suite dies at its timeout and looks like an image defect;
# the verdict prints host load against CPUs.

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
- **Container teardown**: remove containers with `docker rm -f -v` — the `-v` drops PG18's anonymous `/var/lib/postgresql` PGDATA volume (named volumes always survive); omitting it orphans one per teardown → silent multi-GB bloat. A test container that is never restarted puts PGDATA on tmpfs (`...TEST_SERVER`, `scripts/utils/docker.ts`; reasons and exceptions there): no volume exists to leak or to mistake for an operator's data. An ad-hoc probe (`docker run <image> psql --version`, a smoke start) takes `--rm`, or its stopped container keeps that volume; a bare `docker create` (e.g. to copy files out) makes the same volume, empty and without the aza-pg marker (no initdb ran), so `bun run cleanup` never finds it: remove it with `docker rm -v`. `-v` is enforced by `Subprocess Calls` in `validate`. Test leftovers clean themselves: test-all sweeps each suite, and both test-all (at start) and `bun run cleanup` remove any test container, volume or network whose creating process is gone (`sweepOrphanedTestResources`; generated names carry that pid), so name test resources only through `generateUnique*Name`. `bun run cleanup` also removes superseded aza-pg images and only lists unattached anonymous aza-pg data volumes, since one may hold an operator's database. `docker run -v <name>:…` creates a named volume that does not exist, so never probe for a volume that way (`docker volume inspect <name>` only reads)
- **Host state must stay bounded**: anything a script keeps between runs (cache dir, Docker volume or image, output file) is either replaced in place or collected by the run that writes it (`.trivy-cache` holds one DB; `build-image.ts` re-roots and GCs the Nix store volume; `bun run build` drops superseded images). A change that moves or renames such a location also deletes the old one in that commit: otherwise it stays on every maintainer's disk, unowned, because no later run knows the old path. One-off scratch lives in `mktemp -d` with an EXIT trap.
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

**Workload**: `POSTGRES_WORKLOAD_TYPE` selects a profile. The entrypoint sizes connections for the memory available. See README “Auto-Config”.

**Storage** (`POSTGRES_STORAGE_TYPE`): `ssd` (default) | `hdd` | `san`

**Memory**: the tuned settings must work at 1–1.5 GB without swap, what PostgreSQL gets on the 2 GB VPS most deployments run on; an overrun there OOM-kills backends. Prove a formula change with real concurrent load under `--memory X --memory-swap X`, read from the container's cgroup (`oom_kill` in `memory.events`, `anon` + `shmem` in `memory.stat`), never by arithmetic on the formula alone: `bun scripts/test/test-memory-fit.ts` (`--all` for 1.5 and 3 GB). The default fits every connection busy at once; `POSTGRES_ACTIVE_CONNECTIONS_PERCENT` trades that for `work_mem`.

**Caps**: shared_buffers ≤32GB; work_mem ≤32MB for web/oltp, mixed/dw up to 64/128/256MB from 2/8/32GB RAM; connections RAM-scaled by tier. Formulas: `calculate_*` in the entrypoint (rules in README "Auto-Config")

## Development Standards

**Writing any TS script or test check: read `scripts/AGENTS.md` first** (Bun API and `Bun.spawn` deadlock rules, test-container isolation rules); it auto-loads only when a file under `scripts/` is opened.

**Linting**: oxlint (fast) + prettier + shellcheck + yamllint | TS strict mode

**Hooks**: bun-git-hooks — pre-commit auto-fixes + regenerates if manifest changed, then runs `validate.ts --staged`: lint/format take the staged files, and a check declaring `affects` runs only when a staged path can change its verdict (declare it for every check whose inputs are listable). A failing check blocks the commit; success is silent

**CI**: `ci.yml` (pushes, PRs) | `publish.yml` (releases: amd64+arm64 build, test gate, Cosign signing; a failed gate publishes nothing)

**Tags**: `vMM.mm-TS` (e.g., `v18.1-202602082259`) — NO `latest` from dev builds

## Common Mistakes

- ❌ Using Node.js fs/child_process → ✅ Use Bun.file/Bun.$
- ❌ Hardcoded counts in docs → ✅ Reference `docs/.generated/docs-data.json`
- ❌ KiB/MiB/GiB labels, or a size converted between 1000 and 1024 bases → ✅ our own sizes read KB/MB/GB and mean 1024-based units (`formatSize`, `scripts/utils/logger.ts`; `Size Units` in `validate` refuses IEC labels). Exception: public surfaces (changelog, release notes) quote a size a standard tool reports, Docker first of all (`docker images`, `docker system df`), exactly as it prints it (decimal), so an operator running that tool sees our number; scripts produce that form with `formatDockerSize`
- ❌ Complex bash in YAML → ✅ Extract to TypeScript script
- ❌ Skip validation → ✅ pre-commit runs `validate.ts --staged`; run `bun run validate:all` (what CI runs) yourself when the change touches a `.sh` or YAML file: ShellCheck (info level) and yamllint run only there
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

**CI Workflow Resilience**: Informational steps such as SARIF upload and diagnostics MUST use `continue-on-error: true`. Keep the security gate separate and blocking on both findings and scan failures. A failed informational step cannot stand in for the gate.

**Security scanners**: Use the [pinned scanner entry points](docs/TOOLING.md#image-security-scanners) when scanning or changing CI. Trivy covers language packages in the Nix image. Vulnix gates its C libraries. Use both on the candidate before release.

**SHA Pin Accuracy**: SHA pins go stale silently — run `actions-up` (see `/update` skill) to refresh both the SHA and the `# vX.Y.Z` tag on each `uses:` line. Also audit for version references in prose comments elsewhere in workflow files (`command grep -rn "@v[0-9]" .github/workflows/ .github/actions/ | command grep "#"`). Verify manually: `git ls-remote https://github.com/REPO.git refs/tags/TAG`.

**PostgreSQL Minor Drift Guard**: the server is whatever `flake.lock`'s nixpkgs ships; `flake.nix` refuses to build when `MANIFEST_METADATA.pgVersion` differs, so tags and labels cannot name a version the image lacks. A new minor arrives only by bumping `flake.lock` (`/update`).

**git-ref Drift Guard**: `scripts/extensions/check-updates.ts --format=json` reports `git-ref` `current` vs remote `HEAD` `latest`; treat any enabled `updateAvailable: true` as mandatory update work (not informational), and pair image-facing manifest updates with a `CHANGELOG.md` entry in the same round.

**Secret-Scan Heuristic Trap**: the secret scan (`validate:all`, blocking) can flag ordinary local vars when names look credential-like (e.g., `token = "..."`). In non-secret code paths, use precise neutral names (`versionChunk`, `segment`, etc.) and re-run tests; don't suppress the scan blindly.

**Annotated Tags Have TWO SHAs**: `git ls-remote ... refs/tags/vX.Y` returns the tag OBJECT SHA (not usable for `rev-parse HEAD`). Use `refs/tags/vX.Y^{}` (caret-brace) to get the peeled COMMIT SHA — this is what `HEAD` resolves to after `git clone --branch vX.Y`. Always verify with both: `git ls-remote URL 'refs/tags/TAG' 'refs/tags/TAG^{}'`.

**Release SBOM**: Verify SPDX attestations for each runnable platform with `scripts/release/verify-sbom.ts`. Read the publish workflow before describing how it builds, signs, or attaches them.

**Bun OSV install gate**: `bun install` exits 1 when the `bunfig.toml` scanner finds a CVE, even in a transitive dev dependency. Fix it with a `package.json` `overrides` entry pinning a patched version; add an expiring `.bun-osv.json` ignore only when no patched version exists; never bypass the scanner by env. Read `docs/TOOLING.md#Bun OSV install gate` (full procedure, what `validate-bun-osv.ts` enforces) before changing an install site or bumping the scanner.

## Changelog

Before writing or reviewing `CHANGELOG.md` or release notes, read [docs/CHANGELOG-RULES.md](docs/CHANGELOG-RULES.md): which section a change goes in (by what the operator must update), one entry per component, entry rules, and what never belongs.

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

Write short commands a cold reader can act on. Keep common rules here, folder rules in the nearest AGENTS.md and rare procedures behind a link triggered by the task. Replace stale guidance. Keep history in Git.
