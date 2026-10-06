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

- **MANIFEST_METADATA**: PostgreSQL version, base image SHA, Rust toolchain and builder image digests
- **MANIFEST_ENTRIES**: every extension and tool: git source, plus `pgdgVersion` / `perconaVersion` / `timescaleVersion` for apt installs
- Covers: every extension and tool

**How it works:**

- Each extension entry defines its git source (repository, tag/ref)
- PGDG-installed extensions additionally include a `pgdgVersion` field
- The `pgdgVersion` semantic version MUST match the `source.tag` version
- `bun run validate` checks each `pgdgVersion` against the PGDG repo; the tag/version pair is kept in step by hand

**Generated artifacts** (never edit directly):

- `docker/postgres/Dockerfile` - Auto-generated from template + manifest
- `docker/postgres/extensions.*.manifest.json` - Auto-generated with resolved commits
- `docs/.generated/docs-data.json` - Auto-generated reference documentation

**Why this design?** Any copy of manifest data (a generated defaults file, a side table keyed by extension name) drifts from the manifest unnoticed. Generators and validators therefore read `manifest-data.ts` directly, and per-extension facts such as the PGDG apt name (`pgdgPackage`) live on the entry itself.

---

## Quick Reference

### When to Update Which File

| What to Update                | File                                  | Field                                              |
| ----------------------------- | ------------------------------------- | -------------------------------------------------- |
| PostgreSQL version            | `manifest-data.ts`                    | `MANIFEST_METADATA.pgVersion`                      |
| PostgreSQL base image SHA     | `manifest-data.ts`                    | `MANIFEST_METADATA.baseImageSha`                   |
| PGDG extension version        | `manifest-data.ts`                    | Entry's `pgdgVersion` field                        |
| Git-based extension tags/refs | `manifest-data.ts`                    | Entry's `source.tag` or `source.ref`               |
| Rust toolchain (pgrx builds)  | `manifest-data.ts`                    | `MANIFEST_METADATA.rustToolchain` + `rustImageSha` |
| Bun version                   | `.tool-versions` + `manifest-data.ts` | `bun X.Y.Z` + `MANIFEST_METADATA.bunImageSha`      |

**After ANY change:** Run `bun run generate` to propagate updates to the Dockerfile, manifests and docs.

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
# Regenerate all artifacts (Dockerfile, manifests, docs)
bun run generate

# Verify changes
git diff docker/postgres/Dockerfile

# Validate (fast checks)
bun run validate

# Fails unless postgres:<major>-trixie matches the pinned minor and digest
bun scripts/validate-base-image-sha.ts --require-latest-minor

# Build (tags aza-pg:pg18) and run it through the full suites
bun run build
bun run test
```

#### Step 4: Commit Changes

```bash
git status --short  # every file `bun run generate` changed, plus the CHANGELOG.md [Unreleased] entry
git commit --only -m "deps(postgres): update base image to 18.2" -- <those files>
```

---

### Procedure 2: Update PGDG Extension Version

**Example:** Update hypopg from 1.4.2 to 1.4.3

PGDG extensions are pre-compiled Debian packages: every manifest entry with `install_via: "pgdg"`. Before switching a source-built entry to `pgdg`, read its manifest entry's `notes`: an entry built from source because the PGDG package lacked a fix names the minimum safe version there, and switching to an older PGDG version would ship the vulnerable one.

#### Step 1: Find Latest PGDG Version

PGDG versions follow format: `SEMANTIC_VERSION-DEBIAN_RELEASE.pgdgREPO+BUILD`

Example: `1.4.3-1.pgdg13+2` means:

- Semantic version: 1.4.3
- Debian release: 1
- PGDG repository: `pgdg13` = built for Debian 13 (trixie)
- PGDG rebuild number: 2

**How to check latest PGDG version:**

```bash
# Method 1: Check in Docker container with PGDG repo
docker run --rm postgres:18-trixie bash -c "
  apt-get update -qq && \
  apt-cache policy postgresql-18-hypopg | grep Candidate
"

