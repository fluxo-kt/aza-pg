# Extension Size Impact Analysis — aza-pg:pgdg-opt

Complete analysis of PostgreSQL extension footprint in the aza-pg Docker image.

## Documents in This Directory

### 1. **extension-size-analysis.md** (Main Report)

Comprehensive breakdown of:

- Image layer sizes from `docker history`
- Extension storage breakdown by location
- Top 20 extensions by size with installation method
- Installation strategy (PGDG vs source-compiled vs builtin)
- Size impact by functional category
- Detailed explanation of TimescaleDB Toolkit optimization (13MB, optimized from 186MB pre-Phase 11)
- Multi-stage build flow explanation
- Runtime vs compile-time artifacts

**Read this for:** Full technical understanding of where size comes from

---

### 2. **extension-size-summary.txt** (Visual Summary)

ASCII formatted reference guide with:

- Image layer breakdown table
- Final image extension footprint
- Top 10 extensions ranked by size
- Installation method breakdown
- Functional category breakdown
- Build system breakdown
- Optimization opportunities matrix
- Docker multistage flow diagram
- Runtime vs compile-time artifacts table
- Key findings & recommendations

**Read this for:** Quick reference, presentations, status reports

---

### 3. **extension-inventory.csv** (Data)

Raw data table of all extensions with columns:

- Extension name
- Binary size (.so)
- Category
- Build type (pgxs, cargo-pgrx, etc.)
- Installation source (PGDG, source-compiled, builtin)
- Notes

**Read this for:** Data analysis, filtering, sorting in Excel/Sheets

---

### 4. **OPTIMIZATION-ROADMAP.md** (Action Plan)

Phased implementation guide with:

- Quick wins (bitcode removal, symbol stripping) — 1-2 hours
- Medium-term options (image variants) — 8-12 hours
- Long-term optimizations (Rust compilation, Alpine base) — 20+ hours
- Detailed implementation code for each option
- Metrics to track and targets
- User migration path
- CI/CD update requirements
- Expected outcomes and decision matrix

**Read this for:** Planning optimization work, understanding trade-offs

---

### 5. **PIGSTY-EVALUATION.md** (Alternative Extension Repository)

Comprehensive evaluation of PIGSTY as alternative extension source:

- PostgreSQL 18 support status (beta in v3.5.0, GA planned for v4.0)
- Security assessment (GPG signing, trust model, supply chain)
- Compatibility matrix (38 aza-pg extensions vs PIGSTY availability)
- Operational assessment (update frequency, platform support, maintenance burden)
- Decision matrix (short/medium/long-term recommendations)
- Hybrid strategy proposal (PGDG + PIGSTY + selective source compilation)

**Decision:** ❌ DO NOT USE for PG18 now (blocked on v4.0 GA release)
**Future:** ✅ Consider for PG19+ after v4.0 matures (Q1-Q2 2026+)

**Read this for:** Understanding PIGSTY trade-offs, planning future migration path

---

## Key Findings at a Glance

### Size Breakdown

```
Total extension content:        319MB
  ├─ Extension binaries (.so)  247MB
  └─ Extension configs/SQL     72MB

Image total with dependencies:  950MB
  ├─ PostgreSQL base           ~500MB
  ├─ Runtime dependencies      368MB
  ├─ Extension packages        294MB
  └─ Source-compiled ext.      287MB

Removable (no runtime impact):  37MB
  ├─ LLVM bitcode (debug)      36MB
  └─ Archive libraries          1MB
```

### Largest Extensions

| #   | Name                | Size              | %              | Type                         |
| --- | ------------------- | ----------------- | -------------- | ---------------------------- |
| 1   | timescaledb_toolkit | 13MB (from 186MB) | ~5% (from 58%) | Rust (optimized in Phase 11) |
| 2   | pg_jsonschema       | 4.4MB             | 1.4%           | Rust                         |
| 3   | libpgrouting        | 3.5MB             | 1.1%           | C                            |
| 4   | pgroonga            | 2.1MB             | 0.7%           | Rust/C                       |
| 5   | vectorscale         | 1.6MB             | 0.5%           | Rust                         |

**Key Insight:** One extension (timescaledb_toolkit) was 58% of size pre-optimization, now optimized to 13MB from 186MB in Phase 11

### Installation Strategy

- **15 PGDG packages** (certified, security-updated, dependencies bundled)
- **13 source-compiled** (SHA-pinned, custom versions, reproducible)
- **130+ builtins** (PostgreSQL core, already included)

---

## Recommendations by Priority

### Immediate (This Week) — No Risk

```
✅ Remove LLVM bitcode
   └─ 36MB savings, 0 runtime impact
   └─ Implementation: 1 line in Dockerfile

✅ Strip debug symbols
   └─ 10-20MB savings, faster runtime
   └─ Implementation: 1 line in Dockerfile

✅ Cleanup archive libraries
   └─ 1-2MB savings, 0 runtime impact
   └─ Implementation: 2 lines in Dockerfile

Total savings: 47-56MB (5-6% image reduction)
```

### Short-term (2-3 Weeks) — Medium Effort

```
✅ Create aza-pg:18-core variant
   └─ ~600MB image (35% smaller)
   └─ Essential extensions only
   └─ For general-purpose workloads

✅ Document variant selection guide
   └─ Help users pick right image size
   └─ Reduce support requests
```

### Medium-term (4+ Weeks) — Higher Effort

```
⚡ Create specialized variants
   └─ aza-pg:18-analytics (timescaledb_toolkit included)
   └─ aza-pg:18-search (pgroonga, pg_jsonschema focused)
   └─ aza-pg:18-geospatial (PostGIS focused)

⚡ Optimize Rust compilation
   └─ 50MB potential savings in Rust extensions
   └─ Requires testing (debug loss risk)
```

