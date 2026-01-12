---
name: /update
description: Comprehensive dependency and extension update guide
argument-hint: (optional additional notes)
id: p-update
category: project
tags: [project, update, maintenance]
---

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
# Update all dependencies to latest versions
bun update --latest

# Validate immediately
bun run validate
```

## Phase 3: Base Image (Only if PostgreSQL Version Changes)

```bash
# Get latest base image SHA
docker pull postgres:18.X-trixie
SHA=$(docker inspect postgres:18.X-trixie --format '{{index .RepoDigests 0}}')

# Update manifest-data.ts (search for MANIFEST_METADATA)
# Change TWO fields:
# - pgVersion: "18.X"
# - baseImageSha: "postgres:18.X-trixie@sha256:..."

# Verify format includes @sha256: prefix
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
# Find dependents
grep -B 3 "dependencies:.*EXTENSION_NAME" scripts/extensions/manifest-data.ts | grep 'name:'

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

## Phase 8: Build & Test

```bash
# Build image
bun run build

# REQUIRED: Full test suite (rebuild + all tests, ~45 min)
bun run test:all
```

**Multi-arch verification**: Image builds for both amd64 and arm64 are verified in GitHub Actions after the user pushes changes. Agents should ensure local tests pass before committing.

**NOTE**: `bun run test` (quick test) exists but should NOT be used for updates - always run full `test:all` to verify comprehensive compatibility.

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

### Development (non-image)
- Updated pgrx to 0.16.1, Rust to 1.88.0
```

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
- Specify output format (e.g., "provide as JSON" or "list as Markdown table")

Don't blindly 100% trust the results from agents. Sometimes they could do the job in the wrong way because they often have weaker models. They could also be too-narrow-minded, so verify.

---
