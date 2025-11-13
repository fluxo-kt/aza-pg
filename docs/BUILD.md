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

**Version Format:** `MM.mm-TS-TYPE`

- `MM` = PostgreSQL major (18)
- `mm` = PostgreSQL minor (0)
- `TS` = build timestamp YYYYMMDDHHmm
- `TYPE` = image type (single-node)

**Example:** `18.0-202511092330-single-node`

**Convenience Tags:**

- `18.0-single-node`
- `18-single-node`
- `18.0`
- `18`

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
  --annotation "index:org.opencontainers.image.description=PostgreSQL 18.1 with 38 extensions - Single-Node" \
  --annotation "index:org.opencontainers.image.vendor=fluxo-kt" \
  --annotation "index:org.opencontainers.image.version=18.1-202511130900-single-node" \
  --annotation "index:org.opencontainers.image.source=https://github.com/fluxo-kt/aza-pg" \
  --annotation "index:org.opencontainers.image.licenses=MIT" \
  ghcr.io/fluxo-kt/aza-pg@sha256:amd64-digest \
  ghcr.io/fluxo-kt/aza-pg@sha256:arm64-digest
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
  "org.opencontainers.image.description": "PostgreSQL 18.1 with 38 extensions - Single-Node",
  "org.opencontainers.image.vendor": "fluxo-kt",
  "org.opencontainers.image.source": "https://github.com/fluxo-kt/aza-pg",
  "org.opencontainers.image.licenses": "MIT"
}
```

### Applied Annotations

Standard OCI annotations applied to all published images:

| Annotation                               | Purpose             | Example Value                                            |
| ---------------------------------------- | ------------------- | -------------------------------------------------------- |
| `org.opencontainers.image.title`         | Display name        | `aza-pg Single-Node PostgreSQL`                          |
| `org.opencontainers.image.description`   | Package description | `PostgreSQL 18.1 with 38 extensions - Single-Node`       |
| `org.opencontainers.image.vendor`        | Organization        | `fluxo-kt`                                               |
| `org.opencontainers.image.version`       | Full version tag    | `18.1-202511130900-single-node`                          |
| `org.opencontainers.image.created`       | Build timestamp     | `202511130900`                                           |
| `org.opencontainers.image.revision`      | Git commit SHA      | `abc123def456...`                                        |
| `org.opencontainers.image.source`        | Repository URL      | `https://github.com/fluxo-kt/aza-pg`                     |
| `org.opencontainers.image.url`           | Homepage URL        | `https://github.com/fluxo-kt/aza-pg`                     |
| `org.opencontainers.image.documentation` | Docs URL            | `https://github.com/fluxo-kt/aza-pg/blob/main/README.md` |
| `org.opencontainers.image.licenses`      | License             | `MIT`                                                    |
| `org.opencontainers.image.base.name`     | Base image          | `docker.io/library/postgres:18-trixie`                   |
| `org.opencontainers.image.base.digest`   | Base SHA256         | `sha256:...`                                             |

Custom annotations for aza-pg metadata:

| Annotation                              | Purpose                 | Example Value |
| --------------------------------------- | ----------------------- | ------------- |
| `io.fluxo-kt.aza-pg.postgres.version`   | PostgreSQL version      | `18.1`        |
| `io.fluxo-kt.aza-pg.build.type`         | Deployment type         | `single-node` |
| `io.fluxo-kt.aza-pg.extensions.enabled` | Enabled extension count | `34`          |
| `io.fluxo-kt.aza-pg.extensions.total`   | Total extension count   | `38`          |

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
- Final size: ~450MB (multi-platform manifest: ~900MB total)

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

**Total Catalog:** 38 entries (36 enabled, 2 disabled: pgq, supautils)

See [EXTENSIONS.md § Extension Classification](EXTENSIONS.md#extension-classification) for complete classification details (tools vs modules vs extensions, preloaded defaults).

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

Run comprehensive test suite:

```bash
# Full test suite (validation + Docker build + functional tests)
bun run test:all

# Fast mode (validation only, skips Docker build and functional tests)
bun run test:all:fast

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
bun run validate:full

# Specific checks
bun run lint              # Oxlint for TypeScript/JavaScript
bun run format:check      # Prettier formatting
bun run check:manifest    # Manifest validation
bun run check:shell       # Shellcheck for bash scripts
bun run check:yaml        # yamllint for YAML files
bun run check:docker      # hadolint for Dockerfiles
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
bun run check:base-image

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
bun run validate:full                 # Full suite

# Test
bun run test:all                      # Full test suite
bun run test:all:fast                 # Skip Docker build

# Generate
bun run generate                      # Regenerate all configs

# Deploy
cd stacks/primary && docker compose up  # Test locally
```

---

**Production-ready PostgreSQL builds with supply chain security and intelligent caching.**
