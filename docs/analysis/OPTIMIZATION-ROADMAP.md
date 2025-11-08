# aza-pg Image Size Optimization Roadmap

**Current Status:** ~247MB extension content (optimized), ~950MB total image with dependencies
**Formerly Largest Single Item:** timescaledb_toolkit (13MB, optimized from 186MB in Phase 11)

---

## Quick Wins (No Breaking Changes)

### 1. Remove Unused LLVM Bitcode (36MB savings)

**Current Impact:** Bitcode directory used only for JIT debugging, not needed in production.

**Implementation:**
```dockerfile
# Add after final stage extension copies
RUN rm -rf /usr/lib/postgresql/18/lib/bitcode

# Savings: 36MB (14% of extension binaries)
# Runtime Impact: None (JIT debugging only)
```

**Effort:** Easy (1 line)  
**Risk:** None (bitcode is debug artifact)

---

### 2. Strip Debug Symbols (10-20MB savings)

**Current Impact:** Extensions compiled with `-g` flag retain debug symbols.

**Implementation:**
```dockerfile
# Add after final stage extension copies
RUN find /usr/lib/postgresql/18/lib -name '*.so' -type f -exec strip {} \;

# Savings: 10-20MB (5-10% of extension binaries)
# Runtime Impact: Harder stack traces, but faster runtime
```

**Effort:** Easy (1 line)  
**Trade-off:** Loses detailed stack traces in production

**Before/After:**
```
Before (pre-Phase 11): timescaledb_toolkit-1.22.0.so  186MB
After (Phase 11):      timescaledb_toolkit-1.22.0.so  13MB (93% reduction achieved)
```

---

### 3. Cleanup: Archive Libraries & Headers (1.3MB savings)

**Current Impact:** Static libraries (.a files) and build headers not needed at runtime.

**Implementation:**
```dockerfile
# Add after final stage
RUN rm -f /usr/lib/postgresql/18/lib/*.a && \
    rm -f /usr/lib/postgresql/18/lib/pkgconfig/* && \
    rm -rf /usr/include/postgresql/

# Savings: 1-2MB
# Runtime Impact: None (compile-time only)
```

**Effort:** Easy (3 lines)  
**Risk:** None (already post-compile)

---

## Medium-Term Options (Variant-Based)

### 4. Create Image Variants

**Option A: Multi-variant approach**

```dockerfile
# Dockerfile.core (lean)
# Skips: timescaledb_toolkit, pgroonga, pg_jsonschema
# Result: ~100MB extension content, 600MB total image
Tag: aza-pg:18-core

# Dockerfile.analytics (full)
# Includes: timescaledb_toolkit, complete suite
# Result: 319MB extension content, 950MB total image
Tag: aza-pg:18-pgdg-opt (current)

# Dockerfile.search (specialized)
# Includes: pgroonga, pg_jsonschema, vectorscale, pgvector
# Skips: timescaledb_toolkit, postgis
# Result: ~50MB extension content, 550MB total image
Tag: aza-pg:18-search
```

**User documentation:**
```yaml
Image Variants:
  aza-pg:18-core
    - Essential: pgvector, pg_cron, pgAudit, pg_partman, pg_repack
    - Size: ~600MB
    - Use: Lightweight, general-purpose workloads

  aza-pg:18-pgdg-opt (default)
    - Everything: all 28 curated extensions
    - Size: ~950MB
    - Use: Production, when extension needs unknown

  aza-pg:18-search
    - Focus: pgroonga, pg_jsonschema, vectorscale, pgvector
    - Size: ~550MB
    - Use: Search-heavy, vector workloads

  aza-pg:18-geospatial
    - Focus: PostGIS, PostGIS raster, address_standardizer
    - Size: ~600MB
    - Use: Geospatial applications

  aza-pg:18-analytics
    - Focus: timescaledb_toolkit, pg_stat_monitor, hll
    - Size: ~650MB
    - Use: Time-series, analytics workloads
```

