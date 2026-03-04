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

## Pre-Flight: Detect Available Updates (RUN IN PARALLEL)

Launch sub-agents (general-purpose, sonnet model) in parallel to check:

1. **Git-based extensions**:

   ```bash
   bun scripts/extensions/check-updates.ts
   ```

2. **Bun dependencies**:

   ```bash
   bun outdated  # Check what's outdated
   ```

3. **Base image** (if upgrading PostgreSQL version):

   ```bash
   docker pull postgres:18.X-trixie
   docker inspect postgres:18.X-trixie --format '{{index .RepoDigests 0}}'
   ```

4. **PGDG apt versions** (automated validation):

   ```bash
   bun run validate
   ```

   **CRITICAL**: This includes PGDG version validation that ensures all PGDG versions in manifest match what's available in the repository. Any mismatch will cause apt-get install to fail silently during Docker build (due to cache layers), resulting in missing extensions at runtime.

## Pre-Flight: Additional Checks (MANDATORY)

5. **Test file version strings**: Search test files for hardcoded version strings of extensions being updated:
   ```bash
   # TypeScript test files
   command grep -rn "0\.8\|2\.8\|0\.5" scripts/test/ | command grep -i "version\|include\|assert"
   # SQL regression expected outputs — also hard-code version strings and WILL break nightly if stale
   command grep -rn "[0-9]\+\.[0-9]\+\.[0-9]\+" tests/regression/extensions/*/expected/*.out 2>/dev/null | command grep -v "^Binary"
   ```
   These WILL break tests if not updated alongside the extension. This is the #1 missed item.

6. **Source→PGDG migration opportunities**: For each source-built extension, check if PGDG now has a package:
   ```bash
   docker run --rm postgres:18-trixie bash -c "apt-get update -qq && apt-cache madison postgresql-18-EXTNAME"
   ```
   If available, migrate to PGDG for faster builds (eliminates source compilation during Docker build).

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
   " 2>&1 | grep -E "percona-pg|percona-postgresql"
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

## Phase 1: Review Upstream Changes (CRITICAL FOR TESTS & CHANGELOG)

For EACH extension to update, check upstream for breaking changes and new features:

```bash
# Method 1: GitHub releases
curl -s https://api.github.com/repos/OWNER/REPO/releases/latest | jq -r '.body'

# Method 2: Upstream CHANGELOG
curl -s https://raw.githubusercontent.com/OWNER/REPO/NEW_TAG/CHANGELOG.md | head -100

# Method 3: Compare tags
curl -s https://api.github.com/repos/OWNER/REPO/compare/OLD_TAG...NEW_TAG | jq '.commits[].commit.message'
```

**Document findings** — you'll need this for:
- Writing new tests (Phase 6)
- Updating CHANGELOG.md (Phase 9)

## Phase 2: Bun Dependencies

```bash
# Update all npm/bun package dependencies to latest versions
bun update --latest

# Validate immediately
bun run validate
```

**⚠️ Linter version jumps**: If oxlint/squawk jumps multiple minor versions, new lint rules may flag
existing code. Run `bun run validate` immediately and fix issues before proceeding. Do NOT blindly
disable new rules — evaluate each one. If a rule is a false positive, suppress only that specific
rule with a comment; if legitimate, fix the code.

**⚠️ ALWAYS check Bun runtime version separately** — `bun update` bumps npm packages (incl.
`@types/bun`) but does NOT update the Bun runtime pinned in `.tool-versions`. These are independent:

```bash
# Check current pinned runtime version
cat .tool-versions            # e.g. "bun 1.3.8"

# Check latest stable Bun runtime
bun --version               # current installed
# Then check https://github.com/oven-sh/bun/releases for latest stable tag
# NOTE: `bun upgrade` has no --dry-run flag — it upgrades immediately; do NOT run it
```

If a new stable runtime is available, update `.tool-versions` manually:
```bash
# Edit .tool-versions: bump bun X.Y.Z to latest stable
```

Note: `@types/bun` (npm package) may lag the runtime release by ~1 week — that is expected.
Keep `.tool-versions` and `@types/bun` approximately in sync but they need not be identical.

## Phase 2.5: GitHub Actions Pins

GitHub Actions use SHA-pinned `uses:` references for security. Run `actions-up` to bump all SHAs
to the latest verified commit for each action's current tag.

```bash
# Update all GitHub Actions SHA pins to latest (respects existing pinned versions)
actions-up --yes
```

