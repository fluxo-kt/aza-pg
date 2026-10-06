---
name: /update
description: Comprehensive dependency and extension update guide
argument-hint: (optional additional notes)
id: p-update
category: project
tags: [project, update, maintenance]
---

# /update

You are updating dependencies and extensions in the aza-pg PostgreSQL container project.

**CRITICAL**: See AGENTS.md "AI Agent Knowledge Updates" section for surprising facts (Debian Trixie is LTS, PG18 released Sep 2025, pgrx needs Rust 1.88+, etc.)

OPTIONAL ADDITIONAL NOTES FROM USER: $ARGUMENTS

# Update Process

## Pre-Flight: Docker Availability Check (FIRST)

Before launching any parallel checks, confirm Docker is available. Docker-dependent checks (3, 8) cannot be deferred past the first commit if they fail here:

```bash
docker info >/dev/null 2>&1 && echo "Docker: OK" || echo "⚠️ Docker OFFLINE — checks 3 and 8 are BLOCKED; they MUST complete before first commit"
```

If Docker is offline: run items 1, 2, 4, 5 (non-Docker), defer 3 and 8, but treat them as **BLOCKING** — no commit until they complete.

## Pre-Flight: Detect Available Updates (RUN IN PARALLEL)

Use parallel tool calls or sub-agents only when the active environment supports them. Keep each
check bounded, verify every returned claim locally, and never let a sub-agent make the decision.
Do not start implementation from only one row of this list. The update scope is the full matrix
below; a clean Bun/actions update is still incomplete until PostgreSQL, image, extension, apt-repo,
and compose-image surfaces have also been checked.
Check:

1. **Git-based extensions**:

   ```bash
   bun scripts/extensions/check-updates.ts --format=json > /tmp/aza-updates.json
   echo "exit=$?"   # 0 = no ENABLED entry has an update, 1 = one does (NOT a failure), 2 = the check itself failed
   ```
   stdout carries only the report (progress goes to stderr), so the JSON file parses as-is. Exit 1 is the
   normal "work to do" answer: in a Bun script use `.nothrow()` and branch on 1 vs 2, never treat non-zero
   as broken. Exit 0 can still carry `updateAvailable: true` rows for disabled entries (Phase 5.5 decides
   those), so read the JSON, not just the code. SOURCE_LIBRARIES (e.g. libsodium) are checked too; their
   rows follow the same rules.
   Mandatory interpretation:
   - Treat `sourceType: "git-ref"` rows exactly like tagged updates: compare `current` vs `latest`
   - If any git-ref row has `latest: null`, stop and fix connectivity/parsing before proceeding
   - If any enabled row has `updateAvailable: true`, either update it now or document a concrete skip reason
   Verify candidate updates are true upgrades in the same release family:
   - Ignore mismatched tag-family noise (e.g., monorepo tags like `foo@X.Y.Z` vs plain `X.Y.Z`)
   - Ignore prereleases (`-beta`, `-rc`) unless intentionally targeting prereleases
   - Ignore downgrades (`current > candidate`) caused by mixed/non-semver tags
   - If GitHub API rate limits (`403`), verify the checker still resolves via tags API / `git ls-remote`
   - **BLIND SPOT**: `check-updates.ts` compares upstream **git tags** only — it does NOT see PGDG
     **packaging-revision** bumps where the upstream tag is unchanged (e.g. pgaudit `18.0-2.pgdg13+1`
     → `18.0-3.pgdg13+1`, tag stays `18.0`). `validate-pgdg-versions.ts` (pre-flight item 4)
     is the **authoritative** PGDG drift detector — it queries apt-madison
     directly. ALWAYS run it in pre-flight and treat any reported version mismatch (including
     pure `-N` revision bumps for unchanged upstream versions) as mandatory update work.

2. **Bun dependencies**:

   ```bash
   bun outdated  # Check what's outdated
   ```

3. **Base image** (every round — see Phase 3):

   ```bash
   bun scripts/validate-base-image-sha.ts --require-latest-minor
   ```

4. **PGDG apt versions** (automated validation):

   ```bash
   # Not `bun run validate`: it skips PGDG while the pins are unchanged since its last pass ("PGDG not contacted")
   bun scripts/extensions/validate-pgdg-versions.ts
   ```

   **CRITICAL**: This checks that every PGDG version in the manifest is what the repository serves now. Any mismatch will cause apt-get install to fail silently during Docker build (due to cache layers), resulting in missing extensions at runtime.

5. **Companion images** — every container image the repo runs or tells operators to run (not in manifest!).
   Enumerate repo-wide, not just `stacks/`: `deployments/` runs its own images (some, e.g. Prometheus and
   Grafana, appear nowhere else), and docs quote image references too:

   ```bash
   # [[:space:]], not \s: git grep -E is POSIX ERE, and on macOS a \s pattern silently matches nothing
   git grep -nE '^[[:space:]]*image:|_IMAGE[:=-]' -- stacks deployments '*.env.example' docs
   ```

   For each repository found, check the latest release (`gh release list --repo ORG/REPO --limit 5`) and
   that every default still resolves (`docker buildx imagetools inspect <ref>`). Update procedure: Phase 5.6.

## Pre-Flight: Additional Checks (MANDATORY)

6. **Test file version strings**: Search test files for hardcoded version strings of extensions being updated:
   ```bash
   # TypeScript test files — search ALL scripts/ subdirs (scripts/test/, scripts/docker/, scripts/config/, etc.)
   command grep -rn -E "0\.8|2\.8|0\.5" scripts/ | command grep -iE "version|include|assert" | command grep -v "\.bun/"
   # Hardcoded PG major in paths breaks on a PG major bump (tool checks read binaryPath/soFileName and pg_config)
   command grep -rn -E "postgresql/[0-9]+/lib" scripts/ | command grep -v "\.bun/"
   ```
   Regression expected outputs hold no version strings (`scripts/test/test-extension-versions.ts` owns versions).
   These WILL break tests if not updated alongside the extension. This is the #1 missed item.

6. **Source→PGDG migration opportunities**: For each source-built extension, check if PGDG now has a package:
   ```bash
   docker run --rm postgres:18-trixie bash -c "apt-get update -qq && apt-cache madison postgresql-18-EXTNAME"
   ```
   If available, migrate to PGDG for faster builds (eliminates source compilation during Docker build).
   If still source-built, verify the upstream build system for the exact new tag before changing the
   manifest. Example: PGroonga 4.0.6 switched from PGXS Makefile to Meson and
   needs `mesonOptions: ["-Dtest=false"]` unless intentionally running upstream tests.

7. **Verify apt version strings**: NEVER assume version strings from memory. Always verify against
   actual apt repos before writing the plan. Use the apt-cache madison command above.
   Note: `pgdg13` in version strings refers to Debian 13 (Trixie), NOT PostgreSQL 13.

8. **Verify Percona/Timescale pinned versions still exist**: Third-party repos drop old versions
   without warning. Always confirm currently pinned versions are still in the apt repo:
   ```bash
   docker run --rm postgres:18-trixie bash -c "
     apt-get update -qq && apt-get install -y -qq curl gnupg2 gpgv lsb-release 2>/dev/null &&
     curl -fsSL https://repo.percona.com/apt/percona-release_latest.generic_all.deb -o /tmp/pr.deb &&
     dpkg -i /tmp/pr.deb 2>/dev/null && percona-release enable ppg-18 release 2>/dev/null &&
     apt-get update -qq 2>/dev/null &&
     apt-cache madison percona-pg-stat-monitor18 percona-postgresql-18-wal2json
   " 2>&1 | command grep -E "percona-pg|percona-postgresql"
   ```
   If a version is gone, update `perconaVersion` in `manifest-data.ts` to the new version
   and regenerate. **Do NOT skip this — a removed version causes a silent build failure.**

   **⚠️ Timescale split packages**: Timescale ships TWO packages for the main extension:
   `timescaledb-2-postgresql-18` (extension SQL+binary) and `timescaledb-2-loader-postgresql-18`
   (preloader). If only the main package is pinned, the loader can jump to a newer version as a
   dependency, causing "no installation script for version X.Y.Z" failures at runtime.
   **The generator now pins the loader automatically** (via regex replacement in `generate-dockerfile.ts`).
   When updating timescaledb, verify both packages exist at the target version:
   ```bash
   apt-cache madison timescaledb-2-postgresql-18 timescaledb-2-loader-postgresql-18
   ```
   Both must show the same `X.Y.Z~debianNN-NNNN` version string.