**Effort:** High (5 new Dockerfiles + CI/CD updates)  
**Benefit:** Users pick right-sized image, registry pushes faster, deployments leaner

---

### 5. Conditional TimescaleDB Toolkit Build

**Phase 11 Status:** Optimized via CARGO_PROFILE flags (13MB from 186MB)  
**Option:** Separate build job triggered only when needed

```dockerfile
# Scenario A: Standard build (skip toolkit)
docker buildx build -f Dockerfile \
  --build-arg SKIP_TIMESCALEDB_TOOLKIT=true \
  --load \
  -t aza-pg:18-pgdg-opt-slim .
# Result: ~130MB extension content

# Scenario B: Analytics build (include toolkit)
docker buildx build -f Dockerfile \
  --build-arg SKIP_TIMESCALEDB_TOOLKIT=false \
  --load \
  -t aza-pg:18-pgdg-opt-analytics .
# Result: 319MB extension content
```

**Implementation:**
```dockerfile
ARG SKIP_TIMESCALEDB_TOOLKIT=false

# In extensions.manifest.json filtering logic:
RUN jq 'if $ENV.SKIP_TIMESCALEDB_TOOLKIT == "true" then
        .entries |= map(select(.name != "timescaledb_toolkit"))
       else . end' /tmp/extensions.manifest.json > /tmp/extensions.filtered.json
```

**Effort:** Medium (conditional build logic)  
**Benefit:** Single Dockerfile, two build variants

---

## Long-Term Optimizations

### 6. Optimize Rust Compilation (5-10MB savings per extension)

**Current:** cargo-pgrx extensions compiled in debug mode with debug symbols.

**Implementation:**
```dockerfile
# For Rust extensions (builder-cargo stage)
ENV RUSTFLAGS="-C opt-level=3 -C lto=thin"
ENV CARGO_BUILD_JOBS=4

# In build-extensions.sh for cargo builds:
cargo pgrx package \
  --release \
  --profile-default-opt-level 3 \
  --strip
```

**Expected Savings:**
```
timescaledb_toolkit:  186MB → 13MB (Phase 11 achieved 93% reduction, exceeding original estimate)
pg_jsonschema:        4.4MB → 3.5MB
pg_stat_monitor:      245KB → 180KB
vectorscale:          1.6MB → 1.2MB
```

**Effort:** Medium (CARGO/RUSTFLAGS tuning)  
**Risk:** May impact debugging in production, verify performance unchanged

---

### 7. Use Multi-Stage with Smaller Base Image

**Current:** postgres:18-trixie (300-400MB uncompressed)

**Alternative:** Alpine-based postgres (smaller, but fewer binaries)
```dockerfile
FROM postgres:18-alpine AS final
# Result: Base image ~150MB, total ~500MB image
# Trade-off: Fewer build tools, less glibc, harder troubleshooting
```

**Effort:** High (test compatibility, glibc vs musl issues)  
**Risk:** Breaking changes for extensions expecting glibc

---

## Recommended Implementation Plan

### Phase 1 (Week 1) - Quick Wins

```bash
# Apply all quick wins to Dockerfile:
# 1. Add RUN rm -rf /usr/lib/postgresql/18/lib/bitcode
# 2. Add RUN find ... | strip
# 3. Add RUN rm -f *.a && rm -rf /usr/include

# Expected result: 950MB → 900MB total image
# Implementation: 1-2 hours
```

### Phase 2 (Week 2-3) - Create Core Variant

```bash
# Create Dockerfile.core (minimal extensions)
# CI/CD: Add build job for aza-pg:18-core
# Documentation: Variant selection guide
# Testing: Verify core extensions work, benchmark startup

# Expected result: 600MB core variant available
# Implementation: 8-12 hours
```

### Phase 3 (Week 4+) - Analytics/Search Variants

```bash
# Create specialized variants based on usage patterns
# Monitor adoption, gather feedback
# Potentially deprecate full pgdg-opt in favor of variants

# Expected result: 5 image variants, users choose optimal size
# Implementation: 16-20 hours
```

---

## Metrics to Track

