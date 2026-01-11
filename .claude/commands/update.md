---
name: /update
description: Comprehensive dependency and extension update guide
argument-hint: (optional additional notes)
id: p-update
category: project
tags: [project, update, maintenance]
---

You are updating dependencies and extensions in the aza-pg PostgreSQL container project.

**CRITICAL**: See CLAUDE.md "AI Agent Knowledge Updates" section for surprising facts (Debian Trixie is LTS, PG18 released Sep 2025, pgrx needs Rust 1.88+, etc.)

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
   bun update --interactive  # Check what's outdated
   ```

3. **Base image** (if upgrading PostgreSQL version):
   ```bash
   docker pull postgres:18.X-trixie
   docker inspect postgres:18.X-trixie --format '{{index .RepoDigests 0}}'
   ```

4. **PGDG apt versions** (requires Docker container with PGDG repo):
   ```bash
   docker run --rm postgres:18-trixie apt-cache madison postgresql-18-pgvector
   docker run --rm postgres:18-trixie apt-cache madison postgresql-18-postgis-3
   ```

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
# Update within semver constraints
bun update

# Update pinned dependencies (@pgflow packages)
bun update @pgflow/client @pgflow/dsl --latest

# Validate immediately
bun run validate
```

## Phase 3: Base Image (Only if PostgreSQL Version Changes)

```bash
# Step 1: Get latest base image SHA
docker pull postgres:18.X-trixie
SHA=$(docker inspect postgres:18.X-trixie --format '{{index .RepoDigests 0}}')
echo "New SHA: $SHA"

# Step 2: Update manifest-data.ts (search for MANIFEST_METADATA)
# Line ~40-50: Update TWO fields:

# OLD:
# export const MANIFEST_METADATA = {
#   pgVersion: "18.1",
#   baseImageSha: "postgres:18.1-trixie@sha256:38d5c9d5...",
# }

# NEW:
# export const MANIFEST_METADATA = {
#   pgVersion: "18.2",  # ← Update version
#   baseImageSha: "postgres:18.2-trixie@sha256:bfe50b2b...",  # ← Update full digest
# }

# Step 3: Verify format (must include @sha256: prefix)
grep 'baseImageSha:' scripts/extensions/manifest-data.ts
```

## Phase 4: Extensions (BY SOURCE TYPE)

**CRITICAL**: Update in dependency order (dependencies BEFORE dependents).

### Dependency Graph

**Extract from manifest**: `grep 'dependencies:' scripts/extensions/manifest-data.ts -B 2 | grep 'name:'`

Extensions with `dependencies: ["extension1", "extension2"]` field must be updated AFTER their dependencies.

**Example**: If extension B has `dependencies: ["extensionA"]`, update extensionA first, verify compatibility, then update B.

### ⚠️ CRITICAL: Dependency Compatibility

**BEFORE updating any extension that has dependents, verify compatibility:**

```bash
# Step 1: Find extensions that depend on the one you're updating
EXTENSION="pgvector"  # Example: updating pgvector
grep -B 3 "dependencies:.*$EXTENSION" scripts/extensions/manifest-data.ts | grep 'name:'
# Output: vectorscale, index_advisor (both depend on pgvector)

# Step 2: Check dependent's version requirements
# Method A: Check dependent's upstream repository
DEPENDENT_REPO="https://github.com/timescale/pgvectorscale"
curl -s $DEPENDENT_REPO/blob/main/Cargo.toml | grep -A 5 'dependencies'
# Look for: pgrx = "..." and any pgvector version constraints

# Method B: Check dependent's changelog for compatibility notes
curl -s $DEPENDENT_REPO/blob/main/CHANGELOG.md | grep -i "pgvector\|breaking"

# Step 3: Test compatibility after updating dependency
# Update pgvector in manifest, then:
bun run generate
bun run build  # Build will fail if ABI incompatible
# If build succeeds, test runtime interaction:
bun run test -- --filter=vectorscale  # Run dependent's specific tests
```

