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

See `.github/workflows/README.md` or the workflow files directly in `.github/workflows/` for complete workflow documentation.

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

**Classification:**

- **Tools (6):** No CREATE EXTENSION needed (CLI utilities: pgbackrest, pgbadger, wal2json, pg_plan_filter, pg_safeupdate, supautils)
- **Modules (1):** auto_explain - preload-only, NO CREATE EXTENSION (PostgreSQL core module)
- **Extensions (26):** Require CREATE EXTENSION (6 auto-created: pg_cron, pg_stat_statements, pg_trgm, pgaudit, plpgsql, vector)
- **Preloaded (4):** auto_explain (module), pg_cron, pg_stat_statements, pgaudit

**Total Catalog:** 38 entries (36 enabled, 2 disabled: pgq, supautils)

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
