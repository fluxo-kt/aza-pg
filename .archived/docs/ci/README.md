# CI/CD Documentation

## Overview

This directory contains documentation for the CI/CD pipeline and testing infrastructure.

Three main GitHub Actions workflows control the pipeline:

| Workflow | Trigger | Purpose | Time |
|----------|---------|---------|------|
| **ci.yml** | All commits/PRs | Fast validation: manifest, configs, syntax checks | 10 min |
| **build-postgres-image.yml** | Manual (workflow_dispatch) | Developer testing: multi-platform build + full test suite | 18-20 min |
| **publish.yml** | Push to `release` branch | Production release: build + sign + publish to GHCR | 20 min |

## Available Documentation

### [ARM64-TESTING.md](./ARM64-TESTING.md)

Comprehensive guide to arm64 image validation using QEMU emulation in CI. Covers:

- QEMU emulation architecture
- Test coverage and extension selection
- Performance characteristics and timeouts
- Failure modes and troubleshooting
- Local testing procedures
- Maintenance guidelines

**When to Read:**

- Investigating arm64 test failures in CI
- Adding new architecture-specific extensions
- Optimizing QEMU test performance
- Understanding multi-platform build validation

## CI Workflow Files

### `.github/workflows/ci.yml`

Fast validation workflow that runs on all commits and PRs.

**Triggers:** `push` (all branches), `pull_request` (all branches)

**Purpose:** Quick sanity checks (10 minutes)

**What It Does:**
1. Lint & validate (oxlint, prettier, tsc)
2. Verify manifest is up to date
3. Verify generated configs are synced
4. Repository health checks (required files, directories)

**When to Use:**
- Every commit (automatic)
- Quick feedback on code quality
- Ensure configurations match source

**Does NOT:**
- Build Docker images
- Run test containers
- Deploy stacks

---

### `.github/workflows/build-postgres-image.yml`

Manual developer workflow for testing PostgreSQL image builds with optional version parameters.

**Triggers:** Manual (workflow_dispatch)

**See full documentation in workflow file header:** `.github/workflows/build-postgres-image.yml`

**Quick Summary:**

**Who Should Use This:**
- Developers testing extension version combinations
- QA validating multi-platform compatibility (amd64 + arm64)
- Pre-release validation before merging to `release` branch

**When to Use This:**
- Testing custom extension version combinations
- Validating arm64 compatibility with QEMU testing
- Verifying a new extension or extension version works
- Manual pre-release validation before creating release PR

**When NOT to Use This:**
- Automatic CI on commits (use ci.yml)
- Production releases (use publish.yml)
- Simple validation (use local `./scripts/build.sh` or `bun run validate`)

**How to Trigger:**

GitHub UI:
```
Actions tab → "Build PostgreSQL Image" → "Run workflow"
Choose branch and optional version inputs
```

GitHub CLI:
```bash
gh workflow run build-postgres-image.yml -r main

# With custom versions:
gh workflow run build-postgres-image.yml -r main \
  -f pg_version=18 \
  -f pgvector_version=0.8.1 \
  -f pg_cron_version=1.6.7 \
  -f pgaudit_version=18.0
```

**Key Steps:**

1. **Lint** - Validation, manifest sync, smoke tests
2. **Build** - Multi-platform Docker image (linux/amd64 + linux/arm64)
3. **Scan** - Trivy security vulnerability scan
4. **Test** - Extension loading, auto-config, stack integration tests
5. **Report** - Full test results, digests, extensions catalog

**Outputs:**

- Multi-platform image pushed to `ghcr.io/<owner>/aza-pg` with branch tags
- Full SBOM and provenance
- Test results in GitHub Actions UI
- Step summary with extension catalog, versions, test status

**Timeout:** 30 minutes total (5 minutes for arm64 QEMU tests)

---

### `.github/workflows/publish.yml`

Production release workflow that publishes to GHCR when pushing to `release` branch.

**Triggers:** `push` to `release` branch

**Purpose:** Publish stable production releases with signing

**What It Does:**
1. Extract PostgreSQL version from Dockerfile
2. Generate version tags (format: `MM.mm-TS-TYPE`)
3. Build and push multi-platform image
4. Sign image with Cosign
5. Security scan (Trivy)
6. Generate release summary

**When It Runs:**
- Automatically when code is pushed to `release` branch
- For production releases only

**Outputs:**
- Published to `ghcr.io/fluxo-kt/aza-pg`
- Primary tag: `18.0-202511092330-single-node`
- Convenience tags: `18.0-single-node`, `18-single-node`, etc.
- Signed image (Cosign)
- Release summary with pull commands

---

## Workflow Decision Tree

```
Need to validate code changes?
├─ Push to any branch or create PR
│  └─ ci.yml runs automatically
│     └─ Fast 10-minute validation (no Docker build)
│
Need to test Docker image build?
├─ Have custom extension versions to test?
│  └─ Manual trigger: build-postgres-image.yml
│     └─ Full 18-20 minute build + test suite
│
Ready to release to production?
├─ Code reviewed and approved
├─ Push to 'release' branch
│  └─ ci.yml runs (validation)
│  └─ publish.yml runs (build + sign + release)
│     └─ Image published to GHCR with version tags
```

## Quick Reference

### Local Testing (Instead of Using build-postgres-image.yml)

For quick local testing before triggering the manual workflow:

```bash
# Fast validation (2 minutes)
bun run validate:full

# Local Docker build (with cache)
./scripts/build.sh

# Test image directly
docker run -d --name pg-test \
  -e POSTGRES_PASSWORD=test \
  aza-pg:latest
```

