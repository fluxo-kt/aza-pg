# Build from Source

Complete guide to building aza-pg PostgreSQL images locally and in CI/CD.

## Quick Start

```bash
# Default: Single-platform with intelligent caching
bun run build

# Verify build
docker run --rm aza-pg:pg18 psql --version
docker run --rm aza-pg:pg18 postgres --version
```

## Build Methods

### Local Builds (Recommended)

Use the build script with Docker Buildx for fast, optimized builds:

```bash
# Default: Single-platform with intelligent caching
bun run build

# Multi-platform build (amd64 + arm64, requires push)
bun run build -- --multi-arch --push

# Build and push to registry
bun run build -- --push
```

**How it works:**

- Uses Docker Buildx with BuildKit for parallel builds
- Pulls remote cache from GitHub Container Registry
- Falls back to local cache if network unavailable
- Automatically creates buildx builder if needed

**Requirements:**

- Docker Buildx v0.8+ (bundled with Docker 19.03+)
- Network access to `ghcr.io` for cache pull (optional but recommended)
- Registry write access for `--push` (run `docker login ghcr.io`)

### Manual Docker Build

For builds without the helper script:

```bash
# Build from repo root (important: uses root as build context)
docker build -f docker/postgres/Dockerfile -t aza-pg:pg18 .

# With buildx and cache
docker buildx build \
  --file docker/postgres/Dockerfile \
  --tag aza-pg:pg18 \
  --cache-from type=registry,ref=ghcr.io/fluxo-kt/aza-pg:buildcache \
  --load \
  .
```

**Important:** Always use repo root (`.`) as build context, NOT `docker/postgres/`. The Dockerfile references files outside its directory.

### CI/CD Builds

GitHub Actions workflows handle automated builds:

#### CI (ci.yml)

Runs on every push to main/dev/release and every PR: `bun run validate:all`, an amd64 image build, then one job per routine suite group (`bun scripts/test-all.ts --group <group>`).

#### Manual Testing Workflow (build-postgres-image.yml)

Use for developer testing and pre-release validation:

```bash
# Trigger manually via GitHub Actions UI or:
gh workflow run build-postgres-image.yml

# Versions come from scripts/extensions/manifest-data.ts; the only input is push_image:
gh workflow run build-postgres-image.yml -r main -f push_image=true
```

**When to use:**

- Testing extension version updates
- Pre-release validation
- Debug build issues
- Manual QA before production release

**Features (`push_image=true`; the default `false` builds amd64 only and loads it locally):**

- Multi-platform builds (linux/amd64, linux/arm64)
- SBOM generation
- Pushes to the testing registry, then runs every routine suite group and a Trivy scan

#### Production Releases (publish.yml)

Runs when the `CI` workflow succeeds on the `release` branch (`workflow_run`):

- Full multi-platform build
- SBOM and GitHub build-provenance attestation
- Pushes to `ghcr.io/fluxo-kt/aza-pg`
- Tagged with version and convenience tags

`publish.yml` is part of the release contract: current releases are automatic after the build, test, scan, manifest, signature, SBOM, attestation, GitHub Release, and public-artifact gates pass. Do not add a GitHub Environment approval gate without explicitly approving that release-contract change. If that change is approved, use [GITHUB_ENVIRONMENT_SETUP.md](GITHUB_ENVIRONMENT_SETUP.md).

Because `workflow_run` uses workflow definitions from the default branch, release-process edits must be present on `dev` (the default branch) before relying on them for production publishing.

**Version Format:** `MM.mm-TS-TYPE`

- `MM` = PostgreSQL major (18)
- `mm` = PostgreSQL minor (0)
- `TS` = build timestamp YYYYMMDDHHmm
- `TYPE` = image type (single-node)

**Example:** `18.1-202511142330-single-node`

**Convenience Tags:**

- `18.0-single-node`
- `18-single-node`
- `18.0`
- `18`

#### Automated GitHub Releases

