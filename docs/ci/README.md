# CI/CD Documentation

## Overview

This directory contains documentation for the CI/CD pipeline and testing infrastructure.

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

### `.github/workflows/build-postgres-image.yml`

Multi-platform Docker image build and validation workflow.

**Triggers:** Manual (workflow_dispatch)

**Key Steps:**

1. Validate Dockerfile paths
2. Multi-platform build (amd64 + arm64)
3. Push to GHCR with SBOM/provenance
4. arm64 validation via QEMU (NEW)
5. Comprehensive extension testing (amd64)
6. Stack integration tests

**Outputs:**

- Image digest
- Extension manifest summary
- arm64 validation status
- Test results

**Timeout:** 30 minutes total (5 minutes for arm64 tests)

## Quick Reference

### Local arm64 Testing

```bash
# Pull arm64 variant
docker pull --platform linux/arm64 ghcr.io/USERNAME/aza-pg:latest

# Run smoke test
docker run -d --platform linux/arm64 \
  --name pg-arm64 \
  -e POSTGRES_PASSWORD=test \
  ghcr.io/USERNAME/aza-pg:latest

# Verify
docker exec pg-arm64 uname -m  # Expected: aarch64
docker exec pg-arm64 psql -U postgres -c "CREATE EXTENSION vector;"

# Cleanup
docker rm -f pg-arm64
```

### Triggering CI Builds

```bash
# Via GitHub UI
Actions → Build PostgreSQL Image → Run workflow

# Default versions
PG_VERSION=18
PGVECTOR_VERSION=0.8.1
PG_CRON_VERSION=1.6.7
PGAUDIT_VERSION=18.0
```

### Understanding Test Results

**Green arm64 validation:**

```
✅ arm64 image validation passed!

### arm64 Validation ✅

- Architecture: aarch64
- pgvector (compiled): ✅
- pg_cron (PGDG): ✅
- pg_jsonschema (Rust): ✅
- Auto-config: ✅
```

**Failed extension test:**

```
❌ pgvector failed on arm64 (compilation issue?)
```

→ Check Dockerfile for architecture-specific build flags
→ See ARM64-TESTING.md → "Compilation Failures"

**QEMU timeout:**

```
❌ PostgreSQL failed to start on arm64
```

→ QEMU emulation too slow or initialization hang
→ Review container logs: `docker logs pg-arm64-test`
→ Consider increasing timeout in workflow

## Common Issues

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
- Test locally with `docker buildx build --platform linux/amd64,linux/arm64`

## Best Practices

### Extension Testing Strategy

**Always test on arm64:**

- Compiled extensions (Rust, C++ with complex dependencies)
- Architecture-specific code (SIMD, vector operations)
- Extensions with custom build flags

**Skip on arm64:**

- Pure SQL extensions (no binaries)
- Well-tested PGDG packages (already validated upstream)
- Extensions with slow compilation (add to CI only if critical)

### Timeout Configuration

**Current timeouts:**

- Total workflow: 30 minutes
- arm64 test step: 5 minutes
- PostgreSQL startup: 60 seconds (QEMU overhead)

**When to increase:**

- Adding more extensions to arm64 tests
- QEMU version upgrade causes slowdown
- GitHub Actions runner performance regression

**When to decrease:**

- Removing extension tests
- Native arm64 runners available (no QEMU)
- Optimizing Dockerfile reduces startup time

### Cache Strategy

**Build cache:**

- `cache-from: type=gha` (GitHub Actions cache)
- `cache-to: type=gha,mode=max` (save all layers)
- Shared across branches (reduces rebuild time)

**Image pull cache:**

- Multi-platform manifest cached by digest
- arm64 variant cached after first pull
- Reduces test time on subsequent runs

## Metrics

### Build Performance

| Metric        | Value     | Notes                           |
| ------------- | --------- | ------------------------------- |
| Build time    | ~12min    | Full compilation (cold cache)   |
| Cached build  | ~2min     | Layer cache hit                 |
| arm64 test    | ~2-3min   | QEMU emulation overhead         |
| Total CI time | ~18-20min | Build + test + arm64 validation |

### Extension Coverage

| Category  | Count  | arm64 Tested          |
| --------- | ------ | --------------------- |
| Builtin   | 6      | N/A (core)            |
| PGDG      | 14     | 2 (pgvector, pg_cron) |
| Compiled  | 18     | 1 (pg_jsonschema)     |
| **Total** | **38** | **3**                 |

**Rationale:** 3 extensions cover all failure modes (PGDG packaging, C compilation, Rust toolchain). Testing all 38 would add ~10 minutes to QEMU tests with minimal value.

## Future Enhancements

### Native arm64 Runners

GitHub Actions adding native arm64 runners (beta 2024). When available:

- Replace QEMU with native execution
- Expand test coverage (all 38 extensions)
- Add performance benchmarks (amd64 vs arm64)
- Keep QEMU tests as fallback

### Automated Triage

Planned features:

- Parse failure logs for common patterns
- Suggest fixes in PR comments
- Link to relevant documentation sections
- Auto-label issues (arm64, QEMU, compilation)

### Expanded Coverage

Potential improvements:

- Test PgBouncer + Postgres stack on arm64
- Add replica/single stack validation
- Benchmark query performance (QEMU vs native)
- Validate all 18 compiled extensions

## References

- **Main Workflow:** `.github/workflows/build-postgres-image.yml`
- **Extension Manifest:** `docker/postgres/extensions.manifest.json`
- **Build Script:** `scripts/build.sh`
- **Auto-config Test:** `scripts/test/test-auto-config.sh`
- **Extension Tests:** `scripts/test/test-all-extensions-functional.ts`