# Method 2: Check PGDG package repository
# Visit: https://apt.postgresql.org/pub/repos/apt/dists/trixie-pgdg/
# Or search: apt.postgresql.org package list
```

#### Step 2: Update manifest-data.ts (Both Fields!)

**CRITICAL:** Update BOTH `source.tag` AND `pgdgVersion` in the same entry. `bun run validate` checks `pgdgVersion` against the PGDG repo; nothing checks the pair, so keep the tag in step by hand.

```typescript
// File: scripts/extensions/manifest-data.ts
{
  name: "hypopg",
  install_via: "pgdg",
  pgdgVersion: "1.4.3-1.pgdg13+2",  // ← Update PGDG version (semantic must match tag!)
  source: {
    type: "git",
    repository: "https://github.com/HypoPG/hypopg.git",
    tag: "1.4.3",  // ← Update git tag (keep the repo's own prefix, e.g. "v")
  },
  // ...
}
```

**Validation:** The semantic version from `pgdgVersion` (e.g., "1.4.3") must match `source.tag` (e.g., "1.4.3"): check-updates compares the tag with upstream, so a stale tag misreports updates. `validate-pgdg-versions.ts` checks only that `pgdgVersion` is what the PGDG repo serves.

#### Step 3: Regenerate and Validate

```bash
bun run generate
bun run validate  # Automatically runs PGDG version validation
git diff docker/postgres/Dockerfile
```

#### Step 4: Commit Changes

```bash
git status --short  # every file `bun run generate` changed, plus the CHANGELOG.md [Unreleased] entry
git commit --only -m "deps(hypopg): update to 1.4.3" -- <those files>
```

---

### Procedure 3: Update Source-Built Extension (Git Tag)

**Example:** Update pgmq from v1.13.0 to v1.14.0

Entries with no `install_via` (or `install_via: "source"`) are built from source, e.g. pgmq, pgsodium, pgroonga and the cargo-pgrx entries (wrappers, pg_jsonschema, vectorscale). `install_via: "percona"` and `"timescale"` entries are apt packages pinned by `perconaVersion` / `timescaleVersion`.

#### Step 1: Find Latest Git Tag

```bash
# Visit GitHub releases page
# Example: https://github.com/tembo-io/pgmq/releases

# Or use git CLI
git ls-remote --tags https://github.com/tembo-io/pgmq.git
```

#### Step 2: Update manifest-data.ts

```typescript
// File: scripts/extensions/manifest-data.ts
{
  name: "pgmq",
  kind: "extension",
  source: {
    type: "git",
    repository: "https://github.com/tembo-io/pgmq.git",
    tag: "v1.14.0",  // ← Update this
  },
  // ...
}
```

#### Step 3: Regenerate Manifests

```bash
# This resolves git tags to commit SHAs and generates manifests
bun run generate

# Verify resolved commit SHA
jq '.entries[] | select(.name=="pgmq") | .source' docker/postgres/extensions.manifest.json
```

#### Step 4: Validate and Test

```bash
bun run validate

# Build to test compilation
bun run build
```

#### Step 5: Commit Changes

```bash
git status --short  # every file `bun run generate` changed, plus the CHANGELOG.md [Unreleased] entry
git commit --only -m "deps(pgmq): update to v1.14.0" -- <those files>
```

---

### Procedure 4: Update Cargo-pgrx Extension

**Example:** Update supabase wrappers to a new tag

Cargo-pgrx extensions use Rust: every entry with `build.type: "cargo-pgrx"` (wrappers, pg_jsonschema, vectorscale; vectorscale also needs Procedure 5).

**Key consideration:** `build-extensions.ts` installs the cargo-pgrx version the extension's own `Cargo.toml` pins, so the new tag's pgrx must support the PostgreSQL major, and must build with `MANIFEST_METADATA.rustToolchain`.

#### Step 1: Check pgrx Compatibility

```bash
# Visit: https://github.com/pgcentralfoundation/pgrx/releases
# Verify the pgrx version in the extension's Cargo.toml supports the PostgreSQL major
```

#### Step 2: Find Latest Extension Release

```bash
# Example: supabase wrappers
# Visit: https://github.com/supabase/wrappers/releases

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
    tag: "vX.Y.Z",  // ← Use stable tag instead
  },
  // ...
}
```

#### Step 4: Refresh Patches (if the entry has any)

`build.patches` lists unified-diff files in `docker/postgres/patches/`, applied with `git apply` to the fresh clone. A patch that no longer applies fails the build; regenerate it against the new tag (Procedure 5 shows how for vectorscale).

#### Step 5: Regenerate and Test

```bash
bun run generate