The publish workflow automatically creates GitHub Releases to showcase image contents and extension catalog. This provides:

- Extension list visibility on repository homepage
- Categorized catalog (AI/ML, time-series, GIS, search, security, operations)
- Quick start examples (Docker + SQL)
- Verification commands (Cosign signature, SBOM download)
- RSS/notification subscriptions for new releases

**How it works:**

1. `scripts/generate-release-notes.ts` reads extension manifest
2. Groups enabled extensions by category
3. Generates structured markdown with:
   - Extension catalog by use case with versions
   - Image metadata (tags, digest, platforms)
   - Quick start examples (Docker run + SQL CREATE EXTENSION)
   - Auto-configuration details
   - Verification commands
   - Documentation links

4. `create-release` job creates GitHub Release via `gh` CLI
5. Tag format: `v{pg-version}-{timestamp}`, without the image-type suffix (e.g., `v18.1-202511132330`)

**Release notes include:**

- Enabled extensions across all categories (see [Extension Catalog](EXTENSIONS.md))
- Version information for each extension
- Image digest and multi-platform confirmation
- Production-ready quick start commands
- Security verification steps

All data is dynamically generated from `docker/postgres/extensions.manifest.json`.

**Discoverability benefits:**

- Releases appear on GitHub homepage and repository insights
- Extension names indexed by GitHub search
- RSS feeds available for new releases (`/releases.atom`)
- Email notifications for watchers
- Historical record of extension changes per version

See workflow files in `.github/workflows/` for complete workflow details.

## CI/CD Build Design

**1. Trivy Security Scanning**

- SARIF upload runs only when the file exists (`hashFiles()` check), so a scan that wrote no SARIF does not fail the upload step
- The Trivy vulnerability DB is cached between runs (`actions/cache`, `.trivy-cache`)

**2. Native ARM64 Runners with Parallel Builds**

Each platform builds on its own native runner in parallel; no QEMU emulation.

**publish.yml jobs:**

1. **prep** - Validation and metadata (version, tags, labels, annotations)
2. **build** - Matrix builds on native runners (amd64 + arm64 in parallel), pushed by digest
3. **merge** - Multi-arch manifest from platform digests under the `testing-<sha>` tag
4. **test** - One job per routine suite group (`bun scripts/test-all.ts --group <g>`) on amd64, plus `extensions` on arm64 so the arm64 image is started before release; **test-complete** gates on all of them
5. **scan** - Security scanning (Dockle + Trivy)
6. **release** - Cosign signing, promotion to production tags, SBOM and provenance attestation
7. **create-release** - GitHub Release with generated notes
8. **verify-public-release** - Verifies the published GitHub Release, manifests, signatures, SBOM and attestation
9. **cleanup** - Deletes the run's testing images

**Key implementation:**

- **Push by digest:** `push-by-digest=true,name-canonical=true,push=true`
- **Platform caching:** Architecture-specific cache scopes
- **Native ARM64:** `ubuntu-24.04-arm` runner (NO QEMU during build)
- **Parallel execution:** Both platforms build simultaneously

**build-postgres-image.yml Architecture:**

Adaptive multi-platform builds based on `push_image` input:

- **When push_image=false (default):** Single-platform amd64, local build, no tests or scan
- **When push_image=true:** Matrix builds with native ARM64, parallel execution, all routine suite groups and a Trivy scan

### Technical Details

**Matrix Strategy:**

```yaml
strategy:
  fail-fast: false
  matrix:
    include:
      - platform: linux/amd64
        runner: ubuntu-26.04
        artifact: linux-amd64
      - platform: linux/arm64
        runner: ubuntu-24.04-arm
        artifact: linux-arm64
```

Every workflow names its runner image (`ubuntu-26.04`, `ubuntu-24.04-arm`) instead of `ubuntu-latest`, so a runner upgrade lands as a commit that CI tests instead of on the date GitHub moves the label.