This updates the `uses:` SHA in every workflow and composite action. It will report how many
actions were updated and how many were **breaking** (major version bumps).

### MANDATORY: Identify and Audit Breaking Changes

`actions-up` reports breaking changes (major version jumps) separately. **These require manual
review** — do NOT blindly accept without checking each one.

**For every major-version bump** (e.g., `upload-artifact v6 → v7`):

1. Fetch the upstream release notes:
   ```bash
   # Replace OWNER/REPO and vN.0.0 with the actual action and version
   curl -s https://api.github.com/repos/OWNER/REPO/releases/tags/vN.0.0 | jq -r '.body'
   # Or fetch the RELEASES.md directly:
   curl -s https://raw.githubusercontent.com/OWNER/REPO/main/RELEASES.md | head -80
   ```

2. Check for each category of breaking change:
   - **Renamed or removed inputs**: does your workflow pass an input that no longer exists?
   - **Renamed or removed outputs**: does a subsequent step reference `steps.X.outputs.Y`?
   - **Behaviour changes** (silent→loud defaults): new defaults may turn previously-tolerated
     warnings into hard failures — this is the most dangerous category
   - **New required inputs**: does the action now require a parameter you haven't set?
   - **Runner version requirements**: Node.js 24 actions require Actions Runner ≥ v2.327.1–v2.329.0;
     self-hosted runners below this threshold will fail with "node24 not found"

3. Fix any incompatible usages before committing.

### Known Breaking Patterns for Common Actions

| Action | Breaking boundary | What changed | Action needed |
|--------|------------------|--------------|---------------|
| `actions/upload-artifact` | v6→v7 | New `archive:` param (default `true`, safe); Node.js 24 | None for normal usage |
| `actions/download-artifact` | v7→v8 | `digest-mismatch` default changed `warn` → `error`; new `skip-decompress` | Check if your workflows relied on silent hash-mismatch tolerance |
| `sigstore/cosign-installer` | v3→v4 | v3 cannot install cosign v3.x (bundle format changed); default cosign bumped to v3.x | If you pin `cosign-release:` explicitly, verify it still installs; verify cosign v3 CLI compat |
| `actions/attest-build-provenance` | v3→v4 | Node.js 24 (runner req); `subject-version` input added (additive) | None unless on old self-hosted runners |
| `actions/checkout` | v5→v6 | Credentials stored in `$RUNNER_TEMP` via `includeIf` (not `.git/config`) | None for normal git usage; breaks scripts that parse `.git/config` directly |
| `actions/cache` | v3→v4 | Removed `save-always` input (use `cache-hit` output pattern instead) | Check for `save-always:` usage |
| `docker/login-action` | v3→v4 | Node.js 20→24 runtime only; all inputs/outputs/defaults identical | None for GitHub-hosted runners (runner ≥ v2.327.1 required; all ubuntu-* runners qualify) |
| `docker/setup-qemu-action` | v3→v4 | Node.js 20→24 runtime only; all inputs/outputs/defaults identical | None for GitHub-hosted runners (same runner requirement) |

### MANDATORY: Fix Stale Inline Version Comments

**`actions-up` updates the `uses:` SHA but does NOT update inline comments.**

After running `actions-up`, scan ALL workflow and composite action files for stale version comments:

```bash
# Find inline version comments that may be stale (e.g., "# v3.0.0" next to a v4 SHA)
command grep -rn "# v" .github/workflows/ .github/actions/
# Also check for explicit version refs in prose comments:
command grep -rn "@v[0-9]" .github/workflows/ .github/actions/ | command grep "#"
```

Cross-reference each comment against the actual `# vX.Y.Z` comment that `actions-up` added to the
`uses:` line. Update any prose comment that references an old version. This is easy to miss and
creates actively misleading documentation.

**Validate after actions-up**:
```bash
bun run validate:all  # catches yamllint, hadolint, workflow syntax issues
```

## Phase 3: Base Image (ALWAYS CHECK — Security Patches!)

PG minor releases include security patches (CVEs). ALWAYS check for a newer base image, even when
not upgrading PG major version. Minor releases can fix critical CVEs (e.g., CVSS 8.8).

```bash
# Check if a newer PG minor version is available (even staying on same major)
docker run --rm postgres:18-trixie postgres --version  # check latest minor

# Get latest base image SHA
docker pull postgres:18.X-trixie
SHA=$(docker inspect postgres:18.X-trixie --format '{{index .RepoDigests 0}}')

# Update manifest-data.ts (search for MANIFEST_METADATA)
# Change TWO fields:
# - pgVersion: "18.X"
# - baseImageSha: "sha256:..."

# Verify format (baseImageSha is just the sha256:... digest, no image name prefix)
grep 'baseImageSha:' scripts/extensions/manifest-data.ts
```