### Triggering CI Builds

```bash
# Via GitHub UI
Actions → "Build PostgreSQL Image" → "Run workflow"

# Via GitHub CLI (default versions)
gh workflow run build-postgres-image.yml -r main

# Via GitHub CLI (custom versions)
PG_VERSION=18
PGVECTOR_VERSION=0.8.1
PG_CRON_VERSION=1.6.7
PGAUDIT_VERSION=18.0
```

### Understanding Test Results

**Green build-postgres-image.yml run:**

```
✅ Lint passed
✅ Multi-platform build succeeded (amd64 + arm64)
✅ Security scan passed
✅ Extension tests passed
✅ Stack integration tests passed
```

**Failed arm64 test:**

```
❌ pgvector failed on arm64 (compilation issue?)
```
→ See ARM64-TESTING.md → "Compilation Failures"

**QEMU timeout:**

```
❌ PostgreSQL failed to start on arm64
```
→ Check logs for hang location; may be emulation overhead vs actual error

---

## Common Issues

### Issue: When Should I Use build-postgres-image.yml vs publish.yml?

**Use build-postgres-image.yml when:**
- Testing extension version combinations locally before release
- Validating arm64 compatibility
- Manual QA before pushing to `release` branch
- Experimenting with new extensions

**Use publish.yml when:**
- Ready to release (code merged, reviewed, tested)
- Pushing to `release` branch (automatic trigger)
- Want auto-generated version tags
- Need signed, production-ready image

### Issue: arm64 test fails but amd64 passes

**Diagnosis:**
1. Check if extension is architecture-specific (compiled, not PGDG)
2. Review Dockerfile for `uname -m` detection in build scripts
3. Verify cross-compilation toolchain setup

**Resolution:**
- See ARM64-TESTING.md → "Compilation Failures"
- Test locally with `--platform linux/arm64`
- Check extension manifest for `install_via: "compiled"`

### Issue: QEMU tests timing out

**Diagnosis:**
1. Check if timeout is QEMU overhead (normal) or actual failure
2. Review workflow logs for hang location
3. Verify memory limits not too restrictive

**Resolution:**
- Increase timeout from 5 minutes if needed
- Reduce test coverage (remove one extension test)
- Check for infinite loops in entrypoint scripts

### Issue: Multi-platform build fails

**Diagnosis:**
1. Check Buildx setup and QEMU availability
2. Verify platform syntax (`linux/amd64,linux/arm64`)
3. Review Dockerfile for architecture-specific commands

**Resolution:**
- Ensure `docker/setup-buildx-action@v3` up to date
- Check `platforms:` parameter in workflow
- Test locally: `docker buildx build --platform linux/amd64,linux/arm64 .`

---

## Best Practices

### When to Use Manual build-postgres-image.yml

**DO:**
- Manually test before each release
- Validate new extension versions
- Check arm64 compatibility with QEMU
- Test different PostgreSQL major versions
- Run multi-platform validation

**DON'T:**
- Use for every commit (ci.yml does code validation faster)
- Use as automatic CI (that's what ci.yml is for)
- Forget to check logs if tests fail
- Push to `release` without testing

### Extension Testing Strategy

**Always test on arm64:**
- Compiled extensions (Rust, C++ with complex dependencies)
- Architecture-specific code (SIMD, vector operations)
- Extensions with custom build flags

**OK to skip on arm64:**
- Pure SQL extensions (no binaries)
- Well-tested PGDG packages (already validated upstream)
- Extensions with slow compilation (unless critical)

### Cache Strategy

**Build cache:**
- `cache-from: type=gha` (GitHub Actions cache)
- `cache-to: type=gha,mode=max` (save all layers)
- Shared across branches (reduces rebuild time)

**Performance:**
- Full build (cold cache): ~12 minutes
- Cached build: ~2 minutes
- arm64 QEMU tests: ~2-3 minutes
- Total workflow: ~18-20 minutes

---

## Metrics

### Build Performance

| Metric | Value | Notes |
|--------|-------|-------|
| Full build | ~12 min | Cold cache, all layers |
| Cached build | ~2 min | Layer cache hit |
| arm64 QEMU tests | ~2-3 min | Emulation overhead |
| Total CI time | ~18-20 min | build-postgres-image.yml |
| Fast validation | ~10 min | ci.yml only |

### Extension Coverage

| Category | Count | arm64 Tested |
|----------|-------|--------------|
| Builtin | 6 | N/A (core) |
| PGDG | 14 | 2 (pgvector, pg_cron) |
| Compiled | 17 | 1 (pg_jsonschema) |
| **Total** | **38** | **3** |

**Rationale:** 3 extensions cover all failure modes (PGDG packaging, C compilation, Rust toolchain). Testing all 38 would add ~10 minutes to QEMU tests with minimal value.

---

## Related Documentation

- **Main Workflows:** `.github/workflows/{ci,build-postgres-image,publish}.yml`
- **Extension Manifest:** `docker/postgres/extensions.manifest.json`
- **Build Script:** `scripts/build.sh`
- **Development Standards:** `CLAUDE.md` → "Development Standards" section
- **Extension Tests:** `scripts/test/test-all-extensions-functional.ts`
- **ARM64 Testing:** `ARM64-TESTING.md` (this directory)

## References

- PostgreSQL docs: https://www.postgresql.org/docs/
- pgvector: https://github.com/pgvector/pgvector
- PGDG packages: https://wiki.postgresql.org/wiki/Apt
- Docker Buildx: https://docs.docker.com/build/architecture/
- GitHub Actions: https://docs.github.com/en/actions