**Digest Handling:**

1. Each platform builds and pushes by digest (immutable reference)
2. Digests exported as artifacts (empty files named with SHA256 hash)
3. Merge job downloads digests and creates multi-arch manifest
4. All subsequent operations use merged manifest digest

**Platform-Specific Caching:**

```yaml
cache-from: type=gha,scope=aza-pg-${{ matrix.artifact }}
cache-to: type=gha,mode=max,scope=aza-pg-${{ matrix.artifact }}
```

One scope per platform, shared by `publish.yml` and `build-postgres-image.yml`, so the two architectures never overwrite each other's layers.

See workflow files in `.github/workflows/` for complete implementation details.

## OCI Annotations for Multi-Arch Manifests

### Overview

GitHub Container Registry (GHCR) displays package metadata (description, license, documentation links) by reading **OCI annotations** from the image manifest. For multi-arch images, these annotations must be applied to the **image index** (manifest list), not just the individual platform images.

**Why annotations matter:**

- GitHub shows "No description provided" warning without `org.opencontainers.image.description`
- Source repository linking requires `org.opencontainers.image.source`
- License information displayed from `org.opencontainers.image.licenses`
- All standard OCI annotations improve discoverability and documentation

### Application Method

Annotations are applied using `docker buildx imagetools create` with `--annotation` flags. The `index:` prefix indicates the annotation applies to the image index (multi-arch manifest list) rather than individual platform manifests.

**Shape of the command** that `scripts/docker/create-manifest.ts` (merge job) and `scripts/release/promote-image.ts` (release job) run:

```bash
docker buildx imagetools create \
  -t ghcr.io/fluxo-kt/aza-pg:testing-sha \
  --annotation "index:org.opencontainers.image.title=aza-pg Single-Node PostgreSQL" \
  --annotation "index:org.opencontainers.image.description=PostgreSQL {version} with {count} extensions..." \
  --annotation "index:org.opencontainers.image.authors=fluxo-kt" \
  --annotation "index:org.opencontainers.image.version={version}-{timestamp}-single-node" \
  --annotation "index:org.opencontainers.image.source=https://github.com/fluxo-kt/aza-pg" \
  --annotation "index:org.opencontainers.image.licenses=MIT" \
  ghcr.io/fluxo-kt/aza-pg@sha256:{amd64-digest} \
  ghcr.io/fluxo-kt/aza-pg@sha256:{arm64-digest}
```

**Critical notes:**