**Concrete examples:**

| Updating | Check | Command |
|----------|-------|---------|
| **pgvector** (depended on by vectorscale, index_advisor) | vectorscale's Cargo.toml for pgvector constraints | `curl -s https://raw.githubusercontent.com/timescale/pgvectorscale/main/Cargo.toml \| grep -A 3 pgvector` |
| **pgsodium** (depended on by supabase_vault) | supabase_vault's SQL for pgsodium function calls | `grep -r "pgsodium\." scripts/test/test-extensions.ts` |
| **pgmq** (depended on by pgflow) | pgflow's package.json or schema for pgmq version | `grep pgmq tests/fixtures/pgflow/schema-v*.sql` |

**If incompatible**: Either skip update OR update both dependency + dependent together:

```bash
# Update both together in single commit:
# 1. Update pgvector to 0.9.0 in manifest
# 2. Update vectorscale to compatible version (check their releases)
# 3. Test both: bun run test -- --filter="vector|vectorscale"
# 4. Commit together: git commit -m "feat(extensions): update pgvector + vectorscale together for compatibility"
```

### PGDG Extensions

**Identify**: `grep 'install_via: "pgdg"' scripts/extensions/manifest-data.ts`

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

**VERIFY**: GitHub release has assets for BOTH amd64 and arm64:

```bash
# List all release assets
gh release view vX.Y.Z --repo OWNER/REPO --json assets --jq '.assets[].name'

# Or with curl:
curl -s https://api.github.com/repos/OWNER/REPO/releases/tags/vX.Y.Z | \
  jq -r '.assets[].name'

# Check for both architectures
# Look for patterns like:
# - extension-vX.Y.Z-amd64.deb AND extension-vX.Y.Z-arm64.deb
# - extension-vX.Y.Z-x86_64.tar.gz AND extension-vX.Y.Z-aarch64.tar.gz
# - extension-pg18-amd64.zip AND extension-pg18-arm64.zip

# If only one arch present:
# - Option A: Wait for upstream to release both
# - Option B: Build missing arch from source (switch to source-built)
# - Option C: Disable extension if both arches required
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

### 5.1: pgflow (6+ Files to Update)

**Most complex** — requires coordinated updates across multiple files:

```bash
# Step 1: Generate new schema (combines 21 SQL files from upstream)
bun scripts/pgflow/generate-schema.ts NEW_VERSION --update-install

# Step 2: Update manifest-data.ts
# Change source.tag: "pgflow@X.Y.Z"

# Step 3: Update npm packages in package.json
bun update @pgflow/client @pgflow/dsl --latest

# Step 4: Update Dockerfile.template (search for `COPY tests/fixtures/pgflow`)
# Change: COPY tests/fixtures/pgflow/schema-vX.Y.Z.sql

# Step 5: Update 05-pgflow-init.sh (search for version in header comment and success message)

# Step 6: Delete old schema file
rm tests/fixtures/pgflow/schema-vOLD_VERSION.sql

# Step 7: Regenerate and test
bun run generate
bun run test:pgflow
```

### 5.2: git-ref Extensions (Manual Review Required)

**Identify**: `grep 'type: "git-ref"' scripts/extensions/manifest-data.ts -B 2 | grep 'name:'`

These extensions use commit SHAs instead of version tags, usually because:
- Upstream doesn't use semantic versioning
- Waiting for stable release compatible with current PostgreSQL version
- Patches or fixes not yet tagged

**Update procedure**:

```bash
# Step 1: Find current ref and repository
grep -A 5 '"EXTENSION_NAME"' scripts/extensions/manifest-data.ts | grep 'ref:\|repository:'

# Step 2: Check if upstream now has stable tags
REPO="https://github.com/OWNER/REPO"
git ls-remote --tags $REPO | tail -20

