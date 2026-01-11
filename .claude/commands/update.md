---
name: /update
description: Comprehensive dependency and extension update guide
argument-hint: (optional additional notes)
agent: plan
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
# Get latest base image SHA
docker pull postgres:18.X-trixie
SHA=$(docker inspect postgres:18.X-trixie --format '{{index .RepoDigests 0}}')

# Update manifest-data.ts
# Change MANIFEST_METADATA.pgVersion and baseImageSha
```

## Phase 4: Extensions (BY SOURCE TYPE)

**CRITICAL**: Update in dependency order (dependencies BEFORE dependents).

### Dependency Graph
```typescript
// Check these before updating (update dependencies BEFORE their dependents):
vector → vectorscale
hypopg → index_advisor
pg_stat_statements → wrappers
postgis → pgrouting
pgsodium → supabase_vault
pgmq, pg_net, pg_cron, supabase_vault → pgflow
timescaledb → timescaledb_toolkit
```

### ⚠️ CRITICAL: Dependency Compatibility

**BEFORE updating any extension that has dependents, verify compatibility:**

1. **Check dependent requirements** - Read dependent's docs/changelog for version requirements
2. **Major version changes** - Breaking API changes may break dependents (e.g., vector 0.8→0.9 may break vectorscale)
3. **Test after updates** - Run specific tests for dependent extensions after updating their dependencies
4. **Update together** - If incompatible, update dependency + dependent together in same session

**Examples:**
- Updating `vector`: Check if `vectorscale` supports new version
- Updating `pgsodium`: Verify `supabase_vault` compatibility
- Updating `pgmq/pg_net/pg_cron`: Check `pgflow` requirements

**If incompatible**: Either skip update OR update both dependency + dependent together.

### PGDG Extensions (14 total)

Update BOTH `source.tag` AND `pgdgVersion`:

```typescript
{
  name: "vector",
  source: { type: "git", tag: "v0.9.0" },        // ← Update tag
  pgdgVersion: "0.9.0-2.pgdg13+1",               // ← Update version string
}
```

**PGDG version format**: `{version}-{build}.pgdg{debian_ver}+{revision}`
- Example: `0.8.1-2.pgdg13+1`
- The `pgdg13` refers to Debian version, NOT PostgreSQL!

### Percona Extensions (2 total: pg_stat_monitor, wal2json)

Update BOTH `source.tag` AND `perconaVersion`:

```typescript
{
  name: "pg_stat_monitor",
  source: { type: "git", tag: "2.4.0" },          // ← Update tag
  perconaVersion: "1:2.4.0-2.trixie",             // ← Note epoch prefix!
}
```

**Percona version format**: `[epoch:]version-build.distro`
- Epochs matter for version comparison: `1:2.0` > `2.0`
- Example: `1:2.3.1-2.trixie`

### Timescale Extensions (2 total: timescaledb, timescaledb_toolkit)

Update BOTH `source.tag` AND `timescaleVersion`:

```typescript
{
  name: "timescaledb",
  source: { type: "git", tag: "2.25.0" },         // ← Update tag
  timescaleVersion: "2.25.0~debian13-1801",       // ← Note tilde format!
}
```

**Timescale version format**: `version~distro-pgversion`
- Example: `2.24.0~debian13-1801`

### GitHub Release Extensions (1 total: vectorscale)

Update BOTH `source.tag` AND `githubReleaseTag` (must match):

```typescript
{
  name: "vectorscale",
  source: { type: "git", tag: "0.10.0" },         // ← Update tag
  githubReleaseTag: "0.10.0",                     // ← Must match!
}
```

**VERIFY**: GitHub release has assets for BOTH amd64 and arm64:
- Pattern: `pgvectorscale-{version}-pg{pgMajor}-{arch}.zip`

### Source-Only Extensions (17 total)

Update ONLY `source.tag`:

```typescript
{
  name: "pgmq",
  source: { type: "git", tag: "v1.9.0" },         // ← Only this field
}
```

### Builtin Extensions (6 total)

**No manual updates required** - Builtin extensions (adminpack, amcheck, btree_gin, btree_gist, citext, pg_stat_statements) are part of PostgreSQL core and update automatically with the base image (Phase 3).

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

# Step 4: Update Dockerfile.template line 244
# Change: COPY tests/fixtures/pgflow/schema-vX.Y.Z.sql

# Step 5: Update 05-pgflow-init.sh version comments (lines 2, 60)
# Currently shows v0.11.0 but should be v0.13.0 (BUG!)

# Step 6: Delete old schema file
rm tests/fixtures/pgflow/schema-v0.13.0.sql

# Step 7: Regenerate and test
bun run generate
bun run test:pgflow
```