**⚠️ TimescaleDB coupling**: timescaleVersion suffix encodes PG minor version (e.g., `-1803` for
PG 18.3). When bumping PG minor version, ALWAYS update timescaleVersion in the same commit.

## Phase 4: Extensions (BY SOURCE TYPE)

**CRITICAL**: Update in dependency order (dependencies BEFORE dependents).

### Dependency Graph

**Extract from manifest**: `grep 'dependencies:' scripts/extensions/manifest-data.ts -B 2 | grep 'name:'`

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

**Identify**: `grep 'install_via: "pgdg"' scripts/extensions/manifest-data.ts`

**⚠️ CRITICAL**: When switching between PGDG and source build, update **4 files**:
1. `scripts/extensions/manifest-data.ts`: Change `install_via`, add/remove `pgdgVersion`, add/remove `build`
2. `scripts/extensions/generate-extension-defaults.ts`: Add/remove from `NAME_TO_KEY`
3. `scripts/extensions/pgdg-mappings.ts`: Add/remove from `PGDG_MAPPINGS` array
4. `scripts/ci/validate-manifest-integrity.ts`: Add/remove from both inline `NAME_TO_KEY` AND `PGDG_MAPPING_NAMES`

The manifest integrity validator (`scripts/ci/validate-manifest-integrity.ts`) has its own **inline
copies** of NAME_TO_KEY and PGDG_MAPPING_NAMES — these are NOT imported from the other files and
MUST be kept in sync manually. Missing this file causes integrity validation failures.

**Source → PGDG migration** (extension now has PGDG package):
- Remove `install_via: "source"`, add `install_via: "pgdg"` and `pgdgVersion`
- Remove `build: { type: "pgxs" }` (PGDG handles compilation)
- Add to NAME_TO_KEY, PGDG_MAPPINGS, and both sets in validate-manifest-integrity.ts
- Place in appropriate tier in PGDG_MAPPINGS (VOLATILE for frequent releases)

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

**Identify**: `grep 'install_via: "percona"' scripts/extensions/manifest-data.ts`

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

**Identify**: `grep 'install_via: "timescale"' scripts/extensions/manifest-data.ts`

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

### GitHub Release Extensions

**Identify**: `grep 'install_via: "github-release"' scripts/extensions/manifest-data.ts`

Update BOTH `source.tag` AND `githubReleaseTag` (must match):

```typescript
{
  name: "extension_name",
  source: { type: "git", tag: "X.Y.Z" },          // ← Update tag
  githubReleaseTag: "X.Y.Z",                      // ← Must match!
}
```

**VERIFY**: GitHub release has assets for BOTH amd64 and arm64.

```bash
# List release assets
gh release view TAG --repo OWNER/REPO --json assets --jq '.assets[].name'

# Verify both architectures present (amd64/x86_64 AND arm64/aarch64)
# If missing: wait for upstream, build from source, or disable
```

### Source-Built Extensions

**Identify**: Extensions with `build:` field (no `install_via`, or `install_via` with `build:`)
- `grep -B 5 'build:' scripts/extensions/manifest-data.ts | grep 'name:'`

Update ONLY `source.tag`:

```typescript
{
  name: "extension_name",
  source: { type: "git", tag: "vX.Y.Z" },         // ← Only this field
}
```

**These extensions are built from source** during Docker image build using PGXS, cargo-pgrx, cmake, autotools, or other build systems.

### Builtin Extensions

**Identify**: `grep 'kind: "builtin"' scripts/extensions/manifest-data.ts`

**No manual updates required** - Builtin extensions are part of PostgreSQL core and update automatically with the base image (Phase 3).

These only need updates when PostgreSQL version changes.

## Phase 5: Special Extensions

**IMPORTANT**: When updating any extension, check for local patches/compatibility layers in `docker/postgres/`:
- Search for files: `find docker/postgres -name "*EXTENSION_NAME*patch*" -o -name "*EXTENSION_NAME*stub*" -o -name "*EXTENSION_NAME*compat*"`
- Review init scripts: `grep -r "EXTENSION_NAME" docker/postgres/docker-entrypoint-initdb.d/`
- Verify patches still apply with new version or if upstream fixed them