- Annotations must be reapplied when creating new tags (they don't automatically propagate)
- Both merge and release jobs apply annotations to ensure all tags have proper metadata
- The `index:` prefix is required for multi-arch manifests (OCI 1.1 spec)
- Annotations are applied to the manifest list, not individual platform images

### Verification

Verify annotations are present in the image index:

```bash
# View manifest in raw format
docker buildx imagetools inspect ghcr.io/fluxo-kt/aza-pg:18-single-node --raw | jq '.annotations'

# Check specific annotation
docker buildx imagetools inspect ghcr.io/fluxo-kt/aza-pg:18-single-node --raw | \
  jq -r '.annotations."org.opencontainers.image.description"'

# Verify multi-arch structure
docker buildx imagetools inspect ghcr.io/fluxo-kt/aza-pg:18-single-node --raw | \
  jq -r '.manifests[] | "\(.platform.os)/\(.platform.architecture)"'
```

Expected output shows both platforms and all annotations:

```json
{
  "org.opencontainers.image.title": "aza-pg Single-Node PostgreSQL",
  "org.opencontainers.image.description": "PostgreSQL {version} with {count} extensions...",
  "org.opencontainers.image.authors": "fluxo-kt",
  "org.opencontainers.image.source": "https://github.com/fluxo-kt/aza-pg",
  "org.opencontainers.image.licenses": "MIT"
}
```

### Impact on Existing Tags

GHCR shows the metadata of each tag's most recent push. A tag published without manifest-level annotations keeps showing "No description provided" until a `publish.yml` run re-pushes it; every release re-pushes the convenience tags with annotations.

### Applied Annotations

Standard OCI annotations applied to all published images:

| Annotation                               | Purpose             | Format/Example                                                                                                     |
| ---------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `org.opencontainers.image.title`         | Display name        | `aza-pg Single-Node PostgreSQL`                                                                                    |
| `org.opencontainers.image.description`   | Package description | `PostgreSQL {version} with {count} extensions...`                                                                  |
| `org.opencontainers.image.vendor`        | Organization        | `fluxo-kt` (image labels and per-platform manifests; the index carries `org.opencontainers.image.authors` instead) |
| `org.opencontainers.image.version`       | Full version tag    | `{major}.{minor}-{timestamp}-{type}`                                                                               |
| `org.opencontainers.image.created`       | Build timestamp     | RFC 3339 (`2025-11-14T23:30:00Z`)                                                                                  |
| `org.opencontainers.image.revision`      | Git commit SHA      | `{sha}`                                                                                                            |
| `org.opencontainers.image.source`        | Repository URL      | `https://github.com/fluxo-kt/aza-pg`                                                                               |
| `org.opencontainers.image.url`           | Homepage URL        | `https://github.com/fluxo-kt/aza-pg`                                                                               |
| `org.opencontainers.image.documentation` | Docs URL            | `https://github.com/fluxo-kt/aza-pg/blob/main/README.md`                                                           |
| `org.opencontainers.image.licenses`      | License             | `MIT`                                                                                                              |
| `org.opencontainers.image.base.name`     | Base image          | `docker.io/library/postgres:{major}-trixie`                                                                        |
| `org.opencontainers.image.base.digest`   | Base SHA256         | `sha256:{digest}`                                                                                                  |

Custom aza-pg metadata. Image labels and per-platform manifests (`docker/metadata-action` in the `prep` job) use these keys; the index annotations written by `scripts/utils/oci-metadata.ts` use `io.fluxo-kt.aza-pg.postgresql.version`, `io.fluxo-kt.aza-pg.catalog.enabled` and `io.fluxo-kt.aza-pg.catalog.total` and omit `build.type`:

| Annotation                              | Purpose                 | Format/Source                                  |
| --------------------------------------- | ----------------------- | ---------------------------------------------- |
| `io.fluxo-kt.aza-pg.postgres.version`   | PostgreSQL version      | From base image (`{major}.{minor}`)            |
| `io.fluxo-kt.aza-pg.build.type`         | Deployment type         | `single-node`                                  |
| `io.fluxo-kt.aza-pg.extensions.enabled` | Enabled extension count | From manifest (count where `enabled != false`) |
| `io.fluxo-kt.aza-pg.extensions.total`   | Total extension count   | From manifest (total entries)                  |

## Build Architecture

### Multi-Stage Build

`docker/postgres/Dockerfile` (generated from `Dockerfile.template`) has these stages:

- **builder-base** - `postgres:{PG}-trixie` pinned by digest, plus build packages, the Rust toolchain and Bun (build-time only)
- **builder-pgxs** - builds source extensions using PGXS, autotools, CMake, Meson or make (`docker/postgres/build-extensions.ts` over `extensions.pgxs.manifest.json`) into `/opt/ext-out/`
- **builder-cargo** - builds Rust (cargo/pgrx) extensions the same way over `extensions.cargo.manifest.json`
- **builder-version-info** - writes `/etc/postgresql/version-info.{txt,json}`
- **final** - the same pinned base image; `apt-get upgrade`, runtime packages (`docker/postgres/extensions.runtime-packages.txt`), PGDG/Percona/Timescale packages pinned by version, then copies `/opt/ext-out/` from both builders. No build tools or Bun.

### Supply Chain Security

**Pinning:**

- Source-built extensions name a git tag (or ref) in `scripts/extensions/manifest-data.ts`; `bun run generate` resolves it to a commit SHA in `docker/postgres/extensions.manifest.json`, and the build fetches that commit
- Packaged extensions (`pgdg`, `percona`, `timescale`) are apt version pins written into the Dockerfile at generation time
- Base, Rust and Bun images are pinned by digest

**Why SHA pinning:**

- Tags can be force-pushed (mutable)
- Commit SHAs are immutable
- Prevents supply chain attacks via tag mutation

**Build Attestation:**

- SBOM (Software Bill of Materials) tracks all dependencies
- Provenance proves build authenticity
- Generated automatically in CI/CD via GitHub Actions

### Extension System

See [EXTENSIONS.md](EXTENSIONS.md) for the complete extension catalog with enabled/disabled status and classification details (tools vs modules vs extensions, preloaded defaults). The manifest at `scripts/extensions/manifest-data.ts` is the single source of truth for all extension configuration.

**Manifest-Driven:**

All extension metadata lives in `scripts/extensions/manifest-data.ts`:

- Enabled/disabled state
- Install method (`install_via`: `pgdg`, `percona`, `timescale`, `source`) or `builtin` kind
- Git tags/refs for source-built extensions
- Dependencies and build flags

**Customizing Extensions:**

To disable an extension (e.g., reduce image size):

1. Edit `scripts/extensions/manifest-data.ts`: Set `enabled: false` and add `disabledReason`
2. Regenerate: `bun run generate` (manifest JSON, Dockerfile and the other generated files)
3. Rebuild: `bun run build`

**Default preloads:** Disabling an entry that is preloaded by default also drops it from the default `shared_preload_libraries` when `bun run generate` runs (the pre-commit hook does it too); `validate-manifest.ts` only checks that the generated default matches the manifest. Databases that already created the extension can no longer load it.

See [EXTENSIONS.md](EXTENSIONS.md) for complete details.

## Testing & Validation

Run regression test suite:

```bash
# Full: build image, validate:all, every routine suite group
bun run test:all

# Fast mode (validation only, skips Docker build and functional tests)
bun run validate

# Docker suites only, against an existing image
bun scripts/test-all.ts [--group G[,G…]] [--image REF] [--shuffle[=SEED]]
```

Release validation requires both exit code `0` and a final summary with `Failed: 0`; a zero exit code alone is insufficient.

The test suite includes:

- **Validation**: manifest, TypeScript, linting, formatting, docs, shell scripts, Dockerfile, YAML
- **Build**: Docker image build (`bun run build`)
- **Functional**: the Docker suite groups in `SUITES` of `scripts/test-all.ts` (extensions, security, stacks, features, regression)

See [TESTING.md](TESTING.md) for detailed testing documentation.

### Individual Validation Commands

```bash
# Fast validation (skips Docker build)
bun run validate

# Full validation (includes all checks)
bun run validate:all

# Aliases (run validate with different modes)
bun run lint                      # Check only (alias for validate)
bun run format                    # Check + auto-fix (alias for validate:fix)
bun scripts/extensions/validate-manifest.ts  # Manifest validation
bun scripts/ci/lint-yaml-tracked.ts  # YAML files (pinned yamllint image; .yamllint, .yamllint-workflows)
```

ShellCheck (every tracked `*.sh`) and hadolint (pinned image, `.hadolint.yaml`) run inside `bun run validate:all`; it is the reference invocation for both.

## Troubleshooting

### Build Failures

**COPY path errors:**

```
ERROR [final 4/8] COPY --from=builder /extensions/*.so /usr/share/postgresql/18/extension/
```

**Solution:** Use repo root as build context: `docker build -f docker/postgres/Dockerfile .` (NOT `docker build -f Dockerfile .` from `docker/postgres/`)

**Extension compilation timeout:**

**Solution:** Increase Docker build timeout or use cached image:

```bash
# Use remote cache
bun run build  # automatically uses cache

# Or manually with buildx
docker buildx build --build-arg BUILDKIT_INLINE_CACHE=1 \
  --cache-from type=registry,ref=ghcr.io/fluxo-kt/aza-pg:buildcache \
  ...
```

**Out of disk space during build:**

**Solution:** Clean up Docker build cache:

```bash
docker builder prune -a  # Remove all build cache
docker system prune -a   # Clean up everything (images, containers, volumes)
```

**SHA verification failed:**

```
fatal: reference is not a tree: <commit>
```

**Solution:** The commit resolved from the entry's tag may be gone (tag moved or history rewritten). Compare with upstream:

```bash
git ls-remote https://github.com/OWNER/REPO.git 'refs/tags/TAG' 'refs/tags/TAG^{}'
```

Fix the tag in `scripts/extensions/manifest-data.ts`, then `bun run generate` to re-resolve the commit.

**Base image SHA validation failed:**

The Dockerfile pins the PostgreSQL base image to a specific SHA for reproducibility. If the SHA becomes stale or invalid:

```bash
# Check the pinned base image digest (add --require-latest-minor to also catch a newer PG minor)
bun scripts/validate-base-image-sha.ts

# Get latest SHA from Docker Hub
docker pull postgres:18-trixie
docker inspect postgres:18-trixie --format '{{.RepoDigests}}'

# Update MANIFEST_METADATA.baseImageSha (and pgVersion) in scripts/extensions/manifest-data.ts, then: bun run generate
```

**Why pin base image SHA:**

- Ensures reproducible builds
- Prevents unexpected base image changes
- Security: explicit opt-in for base image updates
- Validates SHA exists before building

**When to update:**

- Monthly security patches from PostgreSQL upstream
- After verifying new base image in staging
- When validation script reports staleness

### CI Workflow Failure Diagnostics

**Test failures:** each `Test <group>` job prints every failed suite's full output (a suite that cannot start PostgreSQL includes the container's last log lines). The job log is the only record: `test-all` removes every container a suite started before it exits, so no step after it could collect their logs.

