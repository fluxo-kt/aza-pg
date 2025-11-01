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

**Performance:**

- First build: ~12 minutes (compiles all extensions)
- Cached build: ~2 minutes (reuses CI artifacts)
- No network: ~12 minutes (falls back to local cache)

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

#### Fast Validation (ci.yml)

Runs on every commit:

- Fast validation (~10 min)
- No Docker build
- Code checks only (TypeScript, linting, formatting, shell scripts)

#### Manual Testing Workflow (build-postgres-image.yml)

Use for developer testing and pre-release validation:

```bash
# Trigger manually via GitHub Actions UI or:
gh workflow run build-postgres-image.yml

# With custom extension versions:
gh workflow run build-postgres-image.yml -r main \
  -f pg_version=18 \
  -f pgvector_version=0.8.1
```

**When to use:**

- Testing extension version updates
- Pre-release validation
- Debug build issues
- Manual QA before production release

**Features:**

- Multi-platform builds (linux/amd64, linux/arm64)
- SBOM and provenance generation
- Pushes to registry with test tags
- ~15-20 minutes (includes full build + tests)

#### Production Releases (publish.yml)

Automatic on `release` branch:

- Full multi-platform build
- SBOM and provenance attestation
- Pushes to `ghcr.io/fluxo-kt/aza-pg`
- Tagged with version and convenience tags

**GitHub Environment Setup:** The publish workflow requires a `production` GitHub Environment with manual approval. See [GITHUB_ENVIRONMENT_SETUP.md](GITHUB_ENVIRONMENT_SETUP.md) for configuration steps.

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
2. Groups enabled extensions by category (18 categories)
3. Generates structured markdown with:
   - Extension catalog by use case with versions
   - Image metadata (tags, digest, platforms)
   - Quick start examples (Docker run + SQL CREATE EXTENSION)
   - Auto-configuration details
   - Verification commands
   - Documentation links

4. `create-release` job creates GitHub Release via `gh` CLI
5. Tag format: `v{version}` (e.g., `v18.0-202511132330-single-node`)

**Release notes include:**

- Enabled extensions across all categories (see [Extension Catalog](EXTENSIONS.md))
- Version information for each extension
- Image digest and multi-platform confirmation
- Production-ready quick start commands
- Security verification steps

**Release notes structure:**

Generated release notes include:

- Extension catalog grouped by category (AI/ML, time-series, search, security, operations, etc.)
- Version information for each extension
- Image metadata (registry, tags, digest, platforms)
- Quick start examples (Docker run + SQL CREATE EXTENSION)
- Auto-configuration details
- Verification commands (Cosign signature, SBOM download)
- Documentation links

All data is dynamically generated from `docker/postgres/extensions.manifest.json`.

**Discoverability benefits:**

- Releases appear on GitHub homepage and repository insights
- Extension names indexed by GitHub search
- RSS feeds available for new releases (`/releases.atom`)
- Email notifications for watchers
- Historical record of extension changes per version

See workflow files in `.github/workflows/` for complete workflow details.

## CI/CD Performance Optimizations

### Implemented Optimizations (2025-11-12)

**1. Trivy Security Scanning (3-5 min saved)**

- **Problem solved:** SARIF upload failures when no vulnerabilities found
- **Solution:** Conditional upload using `hashFiles()` check
- **Database caching:** Trivy vulnerability DB cached between scans
- **Time saved:** 3-5 minutes per workflow (duplicate DB downloads eliminated)

**2. Native ARM64 Runners with Parallel Builds (15-20 min saved)**

Complete workflow restructuring from QEMU-based sequential builds to native ARM64 runners with parallel execution.

**publish.yml Architecture:**

6-job pipeline with parallel platform builds:

1. **prep** - Metadata preparation (version, tags, labels)
2. **build** - Matrix builds on native runners (amd64 + arm64 in parallel)
3. **merge** - Multi-arch manifest creation from platform digests
4. **test** - Platform testing (amd64 native, arm64 QEMU for testing only)
5. **scan** - Security scanning (Dockle + Trivy)
6. **release** - Cosign signing and tag promotion