### 5.1: pgflow (6+ Files to Update)

**Most complex** — requires coordinated updates across multiple files:

```bash
# Step 1: Generate new schema (combines 21 SQL files from upstream)
bun scripts/pgflow/generate-schema.ts NEW_VERSION --update-install
# ⚠️ This updates manifest-data.ts and install.ts, but NOT Dockerfile.template!

# Step 2: Update Dockerfile.template manually (script doesn't do this)
# Change: COPY tests/fixtures/pgflow/schema-vOLD.sql → schema-vNEW.sql

# Step 3: Update npm packages in package.json
bun update @pgflow/client @pgflow/dsl --latest

# Step 4: Update Dockerfile.template (search for `COPY tests/fixtures/pgflow`)
# Change: COPY tests/fixtures/pgflow/schema-vX.Y.Z.sql

# Step 5: Update 05-pgflow-init.sh (search for version in header comment and success message)

# Step 6: Review and update ALL patches and compatibility layers
# Check ALL pgflow patches for compatibility with new version:
#   - docker/postgres/pgflow/security-patches.sql (SET search_path protection)
#   - docker/postgres/docker-entrypoint-initdb.d/04a-pgflow-realtime-stub.sh (Supabase compatibility)
# Verify patches still apply or if upstream fixed them
# Check if new version introduces breaking changes requiring new patches

# Step 7: Delete old schema file
rm tests/fixtures/pgflow/schema-vOLD_VERSION.sql

# Step 8: Regenerate and test
bun run generate
bun run test:pgflow
```

### 5.2: git-ref Extensions (Manual Review Required)

**Identify**: `grep 'type: "git-ref"' scripts/extensions/manifest-data.ts -B 2 | grep 'name:'`

These use commit SHAs (no version tags). Update requires manual review:

```bash
# Check if upstream now has stable tags
git ls-remote --tags https://github.com/OWNER/REPO | tail -20

# If tags exist: migrate from git-ref to git type
# Change: type: "git-ref", ref: "..."
# To:     type: "git", tag: "vX.Y.Z"

# If no tags: verify newer commit is PG18-compatible
# Check: CI status, changelog mentions, no breaking changes
gh api repos/OWNER/REPO/commits/COMMIT_REF/status
```

### 5.3: cargo-pgrx Extensions (Rust Version Alignment)

**Identify**: `grep 'type: "cargo-pgrx"' scripts/extensions/manifest-data.ts -B 5 | grep 'name:'`

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

### 5.5: Updating Disabled Extensions

**Identify**: `grep 'enabled: false' scripts/extensions/manifest-data.ts -B 2 | grep 'name:'`

**Principle**: Update disabled extensions if they're still tested or might be re-enabled. Skip if permanently incompatible.

Extensions still in test suites should stay current. Permanently broken extensions can be skipped.

### 5.6: PgBouncer Image (Outside Manifest)

**Not in manifest-data.ts!** PgBouncer version is hardcoded in:
- `stacks/primary/compose.yml` (search for `edoburu/pgbouncer`)
- Test files: `scripts/test/test-pgbouncer-*.ts`

**Update procedure**:

1. Check for new edoburu/pgbouncer releases on Docker Hub
2. Update image tag and SHA256 digest in compose.yml
3. Update test files if needed

## Phase 6: Add Tests for New Functionality

### MANDATORY Pre-Test Checks

Before writing tests, search for hardcoded version strings in ALL test files:

```bash
# Find any hardcoded version strings that will break after an upgrade (TypeScript test files)
command grep -rn "includes(\"0\.\|includes(\"1\.\|includes(\"2\." scripts/test/ | command grep -v ".bun/"
# Also search for specific old version patterns:
command grep -rn "0\.8\|0\.5\|2\.8\|1\.10\|5\.4" scripts/test/ | command grep -v ".bun/" | command grep -i "include\|assert\|version"
# SQL regression expected outputs — hard-code extversion strings; stale = nightly failures
command grep -rn "[0-9]\+\.[0-9]\+\.[0-9]\+" tests/regression/extensions/*/expected/*.out 2>/dev/null | command grep -v "^Binary"
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

### Test File Locations

```text
scripts/test/
  ├── test-all-extensions-functional.ts  # Extension loading tests
  ├── test-pgflow-*.ts                   # pgflow-specific tests
  ├── test-auto-config.ts                # Auto-config tests
  └── test-*.ts                          # Various functional tests
```

## Phase 7: Regenerate & Validate

```bash
# Regenerate all files from manifest
bun run generate