9. **Pre-plan the changelog obligation** (MANDATORY): if you touch any image-affecting source
   (`scripts/extensions/manifest-data.ts`, `docker/postgres/`, `stacks/*/compose.yml`), you MUST update `CHANGELOG.md` in the
   same update round before Phase 12.

## Phase 1: Review Upstream Changes (CRITICAL FOR TESTS & CHANGELOG)

For EACH extension to update, inspect upstream delta before writing tests or changelog text:

```bash
# Method 1: GitHub releases (PREFERRED — curl | jq is broken via RTK proxy)
gh release view vX.Y.Z --repo OWNER/REPO --json body --jq .body

# Method 2: Latest release (no tag needed)
gh release view --repo OWNER/REPO --json body --jq .body

# Method 3: Upstream CHANGELOG (raw file — still works via curl since RTK only transforms API JSON)
curl -s https://raw.githubusercontent.com/OWNER/REPO/NEW_TAG/CHANGELOG.md | head -100

# Method 4: Compare tags via gh
gh api repos/OWNER/REPO/compare/OLD_TAG...NEW_TAG --jq '.commits[].commit.message'

# Method 5 (MANDATORY for git-ref updates): inspect commit range and touched paths
git clone https://github.com/OWNER/REPO.git /tmp/EXT-REPO
cd /tmp/EXT-REPO
git log --oneline OLD_REF..NEW_REF
git diff --name-status OLD_REF..NEW_REF
```

**⚠️ RTK proxy note**: `curl` to `api.github.com` returns RTK-filtered non-JSON output — `| jq` will fail. Always use `gh` CLI for GitHub API calls.

**MANDATORY evidence discipline**:
- Do not claim "bug fixes", "schema fixes", or "new features" unless the commit range proves it
- For git-ref bumps, summarize what changed by path class (`src/`, `sql/`, docs/CI/release scripts)
- If only CI/docs/release metadata changed, say exactly that in CHANGELOG (no runtime-claim inflation)

**Document findings** — you'll need this for:
- Writing new tests (Phase 6)
- Updating CHANGELOG.md (Phase 9)

## Phase 2: Bun Dependencies

```bash
# Update package dependencies to latest versions
bun update --latest

# Normalize bun.lock root specs back to package.json ranges after --latest resolution
bun install

# If Bun reports blocked lifecycle scripts, inspect them before proceeding.
# Trust only scripts that are expected, necessary, and runnable; otherwise document why blocked is acceptable.
bun pm untrusted

# Validate immediately
bun run validate
```

**⚠️ Linter version jumps**: If oxlint/squawk jumps multiple minor versions, new lint rules may flag
existing code. Run `bun run validate` immediately and fix issues before proceeding. Do NOT blindly
disable new rules — evaluate each one. If a rule is a false positive, suppress only that specific
rule with a comment; if legitimate, fix the code.

**⚠️ OSV security scanner blocks install (no-TTY)**: the project pins `@bun-security-scanner/osv` in
`bunfig.toml [install.security]`. When a newly-disclosed CVE lands on a (often transitive) dependency,
`bun install`/`bun update` aborts with "Security warnings found. Cannot prompt for confirmation (no TTY)"
and changes NOTHING (atomic — working tree stays clean). Do NOT bypass the scanner. The correct fix is
to force the affected package to a patched version via a package.json `overrides` block, then re-install:
```jsonc
"overrides": { "ws": "^8.20.1", "uuid": "^14.0.0" }  // pin transitive deps to patched versions
```
Look up the fixed version (the advisory states it), prefer the latest compatible line, and VERIFY the
override did not break the dependent — run its tests (e.g. `bun test scripts/pgflow/schema-fixture.test.ts`
for @pgflow-tree deps) plus `bun run validate`. These dev/test-only deps are absent from the final image
(no Bun, no node_modules), so the CHANGELOG note belongs under Development, not a user-facing section.

**⚠️ ALWAYS check Bun runtime version separately** — `bun update` bumps package dependencies (incl.
`@types/bun`) but does NOT update the Bun runtime pinned in `.tool-versions`. These are independent:

```bash
# Check current pinned runtime version vs latest stable
cat .tool-versions | command grep bun          # e.g. "bun 1.3.10"
gh release view --repo oven-sh/bun --json tagName --jq .tagName  # e.g. "bun-v1.3.11"
# NOTE: `bun upgrade` has no --dry-run flag — it upgrades immediately; do NOT run it
```

If a new stable runtime is available, update `.tool-versions` manually:
```bash
# Edit .tool-versions: bump bun X.Y.Z to latest stable
```

Note: `@types/bun` may lag the runtime release. That is expected.
Keep `.tool-versions` and `@types/bun` approximately in sync but they need not be identical.

**TypeScript major bumps**: TypeScript 7+ is the native (Go) compiler, shipped as per-platform
`@typescript/typescript-<os>-<arch>` packages; `import "typescript"` now yields only the version (the
old compiler API is gone; a different one sits under `typescript/unstable/*`). Before accepting
a major bump: `rg -n "from ['\"]typescript['\"]"` must find no programmatic users (this repo only
runs the `tsc` CLI); `bun.lock` must list the `linux-x64` and `linux-arm64` packages (CI runners);
compare `tsc --noEmit --listFilesOnly` file sets between old and new (same project files); and plant
a type error in a scratch `scripts/*.ts` file to prove the new `tsc` exits 1 on it. A fast green
proves nothing until the plant fails.

## Phase 2.5: GitHub Actions Pins

GitHub Actions use SHA-pinned `uses:` references for security. Run `actions-up` to bump all SHAs
to the latest verified commit for each action's current tag.

```bash
# Update all GitHub Actions SHA pins to latest
actions-up --yes
```

This updates the `uses:` SHA in every workflow and composite action. It will report how many
actions were updated and how many were **breaking** (major version bumps).

### MANDATORY: Identify and Audit Breaking Changes

`actions-up` reports breaking changes (major version jumps) separately. **These require manual
review** — do NOT blindly accept without checking each one.

**For every major-version bump** (e.g., `actions/upload-artifact` bumping a major version):

1. Fetch the upstream release notes (RTK proxy breaks `curl | jq` — use `gh` instead):
   ```bash
   # PREFERRED — works reliably via RTK proxy
   gh release view vN.0.0 --repo OWNER/REPO --json body --jq .body
   # Or fetch raw RELEASES.md (curl of raw content works fine — RTK only transforms API JSON):
   curl -s https://raw.githubusercontent.com/OWNER/REPO/main/RELEASES.md | head -80
   ```