---

## Quick Reference: What's Large and Why?

### timescaledb_toolkit (13MB optimized from 186MB pre-Phase 11) — How was it optimized?

**Problem:** Rust extension compiled with debug symbols, includes LLVM bitcode.

**Comparison:**

- TimescaleDB core (C): 719K
- TimescaleDB Toolkit (Rust): 13MB (optimized from 186MB in Phase 11)
- Ratio: **260x larger despite similar functionality**

**Causes:**

1. Rust binaries larger than C (language overhead)
2. Debug symbols not stripped (`-g` flag retained)
3. LLVM IR embedded in binary for JIT (36MB total across all extensions)

**Solutions:**

1. Strip symbols: ~50% reduction possible
2. Remove bitcode: ~20% reduction
3. Optimize Rust flags: ~10% reduction
4. Alternative: Make optional (separate image variant)

---

### Runtime Dependencies (368MB) — Why?

**Problem:** PGDG packages pull full system dependencies.

**What's installed:**

- GEOS + PROJ (PostGIS geometry: ~50MB)
- libcurl + libjson-c (http, pg_jsonschema, pgroonga: ~20MB)
- libfuzzy (pgroonga FTS)
- libsodium (pgsodium crypto)
- Development headers

**Trade-off:** Versioning certainty (Debian-managed) vs image size

**Solutions:**

1. Slim PGDG base image (breaking change)
2. Alpine instead of Debian (glibc vs musl issues)
3. Accept as reasonable cost (current approach)

---

### PGDG Extension Packages (294MB) — Why?

**Problem:** PGDG repositories provide pre-built binaries.

**Benefits:**

- ✅ Certified, security-updated regularly
- ✅ Tested with Debian ecosystem
- ✅ Faster builds (no compilation)
- ✅ Versioning clarity

**Cost:**

- ❌ Can't control build flags
- ❌ Large binaries with debug symbols
- ❌ Full package dependencies included

**Alternative:** Build from source (but slower builds, manual updates)

---

## Usage Guide

### For Understanding Current Size

1. Read **extension-size-analysis.md** (15 min read)
2. Reference **extension-size-summary.txt** for quick lookups
3. Check **extension-inventory.csv** if you need specific extension data

### For Optimization Planning

1. Read **OPTIMIZATION-ROADMAP.md** (20 min read)
2. Review decision matrix for trade-offs
3. Choose phase/priority for your deployment model

### For Status/Reporting

1. Use tables from **extension-size-summary.txt**
2. Export **extension-inventory.csv** to spreadsheet
3. Cite findings from **extension-size-analysis.md**

---

## Key Metrics

| Metric                               | Value                             | Notes                         |
| ------------------------------------ | --------------------------------- | ----------------------------- |
| **Extensions (curated)**             | 28                                | PGDG + source-compiled        |
| **Extensions (total)**               | 130+                              | Includes PostgreSQL builtins  |
| **Extension binaries**               | 247MB                             | 119 .so files                 |
| **Extension configs**                | 72MB                              | SQL/control files             |
| **Total extension content**          | 319MB                             | 28 curated + builtins         |
| **Full image size**                  | 950MB                             | With base + dependencies      |
| **Compressed size**                  | 400-500MB                         | Registry compression (40-50%) |
| **Largest extension (pre-Phase 11)** | 186MB → 13MB (Phase 11 optimized) | timescaledb_toolkit           |
| **Top 5 extensions**                 | 197MB                             | 62% of all binaries           |
| **Removable (safe)**                 | 37MB                              | Bitcode + archives            |

---

## Upcoming Work

### Phase 1: Quick Wins

- [ ] Remove bitcode: `RUN rm -rf /usr/lib/postgresql/18/lib/bitcode`
- [ ] Strip symbols: `RUN find /usr/lib/postgresql/18/lib -name '*.so' -exec strip {} \;`
- [ ] Cleanup libs: `RUN rm -f /usr/lib/postgresql/18/lib/*.a`
- [ ] Test image functionality
- [ ] Benchmark startup time
- [ ] Merge to main

### Phase 2: Core Variant

- [ ] Create `Dockerfile.core` (skip toolkit, pgroonga, pg_jsonschema)
- [ ] Add CI/CD build job for `aza-pg:18-core`
- [ ] Document variant selection guide
- [ ] Test core variant image
- [ ] Publish variant to registry

### Phase 3: Specialized Variants

- [ ] Create `Dockerfile.analytics` (toolkit included)
- [ ] Create `Dockerfile.search` (pgroonga, vectorscale focused)
- [ ] Create `Dockerfile.geospatial` (PostGIS focused)
- [ ] Update documentation
- [ ] Monitor adoption patterns

---

## Related Documentation

- **Main guide:** `/opt/apps/art/infra/aza-pg/CLAUDE.md` (architecture overview)
- **Dockerfile:** `/opt/apps/art/infra/aza-pg/docker/postgres/Dockerfile` (build definition)
- **Extensions manifest:** `/opt/apps/art/infra/aza-pg/docker/postgres/extensions.manifest.json` (extension list)
- **Build script:** `/opt/apps/art/infra/aza-pg/docker/postgres/build-extensions.sh` (compilation logic)

---

## Contact & Questions

For questions about extension sizes or optimization:

1. Check analysis documents first
2. Review OPTIMIZATION-ROADMAP.md for implementation details
3. Examine extension-inventory.csv for specific extension data

---

**Last Updated:** 2025-11-05  
**Image Analyzed:** aza-pg:pgdg-opt (PostgreSQL 18.0-1.pgdg13+3)  
**Platform:** linux/amd64