**Scan failures** (`scan-failure-diagnostics-<SHA>`): full Trivy output, Trivy JSON, image manifest metadata and the SARIF file when generated.

Artifacts are kept for 7 days (GitHub Actions run page → Artifacts).

### Performance Issues

**Slow first build:**

**Expected:** A cold build compiles every source-built extension; later builds reuse the registry and local cache.

**Speed up:**

1. Enable BuildKit: `export DOCKER_BUILDKIT=1`
2. Use build script (handles caching): `bun run build`
3. Pull cache first: `docker pull ghcr.io/fluxo-kt/aza-pg:buildcache`

**Multi-platform build very slow:**

**Expected:** Multi-platform builds (amd64 + arm64) are slower due to QEMU emulation for foreign architectures.

**Options:**

- Build single platform for local testing: `bun run build` (default)
- Use CI/CD for multi-platform releases
- Use native arm64 builder for arm64 builds (buildx with remote builder)

## Development Standards

All builds follow the Bun-first philosophy:

**Tooling:**

- **Bun** for all TypeScript scripts (no Node.js)
- **Oxlint** for linting (50-100x faster than ESLint)
- **Prettier** for formatting (will migrate to Oxfmt when stable)
- **ArkType** for validation (NOT Zod - faster runtime)
- **bun-git-hooks** for pre-commit hooks