**Key implementation:**

- **Push by digest:** `push-by-digest=true,name-canonical=true,push=true`
- **Platform caching:** Architecture-specific cache scopes
- **Native ARM64:** `ubuntu-24.04-arm` runner (NO QEMU during build)
- **Parallel execution:** Both platforms build simultaneously

**build-postgres-image.yml Architecture:**

Adaptive multi-platform builds based on `push_image` input:

- **When push_image=false (default):** Single-platform amd64, local build, fast iteration (8-12 min)
- **When push_image=true:** Matrix builds with native ARM64, parallel execution, full testing (30-45 min)

**Performance Impact:**

| Workflow                                 | Before           | After             | Improvement       |
| ---------------------------------------- | ---------------- | ----------------- | ----------------- |
| **publish.yml**                          | ~44 min          | ~25-30 min        | **35-45% faster** |
| **build-postgres-image.yml** (push=true) | ~90-120 min      | ~30-45 min        | **60-70% faster** |
| **ARM64 build time**                     | 60-90 min (QEMU) | 8-15 min (native) | **75-85% faster** |

**Benefits:**

- 3-4x faster ARM64 builds (native vs QEMU emulation)
- Parallel platform execution (both build simultaneously)
- Better cache hit rates (platform-specific scopes)
- Same security guarantees (SBOM, provenance, signing)

### Technical Details

**Matrix Strategy:**

```yaml
strategy:
  fail-fast: false
  matrix:
    include:
      - platform: linux/amd64
        runner: ubuntu-latest
        artifact: linux-amd64
      - platform: linux/arm64
        runner: ubuntu-24.04-arm
        artifact: linux-arm64
```

**Digest Handling:**

1. Each platform builds and pushes by digest (immutable reference)
2. Digests exported as artifacts (empty files named with SHA256 hash)
3. Merge job downloads digests and creates multi-arch manifest
4. All subsequent operations use merged manifest digest

**Platform-Specific Caching:**

```yaml
cache-from: type=gha,scope=${{ github.ref_name }}-${{ matrix.artifact }}
cache-to: type=gha,mode=max,scope=${{ github.ref_name }}-${{ matrix.artifact }}
```

Prevents cache conflicts and improves hit rates.

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

**Example from publish.yml merge job:**

```bash
docker buildx imagetools create \
  -t ghcr.io/fluxo-kt/aza-pg:testing-sha \
  --annotation "index:org.opencontainers.image.title=aza-pg Single-Node PostgreSQL" \
  --annotation "index:org.opencontainers.image.description=PostgreSQL {version} with {count} extensions..." \
  --annotation "index:org.opencontainers.image.vendor=fluxo-kt" \
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
  "org.opencontainers.image.vendor": "fluxo-kt",
  "org.opencontainers.image.source": "https://github.com/fluxo-kt/aza-pg",
  "org.opencontainers.image.licenses": "MIT"
}
```

### Impact on Existing Tags

**Important:** This annotation implementation only affects **future releases**. Existing published tags (pre-dating this change) were created without manifest-level annotations and will continue to show "No description provided" on GitHub Container Registry.

To update existing tags with annotations:

1. Tags will be automatically updated when the next release is published to the `release` branch
2. The `publish.yml` workflow creates new tags with annotations for each release
3. GitHub displays metadata from the most recent push of each tag

**No action required** - the next publish workflow run will apply annotations to all tags.

### Applied Annotations

Standard OCI annotations applied to all published images:

| Annotation                               | Purpose             | Format/Example                                           |
| ---------------------------------------- | ------------------- | -------------------------------------------------------- |
| `org.opencontainers.image.title`         | Display name        | `aza-pg Single-Node PostgreSQL`                          |
| `org.opencontainers.image.description`   | Package description | `PostgreSQL {version} with {count} extensions...`        |
| `org.opencontainers.image.vendor`        | Organization        | `fluxo-kt`                                               |
| `org.opencontainers.image.version`       | Full version tag    | `{major}.{minor}-{timestamp}-{type}`                     |
| `org.opencontainers.image.created`       | Build timestamp     | `YYYYMMDDHHmm`                                           |
| `org.opencontainers.image.revision`      | Git commit SHA      | `{sha}`                                                  |
| `org.opencontainers.image.source`        | Repository URL      | `https://github.com/fluxo-kt/aza-pg`                     |
| `org.opencontainers.image.url`           | Homepage URL        | `https://github.com/fluxo-kt/aza-pg`                     |
| `org.opencontainers.image.documentation` | Docs URL            | `https://github.com/fluxo-kt/aza-pg/blob/main/README.md` |
| `org.opencontainers.image.licenses`      | License             | `MIT`                                                    |
| `org.opencontainers.image.base.name`     | Base image          | `docker.io/library/postgres:{major}-trixie`              |
| `org.opencontainers.image.base.digest`   | Base SHA256         | `sha256:{digest}`                                        |

Custom annotations for aza-pg metadata:

| Annotation                              | Purpose                 | Format/Source                                  |
| --------------------------------------- | ----------------------- | ---------------------------------------------- |
| `io.fluxo-kt.aza-pg.postgres.version`   | PostgreSQL version      | From base image (`{major}.{minor}`)            |
| `io.fluxo-kt.aza-pg.build.type`         | Deployment type         | `single-node`                                  |
| `io.fluxo-kt.aza-pg.extensions.enabled` | Enabled extension count | From manifest (count where `enabled != false`) |
| `io.fluxo-kt.aza-pg.extensions.total`   | Total extension count   | From manifest (total entries)                  |

## Build Architecture

### Multi-Stage Build

```
┌──────────────────────┐
│  Stage 1: Builder    │
│  - Clone pgvector    │ ──SHA──┐
│  - Clone pg_cron     │   Pin  │
│  - Clone pgAudit     │ ──────┤
│  - Compile extensions│       │
└──────────────────────┘       │
         │                     │
         ▼                     │
┌──────────────────────┐       │
│  Stage 2: Final      │       │ Supply Chain
│  - postgres:18       │       │ Security
│  - Copy .so files    │◄──────┤ (Immutable)
│  - Copy control files│       │
│  - Copy entrypoint   │       │
└──────────────────────┘       │
         │                     │
         ▼                     │
   aza-pg:pg18 Image           │
   (~450MB)                    │
   + SBOM/Provenance           │
```

**Stage 1 (Builder):**

- Clones extension repos at specific commit SHAs
- Compiles C extensions with PostgreSQL dev headers
- Parallel compilation (~40% faster builds)
- Includes build tools (gcc, make, cargo, etc.)

**Stage 2 (Final):**

- Based on `postgres:18-trixie` (~93-154MB)
- Copies only `.so` files and control files from builder
- Minimal runtime dependencies (ca-certificates, zstd, lz4)
- No build tools in final image
- Final size: ~900MB uncompressed per platform (~250MB compressed wire, ~1.8GB combined multi-arch)

### Supply Chain Security

**SHA Pinning:**

All extensions are pinned to specific commit SHAs (not tags):

- pgvector: `0.8.1` → SHA `a1ecca1cc67b9f952e43a5d29e0cec2ac4bea0fa`
- pg_cron: `1.6.7` → SHA `e44fcb7c5d94b53bd0e5ee8e8eecbe9e9f03df35`
- pgAudit: `18.0` → SHA `5c279fa5f7cd0c50aef39ef4d9a6ec0df4e62c46`

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
- Source type (compiled, PGDG, builtin)
- SHA pins for compiled extensions
- Dependencies and build flags

**Customizing Extensions:**

To disable an extension (e.g., reduce image size):

1. Edit `scripts/extensions/manifest-data.ts`: Set `enabled: false` and add `disabledReason`
2. Regenerate: `bun scripts/extensions/generate-manifest.ts`
3. Rebuild: `bun run build`