# Fast validation (REQUIRED - static checks + unit tests)
bun run validate

# Full validation (includes shellcheck, hadolint, yamllint)
bun run validate:all
```

## Phase 8: Build & Test (Intermediate Check)

```bash
# Build image
bun run build

# Full test suite (rebuild + all tests, ~45 min)
bun run test:all
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

## Phase 9.5: Mandatory Adversarial Self-Audit (BEFORE COMMITTING)

**Do this after every batch of changes, without waiting to be asked.** Assume you missed
something. Run through these checks adversarially — try to break your own work:

**Tests**
- Do any new tests pass trivially regardless of the fix they claim to cover?
  (e.g., EXPLAIN test on a tiny table uses SeqScan → never touches the HNSW-specific code path)
- Does the test actually force the execution path it claims to verify?
  Query planner optimisations, small row counts, or default settings can silently bypass the exact
  code path being tested. Add session-level forcing (e.g. `SET enable_seqscan = OFF`) or sufficient
  data volume to guarantee the expected path is taken.
- Does the test verify the actual bug mode, or just that no crash occurred?

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
- Specifically: auto-generated files (`extension-defaults.ts`, `Dockerfile`,
  `regression.Dockerfile`, `docs/EXTENSIONS.md`) — did they regenerate correctly?

**Mandatory doc sync** (NOT auto-generated — must be updated manually every round):
- `docs/EXTENSION-SOURCES.md`: PGDG/source-built/Percona/Timescale version tables — update
  every changed extension version AND verify categorisation (PGDG vs source-built) is still
  correct. A migrated extension (source→PGDG or vice-versa) MUST move between table sections.
  The PGDG count in the overview table must be updated if any extension changes install method.
- `docs/ARCHITECTURE.md`: ASCII diagram at "Build Time / Runtime" section contains pgvector
  and pg_cron version strings — update if those change.
- **Check for orphaned test files**: When migrating an extension's install method, search for
  dedicated test files (`test-EXT-NAME-*.ts`) that may now be stale (wrong version assertions,
  wrong install path descriptions). Delete or migrate their valuable tests.
- **Check unit tests in `generate-dockerfile.test.ts`**: The "All PGDG versions are defined"
  test has inline comments listing extensions NOT expected in pgdgVersions (source-built ones).
  When migrating an extension to/from PGDG, add/remove `expect(versions.KEY).toBeDefined()` and
  update the comments accordingly.
- **`scripts/test/test-timescaledb-breaking-changes.ts`**: Standalone test not in `test:all`.
  Contains a version series check (`startsWith("2.25.")`) — **update the series prefix** when
  TimescaleDB crosses a minor version boundary (2.25.x → 2.26.x). Also update the file title
  and run banner.
- **Search all test files for hardcoded version strings** that would fail after the update:
  `command grep -rn 'includes\|startsWith\|=== "' scripts/test/ | command grep -E '[0-9]+\.[0-9]'`
  Also check SQL regression expected outputs: `command grep -rn "[0-9]\+\.[0-9]\+\.[0-9]\+" tests/regression/extensions/*/expected/*.out 2>/dev/null`

**The question to answer**: "If the user ran an adversarial audit on what I just did,
what would they find?" Find it yourself first.

## Phase 10: Commit

**Conventional commit format**:
- `chore(deps): update Bun dependencies`
- `feat(extensions): upgrade pgvector to 0.9.0 with new HNSW params`
- `fix(postgres): update TimescaleDB to 2.24.0, fixes recompression perf`

**Always include**:

```text
Co-Authored-By: Claude <noreply@anthropic.com>
```

**Commit granularity**: One logical change per commit (e.g., one extension update, or all Bun deps).

**Commit ordering**: If PGDG validation is currently failing (stale version strings for disabled
extensions), fix PGDG versions in the FIRST commit to restore clean validation for subsequent
commits. TimescaleDB version suffix changes must be bundled with PG base image bumps (same commit).

## Phase 11: Retrospective & Skill Self-Update (MANDATORY)

After every update round, perform a mandatory self-reflection before closing out the work:

1. **What was missed in pre-flight?** Items caught mid-implementation instead of upfront
2. **What was assumed without verification?** Version strings, API signatures, URLs, compatibility
3. **What hardcoded values broke tests?** Document the pattern for future detection
4. **What files were unexpectedly required?** (e.g., `validate-manifest-integrity.ts` has inline
   copies of mappings that must be kept in sync — not obvious from other files)