**Quality Checks:**

- Pre-commit (`scripts/pre-commit.ts`): oxlint --fix, prettier --write, regenerate if `manifest-data.ts` changed, then `bun run validate`
- No pre-push hook; CI runs `bun run validate:all` on every push and PR

See [TOOLING.md](TOOLING.md) for complete tooling decisions.

## Script Reference

Build, test and operational scripts are Bun TypeScript under `scripts/`.

### Shared Utilities

New scripts import these instead of writing their own:

- `scripts/utils/docker.ts`: `checkCommand(cmd)`, `checkDockerDaemon()`, `isDockerDaemonRunning()`, `waitForPostgres({ container, timeout })` (or `{ host, port, user, timeout }`; throws on timeout), `generateUniqueContainerName(prefix)`, `dockerCleanup(container)`
- `scripts/utils/logger.ts`: `info()`, `success()`, `warning()`, `error()`, `section()`

```typescript
import { checkDockerDaemon, waitForPostgres } from "../utils/docker";
import { info } from "../utils/logger";

await checkDockerDaemon();
await waitForPostgres({ container, timeout: 60 });
info("PostgreSQL is ready");
```

### Test Scripts

Docker suites are listed once, in `SUITES` of `scripts/test-all.ts`, and run by group; `docs/TESTING.md` "Running Tests" has the commands and what each group proves.