### 5.2: git-ref Extensions (Manual Review Required)

These use commit SHAs instead of tags:

| Extension | Current Status | Action |
|-----------|---------------|--------|
| `pg_jsonschema` | `7c8603f...` | Check upstream for new PG18 stable tag |
| `pg_hashids` | `8c404dd...` | Check if v1.3 released yet |
| `pg_plan_filter` | `5081a7b...` | DISABLED - incompatible with PG18 |

**If upstream now has stable tags**, migrate from `git-ref` to `git`:

```typescript
// FROM:
source: { type: "git-ref", repository: "...", ref: "abc123..." }

// TO:
source: { type: "git", repository: "...", tag: "v1.0.0" }
```

### 5.3: cargo-pgrx Extensions (Rust Version Alignment)

Extensions using Rust pgrx framework:
- `wrappers` (Supabase FDW framework)
- `pg_jsonschema` (JSON Schema validation)

**Requirements**:
- pgrx 0.16.1 for PostgreSQL 18
- Rust 1.88.0+
- Feature flag: `features: ["pg18"]`

**If pgrx version changes**: Update hardcoded fallback in `docker/postgres/build-extensions.ts` line 282.

### 5.4: Disabling Unmaintained Extensions

If an extension becomes incompatible (like `pg_plan_filter`):

```typescript
{
  name: "pg_plan_filter",
  enabled: false,
  disabledReason: "Not compatible with PostgreSQL 18. Last updated for PG13 (2021). Maintainer inactive.",
}
```

### 5.5: PgBouncer Image (Outside Manifest)

**Not in manifest-data.ts!** Hardcoded in:
- `stacks/primary/compose.yml` line 48: `edoburu/pgbouncer:v1.24.1-p1@sha256:...`
- Test files: `scripts/test/test-pgbouncer-*.ts`

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

# Fast validation (static checks + unit tests)
bun run validate

# Full validation (includes shellcheck, hadolint, yamllint)
bun run validate:all
```

## Phase 8: Build & Test

```bash
# Build image
bun run build

# Quick test (skip rebuild)
bun run test

# Full test suite (rebuild + all 48 checks, ~45 min)
bun run test:all
```

**Multi-arch verification**: Image builds for both amd64 and arm64 (GitHub Actions handles this).

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

If update breaks:

```bash
# Discard uncommitted changes
git checkout -- .

# Revert last commit
git revert HEAD

# Nuclear option: reset to known good state
git reset --hard <known-good-commit>

# Rebuild
bun run generate
bun run build
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
| **Percona apt** | Need container with `percona-release setup ppg-18` |
| **Timescale apt** | Need container with Timescale repo configured |

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

# Known Bugs to Fix

**BUG**: `docker/postgres/docker-entrypoint-initdb.d/05-pgflow-init.sh` shows `v0.11.0` but manifest has `pgflow@0.13.0`:
- Line 2: `# pgflow v0.11.0 Schema Initialization`
- Line 60: `echo "[05-pgflow] pgflow v0.11.0 schema installed successfully"`

**Fix during next pgflow update** or separately.