# Cargo builds are slow - test locally first
bun run build

# Verify extension loads (the stack defaults to the published image; point it at the local build)
cd stacks/single && POSTGRES_IMAGE=aza-pg:pg18 POSTGRES_PASSWORD=dev docker compose up -d
docker compose exec postgres psql -U postgres -c "CREATE EXTENSION wrappers;"
```

#### Step 6: Commit Changes

```bash
git status --short  # every file `bun run generate` changed, plus the CHANGELOG.md [Unreleased] entry
git commit --only -m "deps(wrappers): update to vX.Y.Z" -- <those files>
```

---

### Procedure 5: Update vectorscale (patched cargo-pgrx)

vectorscale is built from source because upstream's release binary is compiled with AVX2/FMA on for every function and kills the server (SIGILL) on x86-64 CPUs without them. `docker/postgres/patches/vectorscale-runtime-dispatch.patch` makes it pick AVX2+FMA kernels at runtime instead.

1. Follow Procedure 4 for the tag bump, and set `soFileName` to `vectorscale-<new version>.so`.
2. Check upstream's default features in `pgvectorscale/Cargo.toml` at the new tag; the manifest pins them (`noDefaultFeatures` + `features`) so an upstream default change cannot silently alter the build.
3. If the build stops with `Patch vectorscale-runtime-dispatch.patch no longer applies`, regenerate it: clone the new tag, `git apply --3way` the old patch, resolve, and write `git diff` back to the patch file. `git apply` is all-or-nothing, so a stale patch can never ship half-applied.
4. Regenerate `docker/postgres/patches/vectorscale-cargo-lock.patch` on every bump: upstream ships no `Cargo.lock`, and the build refuses a cargo crate without one, because unlocked crates resolve differently from day to day. In a `rust:<MANIFEST_METADATA.rustToolchain>` container: clone at the new commit, apply the runtime-dispatch patch, `cargo generate-lockfile` at the workspace root, `git add -f -N Cargo.lock`, and write `git diff -- Cargo.lock` to the patch file.
5. Prove the dispatch on an amd64 CPU without AVX2 (e.g. QEMU `-cpu Nehalem`): `CREATE EXTENSION vectorscale` and a DiskANN index query must succeed there.

---

### Procedure 6: Bulk Update All Extensions

**Systematic approach for updating all extensions at once**

#### Step 1: List Available Updates

```bash
# Compares every git tag, git-ref, source library, the Rust toolchain and pinned stack images with upstream
# (exit 1 = an enabled entry has an update)
bun scripts/extensions/check-updates.ts --format=table
```

It compares upstream git tags only, so it misses PGDG packaging-revision bumps under an unchanged tag; `bun scripts/extensions/validate-pgdg-versions.ts` catches those. The `/update` command (`.claude/commands/update.md`) walks the full round.

#### Step 2: Check Each Update Upstream

Read each release's notes for PostgreSQL compatibility and breaking changes ([Git-Based Extension Versions](#git-based-extension-versions) lists the repositories).

#### Step 3: Update in Batches

Group updates by type to minimize risk:

**Batch 1: PGDG Extensions** (fast, low risk)

```bash
# Update pgdgVersion on the PGDG entries in manifest-data.ts
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
# After each batch (bun run build first):
cd stacks/single
export POSTGRES_IMAGE=aza-pg:pg18 POSTGRES_PASSWORD=dev
docker compose down -v
docker compose up -d