2. Check for each category of breaking change:
   - **Renamed or removed inputs**: does your workflow pass an input that no longer exists?
   - **Renamed or removed outputs**: does a subsequent step reference `steps.X.outputs.Y`?
   - **Behaviour changes** (silent→loud defaults): new defaults may turn previously-tolerated
     warnings into hard failures — this is the most dangerous category
   - **New required inputs**: does the action now require a parameter you haven't set?
   - **Runner version requirements**: Node.js runtime version bump = new minimum runner version;
     self-hosted runners below the threshold will fail with "nodeXX not found" (check release notes
     for the minimum runner version required by the action's Node.js release)

3. Fix any incompatible usages before committing.

### Known Breaking Patterns for Common Actions

| Action | Typical major-version changes | What to verify |
|--------|------------------------------|----------------|
| `actions/upload-artifact` | Node.js runtime bump; additive params | Generally safe; check release notes for new required inputs or default changes |
| `actions/download-artifact` | Default strictness changes (hash-mismatch handling); new inputs | Check if workflow relied on lenient defaults (e.g., silent mismatch tolerance) |
| `sigstore/cosign-installer` | Cosign bundle format compatibility; default cosign version bump | If you pin `cosign-release:`, verify pinned version still installs; check CLI compat |
| `actions/attest-build-provenance` | Node.js runtime bump; new optional inputs (additive) | Check runner version requirement in release notes; new additive inputs are safe if not referenced |
| `actions/checkout` | Credentials storage location can change | Breaks scripts parsing `.git/config` directly; normal git usage unaffected |
| `actions/cache` | Input removals/renames (e.g., `save-always` was removed) | Grep all `cache:` steps for removed/renamed inputs; use `cache-hit` output pattern |
| `docker/login-action` | Has historically been runtime-only (no interface changes) | For self-hosted runners: check Node.js runtime requirement in release notes |
| `docker/setup-qemu-action` | Has historically been runtime-only (no interface changes) | Same pattern as docker/login-action; GitHub-hosted runners always qualify |

### MANDATORY: Audit for Stale Prose Version Comments

**`actions-up` updates the SHA AND the `# vX.Y.Z` tag on each `uses:` line, but does NOT update
version references in prose comments elsewhere in the file** (e.g., a comment in a `run:` step
or a description block that mentions an old version like `# Uses upload-artifact v6`).

After running `actions-up`, scan ALL workflow and composite action files for stale prose comments:

```bash
# Find prose version references that may be stale (distinct from the uses: line comments)
command grep -rn "@v[0-9]" .github/workflows/ .github/actions/ | command grep "#"
```

Cross-reference each result against the `# vX.Y.Z` tag on the corresponding `uses:` line.
Update any prose comment that references an old version. This is easy to miss and creates
actively misleading documentation.

### MANDATORY: Fix Branch-Pinned Reusable Workflow Refs

**`actions-up` has a critical blind spot**: it cannot SHA-pin job-level `uses:` refs for reusable
workflows (`uses: ORG/REPO/.github/workflows/FILE.yml@main`). It reports them as
"Skipped N actions pinned to branches" and `--include-branches` does NOT fix them either —
it only applies to step-level action refs.

After `actions-up`, manually check for any remaining branch-pinned reusable workflow calls:

```bash
# Find all job-level uses: with branch refs (not SHA-pinned)
command grep -rn "uses:.*\.yml@[a-zA-Z]" .github/workflows/ | command grep -v "@[0-9a-f]\{40\}"
```

For each found: get the current HEAD SHA and pin it:

```bash
# Get current HEAD SHA of the branch
git ls-remote https://github.com/ORG/REPO.git refs/heads/BRANCH

# Then update the workflow file:
# uses: ORG/REPO/.github/workflows/FILE.yml@BRANCH
# →
# uses: ORG/REPO/.github/workflows/FILE.yml@SHA # BRANCH
```

This is especially important for reusable workflows with broad permissions (`contents: write`,
`packages: write`, etc.) — a compromised upstream branch would get those permissions on the
next manual or scheduled invocation.

### MANDATORY: Pin Container Images in Workflow Shell Steps

`actions-up` only updates `uses:` refs. It does not see Docker images embedded in `run:` blocks.
After action updates, scan workflow/composite scripts for mutable images and pin them:

```bash
command grep -rn -E ":[Ll]atest\\b" .github/workflows/ .github/actions/ scripts/ | command grep -E "docker run|image"
```

For security scanners, prefer the same pinned container used by local tooling (for example,
`scripts/security-scan.ts`) so CI diagnostics and local scans use the same scanner family.

Tool images run by scripts (hadolint, actionlint, yamllint, trivy) are invisible to `actions-up` and
`bun outdated`, so bump them here. List them:

```bash
rg -n '"[a-z0-9./_-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}"' scripts .github   # digest pins
rg -n 'aquasec/trivy:' scripts .github                                             # trivy is tag-pinned in several places
```

For each, read the latest release, resolve the index digest with `docker buildx imagetools inspect`,
replace the reference everywhere it appears, and run the check that uses it (`bun run validate:all`
runs hadolint, actionlint and yamllint).

**Validate after actions-up**:
```bash
bun run validate:all  # catches yamllint, hadolint, workflow syntax issues
```

## Phase 3: Base Image (ALWAYS CHECK — Security Patches!)

PG minor releases include security patches (CVEs). ALWAYS check for a newer base image, even when
not upgrading PG major version. Minor releases can fix critical CVEs (e.g., CVSS 8.8).

**⚠️ Stale digest even at an unchanged PG minor**: the `postgres:18.X-trixie` tag is periodically
re-pushed with Debian security rebuilds, so the tag moves to a new digest while `pgVersion` is still
correct; the old digest stays pullable, so nothing fails until a check compares them. ALWAYS run
`bun scripts/validate-base-image-sha.ts --require-latest-minor` in pre-flight — it fails when the tag
has moved past the pin AND when a newer minor exists. If it fails, repin `baseImageSha` to the tag's
current index digest (a security refresh; no `pgVersion` change needed and no separate CHANGELOG line
if the existing PG-minor entry already covers it).

```bash
# Index digest of the tag, read from the registry without downloading layers.
# Pin THIS digest (the multi-platform index), never a per-platform one from docker inspect/pull.
docker buildx imagetools inspect postgres:18.X-trixie --format '{{json .Manifest.Digest}}'

# Update MANIFEST_METADATA in manifest-data.ts: pgVersion "18.X", baseImageSha "sha256:..."
# (just the digest, no image name prefix), then: bun run generate
```

**⚠️ New security settings in PG minors**: a minor release can add a setting whose default refuses
something the image ships. PostgreSQL 18.6 added `output_plugin_libraries`, refusing (superusers
included) any logical-decoding plugin not listed, which would have broken the shipped wal2json. On every
minor bump, read the release notes' new settings and their defaults. When adding or renaming a logical
decoding plugin, add it to the `POSTGRES_OUTPUT_PLUGIN_LIBRARIES` default in
`docker/postgres/docker-auto-config-entrypoint.sh.template` and `docs/ENVIRONMENT-VARIABLES.md`.

**Probing amd64 from an arm64 host**: run the amd64 variant by its platform digest so the local
arm64 copy of the same tag is neither used nor replaced:

```bash
D=$(docker buildx imagetools inspect postgres:18.X-trixie --format '{{json .Manifest}}' \
  | bun -e 'const j = JSON.parse(await Bun.stdin.text()); console.log(j.manifests.find((m) => m.platform?.os === "linux" && m.platform?.architecture === "amd64").digest)')
docker run --rm --platform linux/amd64 "postgres@$D" postgres --version
```

Rosetta (Docker Desktop/OrbStack on Apple silicon) runs amd64 images but cannot choose a CPU model,
and its `/proc/cpuinfo` lists no `avx`/`avx2` flags, so a Rosetta run says nothing about a specific x86
CPU. To prove a binary runs on an older or newer CPU, use QEMU user mode with `-cpu Nehalem` / `-cpu
Haswell` (vectorscale procedure: docs/VERSION-MANAGEMENT.md Procedure 5). QEMU user mode cannot run
`initdb` or a full server (they start `postgres` child processes, which leave QEMU without binfmt
registration), so: export the amd64 image's filesystem, `initdb` under Rosetta, then in an arm64
`debian:trixie-slim` container with `qemu-user` run `qemu-x86_64 -cpu Nehalem -L <rootfs>
<rootfs>/usr/lib/postgresql/<major>/bin/postgres --single -D <pgdata> postgres` and feed it SQL on stdin.

**⚠️ TimescaleDB coupling**: timescaleVersion suffix encodes PG minor version (e.g., `-1803` for
PG 18.3, `-1804` for PG 18.4). When bumping PG minor version, ALWAYS update timescaleVersion in the
same commit. **The reverse also bites**: the suffix can silently LAG the base PG-minor (e.g. base
already at 18.4 while timescaleVersion is still `~debian13-1803`); a Timescale bump that moves to
`-1804` realigns it — check for this drift even when the PG minor is unchanged. Also, Timescale's apt
repo may not carry the newest upstream git tag yet (e.g. `2.27.2` released on GitHub but apt only has
`2.27.1`); apt is the ceiling for `install_via: "timescale"` — verify both the extension AND loader
packages exist at the target `X.Y.Z~debianNN-NNNN` via `apt-cache madison` before pinning.

**⚠️ PG MAJOR version bump** (18→19): additional files need updating beyond manifest-data.ts:
- Tool checks need no edit: `testToolsPresent` finds each tool by its manifest entry's `binaryPath`/`soFileName` and takes PG-major paths from `pg_config`; still grep `scripts/` for hardcoded `postgresql/[0-9]+/` paths
- pgrx feature flags in manifest-data.ts (e.g., `features: ["pg18"]` → `features: ["pg19"]`)
- TimescaleDB version suffix (e.g., `-1803` → `-1900`)
- All `pgdgVersion` strings that contain the PG major version
- All `pgdg13+N` suffixes stay unchanged (that's the Debian version, not PG version)

## Phase 4: Extensions (BY SOURCE TYPE)

**CRITICAL**: Update in dependency order (dependencies BEFORE dependents).

### Dependency Graph

**Extract from manifest**: `command grep 'dependencies:' scripts/extensions/manifest-data.ts -B 2 | command grep 'name:'`

Extensions with `dependencies: ["extension1", "extension2"]` field must be updated AFTER their dependencies.

**Example**: If extension B has `dependencies: ["extensionA"]`, update extensionA first, verify compatibility, then update B.

### ⚠️ CRITICAL: Dependency Compatibility

**BEFORE updating any extension that has dependents, verify compatibility:**

```bash
# Find dependents
command grep -B 30 "dependencies:.*EXTENSION_NAME" scripts/extensions/manifest-data.ts | command grep 'name:'

# Check compatibility:
# - Read dependent's Cargo.toml / package.json for version constraints
# - Check dependent's changelog/releases for breaking changes
# - Major version changes often break dependents

# Test after update
bun run generate
bun run build  # Fails if ABI incompatible
bun run test:all  # Verify runtime compatibility
```

**Common dependency chains:**
- `pgvector` → vectorscale
- `pgsodium` → supabase_vault
- `pgmq/pg_net/pg_cron/supabase_vault` → pgflow
- `hypopg` → index_advisor
- `postgis` → pgrouting
- `timescaledb` → timescaledb_toolkit

**If incompatible**: Skip update OR update both together in single commit.

### PGDG Extensions

**Identify**: `command grep 'install_via: "pgdg"' scripts/extensions/manifest-data.ts`

Switching between PGDG and source build is a one-entry edit in `scripts/extensions/manifest-data.ts`:
`install_via`, `pgdgVersion` + `pgdgPackage` (apt suffix: `postgresql-18-<pgdgPackage>`), and `build`.
Nothing else lists PGDG extensions; the generator and `validate-pgdg-versions.ts` read the entry.

**Proactively hunt promotions** (user often asks for this): for EVERY source-built extension, check
`apt-cache search postgresql-18 | grep -iE 'EXTNAME'` — a hit at our pinned version is a promotion
opportunity (faster builds, official packages). Re-run the search to confirm empty results are real,
not a transient apt glitch. Stale manifest notes like "PGDG package not available for PG18" are prime
suspects — verify and migrate.

**Source → PGDG migration** (extension now has PGDG package):
- Remove `install_via: "source"`, add `install_via: "pgdg"` and `pgdgVersion`
- Remove `build: { type: "pgxs" }` (cosmetic — the generator already excludes any `install_via: "pgdg"`
  entry from source builds via the `install_via !== "pgdg"` guard — but removing it makes intent honest)
- Add `pgdgPackage` (the apt name suffix — `apt-cache search --names-only '^postgresql-18-'`)
- **VERIFY THE PACKAGE before trusting the migration**: `apt-get install` it in a throwaway container, then
  `dpkg -L postgresql-18-EXTNAME | grep '\.so$'` to confirm it ships the expected libs — ESPECIALLY any
  preload worker (e.g. pg_partman ships `pg_partman_bgw.so` at `/usr/lib/postgresql/18/lib/`). Set the
  entry's `soFileName` to the module's `.so`: the generated Dockerfile asserts it exists, and `generate`
  fails for an enabled PGDG module entry without one.
  Also `grep default_version EXTNAME.control`: `scripts/test/test-extension-versions.ts` fails when it
  leaves the MAJOR.MINOR line the manifest entry pins.
- **PGDG may lag upstream**: the apt package can sit a release behind the latest git tag (e.g. plpgsql_check
  upstream `v2.9.1` but PGDG only `2.9.0`). For `install_via: "pgdg"` the **`pgdgVersion` is authoritative** —
  set `source.tag` to match the PGDG-available version, not the newest upstream tag.

Update BOTH `source.tag` AND `pgdgVersion`:

```typescript
{
  name: "extension_name",
  source: { type: "git", tag: "vX.Y.Z" },        // ← Update tag
  pgdgVersion: "X.Y.Z-N.pgdg13+N",               // ← Update version string
}
```

**PGDG version format**: `{version}-{build}.pgdg{debian_ver}+{revision}`
- Example: `0.8.1-2.pgdg13+1`
- The `pgdg13` refers to Debian version (13=Trixie), NOT PostgreSQL!
- Check available versions: `docker run --rm postgres:18-trixie bash -c "apt-get update -qq && apt-cache madison postgresql-18-EXTNAME"`

### Percona Extensions

**Identify**: `command grep 'install_via: "percona"' scripts/extensions/manifest-data.ts`

Update BOTH `source.tag` AND `perconaVersion`:

```typescript
{
  name: "extension_name",
  source: { type: "git", tag: "X.Y.Z" },          // ← Update tag
  perconaVersion: "[epoch:]X.Y.Z-N.trixie",       // ← Note optional epoch prefix!
}
```

**Percona version format**: `[epoch:]version-build.distro`
- Epochs matter for version comparison: `1:2.0` > `2.0`
- Example: `1:2.3.1-2.trixie`
- Check available versions: Requires container with `percona-release setup ppg-18`

### Timescale Extensions

**Identify**: `command grep 'install_via: "timescale"' scripts/extensions/manifest-data.ts`

Update BOTH `source.tag` AND `timescaleVersion`:

```typescript
{
  name: "extension_name",
  source: { type: "git", tag: "X.Y.Z" },          // ← Update tag
  timescaleVersion: "X.Y.Z~debian13-PGMM",        // ← Note tilde format!
}
```

**Timescale version format**: `version~distro-pgversion`
- Example: `2.24.0~debian13-1801` (1801 = PostgreSQL 18.1)
- Check available versions: Requires container with Timescale repo configured

### Patched Source Extensions (`build.patches`)

**Identify**: `command grep -n "patches: \[" scripts/extensions/manifest-data.ts`

A bump can stop the build with `Patch <file> no longer applies`: refresh the diff in `docker/postgres/patches/` against the new tag (vectorscale: docs/VERSION-MANAGEMENT.md Procedure 5, including the non-AVX2 CPU proof).

### Source-Built Extensions

**Identify**: Extensions with `build:` field (no `install_via`, or `install_via` with `build:`)
- `command grep -B 5 'build:' scripts/extensions/manifest-data.ts | command grep 'name:'`

Update ONLY `source.tag`:

```typescript
{
  name: "extension_name",
  source: { type: "git", tag: "vX.Y.Z" },         // ← Only this field
}
```

**These extensions are built from source** during Docker image build using PGXS, cargo-pgrx, cmake, autotools, or other build systems.

**Commit lock**: `docker/postgres/extensions.manifest.json` is the lock file for tags, as `bun.lock` is
for `package.json`. `bun run generate` resolves a tag to its commit only when the entry's repository or
tag changes, and the build clones that commit. So a tag that upstream moved after you pinned it changes
nothing until you edit the tag; to pick up a re-pushed tag, delete that entry's `commit` line from the
generated manifest and regenerate. Review the `commit` diff of every tag you bump (annotated tags:
`git ls-remote URL 'refs/tags/TAG^{}'` gives the commit).

**Portable, optimised builds** (`docker/postgres/build-extensions.ts`): a PGXS build stops when its
`make -n` plan contains `-march/-mtune/-mcpu=native` (ties the binary to the build host's CPU: SIGILL on
older hosts, invisible to every test on the runner) or compiles with `-O0` as the last `-O`. A bump that
trips either names the Makefile variable to clear: native flags in `PORTABLE_PGXS`, `-O0` with
`build.makeOptions` on the manifest entry. Never bypass the check.

**Source libraries** (`SOURCE_LIBRARIES` in `manifest-data.ts`, e.g. libsodium): built once into
`/usr/local` and linked by every extension that lists them in `sourceLibraries`; their security updates
are ours, not Debian's. To bump: download the release tarball, verify it with the command in the
entry's `notes` (minisign with the upstream public key), then set `asset`, `sha256` (of the verified
tarball) and `source.tag` together. Never take a sha256 from anywhere but the verified file.

### Builtin Extensions

**Identify**: `command grep 'kind: "builtin"' scripts/extensions/manifest-data.ts`

**No manual updates required** - Builtin extensions are part of PostgreSQL core and update automatically with the base image (Phase 3).

These only need updates when PostgreSQL version changes.

## Phase 5: Special Extensions

**IMPORTANT**: When updating any extension, check for local patches/compatibility layers in `docker/postgres/`:
- Search for files: `find docker/postgres -name "*EXTENSION_NAME*patch*" -o -name "*EXTENSION_NAME*stub*" -o -name "*EXTENSION_NAME*compat*"`
- Review init scripts: `command grep -r "EXTENSION_NAME" docker/postgres/docker-entrypoint-initdb.d/`
- Verify patches still apply with new version or if upstream fixed them

### 5.1: pgflow

The version is written once: the pgflow entry's tag (`pgflow@X.Y.Z`) in `manifest-data.ts`;
`scripts/pgflow/generate-schema.ts` writes it into the schema fixture, and `scripts/pgflow/schema-fixture.test.ts`
(in `validate`) fails when the fixture's version differs from the manifest's.

```bash
# 1. Edit the pgflow tag in manifest-data.ts, then regenerate the schema fixture and upgrade bundle
#    (tests/fixtures/pgflow/schema.sql + upgrade/: migrations, versions.tsv, aza-overrides.sql)
bun scripts/pgflow/generate-schema.ts
# 2. Client pins must equal the tag (scripts/pgflow/version.test.ts checks them in validate)
bun add --dev @pgflow/client@X.Y.Z @pgflow/dsl@X.Y.Z
# 3. Regenerate, then prove fresh installs AND upgrades of existing databases
bun run generate
bun test scripts/pgflow/
bun run build                              # the image COPYs schema.sql and upgrade/; suites test the image
bun scripts/test-all.ts --group features   # includes test-pgflow*.ts and test-pgflow-upgrade.ts
```

Review the local layers against the new upstream: `docker/postgres/pgflow/security-patches.sql` and the
functions the generator overrides (aza-overrides). The generator stops when an expected upstream text
is missing (`replaceRequired`); fix the replacement, never loosen it. `test-pgflow-upgrade.ts` upgrades a
database created by the last release in its `LEGACY` list with `pgflow-upgrade` and requires it to equal
a fresh install: if it fails, the new migrations or overrides break existing databases. A release whose schema changes
needs a CHANGELOG entry telling operators to run `docker exec <container> pgflow-upgrade` (stop pgflow
workers first; upgrade the database before deploying the new `@pgflow/client`).

### 5.2: git-ref Extensions (HEAD Drift Verification REQUIRED)

**Identify**: `command grep 'type: "git-ref"' scripts/extensions/manifest-data.ts -B 2 | command grep 'name:'`

These use commit SHAs (no version tags). Verification is mandatory:

```bash
# Primary check (must be zero for enabled extensions before closing round)
bun scripts/extensions/check-updates.ts --format=json | jq -r '
  .[] | select(.sourceType=="git-ref" and .enabled==true and .updateAvailable==true) |
  "\(.name): \(.current) -> \(.latest)"'

# Check if upstream now has stable tags
git ls-remote --tags https://github.com/OWNER/REPO | tail -20

# If tags exist: migrate from git-ref to git type
# Change: type: "git-ref", ref: "..."
# To:     type: "git", tag: "vX.Y.Z"

# If no tags: verify newer commit is PG18-compatible
# Check: CI status, changelog mentions, no breaking changes
gh api repos/OWNER/REPO/commits/COMMIT_REF/status
```

Any non-empty output from the `jq` command above is actionable work, not an informational note.

### 5.3: cargo-pgrx Extensions (Rust Version Alignment)

**Identify**: `command grep 'type: "cargo-pgrx"' scripts/extensions/manifest-data.ts -B 5 | command grep 'name:'`

These extensions use Rust pgrx framework for building PostgreSQL extensions in Rust.

**Version alignment**:
1. Check pgrx version required for current PostgreSQL major version (search `docker/postgres/build-extensions.ts` for pgrx fallback version)
2. Verify minimum Rust version (usually documented in extension's README)
3. Ensure feature flags match PostgreSQL version (e.g., `features: ["pg18"]` for PG18)

**If pgrx version changes**: Update hardcoded fallback in `docker/postgres/build-extensions.ts` (search for `getPgrxVersion` fallback).

### 5.4: Disabling Unmaintained Extensions

If an extension becomes incompatible (like `pg_plan_filter`):

```typescript
{
  name: "pg_plan_filter",
  enabled: false,
  disabledReason: "Not compatible with PostgreSQL 18. Last updated for PG13 (2021). Maintainer inactive.",
}
```

**Also remove from `scripts/config/size-baselines.json`** if the extension is listed there.
A disabled extension can never be size-checked (no Docker image runs it), so keeping its entry
creates false confidence that it's being validated. The `postgis` incident: it was disabled AND
had the wrong `.so` filename — the dead entry went unnoticed until an explicit audit.

### 5.5: Updating Disabled Extensions

**Identify**: `command grep 'enabled: false' scripts/extensions/manifest-data.ts -B 2 | command grep 'name:'`

**Principle**: Update disabled extensions if they're still tested or might be re-enabled. Skip if permanently incompatible.

Extensions still in test suites should stay current. Permanently broken extensions can be skipped.

### 5.6: Compose Stack Images (Outside Manifest)

**Not in manifest-data.ts.** A companion image (pgbouncer, the exporters) has ONE pin: the
`${VAR:-repo:tag@sha256:…}` default in `stacks/*/compose.yml`. `bun run validate` ("Companion Image
Pins", `scripts/validate/companion-image-pins.ts`) requires every other mention of that repository —
`.env.example` files, `docs/`, `scripts/test/`, `deployments/`, this file — to carry the same
`tag@digest`, and lists each drifted `file:line`. So: edit the compose defaults, run validate, fix
what it lists.

Images that appear only outside `stacks/` (e.g. `deployments/` Prometheus/Grafana, or a different
pgbouncer repository there) have no compose pin, so the check cannot see them: update and pin them by
hand, each with `tag@digest`.

```bash
# Index digest for a new tag (no layers downloaded)
docker buildx imagetools inspect ORG/REPO:TAG --format '{{json .Manifest.Digest}}'
```

**Per image**:
1. Read the release notes from the current tag to the new one for removed or renamed flags, env vars
   and metrics. postgres-exporter 0.20 is the pattern: `PG_EXPORTER_DISABLE_SETTINGS_METRICS` was
   removed (the exporter ignores unknown env vars, so a dead setting stays silent) and
   `pg_replication_slot_*` metrics became `pg_replication_slots_*`. Confirm each env var the stacks set
   against the new binary's own flag list (`docker run --rm IMAGE --help`), with a definitely-invalid flag
   as control. Rename users of changed metrics (dashboards and queries in `deployments/`).
2. Update the compose defaults; run `bun run validate` until the pin check is clean.
3. CHANGELOG entry (operators see companion images); removed settings or renamed metrics go under Breaking.
4. Run the stack suites (`bun scripts/test-all.ts --group stacks`); each exporter's `/metrics` must show
   `pg_up 1` / `pgbouncer_up 1`.

## Phase 6: Add Tests for New Functionality

### MANDATORY Pre-Test Checks

Before writing tests, search for hardcoded version strings in ALL test files:

```bash
# Find hardcoded version strings in ALL scripts/ subdirs (scripts/test/, scripts/docker/, scripts/config/, etc.)
command grep -rn -E 'includes\("0\.|includes\("1\.|includes\("2\.' scripts/ | command grep -v "\.bun/"
# Also search for specific old version patterns:
command grep -rn -E "0\.8|0\.5|2\.8|1\.10|5\.4" scripts/ | command grep -v "\.bun/" | command grep -iE "include|assert|version"
# Hardcoded PG major in paths breaks on a PG major bump (tool checks read binaryPath/soFileName and pg_config)
command grep -rn -E "postgresql/[0-9]+/lib" scripts/ | command grep -v "\.bun/"
```

These WILL break tests if not updated alongside the extension — this is the #1 missed item in
update rounds. Update any hardcoded version strings before running the test suite.

For each extension with new features (from Phase 1 release notes): plan specific tests.
New APIs, behavior changes — all need test coverage. **ALWAYS verify the actual SQL API** by
reading the extension's SQL files or docs before writing tests — planned API signatures are
frequently wrong (extension may use different function names than expected).

**REQUIRED** when upstream has breaking changes or significant new features.

### Test Creation Criteria

- **API signature changed** → Add test verifying new signature works
- **Behavior changed** → Add test verifying new behavior
- **New feature added** → Add test if relevant to our use case
- **Breaking change** → Update existing tests to match new behavior

### Where Tests Live

Docker suites are `scripts/**/test-*.ts` files listed in `SUITES` in `scripts/test-all.ts`, each with a
group (`extensions`, `security`, `stacks`, `features`, `regression`, `nightly`); CI runs each group as
one job. A new suite must be added to `SUITES` (`bun run validate` fails naming any unregistered one).
Extension behaviour belongs in the suite of group `extensions` that already owns the extension: `rg`
the extension name in `scripts/` first. Run one group with
`bun scripts/test-all.ts --group <group> [--image <ref>]`.

## Phase 7: Regenerate & Validate

```bash
# Regenerate all files from manifest
bun run generate

# Fast validation: static checks + unit tests; runs without Docker
bun run validate

# MANDATORY full validation: + shellcheck, hadolint (pinned Docker image), yamllint
bun run validate:all
```

**Both must pass before any commit.** `bun run validate:all` catches shell script errors (shellcheck), Dockerfile issues (hadolint), and YAML syntax (yamllint) without building the image. Skipping `validate:all` in favour of just `validate` is NOT acceptable.

## Phase 8: Build & Test (Intermediate Check)

```bash
# Build, validate:all, then every registered suite against the new image (exit 1 on any failure)
bun run test:all
# Already built? Only the suites: bun run test
```

**IMPORTANT**: This is an intermediate check — NOT the final gate. Phases 9–11 add more commits
(CHANGELOG, skill update). **Phase 12 is the mandatory final gate** after all commits are done.

**Multi-arch verification**: Image builds for both amd64 and arm64 are verified in GitHub Actions after the user pushes changes. Agents should ensure local tests pass before committing.

**NOTE**: `bun run test` (quick test) exists but should NOT be used for updates — always run full
`test:all` to verify comprehensive compatibility. Build success alone is NOT sufficient: a broken
image can build cleanly if `set -e` is bypassed by `|| true` patterns.

### Build Failure Troubleshooting

**Build errors name the failing extension and error type.**

Common causes:
- Missing build dependencies → Add to `build.aptPackages` in manifest
- Version incompatibility → Update pgrx fallback or disable extension
- ABI break → Disable extension with `disabledReason`

Resolution options:
1. Fix (add missing deps, update versions) → regenerate → rebuild
2. Disable extension (set `enabled: false` + `disabledReason`)
3. Patch build (add `build.patches` for sed fixes)

## Phase 9: Update CHANGELOG.md (Image Consumer Focus)

**MANDATORY GATE**: If this round changed any image-affecting files, `CHANGELOG.md` must be
updated before proceeding to Phase 10/12. No exceptions.

**Rules**:
1. **User-facing changes**: Full detail with migration guidance
2. **Breaking changes**: Separate section with "action required" flag
3. **Development (non-image) changes**: One line max, or omit if trivial

**Standard categories** (in impact order): `Breaking` | `Security` | `Fixed` | `Changed` | `Added` | `Deprecated` | `Removed` | `Development`. Do not invent categories beyond this set.

**Format**:

```markdown
## [Unreleased]

### Breaking (action required)
- **pgflow 0.13.0**: Handler signature changed - root steps now receive `(flowInput, ctx)` instead of `(input)`. Update your handler functions.

### Security
- **pg_partman**: Patched CVE-XXXX-YYYY (privilege escalation via search_path in run_maintenance())

### Fixed
- **pg_cron**: Fixed scheduled jobs failing silently when pg_cron.max_running_jobs limit was reached

### Changed (user-facing)
- **pgvector 0.8.1 → 0.9.0**: New HNSW parameters (ef_search default changed from 40 to 100)
- **TimescaleDB 2.24.0**: 4-5× faster recompression

### Added
- New extension: xyz with feature ABC

### Development (non-image)
- Updated pgrx to 0.16.1, Rust to 1.88.0
```

## Phase 9.5: Mandatory Adversarial Self-Audit (BEFORE EVERY COMMIT — NO EXCEPTIONS)

**This is a MANDATORY GATE before every commit — not a suggestion, not "when time permits", not something to do when the user asks.** If you are about to call `git commit`, stop and run through this checklist first. Adversarially assume you missed something.

**Pre-commit mechanical checklist** (run these commands, check the output):
```bash
# 1. Verify CHANGELOG gating
git diff --name-only -- scripts/extensions/manifest-data.ts docker/postgres stacks
# If non-empty → must also show: git diff --name-only -- CHANGELOG.md (non-empty)

# 2. Verify no stale version strings in tests
command grep -rn -E 'includes\(|startsWith\(' scripts/ | command grep -E '[0-9]+\.[0-9]' | command grep -v "\.bun/"

# 3. Companion image pins propagated: covered by validate ("Companion Image Pins"), step 5

# 4. Verify no branch-pinned reusable workflow refs remain
command grep -rn "uses:.*\.yml@[a-zA-Z]" .github/workflows/ | command grep -v "@[0-9a-f]\{40\}"
# (non-empty output = action required)

# 5. Verify validate:all passes
bun run validate:all

```

**Then review these qualitative questions** — try to break your own work:

**Tests**
- Do any new tests pass trivially regardless of the fix they claim to cover?
  (e.g., EXPLAIN test on a tiny table uses SeqScan → never touches the HNSW-specific code path)
- Does the test actually force the execution path it claims to verify?
  Query planner optimisations, small row counts, or default settings can silently bypass the exact
  code path being tested. Add session-level forcing (e.g. `SET enable_seqscan = OFF`) or sufficient
  data volume to guarantee the expected path is taken.
- Does the test verify the actual bug mode, or just that no crash occurred?
- Did secret scanning run on changed scripts, and did it flag false positives from ambiguous names
  (`token`, `secret`, `password`) used as ordinary local variables? Prefer explicit non-secret names
  (`versionChunk`, `authHeader`) and re-run `bun run test:all`.

**File completeness**
- When touching a file that documents required changes (README, validator error messages,
  skill files): do the instructions in that file still work? Are any file references stale?
- When touching any validator: do its own fix instructions actually fix the error it reports?
  Validators with inline copies of data must point users to update BOTH the canonical file
  AND the validator's own inline copy.
- Are all tooling version files in sync? (`.tool-versions`, `package.json`, lock files)

**Version strings and URLs**
- Every URL, version string, and file path you wrote or modified — verify it, don't assume.
  GitHub repository transfers happen; org names change. Check the actual URL before "fixing" it.

**What you didn't look at**
- List files that are related to your changes but that you haven't read. Read them now.
- Specifically: auto-generated files (`Dockerfile`, `docs/EXTENSIONS.md`) — did they regenerate correctly?

**Mandatory doc sync** (NOT auto-generated — must be updated manually every round):
- **`CHANGELOG.md` gate**: If `git diff --name-only -- scripts/extensions/manifest-data.ts docker/postgres stacks` is non-empty, `git diff --name-only -- CHANGELOG.md` MUST also be non-empty before Phase 12.
- **Check for orphaned test files**: When migrating an extension's install method, search for
  dedicated test files (`test-EXT-NAME-*.ts`) that may now be stale (wrong version assertions,
  wrong install path descriptions). Delete or migrate their valuable tests.
- **`scripts/test/test-timescaledb-tsl.ts`** (suite group `extensions`): compresses chunks and refreshes a
  continuous aggregate over them; update it when a TimescaleDB release changes those APIs.
- **Tools**: `testToolsPresent` finds each enabled tool by its manifest entry's `binaryPath` or `soFileName`,
  so a new or moved tool is an edit to that entry. Find hardcoded PG-major paths anyway:
  `command grep -rn -E "postgresql/[0-9]+/lib" scripts/ | command grep -v "\.bun/"`
- **Search all test files for hardcoded version strings** that would fail after the update:
  `command grep -rn -E 'includes|startsWith|=== "' scripts/ | command grep -E '[0-9]+\.[0-9]' | command grep -v "\.bun/"`
- **Size baselines after updating any tracked extension**: After updating any extension listed in
  `scripts/config/size-baselines.json` (timescaledb, pgroonga, pg_jsonschema, wrappers,
  vectorscale, etc.), run the size regression check. Advisory warnings indicate a stale baseline:
  ```bash
  bun scripts/check-size-regression.ts  # requires a built image; run bun run build first if needed
  ```
  If advisory warnings appear for an extension you just updated, update `scripts/config/size-baselines.json`
  with the new observed range (keep ~10-20% headroom above measured size for the `max`).

**The question to answer**: "If the user ran an adversarial audit on what I just did,
what would they find?" Find it yourself first.

## Phase 10: Commit

**Conventional commit format**:
- `chore(deps): update Bun dependencies`
- `feat(extensions): upgrade pgvector to 0.9.0 with new HNSW params`
- `fix(postgres): update TimescaleDB to 2.24.0, fixes recompression perf`

**Always include** your own co-author trailer from AGENTS.md "Git Workflow" (e.g.
`Co-Authored-By: Claude <noreply@anthropic.com>`).

**Commit granularity**: One logical change per commit (e.g., one extension update, or all Bun deps).
Commit with `git commit --only -m "…" -- <every file of the change>`: a bare `git commit` takes the
whole index, including renames and files another agent staged.

**Commit ordering**: If PGDG validation is currently failing (stale version strings for disabled
extensions), fix PGDG versions in the FIRST commit to restore clean validation for subsequent
commits. TimescaleDB version suffix changes must be bundled with PG base image bumps (same commit).

## Phase 11: Retrospective & Skill Self-Update (MANDATORY)

After every update round, perform a mandatory self-reflection before closing out the work:

1. **What was missed in pre-flight?** Items caught mid-implementation instead of upfront
2. **What was assumed without verification?** Version strings, API signatures, URLs, compatibility
3. **What hardcoded values broke tests?** Document the pattern for future detection
4. **What files were unexpectedly required?** A change that needs edits in several files to stay
   consistent means a fact is stored twice — move it onto the manifest entry instead of syncing copies
5. **What upstream API was different from expected?** (e.g., pgmq topic API uses `bind_topic`,
   not `create_topic`/`subscribe` — always verify from actual source before writing tests)
6. **Were all tooling version files kept in sync?** `.tool-versions` (Bun runtime), `package.json`
   (@types/bun). These are updated separately — `bun update` does NOT touch `.tool-versions`.
7. **Were validator error messages and fix instructions actually correct?** When editing any
   validator script, verify that following its own fix instructions would resolve the error it
   reports.
8. **Were stale prose version comments audited?** `actions-up` updates `uses:` line comments
   automatically — the risk is prose comments *elsewhere* in the file. See Phase 2.5 MANDATORY
   section for the exact grep command and what to look for.
8a. **Were branch-pinned reusable workflow refs checked?** `actions-up` cannot SHA-pin job-level
    `uses:` refs (`ORG/REPO/.github/workflows/FILE.yml@branch`). Run the mandatory grep from
    Phase 2.5 to find any remaining branch-pinned reusable workflows and SHA-pin them manually.
9. **Were third-party apt repos checked for dropped versions?** Percona (and Timescale) drop old
   package versions from their apt repos without warning. A removed pin makes `apt-get install` fail
   the build. **Always verify Percona and Timescale pinned versions still exist in the repo** before
   finalising the update round:
   ```bash
   # Check Percona versions (run from a container or use the earlier docker run command)
   bun scripts/extensions/validate-pgdg-versions.ts  # validates PGDG; Percona checked separately
   docker run --rm postgres:18-trixie bash -c "
     apt-get update -qq && apt-get install -y -qq curl gnupg2 gpgv lsb-release 2>/dev/null &&
     curl -fsSL https://repo.percona.com/apt/percona-release_latest.generic_all.deb -o /tmp/pr.deb &&
     dpkg -i /tmp/pr.deb 2>/dev/null && percona-release enable ppg-18 release 2>/dev/null &&
   apt-get update -qq 2>/dev/null && apt-cache madison percona-pg-stat-monitor18
  " 2>&1 | command grep "percona-pg-stat-monitor"
   ```
10. **Was extension update detection quality-checked?** If `check-updates.ts` output looked noisy,
    verify each candidate is same-family + monotonic (not prerelease/downgrade) and confirm fallback
    paths were exercised when GitHub API was rate-limited.
11. **Was changelog gating enforced?** If any image-affecting files changed, verify `CHANGELOG.md`
    was updated in the same round with user-facing entries (or explicitly document why no user-facing
    impact exists).
12. **Are changelog claims evidence-backed?** Cross-check each changelog statement against actual
    upstream diff evidence (release notes, compare output, commit/file diffs). Remove any claim that
    cannot be tied to concrete upstream changes.
13. **Were all bug fixes systematically verified with a full-codebase grep?** A targeted fix (e.g.,
    fixing `.env()` calls in the files that visibly failed) is not the same as verifying the entire
    codebase. After any structural fix pattern, run a grep across ALL relevant files to confirm zero
    remaining violations before declaring done. Latent bugs in gracefully-degrading code paths
    (try/catch → warning, optional fallback branches) pass tests silently until they hit edge cases.
    Run the validate check or a direct grep: `bun run validate` now includes "Subprocess Env Safety"
    for the `.env()` pattern specifically.

Then update THIS SKILL FILE (`.claude/commands/update.md`) with concrete improvements:
- Add checks that would have caught missed items
- Strengthen wording where guidance was too weak
- Fix any outdated file references or procedures
- Add new edge cases discovered

**This is kaizen — each update round improves the next. The skill should be a living document
that gets better with every use. Commit the skill update as the final commit of the round.**

## Phase 12: Final Verification Gate (MANDATORY — The Only Acceptable End State)

Before final verification, prove the full update matrix is closed. Do not claim "update complete"
unless every item below has either been updated or has an evidence-backed no-op/skip reason. A skip that
waits on time (a release newer than the minimum release age) records when it ends; after that the item is
due in this round, not the next:

- PostgreSQL base version and digest
- Git/tag/git-ref extensions from `check-updates.ts`
- PGDG package versions from `validate-pgdg-versions.ts` (fast `validate` may not contact PGDG)
- Percona pinned package versions
- Timescale main and loader package versions
- Source-to-PGDG migration opportunities
- Companion images: compose pins (validate-enforced) and `deployments/`-only images
- Tool images run by scripts (Phase 2.5)
- Bun runtime in `.tool-versions`
- Bun package dependencies and `bun.lock`
- GitHub Actions SHA pins, reusable workflow refs, and stale prose comments
- Hardcoded test/doc version strings for every changed image-facing dependency
- Generated files and `CHANGELOG.md` when any image-facing source changed

After ALL other phases — including CHANGELOG, skill update commit, and every other commit — run
the full comprehensive test suite one final time:

```bash
bun run test:all
```

**This is a gate, not a formality.** Rules:

- ✅ **If it passes**: Update round is **COMPLETE**. Repository is in a known-good state.
- ❌ **If it fails**: DO NOT stop. DO NOT declare work done. Fix the issue, commit the fix,
  and re-run `bun run test:all` from the top of Phase 12. Repeat until clean.

**Why this matters**: `bun run build` succeeding is NOT sufficient — it only verifies the image
compiles. A broken image can build successfully if `set -e` is circumvented (e.g., the `|| true`
pattern). Only `test:all` starts PostgreSQL, loads all extensions, and runs functional tests —
verifying the image is actually correct at runtime.

**No exceptions. No "CI will catch it". No "close enough".** The only acceptable end state is
`bun run test:all` passing clean with zero failures on the committed code.

```
test:all → pass → DONE
test:all → fail → fix → commit fix → test:all (loop)
```

## Phase 13: Reclaim Test Artifacts (MANDATORY — after the gate passes)

`bun run build`/`test:all` leave aza-pg-attributable Docker artifacts that bloat the host over
successive update rounds: superseded image layers (each rebuild untags the previous aza-pg image),
the dedicated `aza-pg-builder` buildx cache, and any anonymous PGDATA volumes. Reclaim them:

```bash
bun run cleanup:dry   # preview what would be removed (no changes)
bun run cleanup       # reclaim
```

**Safe on a shared host**: it removes ONLY artifacts positively attributed to aza-pg by aza-pg's own
identity markers — images by OCI label `org.opencontainers.image.title` ("aza-pg …"), volumes by the
`app.aza_pg_custom` marker that `00-aza-pg-settings.sh` writes into PGDATA. It NEVER prunes by type
(`docker system/volume/image prune` would also delete other projects' orphans).

The anonymous-volume leak is fixed at source (test teardown passes `docker rm -f -v`, enforced by the
`Subprocess Calls` check in `validate`), so this step now mainly reclaims superseded image
layers and builder cache — but keep running it: it is the backstop that keeps the host from bloating.

## Recovery Procedure

### Before Push (Local Only)

If update breaks **before pushing to remote**:

```bash
# Inspect exact damage first
git status --short
git diff --stat

# Preferred for committed changes: revert with history
git revert HEAD

# Then regenerate/rebuild from the recovered state
bun run generate
bun run build
```

For uncommitted changes, use targeted `git restore -- <path>` only after verifying the diff belongs
entirely to the failed update attempt. Never discard unrelated user work.

### After User Pushes

Only push when the user explicitly requested upstream publication or the current task requires it.
Verify branch, remotes, CI status, and release invariants before and after pushing.

If update breaks after user already pushed:

```bash
# Create revert commit (keeps history)
git revert HEAD  # Or HEAD~N..HEAD for multiple

# Rebuild
bun run generate
bun run build
bun run test:all

# Agent stops here - user handles remote
```

---

# Reference Tables

## Non-Standard Tag Formats

| Extension | Tag Format | Example |
|-----------|------------|---------|
| **pg_repack** | `ver_X.Y.Z` | `ver_1.5.3` |
| **pgaudit** | `X.Y` (PG major) | `18.0` |
| **set_user** | `RELX_Y_Z` | `REL4_2_0` |
| **pgbackrest** | `release/X.Y.Z` | `release/2.57.0` |
| **wal2json** | `wal2json_X_Y` | `wal2json_2_6` |
| **pgflow** | `pgflow@X.Y.Z` | `pgflow@0.13.1` |

## Version Lookup Commands

| Source | Command |
|--------|---------|
| **GitHub latest release** | `gh release view --repo OWNER/REPO --json tagName --jq .tagName` |
| **GitHub all tags** | `git ls-remote --tags https://github.com/OWNER/REPO \| command grep -v '{}' \| tail -5` |
| **PGDG apt** | `docker run --rm postgres:18-trixie bash -c "apt-get update -qq && apt-cache madison postgresql-18-EXTNAME"` |
| **Percona apt** | `docker run --rm perconalab/percona-distribution-postgresql:18 bash -c "apt-get update -qq && apt-cache madison postgresql-18-EXTNAME"` |
| **Timescale apt** | `docker run --rm timescale/timescaledb:latest-pg18 bash -c "apt-cache madison postgresql-18-timescaledb"` |

## Parallel Execution Opportunities

Use parallelism where supported for:
- ✅ Pre-flight checks that do not share mutable state
- ✅ Upstream changelog review (per extension in parallel)
- ✅ Test creation (if multiple extensions updated)
- ✅ Version lookups from different sources (GitHub, apt repositories)

**Agent prompts should**:
- Be specific about what information to return
- Include filtering criteria (e.g., "return only version numbers")
- Specify output format (e.g., "provide as JSON" or "list as Markdown table")

Do not trust delegated results blindly. Re-run decisive commands locally and verify every version,
URL, digest, release note claim, and file path before editing or committing.

---