**Restrictions:** Core preloaded extensions (auto_explain, pg_cron, pg_stat_statements, pgaudit) cannot be disabled.

See [EXTENSIONS.md](EXTENSIONS.md) for complete details.

## Testing & Validation

Run regression test suite:

```bash
# Full test suite (validation + Docker build + functional tests)
bun run test:all

# Fast mode (validation only, skips Docker build and functional tests)
bun run validate

# Show help
bun scripts/test-all.ts --help
```

The test suite includes:

- **Validation**: manifest, TypeScript, linting, formatting, docs, shell scripts, Dockerfile, YAML
- **Build**: Docker image build, extension size checks, extension count verification
- **Functional**: extension loading, auto-tuning (512MB/2GB/4GB), stack deployments, comprehensive extension tests

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
bun scripts/validate-manifest.ts  # Manifest validation
shellcheck scripts/**/*.sh stacks/*/scripts/*.sh docker/postgres/*.sh  # Shell scripts
yamllint -c .yamllint.yaml .      # YAML files
hadolint docker/postgres/Dockerfile  # Dockerfile
```

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
fatal: reference is not a tree: a1ecca1cc67b9f952e43a5d29e0cec2ac4bea0fa
```

**Solution:** SHA may be invalid or repo history rewritten. Verify SHA exists:

```bash
# Check if SHA exists in GitHub repo
curl -I https://github.com/pgvector/pgvector/commit/a1ecca1cc67b9f952e43a5d29e0cec2ac4bea0fa
```

If 404, update SHA in `scripts/extensions/manifest-data.ts` and regenerate.

**Base image SHA validation failed:**

The Dockerfile pins the PostgreSQL base image to a specific SHA for reproducibility. If the SHA becomes stale or invalid:

```bash
# Check current base image SHA
bun scripts/validate-base-image-sha.ts

# Get latest SHA from Docker Hub
docker pull postgres:18-trixie
docker inspect postgres:18-trixie --format '{{.RepoDigests}}'

# Update PG_BASE_IMAGE_SHA in docker/postgres/Dockerfile
# Example: sha256:41fc5342eefba6cc2ccda736aaf034bbbb7c3df0fdb81516eba1ba33f360162c
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

Both `publish.yml` and `build-postgres-image.yml` workflows automatically capture comprehensive failure diagnostics when tests or scans fail.

**Diagnostic Artifacts Available:**

**Test Failures** (`test-failure-diagnostics-<SHA>`):

- PostgreSQL container logs (full output)
- Complete PostgreSQL configuration (`SHOW ALL`)
- Shared preload libraries configuration
- Installed extensions list
- Image version info (`/etc/postgresql/version-info.txt`)
- Docker Compose logs (for stack tests)

**Scan Failures** (`scan-failure-diagnostics-<SHA>`):

- Full Trivy scan output (all severities)
- Trivy JSON results (for programmatic analysis)
- Image metadata (manifest inspection)
- SARIF file (if generated)

**Stack Test Failures** (`replica-test-failure-diagnostics-<SHA>`, `single-test-failure-diagnostics-<SHA>`):

- Docker Compose logs from respective stacks

**Accessing Diagnostics:**

1. Navigate to failed workflow run in GitHub Actions
2. Scroll to "Artifacts" section at bottom of run summary
3. Download diagnostic artifact(s) for the specific failure
4. Extract and review logs/configs

**Retention:** All diagnostic artifacts are retained for 7 days.

**Example - Debugging Test Failure:**

```bash
# Download test-failure-diagnostics artifact from GitHub Actions UI
unzip test-failure-diagnostics-abc1234.zip
cd diagnostics/

# Review PostgreSQL logs
cat pg-ext-test-logs.txt

# Check configuration
cat postgres-config.txt

# Verify shared preload libraries
cat shared-preload.txt

# Check which extensions are available
cat extensions.txt
```

**When diagnostics are NOT captured:**

- Successful workflows (no failures)
- Build step failures (before test/scan jobs run)
- Cancelled workflows (manual cancellation)

**Pro tip:** Check diagnostic artifacts BEFORE re-running failed workflows - they often contain the root cause immediately.

### Performance Issues

**Slow first build:**

**Expected:** First build takes ~12 minutes to compile all extensions from source. Subsequent builds with cache take ~2 minutes.

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

- Pre-commit: validate + lint + format
- Pre-push: full validation suite
- CI: Fast validation on every commit (~10 min)

See [TOOLING.md](TOOLING.md) for complete tooling decisions.

## Script Reference

Comprehensive collection of build, test, and operational scripts using Bun-first TypeScript patterns. All scripts include robust error handling and use shared utilities from `lib/common.ts`.

### Directory Structure

```
scripts/
├── lib/              # Shared library functions
├── test/             # Test and validation scripts
├── tools/            # Operational tooling
├── build.ts          # Main build script (Bun TypeScript)
```

### Shared Library (lib/common.ts)

Core utilities for all scripts:

**Functions:**

- `logInfo()`, `logSuccess()`, `logWarning()`, `logError()` - Colored logging
- `dockerCleanup(container)` - Safe container removal
- `checkCommand(cmd)` - Verify command availability
- `checkDockerDaemon()` - Verify Docker is running
- `waitForPostgres(host, port, user, timeout, container?)` - Wait for PostgreSQL readiness

**Usage:**

```typescript
import {
  checkCommand,
  checkDockerDaemon,
  waitForPostgres,
} from "../lib/common.ts";

await checkCommand("docker");
await checkDockerDaemon();
await waitForPostgres("localhost", 5432, "postgres", 60);
```

### Test Scripts

#### test-build.ts [image-tag]

Builds Docker image and verifies extensions are functional.

**What it tests:**

- Image build process (via buildx)
- PostgreSQL version
- Auto-config entrypoint presence
- Extension creation (vector, pg_trgm, pg_cron, pgaudit, etc.)
- Extension functionality (vector types, similarity, cron jobs)

**Usage:**

```bash
bun scripts/test/test-build.ts                # Default tag: aza-pg:pg18
bun scripts/test/test-build.ts my-custom:tag  # Custom tag
```

**Dependencies:** `docker`, `buildx`

---

#### test-auto-config.ts [image-tag]

Validates auto-config RAM/CPU detection and PostgreSQL tuning.

**What it tests:**

1. Manual memory override (`POSTGRES_MEMORY`)
2. 2GB cgroup v2 detection
3. 512MB minimum memory limit
4. 64GB high-memory override
5. CPU core detection and worker tuning
6. Below-minimum memory rejection (256MB)
7. Custom `shared_preload_libraries` override

**Usage:**

```bash
bun scripts/test/test-auto-config.ts                # Default tag: aza-pg:pg18
bun scripts/test/test-auto-config.ts my-custom:tag  # Custom tag
```

**Dependencies:** `docker`

---

#### run-extension-smoke.ts [image-tag]

Tests extension loading in dependency order using manifest.

**What it tests:**

- Topological sort of extension dependencies
- CREATE EXTENSION for all extensions (excluding tools)
- Dependency resolution accuracy

**Usage:**

```bash
bun scripts/test/run-extension-smoke.ts                # Default tag: aza-pg:test
bun scripts/test/run-extension-smoke.ts my-custom:tag  # Custom tag
```

**Dependencies:** `docker`

---

#### test-pgbouncer-healthcheck.ts [stack-dir]

Validates PgBouncer healthcheck and authentication.

**What it tests:**

- Stack deployment (compose up)
- PostgreSQL readiness
- PgBouncer auth via `pgbouncer_lookup()` function
- Health check connectivity
- Query execution through PgBouncer

**Usage:**

```bash
bun scripts/test/test-pgbouncer-healthcheck.ts                  # Default: stacks/primary
bun scripts/test/test-pgbouncer-healthcheck.ts stacks/primary   # Explicit path
```

**Dependencies:** `docker`, `docker compose`, `psql`

---

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

**Dependencies:** `pg_dump`, `pg_isready`, `gzip`, `du`

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

- Verifies replica is in recovery mode
- Optional pre-promotion backup
- Safe promotion using `pg_ctl promote`
- Configuration updates (removes `standby.signal`)
- Post-promotion verification

**Options:**

- `--container NAME` - Container name (default: postgres-replica)
- `--data-dir PATH` - Data directory (default: /var/lib/postgresql/data)
- `--no-backup` - Skip backup before promotion
- `--yes` - Skip confirmation prompt
- `--help` - Show help message

**Usage:**

```bash
bun scripts/tools/promote-replica.ts                     # Interactive promotion
bun scripts/tools/promote-replica.ts --container my-replica --yes    # Skip confirmation
bun scripts/tools/promote-replica.ts --no-backup --yes               # Fast (no backup)
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

- `server.key` - Private key
- `server.crt` - Self-signed certificate

**Usage:**

```bash
bun scripts/tools/generate-ssl-certs.ts
```

**Dependencies:** `openssl`

---

### Common Development Patterns

#### Error Handling

All scripts follow consistent error handling using Bun TypeScript:

```typescript
import {
  checkCommand,
  checkDockerDaemon,
  dockerCleanup,
} from "./lib/common.ts";

// Prerequisites check
await checkCommand("docker");
await checkDockerDaemon();

// Cleanup handler
process.on("exit", () => {
  dockerCleanup(containerName);
});
```

#### Type Safety

All scripts use TypeScript with Bun for type safety:

```typescript
import type { BuildOptions } from "./types.ts";

const options: BuildOptions = {
  multiArch: false,
  push: false,
  tag: "aza-pg:pg18",
};
```

#### Logging

Consistent colored logging via `common.ts`:

```typescript
import { logInfo, logSuccess, logWarning, logError } from "./lib/common.ts";

logInfo("Starting operation...");
logSuccess("Operation completed");
logWarning("Non-critical issue detected");
logError("Critical failure");
```

### Recommended Test Sequence

1. **Build verification:**

   ```bash
   bun scripts/test/test-build.ts
   ```

2. **Auto-config validation:**

   ```bash
   bun scripts/test/test-auto-config.ts
   ```

3. **Extension smoke test:**

   ```bash
   bun scripts/test/run-extension-smoke.ts
   ```

4. **PgBouncer integration:**
   ```bash
   bun scripts/test/test-pgbouncer-healthcheck.ts
   ```

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
docker stop postgres-primary

# 2. Promote replica
bun scripts/tools/promote-replica.ts --container postgres-replica

# 3. Verify promotion
docker exec postgres-replica psql -U postgres -c "SELECT pg_is_in_recovery();"  # Should return 'f'

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

When adding new scripts:

1. **Use common library:** Import from `lib/common.ts` for shared functions
2. **Type safety:** Use TypeScript with proper type annotations
3. **Consistent error handling:** Use try-catch with proper cleanup
4. **Logging:** Use `logInfo()`, `logSuccess()`, etc. from common.ts
5. **Cleanup handlers:** Use `process.on('exit')` pattern
6. **Documentation:** Add JSDoc comments and update documentation
7. **Testing:** Verify script works on clean environment

**Example script template:**

```typescript
#!/usr/bin/env bun
/**
 * Script description
 *
 * Usage: bun script.ts [args]
 *
 * Examples:
 *   bun script.ts example1
 *   bun script.ts example2
 */

import {
  checkCommand,
  checkDockerDaemon,
  dockerCleanup,
  logInfo,
  logSuccess,
  logError,
} from "./lib/common.ts";

const CONTAINER_NAME = "my-container";

// Cleanup handler
process.on("exit", () => {
  dockerCleanup(CONTAINER_NAME);
});

async function main() {
  try {
    // Check prerequisites
    await checkCommand("docker");
    await checkDockerDaemon();

    // Main logic
    logInfo("Starting operation...");
    // ... implementation ...
    logSuccess("Operation complete");
  } catch (error) {
    logError(`Operation failed: ${error}`);
    process.exit(1);
  }
}

main();
```

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
