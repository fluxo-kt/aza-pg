# Version Management Guide

**Single source guide for updating PostgreSQL, extensions, and tools in the aza-pg codebase.**

This guide is for **updating version declarations** in the source code. For runtime upgrade procedures (production deployments), see [UPGRADING.md](UPGRADING.md).

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Quick Reference](#quick-reference)
- [Step-by-Step Update Procedures](#step-by-step-update-procedures)
- [Version Source Locations](#version-source-locations)
- [Finding Latest Versions](#finding-latest-versions)
- [Validation & Testing](#validation-testing)
- [Common Issues](#common-issues)

---

## Architecture Overview

### Single Source of Truth Design

The aza-pg project uses **one authoritative source** for all version information:

**`scripts/extensions/manifest-data.ts`** - The single source of truth

- **MANIFEST_METADATA**: PostgreSQL version and base image SHA
- **MANIFEST_ENTRIES**: All extensions with git sources AND pgdgVersion fields
- Covers: All 39+ extensions and tools

**How it works:**

- Each extension entry defines its git source (repository, tag/ref)
- PGDG-installed extensions additionally include a `pgdgVersion` field
- The `pgdgVersion` semantic version MUST match the `source.tag` version
- Version consistency is automatically validated at build time

**Generated artifacts** (never edit directly):

- `scripts/extension-defaults.ts` - Auto-generated from manifest (for backward compatibility)
- `docker/postgres/Dockerfile` - Auto-generated from template + manifest
- `docker/postgres/extensions.*.manifest.json` - Auto-generated with resolved commits
- `docs/.generated/docs-data.json` - Auto-generated reference documentation

**Why this design?** Previous dual-source architecture led to version drift (e.g., plpgsql_check v2.8.3 in manifest vs 2.8.4 in extension-defaults). Consolidating to a single source eliminates this class of bugs entirely.

---

## Quick Reference

### When to Update Which File

| What to Update                           | File               | Field                                |
| ---------------------------------------- | ------------------ | ------------------------------------ |
| PostgreSQL version                       | `manifest-data.ts` | `MANIFEST_METADATA.pgVersion`        |
| PostgreSQL base image SHA                | `manifest-data.ts` | `MANIFEST_METADATA.baseImageSha`     |
| PGDG extension version (13 total)        | `manifest-data.ts` | Entry's `pgdgVersion` field          |
| Git-based extension tags/refs (39 total) | `manifest-data.ts` | Entry's `source.tag` or `source.ref` |
| Bun version                              | `.tool-versions`   | `bun X.Y.Z`                          |

**⚠️ NEVER edit `scripts/extension-defaults.ts`** - it's auto-generated from manifest-data.ts

**After ANY change:** Run `bun run generate` to propagate updates to Dockerfile, extension-defaults.ts, and manifests.

---

## Step-by-Step Update Procedures

### Procedure 1: Update PostgreSQL Base Version

**Example:** Update from PostgreSQL 18.1 to 18.2

#### Step 1: Find Latest Version and SHA

```bash
# Check Docker Hub for latest postgres:18.x-trixie
# Visit: https://hub.docker.com/_/postgres/tags?name=18

# Find the manifest digest (SHA256) for postgres:18.2-trixie
# Example SHA: sha256:abc123...
```

Or use Docker CLI:

```bash
docker pull postgres:18.2-trixie
docker inspect postgres:18.2-trixie | grep -A 10 RepoDigests
```

#### Step 2: Update manifest-data.ts

```typescript
// File: scripts/extensions/manifest-data.ts (top of file)
export const MANIFEST_METADATA = {
  pgVersion: "18.2", // ← Update this
  baseImageSha: "sha256:abc123...", // ← Update this (full sha256:HASH format)
} as const;
```

#### Step 3: Regenerate and Validate

```bash
# Regenerate all artifacts (Dockerfile, extension-defaults.ts, manifests)
bun run generate

# Verify changes
git diff docker/postgres/Dockerfile scripts/extension-defaults.ts

# Validate (fast checks)
bun run validate

# Build and test locally
bun run build
cd stacks/single && docker compose up -d
```

#### Step 4: Commit Changes

```bash
git add scripts/extensions/manifest-data.ts scripts/extension-defaults.ts docker/
git commit -m "deps(postgres): update base image to 18.2"
```

---

### Procedure 2: Update PGDG Extension Version

**Example:** Update pgvector from 0.8.0 to 0.8.1

PGDG extensions are pre-compiled Debian packages. 13 extensions use this method:

- pgvector, pg_cron, pgaudit, postgis, pg_partman, pg_repack, plpgsql_check, hll, http, hypopg, pgrouting, rum, set_user

#### Step 1: Find Latest PGDG Version

PGDG versions follow format: `SEMANTIC_VERSION-DEBIAN_RELEASE.pgdgREPO+BUILD`

Example: `0.8.1-2.pgdg13+1` means:

- Semantic version: 0.8.1
- Debian release: 2
- PGDG repository: 13+ (Debian Bullseye)
- Build number: 1

**How to check latest PGDG version:**

```bash
# Method 1: Check in Docker container with PGDG repo
docker run --rm postgres:18-trixie bash -c "
  apt-get update -qq && \
  apt-cache policy postgresql-18-pgvector | grep Candidate
"

# Method 2: Check PGDG package repository
# Visit: https://apt.postgresql.org/pub/repos/apt/dists/trixie-pgdg/
# Or search: apt.postgresql.org package list
```

#### Step 2: Update manifest-data.ts (Both Fields!)

**CRITICAL:** Update BOTH `source.tag` AND `pgdgVersion` in the same entry. Version consistency is automatically validated.

```typescript
// File: scripts/extensions/manifest-data.ts
{
  name: "vector",
  source: {
    type: "git",
    repository: "https://github.com/pgvector/pgvector.git",
    tag: "v0.8.1",  // ← Update git tag (prefix with "v" if repo uses it)
  },
  install_via: "pgdg",
  pgdgVersion: "0.8.1-2.pgdg13+1",  // ← Update PGDG version (semantic must match tag!)
  // ...
}
```

**Validation:** The semantic version from `pgdgVersion` (e.g., "0.8.1") must match `source.tag` (e.g., "v0.8.1"). This is enforced by `validate-pgdg-versions.ts`.

#### Step 3: Regenerate and Validate

```bash
bun run generate
bun run validate  # Automatically runs PGDG version validation
git diff docker/postgres/Dockerfile scripts/extension-defaults.ts
```

#### Step 4: Commit Changes

```bash
git add scripts/extensions/manifest-data.ts scripts/extension-defaults.ts docker/
git commit -m "deps(pgvector): update to 0.8.1"
```

---

### Procedure 3: Update Source-Built Extension (Git Tag)

**Example:** Update pgbackrest from 2.57.0 to 2.58.0

Non-PGDG extensions are built from source. This includes:

- Tools: pgbackrest, pgbadger, wal2json
- Cargo-pgrx: wrappers, pg_jsonschema, timescaledb_toolkit
- GitHub Release: vectorscale
- Others: pgroonga, pgsodium, pgmq, etc.

#### Step 1: Find Latest Git Tag

```bash
# Visit GitHub releases page
# Example: https://github.com/pgbackrest/pgbackrest/releases

# Or use git CLI
git ls-remote --tags https://github.com/pgbackrest/pgbackrest.git | grep release
```

#### Step 2: Update manifest-data.ts

```typescript
// File: scripts/extensions/manifest-data.ts
{
  name: "pgbackrest",
  kind: "tool",
  source: {
    type: "git",
    repository: "https://github.com/pgbackrest/pgbackrest.git",
    tag: "release/2.58.0",  // ← Update this
  },
  // ...
}
```

#### Step 3: Regenerate Manifests

```bash
# This resolves git tags to commit SHAs and generates manifests
bun run generate

# Verify resolved commit SHA
cat docker/postgres/extensions.manifest.json | jq '.[] | select(.name=="pgbackrest")'
```

#### Step 4: Validate and Test

```bash
bun run validate

# Build to test compilation
bun run build
```

#### Step 5: Commit Changes

```bash
git add scripts/extensions/manifest-data.ts docker/postgres/extensions.*.manifest.json
git commit -m "deps(pgbackrest): update to 2.58.0"
```

---

### Procedure 4: Update Cargo-pgrx Extension

**Example:** Update supabase wrappers from git-ref to stable tag

Cargo-pgrx extensions use Rust and require special handling:

- wrappers, pg_jsonschema, timescaledb_toolkit

**Key consideration:** pgrx framework version must align with PostgreSQL version.

#### Step 1: Check pgrx Compatibility

```bash
# Visit: https://github.com/pgcentralfoundation/pgrx/releases
# Verify pgrx version supports PostgreSQL 18

# Current project uses: pgrx 0.16.1 (hardcoded in pg_jsonschema patches)
```

#### Step 2: Find Latest Extension Release

```bash
# Example: supabase wrappers
# Visit: https://github.com/supabase/wrappers/releases
# Latest: v0.5.6

# Check if it specifies pgrx version in Cargo.toml
```

#### Step 3: Update manifest-data.ts

For stable releases, prefer tags over git-ref:

```typescript
// BEFORE (using git-ref):
{
  name: "wrappers",
  source: {
    type: "git-ref",
    repository: "https://github.com/supabase/wrappers.git",
    ref: "303da1dd0e7a94365ecf5d48866739fe9fda4d07",
  },
  // ...
}

// AFTER (using stable tag):
{
  name: "wrappers",
  source: {
    type: "git",
    repository: "https://github.com/supabase/wrappers.git",
    tag: "v0.5.6",  // ← Use stable tag instead
  },
  // ...
}
```

#### Step 4: Update pgrx Patches (if needed)

If extension requires specific pgrx version:

```typescript
build: {
  type: "cargo-pgrx",
  patches: [
    's/pgrx = "0\\.16\\.0"/pgrx = "=0.16.1"/',  // ← Update if needed
  ],
}
```

#### Step 5: Regenerate and Test

```bash
bun run generate

# Cargo builds are slow - test locally first
bun run build

# Verify extension loads
cd stacks/single && docker compose up -d
docker compose exec postgres psql -U postgres -c "CREATE EXTENSION wrappers;"
```

#### Step 6: Commit Changes

```bash
git add scripts/extensions/manifest-data.ts docker/postgres/extensions.*.manifest.json
git commit -m "deps(wrappers): update to stable tag v0.5.6"
```

---

### Procedure 5: Update GitHub Release Extension

**Example:** Update pgvectorscale from 0.9.0 to 0.10.0

GitHub release extensions use pre-built binaries from GitHub releases:

- vectorscale (pgvectorscale)

**Key consideration:** PG18 assets must be available for both amd64 and arm64.

#### Step 1: Check for New Releases

```bash
# Visit: https://github.com/timescale/pgvectorscale/releases
# Or use git:
git ls-remote --tags https://github.com/timescale/pgvectorscale.git | grep -v '\^{}' | sort -V | tail -5
```

#### Step 2: Verify PG18 Assets Exist

**CRITICAL:** Confirm assets exist for both architectures:

- `pgvectorscale-0.10.0-pg18-amd64.zip`
- `pgvectorscale-0.10.0-pg18-arm64.zip`

If assets don't exist, stay on current version.

#### Step 3: Update manifest-data.ts (BOTH Fields!)

```typescript
{
  name: "vectorscale",
  install_via: "github-release",
  githubRepo: "timescale/pgvectorscale",
  githubReleaseTag: "0.10.0",  // ← Update this
  githubAssetPattern: "pgvectorscale-{version}-pg{pgMajor}-{arch}.zip",
  soFileName: "vectorscale.so",
  source: {
    type: "git",
    repository: "https://github.com/timescale/pgvectorscale.git",
    tag: "0.10.0",  // ← MUST match githubReleaseTag!
  },
}
```

#### Step 4: Regenerate and Validate

```bash
bun run generate
bun run validate:all
```

#### Step 5: Build and Test

```bash
bun run build

cd stacks/single && docker compose down -v && docker compose up -d
docker compose exec postgres psql -U postgres -c "
  CREATE EXTENSION vector;
  CREATE EXTENSION vectorscale;
  SELECT * FROM pg_extension WHERE extname = 'vectorscale';
"
```

#### Step 6: Commit Changes

```bash
git add scripts/extensions/manifest-data.ts docker/postgres/extensions.*.manifest.json
git commit -m "deps(vectorscale): update to 0.10.0"
```

---

### Procedure 6: Bulk Update All Extensions

**Systematic approach for updating all extensions at once**

#### Step 1: Create Update Checklist

```bash
# Generate list of all extensions with current versions
cat scripts/extensions/manifest-data.ts | grep -E '(name:|tag:|ref:)' > versions-current.txt
```

#### Step 2: Check Each Extension Upstream

For each extension, visit GitHub releases:

| Extension | Current | Latest | Status        | GitHub URL                   |
| --------- | ------- | ------ | ------------- | ---------------------------- |
| pgvector  | v0.8.0  | v0.8.0 | ✅ Up-to-date | github.com/pgvector/pgvector |
| pg_cron   | v1.6.7  | v1.6.7 | ✅ Up-to-date | github.com/citusdata/pg_cron |
| ...       |         |        |               |                              |

#### Step 3: Update in Batches

Group updates by type to minimize risk:

**Batch 1: PGDG Extensions** (fast, low risk)

```bash
# Update extension-defaults.ts for all 14 PGDG extensions
# Regenerate and test
bun run generate && bun run validate
```

**Batch 2: Source-Built Extensions** (moderate risk)

```bash
# Update manifest-data.ts for PGXS extensions
bun run generate && bun run validate
```

**Batch 3: Cargo-pgrx Extensions** (slow builds, higher risk)

```bash
# Update cargo-pgrx extensions last
# These require full Rust compilation
bun run generate && bun run build
```

#### Step 4: Test Each Batch

```bash
# After each batch:
cd stacks/single
docker compose down -v
docker compose up -d

# Verify extensions load
docker compose exec postgres psql -U postgres -c "\dx"
```

#### Step 5: Commit Incrementally

```bash
# Commit after each successful batch
git add -p
git commit -m "deps(batch1): update PGDG extensions to latest"
```

---

## Version Source Locations

### Primary Source (Edit This)

**File:** `scripts/extensions/manifest-data.ts` — THE SINGLE SOURCE OF TRUTH

#### 1. MANIFEST_METADATA: PostgreSQL Base Version

```typescript
export const MANIFEST_METADATA = {
  pgVersion: "18.1", // PostgreSQL semantic version
  baseImageSha:
    "sha256:5ec39c188013123927f30a006987c6b0e20f3ef2b54b140dfa96dac6844d883f",
} as const;
```

#### 2. MANIFEST_ENTRIES: All Extensions & Tools

```typescript
export const MANIFEST_ENTRIES: ManifestEntry[] = [
  // PGDG extension example (has pgdgVersion):
  {
    name: "vector",
    kind: "extension",
    source: {
      type: "git",
      repository: "https://github.com/pgvector/pgvector.git",
      tag: "v0.8.0",
    },
    install_via: "pgdg",
    pgdgVersion: "0.8.0-1.pgdg13+1", // Must match source.tag semantically!
    // ...
  },
  // Source-built extension example (no pgdgVersion):
  {
    name: "pgbackrest",
    kind: "tool",
    source: {
      type: "git",
      repository: "https://github.com/pgbackrest/pgbackrest.git",
      tag: "release/2.57.0",
    },
    // ... no pgdgVersion (built from source)
  },
  // ... 37 more entries
];
```

**Source types:**

- `type: "git"` with `tag: "v1.2.3"` - Stable releases (preferred)
- `type: "git-ref"` with `ref: "abc123..."` - Commit SHA (for unreleased fixes)
- `type: "builtin"` - PostgreSQL built-in extensions (no source)

**Install methods:**

- `install_via: "pgdg"` - Pre-compiled from PGDG repository (requires `pgdgVersion`)
- `install_via: "source"` - Built from git source (PGXS, cargo-pgrx, cmake, meson)

**Propagates to:**

- `scripts/extension-defaults.ts` - AUTO-GENERATED for backward compatibility
- `docker/postgres/Dockerfile` - Version hardcoded at generation time
- `docker/postgres/extensions.manifest.json` - With resolved commit SHAs
- `docker/postgres/extensions.pgxs.manifest.json` - Filtered for PGXS builds
- `docker/postgres/extensions.cargo.manifest.json` - Filtered for cargo-pgrx builds

---

#### 3. Build Tool Versions

**File:** `.tool-versions` (asdf/mise format)

```
bun 1.3.5
```

**Other build tools** (not pinned, use system packages):

- Rust/Cargo: Latest stable via rustup
- CMake, Meson, Ninja: From Debian apt repositories

---

### Generated Artifacts (Never Edit Directly)

#### 1. Extension Defaults (Backward Compatibility)

**File:** `scripts/extension-defaults.ts`

**Generated from:** `manifest-data.ts` (MANIFEST_METADATA + pgdgVersion fields)

**Generation:** `bun scripts/extensions/generate-extension-defaults.ts`

**Purpose:** Provides backward-compatible interface for Dockerfile generation and workflows. Contains the same data as manifest-data.ts in a flat structure.

**⚠️ WARNING:** This file has an AUTO-GENERATED banner. Never edit directly.

---

#### 2. Dockerfile

**File:** `docker/postgres/Dockerfile`

**Generated from:** `docker/postgres/Dockerfile.template` + `manifest-data.ts` (via extension-defaults.ts)

**Generation:** `bun scripts/docker/generate-dockerfile.ts`

**Contains (hardcoded at generation time):**

- PG_VERSION (e.g., `18.1`) - from MANIFEST_METADATA.pgVersion
- PG_BASE_IMAGE_SHA (e.g., `sha256:...`) - from MANIFEST_METADATA.baseImageSha
- PGDG package versions (e.g., `postgresql-18-pgvector=0.8.1-2.pgdg13+1`) - from pgdgVersion fields
- Metadata ARGs: `BUILD_DATE` and `VCS_REF` (no defaults - passed at build time)

**Note:** Version dependencies are NOT ARGs (cannot be overridden at build time). They are hardcoded in the FROM statement and package installation commands during Dockerfile generation.

---

#### 3. Extension Manifests

**Files:**

- `docker/postgres/extensions.manifest.json` (all 39 extensions)
- `docker/postgres/extensions.pgxs.manifest.json` (PGXS builds)
- `docker/postgres/extensions.cargo.manifest.json` (cargo-pgrx builds)

**Generated from:** `manifest-data.ts` with git commit resolution

**Generation:** `bun scripts/extensions/generate-manifest.ts`

**Contains:** Same data as manifest-data.ts but with resolved git commits:

```json
{
  "name": "vector",
  "source": {
    "type": "git",
    "repository": "https://github.com/pgvector/pgvector.git",
    "tag": "v0.8.0",
    "commit": "5bc3f36df8f71399a2f3da18d5bb1c2d90f28d03"
  }
}
```

---

## Finding Latest Versions

### PostgreSQL Base Image

**Source:** Docker Hub official postgres images

**URL:** https://hub.docker.com/_/postgres/tags

**Check latest:**

```bash
# List all 18.x-trixie tags
curl -s "https://hub.docker.com/v2/repositories/library/postgres/tags?page_size=100" | \
  jq -r '.results[] | select(.name | test("^18\\.[0-9]+-trixie$")) | .name'

# Get SHA for specific version
docker pull postgres:18.2-trixie
docker inspect postgres:18.2-trixie --format '{{index .RepoDigests 0}}'
```

**Also check:** [PostgreSQL Release Notes](https://www.postgresql.org/docs/current/release.html)

---

### PGDG Extension Versions

**Source:** PostgreSQL APT Repository (PGDG)

**URL:** https://apt.postgresql.org/pub/repos/apt/

**Check latest:**

```bash
# Method 1: Use Docker with PGDG repo
docker run --rm postgres:18-trixie bash -c "
  echo 'deb http://apt.postgresql.org/pub/repos/apt trixie-pgdg main' > /etc/apt/sources.list.d/pgdg.list && \
  apt-get update -qq && \
  apt-cache policy postgresql-18-pgvector
"

# Method 2: Browse package index
# Visit: https://apt.postgresql.org/pub/repos/apt/dists/trixie-pgdg/main/binary-amd64/Packages
# Search for: Package: postgresql-18-<extension>
```

**Package name format:** `postgresql-18-<extension>`

Examples:

- pgvector: `postgresql-18-pgvector`
- pg_cron: `postgresql-18-cron`
- pgaudit: `postgresql-18-pgaudit`

---

### Git-Based Extension Versions

**Source:** GitHub Releases

**For each extension, visit:**

| Extension           | GitHub Releases URL                                       |
| ------------------- | --------------------------------------------------------- |
| pgvector            | https://github.com/pgvector/pgvector/releases             |
| pg_cron             | https://github.com/citusdata/pg_cron/releases             |
| pgaudit             | https://github.com/pgaudit/pgaudit/releases               |
| timescaledb         | https://github.com/timescale/timescaledb/releases         |
| postgis             | https://github.com/postgis/postgis/releases               |
| pg_partman          | https://github.com/pgpartman/pg_partman/releases          |
| pg_repack           | https://github.com/reorg/pg_repack/releases               |
| plpgsql_check       | https://github.com/okbob/plpgsql_check/releases           |
| pgroonga            | https://github.com/pgroonga/pgroonga/releases             |
| pgsodium            | https://github.com/michelp/pgsodium/releases              |
| supabase_vault      | https://github.com/supabase/vault/releases                |
| pgmq                | https://github.com/tembo-io/pgmq/releases                 |
| wrappers            | https://github.com/supabase/wrappers/releases             |
| pg_jsonschema       | https://github.com/supabase/pg_jsonschema/releases        |
| timescaledb_toolkit | https://github.com/timescale/timescaledb-toolkit/releases |
| vectorscale         | https://github.com/timescale/pgvectorscale/releases       |
| pgbackrest          | https://github.com/pgbackrest/pgbackrest/releases         |
| pgbadger            | https://github.com/darold/pgbadger/releases               |

**CLI check:**

```bash
# Get latest tag for any repo
git ls-remote --tags https://github.com/pgvector/pgvector.git | \
  grep -v '\^{}' | \
  sort -V | \
  tail -n 1
```

**Also check:** Release notes for PostgreSQL compatibility

---

## Validation & Testing

### Validation Levels

#### Level 1: Fast Checks (2-5 minutes)

```bash
bun run validate
```

Runs:

- Linting (oxlint, prettier, shellcheck, hadolint, yamllint)
- TypeScript type checking
- Manifest sync validation
- SHA validation (checks Docker Hub)

**Use for:** Quick verification during development

---

#### Level 2: Full Validation (5-10 minutes)

```bash
bun run validate:all
```

Runs:

- All Level 1 checks
- Extended linting rules
- Additional validation scripts
- Comprehensive type checking

**Use for:** Before committing changes

---

#### Level 3: Build Test (30-60 minutes)

```bash
bun run build
```

Builds Docker image with all extensions.

**Use for:** Verifying compilation works after version updates

**Note:** Cargo-pgrx extensions add significant build time (20-30 min)

---

#### Level 4: Runtime Test (10-15 minutes)

```bash
cd stacks/single
docker compose down -v
docker compose up -d

# Wait for PostgreSQL ready
bun scripts/test/wait-for-postgres.ts

# Test extension loading
docker compose exec postgres psql -U postgres -c "
  CREATE EXTENSION vector;
  CREATE EXTENSION pg_cron;
  CREATE EXTENSION pgaudit;
  -- Test other critical extensions
"
```

**Use for:** Verifying extensions load and function correctly

---

### Automated Validation (CI/CD)

**Workflow:** `.github/workflows/ci.yml`

Runs on every PR:

- Fast validation (lint, type check, manifest sync)
- SHA verification
- ~5 minutes total

**Workflow:** `.github/workflows/publish.yml`

Runs on `release` branch push:

- Full build (all extensions)
- Image scanning (Trivy)
- Cryptographic signing (Cosign)
- Push to ghcr.io/fluxo-kt/aza-pg

---

## Common Issues

### Issue 1: pgvector Version Mismatch

**Symptom:**

```
Error: Unable to find tag v0.8.1 in repository
```

**Cause:** Tag doesn't exist upstream (e.g., v0.8.1 when latest is v0.8.0)

**Fix:**

```bash
# Check GitHub releases
# Update manifest-data.ts to actual tag
# Update extension-defaults.ts to matching PGDG version
bun run generate
```

---

### Issue 2: PGDG Package Not Found

**Symptom:**

```
E: Unable to locate package postgresql-18-pgvector=0.8.1-2.pgdg13+1
```

**Cause:** PGDG version in extension-defaults.ts doesn't match available packages

**Fix:**

```bash
# Check actual PGDG version
docker run --rm postgres:18-trixie bash -c "
  apt-get update && apt-cache policy postgresql-18-pgvector
"

# Update extension-defaults.ts with correct version
bun run generate
```

---

### Issue 3: Cargo-pgrx Compilation Failure

**Symptom:**

```
error: failed to compile pg_jsonschema
error: pgrx version mismatch
```

**Cause:** Extension requires different pgrx version than patched

**Fix:**

```typescript
// In manifest-data.ts, update patches:
patches: [
  's/pgrx = "0\\.17\\.0"/pgrx = "=0.16.1"/', // Match your pgrx version
];
```

Or update to extension version that supports current pgrx.

---

### Issue 4: Git Commit SHA Resolution Failed

**Symptom:**

```
Error: Unable to resolve tag v1.2.3 to commit SHA
```

**Cause:** Network issue or tag doesn't exist

**Fix:**

```bash
# Verify tag exists
git ls-remote https://github.com/owner/repo.git refs/tags/v1.2.3

# If tag missing, check releases page for correct tag name
# Update manifest-data.ts with correct tag
```

---

### Issue 5: Workflow Defaults Out of Sync

**Symptom:** Build workflow uses different versions than local builds

**Cause:** Workflow input defaults hardcoded separately from extension-defaults.ts

**Fix:** Use programmatic extraction:

```yaml
# In .github/workflows/build-postgres-image.yml
- name: Extract defaults
  run: |
    DEFAULTS=$(bun scripts/extension-defaults.ts json)
    echo "PG_VERSION=$(echo $DEFAULTS | jq -r .pgVersion)" >> $GITHUB_ENV
```

Or keep workflow defaults in sync manually (documented in comments).

---

## Maintenance Checklist

### Monthly

- [ ] Check PostgreSQL releases for new minor versions
- [ ] Check PGDG packages for updates (14 extensions)
- [ ] Review GitHub security advisories for used extensions

### Quarterly

- [ ] Systematically check all 50+ extensions for updates
- [ ] Review deprecated extensions (consider removal)
- [ ] Update documentation for any breaking changes
- [ ] Test full build and runtime validation

### Before Major PostgreSQL Version Upgrade

- [ ] Verify all extensions support new PostgreSQL version
- [ ] Check cargo-pgrx compatibility with new version
- [ ] Test full upgrade path in staging environment
- [ ] Update documentation with breaking changes
- [ ] Plan rollback procedure

---

## Resources

### Official Documentation

- [PostgreSQL Release Notes](https://www.postgresql.org/docs/current/release.html)
- [PGDG APT Repository](https://wiki.postgresql.org/wiki/Apt)
- [Docker Official Images - postgres](https://github.com/docker-library/docs/blob/master/postgres/README.md)

### Extension Resources

- [PostgreSQL Extension Network (PGXN)](https://pgxn.org/)
- [cargo-pgrx Documentation](https://github.com/pgcentralfoundation/pgrx)
- [Extension Compatibility Matrix](https://www.postgresql.org/support/versioning/)

### Internal Documentation

- [UPGRADING.md](UPGRADING.md) - Runtime upgrade procedures
- [BUILD.md](BUILD.md) - Build system documentation
- [ARCHITECTURE.md](ARCHITECTURE.md) - System design
- [AGENTS.md](../AGENTS.md) - Development guide

---

## Summary

**Single source of truth:** `scripts/extensions/manifest-data.ts`

- `MANIFEST_METADATA` for PostgreSQL version and base image SHA
- `MANIFEST_ENTRIES[].pgdgVersion` for PGDG packages (13 extensions)
- `MANIFEST_ENTRIES[].source.tag/ref` for all 39 extensions

**Update workflow:**

1. Edit version in `manifest-data.ts` (both `source.tag` AND `pgdgVersion` for PGDG extensions)
2. Run `bun run generate` to propagate to extension-defaults.ts, Dockerfile, and manifests
3. Run `bun run validate` to verify (includes automatic PGDG version consistency check)
4. Commit changes (both source and generated files)

**⚠️ NEVER edit `scripts/extension-defaults.ts`** — it's auto-generated from manifest-data.ts

**Key principle:** Generated artifacts are committed to git for reproducibility. Always regenerate after version changes. Version consistency between `source.tag` and `pgdgVersion` is enforced automatically.