# Verify extensions load
docker compose exec postgres psql -U postgres -c "\dx"
```

#### Step 5: Commit Incrementally

```bash
# Commit after each successful batch
git status --short  # every file `bun run generate` changed, plus the CHANGELOG.md [Unreleased] entry
git commit --only -m "deps(batch1): update PGDG extensions to latest" -- <those files>
```

---

## Version Source Locations

### Primary Source (Edit This)

**File:** `scripts/extensions/manifest-data.ts` — THE SINGLE SOURCE OF TRUTH

#### 1. MANIFEST_METADATA: PostgreSQL Base Version

```typescript
export const MANIFEST_METADATA = {
  pgVersion: "18.x", // PostgreSQL semantic version
  baseImageSha: "sha256:...", // digest of postgres:<pgVersion>-trixie
  rustToolchain: "...", // Rust for the pgrx builds; rustImageSha pins its builder image
  bunImageSha: "sha256:...", // oven/bun builder image for the .tool-versions Bun
} as const;
```

#### 2. MANIFEST_ENTRIES: All Extensions & Tools

```typescript
export const MANIFEST_ENTRIES: ManifestEntry[] = [
  // PGDG extension example (has pgdgVersion):
  {
    name: "hypopg",
    kind: "extension",
    source: {
      type: "git",
      repository: "https://github.com/HypoPG/hypopg.git",
      tag: "1.4.3",
    },
    install_via: "pgdg",
    pgdgVersion: "1.4.3-1.pgdg13+2", // Must match source.tag semantically!
    // ...
  },
  // Source-built extension example (no install_via, no pgdgVersion):
  {
    name: "pgmq",
    kind: "extension",
    source: {
      type: "git",
      repository: "https://github.com/tembo-io/pgmq.git",
      tag: "v1.13.0",
    },
    // ...
  },
  // ...
];
```

**Source types:**

- `type: "git"` with `tag: "v1.2.3"` - Stable releases (preferred)
- `type: "git-ref"` with `ref: "abc123..."` - Commit SHA (for unreleased fixes)
- `type: "builtin"` - PostgreSQL built-in extensions (no source)

**Install methods:**

- `install_via: "pgdg"` - Pre-compiled from PGDG repository (requires `pgdgVersion`)
- `install_via: "percona"` / `"timescale"` - Vendor apt repositories (`perconaVersion` / `timescaleVersion`)
- `install_via: "source"` or omitted - Built from git source (`build.type`: pgxs, cargo-pgrx, cmake, meson, …)

**Propagates to:**

- `docker/postgres/Dockerfile` - Version hardcoded at generation time
- `docker/postgres/extensions.manifest.json` - With resolved commit SHAs
- `docker/postgres/extensions.pgxs.manifest.json` - Filtered for PGXS builds
- `docker/postgres/extensions.cargo.manifest.json` - Filtered for cargo-pgrx builds

---

#### 3. Build Tool Versions

**File:** `.tool-versions` (asdf/mise format)

```
bun X.Y.Z
```

**Other build tools:**

- Rust/Cargo: pinned by `MANIFEST_METADATA.rustToolchain` + `rustImageSha` (builder image)
- Bun builder image: `MANIFEST_METADATA.bunImageSha`, re-resolved on every Bun bump
- CMake, Meson, Ninja: from Debian apt (entry `aptPackages`)

---

### Generated Artifacts (Never Edit Directly)

#### 1. Dockerfile

**File:** `docker/postgres/Dockerfile`

**Generated from:** `docker/postgres/Dockerfile.template` + `manifest-data.ts`

**Generation:** `bun scripts/docker/generate-dockerfile.ts`

**Contains (hardcoded at generation time):**

- `FROM postgres:<pgVersion>-trixie@<baseImageSha>` - from MANIFEST_METADATA
- PGDG package versions (e.g., `postgresql-18-hypopg=1.4.3-1.pgdg13+2`) - from pgdgVersion fields
- Metadata ARGs: `BUILD_DATE` and `VCS_REF` (no defaults - passed at build time)

**Note:** Version dependencies are NOT ARGs (cannot be overridden at build time). They are hardcoded in the FROM statement and package installation commands during Dockerfile generation.

---

#### 2. Extension Manifests

**Files:**

- `docker/postgres/extensions.manifest.json` (every manifest entry)
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
    "tag": "v0.8.x",
    "commit": "<resolved commit SHA>"
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
  apt-cache policy postgresql-18-hypopg
"

# Method 2: Browse package index
# Visit: https://apt.postgresql.org/pub/repos/apt/dists/trixie-pgdg/main/binary-amd64/Packages
# Search for: Package: postgresql-18-<extension>
```

**Package name format:** `postgresql-18-<pgdgPackage>` — the suffix is set per entry because it often differs from the extension name

Examples:

- hypopg: `postgresql-18-hypopg`
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

#### Level 1: Fast Checks

```bash
bun run validate
```

Runs (list: `scripts/validate.ts`):