# Step 3a: If stable tags exist → migrate to git type
# Update manifest-data.ts:
source: { type: "git", repository: "...", tag: "vX.Y.Z" }  # Remove 'ref' field

# Step 3b: If NO stable tags → find newer commit
# Check commits since current ref
CURRENT_REF="abc123..."
git log --oneline --graph --decorate $CURRENT_REF..origin/main | head -20

# Verify new commit is compatible with PG18
# Check for: CI passing, mentions of PostgreSQL 18, no breaking API changes
gh api repos/OWNER/REPO/commits/NEW_REF/status

# Step 4: Update manifest with new ref
# Change: ref: "abc123..." → ref: "def456..."
```

**Migration example** (git-ref → git with tag):

```typescript
// FROM:
source: { type: "git-ref", repository: "https://github.com/supabase/pg_jsonschema", ref: "7c8603f..." }

// TO:
source: { type: "git", repository: "https://github.com/supabase/pg_jsonschema", tag: "v0.3.1" }
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

**Identify disabled extensions**: `grep 'enabled: false' scripts/extensions/manifest-data.ts -B 2 | grep 'name:'`

**Decision: Should you update disabled extensions?**

| Extension State | enabledInComprehensiveTest | Update? | Reason |
|-----------------|---------------------------|---------|--------|
| `enabled: false` | `true` | **YES** | Extension still tested in CI - keep version current |
| `enabled: false` | `false` (or missing) | **MAYBE** | Update if maintaining option to re-enable later |
| `enabled: false` + no `disabledReason` | any | **YES** | Temporarily disabled, keep current for re-enabling |
| `enabled: false` + `disabledReason: "Not compatible..."` | any | **NO** | Permanently incompatible, no point updating |

**Example workflow**:

```bash
# Check disabled extensions with tests
grep -B 5 'enabledInComprehensiveTest: true' scripts/extensions/manifest-data.ts | \
  grep 'enabled: false' -B 2 | grep 'name:'

# These should be updated like enabled extensions:
# - Update version fields (pgdgVersion, tag, etc.)
# - Run: bun run generate
# - Build still includes them (disabled = not loaded, not = not built)
# - Tests verify they compile cleanly for future re-enabling
```

### 5.5: PgBouncer Image (Outside Manifest)

**Not in manifest-data.ts!** PgBouncer version is hardcoded in:
- `stacks/primary/compose.yml` (search for `edoburu/pgbouncer`)
- Test files: `scripts/test/test-pgbouncer-*.ts`

**Update procedure**:
1. Check for new edoburu/pgbouncer releases on Docker Hub
2. Update image tag and SHA256 digest in compose.yml
3. Update test files if needed

## Phase 6: Add Tests for New Functionality

**REQUIRED** when upstream has breaking changes or significant new features.

### Test Creation Criteria
- **API signature changed** → Add test verifying new signature works
- **Behavior changed** → Add test verifying new behavior
- **New feature added** → Add test if relevant to our use case
- **Breaking change** → Update existing tests to match new behavior

### Test File Locations
```
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

## Phase 8: Build & Test

```bash
# Build image
bun run build

# REQUIRED: Full test suite (rebuild + all tests, ~45 min)
bun run test:all
```

**Multi-arch verification**: Image builds for both amd64 and arm64 (GitHub Actions handles this).

**NOTE**: `bun run test` (quick test) exists but should NOT be used for updates - always run full `test:all` to verify comprehensive compatibility.

### Build Failure Troubleshooting

**If `bun run build` fails after manifest update:**

```bash
# Step 1: Check Docker build logs for which extension failed
bun run build 2>&1 | grep -A 10 "ERROR\|FAIL"

# Step 2: Identify the failing extension
# Look for: "Building extension: EXTENSION_NAME" before the error

