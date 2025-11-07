# Extension Build Design

## Current Implementation

**Pattern:** Hardcoded 3 extensions in multi-stage Dockerfile with SHA pinning.

**Extensions:**
- pgvector 0.8.1 (SHA: 778dacf20c07caf904557a88705142631818d8cb)
- pg_cron 1.6.7 (SHA: 465b38c737f584d520229f5a1d69d1d44649e4e5)
- pgAudit 18.0 (SHA: f39f8dbb15dc5bd4cbe5f1e5abe0d930ed7593a8)

**Build Process:**
1. Clone all repos (parallel)
2. Checkout specific commit SHAs
3. Build with `make -j$(nproc)` (parallel compilation)
4. Copy `.so` files + control/sql to final image

**Strengths:**
- Simple, auditable Dockerfile
- Zero runtime dependencies for extension builds
- ~40% faster builds via parallel compilation
- Immutable via SHA pinning (supply chain security)

**Limitations:**
- Adding/removing extensions requires Dockerfile edit
- No per-deployment customization
- All deployments get all extensions (minimal overhead, ~35MB total)

## Recommended Hybrid Approach (Future)

**Pattern:** ARG-based declarative extension list with SHA validation.

**Dockerfile Changes:**
```dockerfile
# Declarative extension list (JSON-like ARG syntax)
ARG EXTENSIONS="\
pgvector:0.8.1:778dacf:https://github.com/pgvector/pgvector|\
pg_cron:1.6.7:465b38c:https://github.com/citusdata/pg_cron|\
pgaudit:18.0:f39f8db:https://github.com/pgaudit/pgaudit"

# Build script parses ARG, loops over extensions
RUN /build-extensions.sh "${EXTENSIONS}"
```

**Build Script Logic:**
```bash
#!/bin/bash
IFS='|' read -ra EXT_LIST <<< "$1"
PIDS=()

for ext in "${EXT_LIST[@]}"; do
    IFS=':' read -r name version sha url <<< "$ext"
    (
        git clone "$url" "/tmp/$name"
        cd "/tmp/$name" && git checkout "$sha"
        make -j$(nproc) && make install
    ) &
    PIDS+=($!)
done

wait "${PIDS[@]}"  # Parallel compilation
```

**Override at Build Time:**
```bash
# Minimal build (no pgaudit)
docker buildx build --load --build-arg EXTENSIONS="pgvector:0.8.1:778dacf:https://..." -t aza-pg:minimal .

# Add custom extension
docker buildx build --load --build-arg EXTENSIONS="pgvector:...|my_ext:1.0:abc123:https://..." -t aza-pg:custom .
```

**Benefits:**
- Single source of truth (Dockerfile ARG default)
- Customizable per build without editing Dockerfile
- Maintains SHA pinning (security)
- Still compiles in parallel (performance)

**Constraints:**
- Requires uniform build process (all extensions use `make && make install`)
- SHA validation more complex (need full 40-char SHA, not prefix)
- Error handling less granular than explicit builds

## Alternative: YAML Manifest (Not Recommended)

**Pattern:** External `extensions.yaml` copied into builder.

```yaml
extensions:
  - name: pgvector
    version: 0.8.1
    commit_sha: 778dacf20c07caf904557a88705142631818d8cb
    repo: https://github.com/pgvector/pgvector
    build_cmd: "make -j$(nproc) && make install"
```

**Why Not:**
- External file = more files to track
- YAML parser required in builder image (bloat)
- Harder to override at build time
- No benefit over ARG-based approach for our use case

## Trade-offs Summary

| Approach | Simplicity | Flexibility | Security | Performance |
|----------|-----------|-------------|----------|-------------|
| **Current (Hardcoded)** | ✅ Best | ❌ None | ✅ SHA-pinned | ✅ Parallel |
| **Recommended (ARG-based)** | ✅ Good | ✅ Build-time | ✅ SHA-pinned | ✅ Parallel |
| **YAML Manifest** | ❌ Complex | ✅ Build-time | ✅ SHA-pinned | ✅ Parallel |

## Implementation Guide (Future)

**When to migrate:** When extension customization is required (currently not needed).

**Steps:**
1. Extract build logic to `/docker/postgres/build-extensions.sh`
2. Add `ARG EXTENSIONS` with current defaults
3. Test with default ARG (should produce identical image)
4. Test with custom ARG (`--build-arg`)
5. Update CI/CD workflow to expose `extensions` input parameter
6. Document in README build section

**Validation:**
```bash
# Verify extensions in final image
docker run --rm aza-pg:pg18 ls /usr/lib/postgresql/18/lib/ | grep -E "vector|pg_cron|pgaudit"

# Compare image sizes (should be similar)
docker images aza-pg --format "{{.Size}}"
```

**Rollback:** Git revert commit, rebuild. ARG approach is backward-compatible (default ARG = current behavior).

---

**Current stance:** Hardcoded approach is optimal for aza-pg's stable extension set. ARG-based becomes valuable if supporting custom forks or per-deployment extension selection.