- Manifest, PGDG version and generated-files checks
- oxlint, prettier, TypeScript type checking, SQL validation
- Unit tests

**Use for:** Every change (the pre-commit hook runs it)

---

#### Level 2: Full Validation

```bash
bun run validate:all
```

Runs:

- All Level 1 checks
- ShellCheck, hadolint, yamllint, workflow expressions
- Base image SHA (checks Docker Hub), documentation consistency and links, secret scan

**Use for:** Any change touching a `.sh`, YAML or Dockerfile template (CI runs it)

---

#### Level 3: Build Test

```bash
bun run build
```

Builds Docker image with all extensions.

**Use for:** Verifying compilation works after version updates

**Note:** Cargo-pgrx extensions dominate build time

---

#### Level 4: Runtime Test

`bun run test` runs every suite group against the built image. For a manual check:

```bash
cd stacks/single
export POSTGRES_IMAGE=aza-pg:pg18 POSTGRES_PASSWORD=dev
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

Runs on every PR and on pushes to `main`, `dev` and `release`:

- `bun run validate:all`
- Image build
- Every routine suite group of `scripts/test-all.ts`, one job each

**Workflow:** `.github/workflows/publish.yml`

Runs after CI succeeds on a `release` branch push (`workflow_run`):

- Multi-arch build and the suite groups against the testing image
- Image scanning (Trivy)
- Cryptographic signing (Cosign), SBOM and provenance attestation
- Promotion to `ghcr.io/fluxo-kt/aza-pg` and the git tag `v<pg>-<timestamp>` (release procedure: [BUILD.md](BUILD.md))

---

## Common Issues

### Issue 1: pgvector Version Mismatch

**Symptom:**

```
Error: No commits found for https://github.com/pgvector/pgvector.git tag v0.8.9
```

**Cause:** Tag doesn't exist upstream (`bun run generate` resolves every tag with `git ls-remote`)

**Fix:**

```bash
# Check GitHub releases
# Update manifest-data.ts to actual tag
# Update pgdgVersion in manifest-data.ts to the matching PGDG version
bun run generate
```

---

### Issue 2: PGDG Package Not Found

**Symptom:**

```
E: Unable to locate package postgresql-18-hypopg=1.4.3-1.pgdg13+2
```

**Cause:** `pgdgVersion` in manifest-data.ts doesn't match available packages

**Fix:**

```bash
# Check actual PGDG version
docker run --rm postgres:18-trixie bash -c "
  apt-get update && apt-cache policy postgresql-18-hypopg
"

# Update pgdgVersion in manifest-data.ts
bun run generate
```

---

### Issue 3: Cargo-pgrx Compilation Failure

**Symptom:**

```
error: failed to compile pg_jsonschema
error: pgrx version mismatch
```

**Cause:** The pgrx version the extension's `Cargo.toml` pins does not support the PostgreSQL major or the pinned `rustToolchain`.

**Fix:** Move to an extension tag whose pgrx supports both, or adjust `MANIFEST_METADATA.rustToolchain`. A local source fix goes in a unified-diff file under `docker/postgres/patches/`, listed in the entry's `build.patches`.

---

### Issue 4: Git Commit SHA Resolution Failed

**Symptom:**

```
Error: git ls-remote failed for <repo> tag v1.2.3 after <n> attempts: ...
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

## Maintenance Checklist

### Monthly

- [ ] Check PostgreSQL releases for new minor versions
- [ ] Check PGDG packages for updates (`install_via: "pgdg"` entries)
- [ ] Review GitHub security advisories for used extensions

### Quarterly

- [ ] Run `bun scripts/extensions/check-updates.ts` and act on every enabled update
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
- `MANIFEST_ENTRIES[].pgdgVersion` + `pgdgPackage` for PGDG packages
- `MANIFEST_ENTRIES[].source.tag/ref` for every extension

**Update workflow:**

1. Edit version in `manifest-data.ts` (both `source.tag` AND `pgdgVersion` for PGDG extensions)
2. Run `bun run generate` to propagate to the Dockerfile, manifests and docs
3. Run `bun run validate` to verify (includes the check that each `pgdgVersion` exists in the PGDG repo)
4. Commit changes (both source and generated files)

**Key principle:** Generated artifacts are committed to git for reproducibility. Always regenerate after version changes.
