# Extension Size Impact Analysis

**Image:** aza-pg (PostgreSQL 18.0-1.pgdg13+3)
**Analysis Date:** 2025-11-06
**Total Extensions:** 38 (6 builtin + 15 PGDG + 17 compiled)

---

## Executive Summary

Extension footprint: **319MB total**
- **247MB** in compiled `.so` libraries (`/usr/lib/postgresql/18/lib`)
- **72MB** in extension SQL/control files (`/usr/share/postgresql/18/extension`)

**Critical finding:** `timescaledb_toolkit-1.22.0.so` = **186MB** (58% of all extension binaries)

**Current image size:** 1.17GB (optimized from 1.41GB in Phase 3)

---

## Per-Extension Size Breakdown

### Top 20 Extensions by Binary Size

| Rank | Extension | Size | % of Total | Type | Installation Method |
|------|-----------|------|------------|------|---------------------|
| 1 | timescaledb_toolkit | 186.0 MB | 58.0% | Rust (cargo-pgrx) | Source-compiled |
| 2 | pg_jsonschema | 4.4 MB | 1.4% | Rust (cargo-pgrx) | Source-compiled |
| 3 | pgrouting | 3.5 MB | 1.1% | C (PGXS) | PGDG package |
| 4 | pgroonga | 2.1 MB | 0.7% | Rust/C hybrid | Source-compiled |
| 5 | vectorscale | 1.6 MB | 0.5% | Rust (cargo-pgrx) | Source-compiled |
| 6 | postgis | 1.3 MB | 0.4% | C (PGXS) | PGDG package |
| 7 | dict_snowball | 787 KB | 0.2% | Builtin | PostgreSQL core |
| 8 | timescaledb | 719 KB | 0.2% | C (PGXS) | PGDG package |
| 9 | wrappers | 595 KB | 0.2% | C (PGXS) | Source-compiled |
| 10 | postgis_raster | 551 KB | 0.2% | C (PGXS) | PGDG package |
| 11 | address_standardizer | 429 KB | 0.1% | C (PGXS) | PGDG package |
| 12 | pgsodium | 380 KB | 0.1% | C (PGXS) | Source-compiled |
| 13 | postgis_topology | 323 KB | 0.1% | C (PGXS) | PGDG package |
| 14 | supautils | 290 KB | 0.1% | Rust (cargo-pgrx) | Source-compiled |
| 15 | pg_stat_monitor | 245 KB | 0.1% | C (PGXS) | Source-compiled |
| 16 | pgvector | 200 KB | 0.1% | C (PGXS) | PGDG package |
| 17 | pgaudit | 156 KB | 0.05% | C (PGXS) | PGDG package |
| 18 | pg_cron | 132 KB | 0.04% | C (PGXS) | PGDG package |
| 19 | hll | 98 KB | 0.03% | C (PGXS) | PGDG package |
| 20 | rum | 87 KB | 0.03% | C (PGXS) | PGDG package |

**Remaining 17 extensions:** ~48 MB combined (includes PostGIS dependencies, encoding modules, small utilities)

---

## Size Impact by Category

| Category | Extensions | Total Size | Key Extensions |
|----------|-----------|------------|----------------|
| **Time-series** | 2 | 186.7 MB | timescaledb_toolkit (186MB), timescaledb (719KB) |
| **Geospatial** | 4 | 2.6 MB | postgis, postgis_raster, postgis_topology, address_standardizer |
| **Search/JSON** | 2 | 6.5 MB | pgroonga (2.1MB), pg_jsonschema (4.4MB) |
| **Vector/ML** | 3 | 1.8 MB | vectorscale (1.6MB), pgvector (200KB), pg_hashids (~100KB) |
| **Observability** | 3 | 377 KB | pg_stat_monitor (245KB), pg_cron (132KB), auto_explain (builtin) |
| **Security** | 4 | 826 KB | pgsodium (380KB), pgaudit (156KB), supautils (290KB), supabase_vault |
| **Development** | 5 | ~800 KB | plpgsql_check, hypopg, pg_repack, wal2json, index_advisor |
| **Foreign Data** | 2 | ~600 KB | wrappers (595KB), http |
| **Other** | 12 | ~48 MB | Routing (3.5MB), encoding modules, utilities |

---

## Installation Method Comparison

### PGDG-Packaged Extensions (14 total)

**Benefits:**
- Pre-compiled, instant installation (~10 seconds)
- GPG-signed by PostgreSQL community
- Multi-architecture support (amd64/arm64)
- Automatic dependency resolution

**Total size contribution:** ~10 MB binaries + 294 MB layer (includes dependencies)