#### wait-for-postgres.ts [host] [port] [user] [timeout]

Waits for PostgreSQL to accept connections.

**Usage:**

```bash
bun scripts/test/wait-for-postgres.ts                             # localhost:5432, 60s
bun scripts/test/wait-for-postgres.ts db.example.com 5432 admin   # Remote host
PGHOST=localhost PGPORT=6432 bun scripts/test/wait-for-postgres.ts  # Via PgBouncer
bun scripts/test/wait-for-postgres.ts localhost 5432 postgres 120   # 2min timeout
```

**Dependencies:** `pg_isready`

---

### Operational Scripts (tools/)

#### backup-postgres.ts [database] [output-file]

Creates compressed PostgreSQL backup using `pg_dump`.

**Features:**

- Auto-named backup files with timestamp
- Gzip compression
- Backup validation (file size, gzip integrity)
- Remote host support via `PGHOST`/`PGPORT`/`PGUSER`
- Safe: prevents overwriting existing backups

**Usage:**

```bash
bun scripts/tools/backup-postgres.ts                      # Backup 'postgres' db
bun scripts/tools/backup-postgres.ts mydb                 # Backup 'mydb'
bun scripts/tools/backup-postgres.ts mydb backup.sql.gz   # Custom output file
PGHOST=db.example.com PGUSER=admin bun scripts/tools/backup-postgres.ts mydb
```

**Environment variables:**

- `PGHOST` - PostgreSQL host (default: localhost)
- `PGPORT` - PostgreSQL port (default: 5432)
- `PGUSER` - PostgreSQL user (default: postgres)
- `PGPASSWORD` - PostgreSQL password (required for remote)

**Dependencies:** `pg_dump`, `psql` (dumps roles too), `pg_isready`, `gzip`, `du`

---

#### restore-postgres.ts <backup-file> [database]

Restores PostgreSQL database from backup.

**Features:**

- Compressed (.gz) and plain SQL file support
- Backup file validation (existence, readability, gzip integrity)
- Interactive confirmation (destructive operation)
- Database statistics after restore

**Usage:**

```bash
bun scripts/tools/restore-postgres.ts backup.sql.gz           # Restore to 'postgres'
bun scripts/tools/restore-postgres.ts backup.sql.gz mydb      # Restore to 'mydb'
PGHOST=db.example.com bun scripts/tools/restore-postgres.ts backup.sql.gz
```

**Environment variables:** Same as `backup-postgres.ts`

**Dependencies:** `psql`, `pg_isready`, `gunzip`

---

#### promote-replica.ts [OPTIONS]

Promotes PostgreSQL replica to primary role.

**Features:**

- Refuses unless the container's server is a running standby (read with `pg_controldata`, no database login)
- Refuses while the standby still streams from a live upstream (`pg_stat_wal_receiver`); `--force` overrides
- `pg_ctl promote` on the running server, which waits until the server is a primary (no restart)

**Options:**