**Current baselines:**
```
Image size (uncompressed):  950MB total
Extension binaries:         247MB
Formerly Largest extension: timescaledb_toolkit (186MB pre-Phase 11, now 13MB)
Build time:                 ~15 min
Pull time (100Mbps):        ~2-3 min
```

**Post-optimization targets:**

| Scenario | Uncompressed | Compressed | Pull Time | Action |
|----------|-------------|-----------|-----------|--------|
| Current  | 950MB       | 400-500MB | 2-3 min   | Baseline |
| +Quick wins | 900MB     | 380-480MB | ~2 min    | Phase 1 |
| +Core variant | 600MB   | 250-350MB | ~1 min    | Phase 2 |
| +Analytics split | 650MB | 280-380MB | ~1 min  | Phase 3 |

---

## User Migration Path

**For users on pgdg-opt:**

```yaml
Option 1: Stay on pgdg-opt
  └─ Advantage: All extensions always available
  └─ Disadvantage: Largest image size
  └─ Recommended: Production workloads with mixed needs

Option 2: Switch to aza-pg:18-core
  └─ Advantage: 35% smaller image, faster pulls
  └─ Disadvantage: timescaledb_toolkit unavailable
  └─ Recommended: Services not using analytics

Option 3: Use variant per service
  └─ Advantage: Optimized sizes across fleet
  └─ Disadvantage: More image variants to manage
  └─ Recommended: Large deployments with diverse workloads
```

---

## Build Infrastructure Changes

**Current build job:**
```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/artginzburg/aza-pg:18-pgdg-opt \
  -f docker/postgres/Dockerfile .
```

**Post-optimization (Phase 2+):**
```bash
# Quick wins applied to main build
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/artginzburg/aza-pg:18-pgdg-opt \
  -f docker/postgres/Dockerfile .

# New core variant
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/artginzburg/aza-pg:18-core \
  -f docker/postgres/Dockerfile.core .

# New analytics variant
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/artginzburg/aza-pg:18-analytics \
  -f docker/postgres/Dockerfile.analytics .

# (repeat for search, geospatial)
```

**CI/CD Update:**
- Matrix build: 3-5 variants
- Estimate: +5 min per variant, total ~40 min build time
- Caching: Independent layer caches per variant

---

## Expected Outcomes

### Size Reduction
```
Baseline:          950MB → 900MB (quick wins, 5%)
With variants:     600-650MB available (35% smaller)
With optimization: 140-160MB timescaledb_toolkit (40% reduction)
```

### User Experience
- **aza-pg:18-core**: 35% faster pulls, essential workloads only
- **aza-pg:18-pgdg-opt**: Unchanged, stays as universal option
- **aza-pg:18-analytics**: 30% smaller than pgdg-opt, toolkit included
- **aza-pg:18-search**: 40% smaller, search-optimized

### Deployment Benefits
- Faster initial pulls in CI/CD pipelines
- Less storage in registries/air-gapped environments
- Clearer intention: "core", "analytics", "search"
- Zero breaking changes (backward compatible)

---

## Decision Matrix

| Optimization | Effort | Savings | Risk | Recommend? |
|---|---|---|---|---|
| Remove bitcode | Easy | 36MB | None | ✅ YES (do first) |
| Strip symbols | Easy | 15MB | Minor | ✅ YES |
| Cleanup libs | Easy | 2MB | None | ✅ YES |
| Core variant | Medium | 30% size | Low | ✅ YES (Phase 2) |
| Analytics split | Medium | Per-variant | Low | ✅ YES (Phase 3) |
| Rust optim | Medium | 50MB | Medium | ✅ EVALUATE |
| Alpine base | High | 40% size | High | ⚠️ NOT YET |

---

## Next Steps

1. **Immediate (this week):** Implement quick wins (bitcode + strip)
2. **Short-term (2 weeks):** Create core variant, measure adoption
3. **Medium-term (4 weeks):** Add specialized variants based on usage data
4. **Long-term (2+ months):** Evaluate Rust optimization, Alpine base trade-offs