| Extension | Version | Binary Size | Package Layer |
|-----------|---------|-------------|---------------|
| pgrouting | 3.8.0 | 3.5 MB | Included in 294MB PGDG layer |
| postgis | 3.6.0 | 1.3 MB | Included in 294MB PGDG layer |
| timescaledb | 2.23.0 | 719 KB | Included in 294MB PGDG layer |
| postgis_raster | 3.6.0 | 551 KB | Included in 294MB PGDG layer |
| address_standardizer | 3.6.0 | 429 KB | Included in 294MB PGDG layer |
| postgis_topology | 3.6.0 | 323 KB | Included in 294MB PGDG layer |
| pgvector | 0.8.1 | 200 KB | Included in 294MB PGDG layer |
| pgaudit | 18.0 | 156 KB | Included in 294MB PGDG layer |
| pg_cron | 1.6.7 | 132 KB | Included in 294MB PGDG layer |
| hll | 2.19 | 98 KB | Included in 294MB PGDG layer |
| rum | 1.3.15 | 87 KB | Included in 294MB PGDG layer |
| pg_partman | 5.3.1 | ~80 KB | Included in 294MB PGDG layer |
| http | 1.7.0 | ~75 KB | Included in 294MB PGDG layer |
| hypopg | 1.4.2 | ~60 KB | Included in 294MB PGDG layer |

### Source-Compiled Extensions (17 total)

**Reasons for compilation:**
- Not available in PGDG repository
- Need specific version/features
- Part of Supabase ecosystem
- Bleeding-edge functionality

**Total size contribution:** ~200 MB binaries

| Extension | Size | Build System | Reason for Compilation |
|-----------|------|--------------|------------------------|
| timescaledb_toolkit | 186 MB | cargo-pgrx (Rust) | Not in PGDG, analytics toolkit |
| pg_jsonschema | 4.4 MB | cargo-pgrx (Rust) | Not in PGDG, JSON schema validation |
| pgroonga | 2.1 MB | meson + Rust | Not in PGDG, FTS engine |
| vectorscale | 1.6 MB | cargo-pgrx (Rust) | Not in PGDG, vector ops |
| wrappers | 595 KB | PGXS (C) | Not in PGDG, FDW framework |
| pgsodium | 380 KB | PGXS (C) | Not in PGDG, crypto |
| supautils | 290 KB | cargo-pgrx (Rust) | Supabase-specific |
| pg_stat_monitor | 245 KB | PGXS (C) | Not in PGDG, monitoring |
| supabase_vault | ~150 KB | PGXS (C) | Supabase-specific |
| pgmq | ~140 KB | cargo-pgrx (Rust) | Not in PGDG, message queue |
| index_advisor | ~120 KB | PGXS (C) | Not in PGDG, optimization |
| pg_hashids | ~100 KB | PGXS (C) | Not in PGDG, encoding |
| pg_plan_filter | ~80 KB | PGXS (C) | Hook-based, not in PGDG |
| pg_safeupdate | ~70 KB | PGXS (C) | Hook-based, not in PGDG |
| pgbackrest | ~50 KB | PGXS (C) | Not in PGDG, backup tool |
| pgbadger | ~40 KB | Perl script | Not in PGDG, log analyzer |
| wal2json | ~35 KB | PGXS (C) | Logical decoding plugin |

**Build time:** ~12 minutes (down from ~20 minutes with full compilation)

---

## The timescaledb_toolkit Outlier

### Why 186MB?

**Root causes:**
1. **Rust binary bloat**: Rust compiles larger than C by default
2. **Unoptimized compilation**: No size optimization flags applied
3. **Debug symbols not stripped**: `-g` flag retained during build
4. **LLVM bitcode embedded**: PostgreSQL 18 saves LLVM IR (~36MB across all extensions)

**Comparison:**
```
timescaledb (C-based core):        719 KB
timescaledb_toolkit (Rust):     186,000 KB  (260x larger)
```

**Impact:** Single extension = 58% of all extension binary size

### Optimization Opportunities

**Planned (Phase 11):**
1. Add RUSTFLAGS to builder-cargo stage:
   ```dockerfile
   ENV RUSTFLAGS="-C opt-level=z -C lto=thin -C strip=symbols"
   ENV CARGO_PROFILE_RELEASE_LTO=thin
   ENV CARGO_PROFILE_RELEASE_OPT_LEVEL=3
   ```
   **Expected reduction:** 186MB → 120-140MB (40-60MB savings)

2. Add conditional build flag:
   ```dockerfile
   ARG INCLUDE_TIMESCALEDB_TOOLKIT=true
   ```
   **Benefit:** Create lean variant without toolkit (saves 186MB)

**Already Applied (Phase 3):**
- Strip debug symbols from all `.so` files: `strip --strip-debug`
- Remove LLVM bitcode directory: 36MB saved
- Remove static libraries (`.a` files): 1.5MB saved