- `--container NAME` - Container name (default: `aza-pg-replica-postgres-replica`)
- `--data-dir PATH` - Data directory (default: the container's `$PGDATA`)
- `--yes` - Skip confirmation prompt
- `--force` - Promote even while still streaming from a live upstream
- `--help` - Show help message

**Usage:**

```bash
bun scripts/tools/promote-replica.ts                     # Interactive promotion
bun scripts/tools/promote-replica.ts --container my-replica --yes    # Skip confirmation
```

**Dependencies:** `docker`

**Warnings:**

- One-way operation (cannot revert)
- Ensure old primary is stopped (avoid split-brain)
- Update client connection strings after promotion

---

#### generate-ssl-certs.ts

Generates self-signed SSL certificates for PostgreSQL TLS.

**Output:**

- `server.key` - Private key (mode 600)
- `server.crt` - Self-signed certificate
- `ca.crt` - Copy of `server.crt`

**Usage:**

```bash
bun scripts/tools/generate-ssl-certs.ts <cert-directory> [days-valid]
bun scripts/tools/generate-ssl-certs.ts stacks/primary/certs 3650
```

**Dependencies:** `openssl`

---

### Recommended Test Sequence

`bun run test:all` builds the image, runs `validate:all`, then every routine suite group. Docker suites are listed once, in `SUITES` of `scripts/test-all.ts`, and run by group; `docs/TESTING.md` "Running Tests" has the commands and what each group proves.

### Operational Workflows

#### Backup and Restore Cycle

```bash
# Backup production database
PGHOST=prod.db.example.com PGPASSWORD=xxx bun scripts/tools/backup-postgres.ts mydb

# Restore to staging
PGHOST=staging.db.example.com PGPASSWORD=yyy bun scripts/tools/restore-postgres.ts backup_mydb_20250131_120000.sql.gz mydb
```

#### Replica Promotion (Failover)

```bash
# 1. Stop old primary (critical!)
docker stop aza-pg-postgres-primary

# 2. Promote replica
bun scripts/tools/promote-replica.ts --container aza-pg-replica-postgres-replica

# 3. Verify promotion
docker exec aza-pg-replica-postgres-replica psql -U postgres -c "SELECT pg_is_in_recovery();"  # Should return 'f'

# 4. Update application connection strings to new primary
```

### Script Dependencies

**Required for all scripts:**

- `bun` (install via `curl -fsSL https://bun.sh/install | bash`)
- `docker` (Docker Engine or Docker Desktop)

**Test scripts:**

- `docker buildx` (bundled with Docker Desktop)
- `psql` / `pg_isready` (for PgBouncer test)

**Tool scripts:**

- `pg_dump`, `pg_isready`, `psql` (PostgreSQL client tools)
- `gzip`, `gunzip`, `du` (standard Unix utilities)
- `openssl` (for SSL cert generation)

### Contributing Scripts

- Use the shared utilities above and Bun APIs (AGENTS.md "Development Standards"); import without file extensions.
- Remove containers in `finally`, never in a `process.on("exit")` handler: an exit handler cannot wait for async work.
- Describe usage and the reason for each non-obvious choice in the file's header comment.

## Related Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) - System design and data flows
- [EXTENSIONS.md](EXTENSIONS.md) - Extension catalog and customization
- [TESTING.md](TESTING.md) - Test patterns and session isolation
- [PRODUCTION.md](PRODUCTION.md) - Deployment and security
- [TOOLING.md](TOOLING.md) - Tech choices and locked decisions
- [../AGENTS.md](../AGENTS.md) - Quick reference for development

## Quick Reference

```bash
# Build
bun run build                         # Local build with cache
bun run build -- --multi-arch --push  # Multi-platform + push

# Validate
bun run validate                      # Fast checks
bun run validate:all                  # Full suite

# Test
bun run test:all                      # Full test suite
bun run validate                      # Validation only (fast)

# Generate
bun run generate                      # Regenerate all configs

# Deploy
cd stacks/primary && docker compose up  # Test locally
```

---

**Production-ready PostgreSQL builds with supply chain security and intelligent caching.**