5. **What upstream API was different from expected?** (e.g., pgmq topic API uses `bind_topic`,
   not `create_topic`/`subscribe` — always verify from actual source before writing tests)
6. **Were all tooling version files kept in sync?** `.tool-versions` (Bun runtime), `package.json`
   (@types/bun). These are updated separately — `bun update` does NOT touch `.tool-versions`.
7. **Were validator error messages and fix instructions actually correct?** When editing any
   validator script, verify that following its own fix instructions would resolve the error it
   reports. Validators with inline data copies (like `validate-manifest-integrity.ts`) are
   especially prone to self-defeating instructions.
8. **Were GitHub Actions stale inline comments fixed?** `actions-up` updates `uses:` SHA pins but
   NOT inline version comments (e.g. `# v3.0.0` that refers to the old version in a prose comment
   elsewhere in the file). After running `actions-up`, every prose comment referencing an old
   version is now silently wrong.
9. **Were third-party apt repos checked for dropped versions?** Percona (and Timescale) drop old
   package versions from their apt repos without warning. If you pin a version that's been removed,
   `apt-get install` silently "fails" and returns exit code 100 — but due to the `|| true` pattern
   (now fixed), this used to produce a broken image without any error. **Always verify Percona and
   Timescale pinned versions still exist in the repo** before finalising the update round:
   ```bash
   # Check Percona versions (run from a container or use the earlier docker run command)
   bun scripts/extensions/validate-pgdg-versions.ts  # validates PGDG; Percona checked separately
   docker run --rm postgres:18-trixie bash -c "
     apt-get update -qq && apt-get install -y -qq curl gnupg2 gpgv lsb-release 2>/dev/null &&
     curl -fsSL https://repo.percona.com/apt/percona-release_latest.generic_all.deb -o /tmp/pr.deb &&
     dpkg -i /tmp/pr.deb 2>/dev/null && percona-release enable ppg-18 release 2>/dev/null &&
     apt-get update -qq 2>/dev/null && apt-cache madison percona-pg-stat-monitor18
   " 2>&1 | grep "percona-pg-stat-monitor"
   ```

Then update THIS SKILL FILE (`.claude/commands/update.md`) with concrete improvements:
- Add checks that would have caught missed items
- Strengthen wording where guidance was too weak
- Fix any outdated file references or procedures
- Add new edge cases discovered

**This is kaizen — each update round improves the next. The skill should be a living document
that gets better with every use. Commit the skill update as the final commit of the round.**

## Phase 12: Final Verification Gate (MANDATORY — The Only Acceptable End State)

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

## Rollback Procedure

### Before Push (Local Only)

If update breaks **before pushing to remote**:

```bash
# Option 1: Discard uncommitted changes
git checkout -- .

# Option 2: Revert last commit (keeps history)
git revert HEAD

# Option 3: Hard reset to known good state (destroys history)
git reset --hard <known-good-commit>

# Then rebuild
bun run generate
bun run build
```

### After User Pushes

**Agents NEVER push - only commit locally.**

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
| **GitHub latest release** | `curl -s https://api.github.com/repos/OWNER/REPO/releases/latest \| jq -r .tag_name` |
| **GitHub all tags** | `git ls-remote --tags https://github.com/OWNER/REPO \| grep -v '{}' \| tail -5` |
| **PGDG apt** | `docker run --rm postgres:18-trixie bash -c "apt-get update -qq && apt-cache madison postgresql-18-EXTNAME"` |
| **Percona apt** | `docker run --rm perconalab/percona-distribution-postgresql:18 bash -c "apt-get update -qq && apt-cache madison postgresql-18-EXTNAME"` |
| **Timescale apt** | `docker run --rm timescale/timescaledb:latest-pg18 bash -c "apt-cache madison postgresql-18-timescaledb"` |

## Parallel Execution Opportunities

Use **general-purpose sub-agents** (sonnet model) for:
- ✅ Pre-flight checks (all 4 in parallel)
- ✅ Upstream changelog review (per extension in parallel)
- ✅ Test creation (if multiple extensions updated)
- ✅ Version lookups from different sources (GitHub, apt repositories)

**Agent prompts should**:
- Be specific about what information to return
- Include filtering criteria (e.g., "return only version numbers")
- Specify output format (e.g., "provide as JSON" or "list as Markdown table")

Don't blindly 100% trust the results from agents. Sometimes they could do the job in the wrong way because they often have weaker models. They could also be too-narrow-minded, so verify.

---