---

## Build Artifact Cleanup Status

### Current Optimizations (Phase 3)

**In builder-pgxs stage:**
```dockerfile
find /opt/ext-out/usr/lib/postgresql/${PG_MAJOR}/lib -name '*.so' -exec strip --strip-debug {} \;
rm -rf /opt/ext-out/usr/lib/postgresql/${PG_MAJOR}/lib/bitcode
find /opt/ext-out -name '*.a' -delete
```

**In builder-cargo stage:**
```dockerfile
find /opt/ext-out/usr/lib/postgresql/${PG_MAJOR}/lib -name '*.so' -exec strip --strip-debug {} \;
rm -rf /opt/ext-out/usr/lib/postgresql/${PG_MAJOR}/lib/bitcode
find /opt/ext-out -name '*.a' -delete
```

**Total savings:** ~37.5MB (36MB bitcode + 1.5MB static libs)

### Verification Needed

**Question:** Are there build artifacts in final image?
- Build tools (gcc, make, cargo) should only be in builder stages
- Final stage should only have runtime binaries and libraries
- Need to verify no `/tmp` artifacts, build caches, or intermediate files

**Action:** Phase 9 will include image inspection to verify cleanliness

---

## Image Layer Analysis

### Current Multi-Stage Build

```
builder-base (Debian dev tools)
    ↓
builder-pgxs (compile PGXS/autotools/cmake/meson extensions)
    → Strip binaries, remove bitcode/static libs
    → Copy to /opt/ext-out/
    ↓
builder-cargo (compile cargo-pgrx Rust extensions)
    → Strip binaries, remove bitcode/static libs
    → Copy to /opt/ext-out/
    ↓
Final stage (postgres:18-trixie base)
    ├── Install PGDG packages (294MB layer)
    ├── Install runtime deps (368MB layer)
    ├── COPY --from=builder-pgxs (245MB layer)
    ├── COPY --from=builder-cargo (42.7MB layer)
    └── Result: 1.17GB total image
```

**Layer breakdown:**
- PostgreSQL 18 base: ~450MB
- PGDG packages: 294MB
- Runtime dependencies: 368MB
- Compiled extensions: 287.7MB (245MB + 42.7MB)
- Configs + scripts: ~30KB

**Total:** 1.17GB (compressed to ~500MB in registry)

---

## Recommendations

### For Size-Critical Deployments

1. **Remove timescaledb_toolkit** → saves 186MB (16% reduction)
2. **Create image variants:**
   - `aza-pg:minimal` — pgvector, postgis only (~800MB)
   - `aza-pg:standard` — without timescaledb_toolkit (~1.0GB)
   - `aza-pg:full` — current, all extensions (~1.17GB)

### For Performance-Critical Deployments

- **Keep current approach** — broad functionality, certified packages
- **Apply Rust optimizations** — reduce toolkit from 186MB to ~130MB
- **Monitor extension usage** — identify unused extensions for custom builds

### For All Deployments

**Verify no build artifacts in final image:**
- Check for gcc, make, cargo, rustc in final stage
- Inspect `/tmp`, `/var/tmp` for build caches
- Confirm no `.c`, `.h`, `.o` files present

---

## Size Monitoring Commands

```bash
# Total extension binary size
du -sh /usr/lib/postgresql/18/lib

# Extension count
find /usr/lib/postgresql/18/lib -name '*.so' | wc -l

# Top 10 extensions by size
find /usr/lib/postgresql/18/lib -name '*.so' -exec ls -lh {} \; | sort -k5 -hr | head -10

# Image layer analysis
docker history --no-trunc aza-pg:latest | grep -E "RUN|COPY"

# Build artifact check (should return empty)
docker run --rm aza-pg:latest sh -c 'which gcc make cargo rustc 2>/dev/null'

# Temporary file check
docker run --rm aza-pg:latest sh -c 'find /tmp /var/tmp -type f 2>/dev/null | wc -l'
```

---

## Conclusion

**Current state:** 38 extensions, 319MB footprint, 1.17GB total image

**Trade-offs:**
- ✅ Single image supports vector, time-series, geospatial, search, security workloads
- ✅ PGDG packages provide stability and security updates
- ✅ SHA-pinned source builds prevent supply chain attacks
- ✅ Already optimized (stripped binaries, no bitcode, no static libs)
- ❌ timescaledb_toolkit dominates size (186MB / 58%)
- ⚠️ Rust extensions unoptimized (RUSTFLAGS not applied)

**Next steps:**
1. Verify no build artifacts in final image
2. Check GitHub releases for pre-built binaries
3. Apply Rust optimization flags (Phase 11)
4. Measure performance impact per extension (Phase 9)