# Step 3: Common failure scenarios and fixes:
```

| Error Pattern | Cause | Fix |
|---------------|-------|-----|
| `No suitable pgrx version found` | pgrx version mismatch for PG18 | Update pgrx fallback in `docker/postgres/build-extensions.ts` (search for `getPgrxVersion`) |
| `Python module not found` | plpython3 missing | Check Dockerfile has `python3-dev` in aptPackages |
| `Missing build dependency` | Extension needs additional package | Add to `build.aptPackages` in manifest |
| `ABI incompatibility` | Extension not compatible with PG18 | Disable extension (set `enabled: false`, add `disabledReason`) |
| `Cargo build failed` | Rust version or feature flag issue | Check extension's `Cargo.toml` for Rust version requirement |
| `configure: error` | Missing C headers/libraries | Add dev packages to aptPackages (e.g., `libssl-dev`) |

**Option A: Fix and rebuild**
```bash
# Update manifest or Dockerfile as needed
bun run generate
bun run build
```

**Option B: Disable incompatible extension**
```typescript
// In manifest-data.ts:
{
  name: "problem_extension",
  enabled: false,
  disabledReason: "Not compatible with PostgreSQL 18. Build fails with: [error message]",
}
```

**Option C: Add build patch** (for minor issues)
```typescript
// In manifest-data.ts:
{
  name: "extension_name",
  build: {
    patches: [
      "sed -i 's/old_pattern/new_pattern/' Makefile",  // Fix Makefile
    ],
  },
}
```

## Phase 9: Update CHANGELOG.md (Image Consumer Focus)

**Rules**:
1. **User-facing changes**: Full detail with migration guidance
2. **Breaking changes**: Separate section with "action required" flag
3. **Internal changes**: One line max, or omit if trivial

**Format**:
```markdown
## [Unreleased]

### Changed (user-facing)
- **pgvector 0.8.1 → 0.9.0**: New HNSW parameters (ef_search default changed from 40 to 100)
- **TimescaleDB 2.24.0**: 4-5× faster recompression, ⚠️ requires bloom filter index rebuild on ARM

### Breaking (action required)
- **pgflow 0.13.0**: Handler signature changed - root steps now receive `(flowInput, ctx)` instead of `(input)`. Update your handler functions.

### Added
- New extension: xyz with feature ABC

### Internal (brief)
- Updated pgrx to 0.16.1, Rust to 1.88.0
```

## Phase 10: Commit

**Conventional commit format**:
- `chore(deps): update Bun dependencies`
- `feat(extensions): upgrade pgvector to 0.9.0 with new HNSW params`
- `fix(postgres): update TimescaleDB to 2.24.0, fixes recompression perf`

**Always include**:
```
Co-Authored-By: Claude <noreply@anthropic.com>
```

**Commit granularity**: One logical change per commit (e.g., one extension update, or all Bun deps).

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

### After Push (Remote Affected)

**NOTE**: Agents DO NOT push. If update breaks **after user pushes to origin/dev**, user should:

```bash
# NEVER force-push! Use revert instead:

# Step 1: Create revert commit
git revert HEAD
# Or revert multiple commits:
git revert HEAD~3..HEAD  # Reverts last 3 commits

# Step 2: Document the revert
git commit --amend -m "Revert failed update: EXTENSION_NAME incompatible with PG18

Original commits reverted:
- abc123: feat(extensions): update EXTENSION_NAME to vX.Y.Z
- def456: chore(deps): update Bun dependencies

Reason: Build failed with ABI incompatibility error.
Will investigate alternative version or disable extension.

Co-Authored-By: Claude <noreply@anthropic.com>"

# Step 3: USER pushes the revert (agents never push!)
# User runs: git push origin dev

# Step 4: Rebuild from reverted state
bun run generate
bun run build
bun run test:all
```

**CRITICAL**:
- **Agents**: NEVER push - always commit locally only
- **Users**: After push, NEVER force-push - use `git revert` instead

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
| **pgflow** | `pgflow@X.Y.Z` | `pgflow@0.13.0` |

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
- Specify output format (e.g., "provide as JSON" or "list as markdown table")

---