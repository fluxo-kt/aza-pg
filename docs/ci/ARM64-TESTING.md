# arm64 Image Testing in CI

## Overview

The CI workflow validates arm64 images using QEMU emulation after multi-platform builds. This ensures arm64 binaries are functional before deployment, preventing architecture-specific compilation issues from reaching production.

## Architecture

**Build Flow:**
1. Multi-platform build (amd64 + arm64) via Docker Buildx
2. Image pushed to GHCR with manifest list
3. QEMU emulation setup for arm64 testing
4. arm64 variant pulled and validated
5. Comprehensive extension testing on emulated arm64

**Why QEMU:** GitHub Actions runners are amd64. QEMU provides transparent arm64 emulation, allowing us to run arm64 containers on amd64 infrastructure without native arm64 runners.

## Test Coverage

### Core Validation (5 minutes timeout)

**Architecture Detection:**
- Verify `uname -m` reports `aarch64` or `arm64`
- Confirms QEMU emulation active and correct platform

**PostgreSQL Startup:**
- 60-second startup window (QEMU is slower than native)
- `pg_isready` health check validation
- Auto-config memory detection on emulated platform

**Extension Testing:**

1. **pgvector** (PGDG package, architecture-specific)
   - Tests APT package compatibility with arm64
   - Validates vector operations: `SELECT '[1,2,3]'::vector`
   - Critical: Vector operations are CPU-architecture dependent

2. **pg_cron** (PGDG package, multi-arch)
   - Validates PGDG packaging for arm64
   - Tests CREATE EXTENSION flow
   - Represents 14 PGDG extensions in stack

3. **pg_jsonschema** (Rust-compiled, architecture-specific)
   - Tests Rust cross-compilation toolchain
   - Validates dependencies (pgrx framework)
   - Most complex compilation scenario (18 compiled extensions)

4. **Auto-config Detection**
   - Verifies RAM/CPU detection in QEMU environment
   - Tests shared_buffers and max_connections tuning
   - Ensures entrypoint script is architecture-agnostic

## Performance Characteristics

**QEMU Overhead:**
- Startup: 2-3x slower than native (20-30s typical)
- SQL queries: ~50% slower (acceptable for smoke tests)
- Container pull: Same speed (no emulation)

**Timeout Strategy:**
- Test timeout: 5 minutes (protects CI from QEMU hangs)
- Startup timeout: 60 seconds (2x native startup time)
- Total validation: ~2-3 minutes typical

## Failure Modes

### Compilation Failures

**Symptoms:**
```
❌ pgvector failed on arm64 (compilation issue?)
```

**Causes:**
- Missing arm64 build dependencies in Dockerfile
- Architecture-specific compiler flags missing
- Cross-compilation toolchain misconfigured

**Resolution:**
1. Check Dockerfile `RUN` commands for architecture detection
2. Verify `--host` and `--target` flags in configure scripts
3. Examine build logs for arm64-specific errors

### PGDG Package Issues

**Symptoms:**
```
❌ pg_cron failed on arm64
```

**Causes:**
- PGDG package not available for arm64
- Version mismatch in APT repository
- GPG key verification failure

**Resolution:**
1. Check `apt.postgresql.org` for arm64 availability
2. Verify package version pins in Dockerfile
3. Test APT install manually in arm64 shell

### QEMU Timeouts

**Symptoms:**
```
❌ PostgreSQL failed to start on arm64
```

**Causes:**
- QEMU emulation overhead too high
- Memory limits too restrictive for emulated workload
- Infinite loop in initialization scripts

**Resolution:**
1. Increase startup timeout (currently 60s)
2. Review container logs for blocking operations
3. Test locally with `docker run --platform linux/arm64`

## Local Testing

**Manual arm64 Validation:**
```bash
# Requires Docker Desktop with QEMU support
docker pull --platform linux/arm64 ghcr.io/username/aza-pg:latest

docker run -d --platform linux/arm64 \
  --name pg-arm64 \
  -e POSTGRES_PASSWORD=test \
  ghcr.io/username/aza-pg:latest

# Wait for startup (slower on QEMU)
sleep 30

# Verify architecture
docker exec pg-arm64 uname -m
# Expected: aarch64

# Test extensions
docker exec pg-arm64 psql -U postgres -c "CREATE EXTENSION vector;"
docker exec pg-arm64 psql -U postgres -c "SELECT '[1,2,3]'::vector;"

# Cleanup
docker rm -f pg-arm64
```

## CI Integration

**Workflow File:** `.github/workflows/build-postgres-image.yml`

**Steps:**
1. `Set up QEMU for arm64 testing` - Enables arm64 emulation
2. `Test arm64 image` - Runs comprehensive validation

**Job Dependencies:**
- Runs in `build` job (after image push, before `test` job)
- Blocks `test` job if arm64 validation fails
- No dependency on native arm64 runners

**GitHub Summary Output:**
```
### arm64 Validation ✅

- Architecture: aarch64
- pgvector (compiled): ✅
- pg_cron (PGDG): ✅
- pg_jsonschema (Rust): ✅
- Auto-config: ✅
```

## Extension Selection Rationale

**Why These 3 Extensions:**

1. **pgvector** - PGDG package with architecture-specific binaries
   - Represents 14 PGDG extensions in manifest
   - Critical for production workloads (vector search)
   - Fast to test (~2 seconds)

2. **pg_cron** - PGDG package, preloaded extension
   - Tests shared_preload_libraries on arm64
   - Validates GUC parameter handling
   - Different code path than regular extensions

3. **pg_jsonschema** - Rust-compiled with complex dependencies
   - Represents 18 compiled extensions
   - Tests pgrx framework cross-compilation
   - Most likely to fail on arm64 (Rust toolchain)

**What We Don't Test:**
- All 38 extensions (too slow on QEMU)
- Performance benchmarks (QEMU overhead invalidates results)
- Multi-container stacks (PgBouncer tested separately)

## Maintenance

**When to Update:**

1. **Adding New Extensions:**
   - If extension is architecture-critical (Rust, C++ with SIMD), add to validation
   - If extension is pure SQL, skip arm64-specific testing

2. **QEMU Performance Issues:**
   - Increase timeout from 5 minutes if needed
   - Consider reducing test coverage (1 extension minimum)
   - Document QEMU version if regression occurs

3. **GitHub Actions Changes:**
   - `docker/setup-qemu-action` version updates require testing
   - Platform syntax changes (`linux/arm64` vs `arm64`)
   - Runner image updates may affect QEMU availability

## Future Enhancements

**Native arm64 Runners:**
- GitHub Actions adding arm64 runners (beta 2024)
- Replace QEMU with native execution when available
- Keep QEMU tests as fallback for cost optimization

**Expanded Coverage:**
- Test all compiled extensions if QEMU performance improves
- Add integration tests (PgBouncer + Postgres on arm64)
- Benchmark comparison (amd64 vs arm64 performance)

**Automated Triage:**
- Parse failure logs to detect common issues
- Suggest fixes in PR comments (architecture flags, PGDG availability)
- Link to relevant documentation sections

## References

- **QEMU Documentation:** https://www.qemu.org/docs/master/
- **Docker Buildx Multi-platform:** https://docs.docker.com/build/building/multi-platform/
- **GitHub Actions QEMU Setup:** https://github.com/docker/setup-qemu-action
- **PostgreSQL arm64 Support:** https://www.postgresql.org/docs/18/install-platforms.html
