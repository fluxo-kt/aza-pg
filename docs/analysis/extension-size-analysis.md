# aza-pg:pgdg-opt Image — Extension Size Impact Analysis

**Analysis Date:** 2025-11-05  
**Image:** aza-pg:pgdg-opt (PostgreSQL 18.0-1.pgdg13+3)  
**Platform:** linux/amd64

---

## Executive Summary

The `aza-pg:pgdg-opt` image contains **28 curated PostgreSQL extensions** totaling **319MB**:
- **247MB** in compiled `.so` libraries (`/usr/lib/postgresql/18/lib`)
- **72MB** in extension SQL/control files (`/usr/share/postgresql/18/extension`)

**Single largest item:** `timescaledb_toolkit-1.22.0.so` = **13MB** (optimized from 186MB pre-Phase 11, was 58% of all extension binaries)

**Build approach:** Hybrid strategy using both:
- **15 PGDG-packaged** extensions (from Debian apt repos)
- **13 source-compiled** extensions (custom builds via pgxs/cargo-pgrx)

---

## Image Layer Breakdown

### Docker Layer Sizes (from `docker history`)

| Layer | Size | Purpose |
|-------|------|---------|
| PGDG extension packages install | 294MB | Pre-compiled binaries: pgvector, pgAudit, PostGIS, TimescaleDB, cron, partman, repack, plpgsql_check, hll, http, hypopg, pgrouting, rum, set_user, wal2json |
| Runtime dependency packages | 368MB | Shared libraries required by compiled extensions (GEOS, PROJ, libcurl, libjson, etc.) |
| Compiled extensions layer 1 | 245MB | First batch of source-compiled extensions |
| Compiled extensions layer 2 | 42.7MB | Second batch of source-compiled extensions |
| Base configs + entrypoint | ~30KB | Auto-config scripts, postgresql-base.conf |

**Total extension footprint:** ~950MB across all layers (raw layer sizes, before deduplication)  
**Actual extension content on disk:** 319MB

---

## Extension Storage Breakdown

### By Location

```
/usr/lib/postgresql/18/lib     247M   (compiled .so binaries)
  ├── Bitcode directory         36M   (LLVM IR, not used at runtime)
  ├── Archive libraries         1.3M  (libpgcommon.a, libpgport.a, etc.)
  └── .so files (119 total)    ~210M  (actual extension binaries)

/usr/share/postgresql/18/extension  72M   (SQL/control files)
  ├── 920 files total
  ├── TimescaleDB data (~10MB)
  └── Extension upgrade scripts
```

### Top 20 Extension Binaries by Size

| Rank | Extension | Size | Type | Installation |
|------|-----------|------|------|---------------|
| 1 | timescaledb_toolkit | 13M (optimized from 186M) | .so | Source-compiled (cargo-pgrx) |
| 2 | pg_jsonschema | 4.4M | .so | Source-compiled |
| 3 | libpgrouting | 3.5M | .so | PGDG package |
| 4 | pgroonga | 2.1M | .so | Source-compiled |
| 5 | vectorscale | 1.6M | .so | Source-compiled |
| 6 | postgis | 1.3M | .so | PGDG package |
| 7 | dict_snowball | 787K | .so | Builtin (PostgreSQL core) |
| 8 | timescaledb | 719K | .so | PGDG package |
| 9 | wrappers | 595K | .so | Source-compiled |
| 10 | postgis_raster | 551K | .so | PGDG package |
| 11 | address_standardizer | 429K | .so | PGDG package |
| 12 | pgsodium | 380K | .so | Source-compiled |
| 13 | postgis_topology | 323K | .so | PGDG package |
| 14 | supautils | 290K | .so | Source-compiled |
| 15 | pg_stat_monitor | 245K | .so | Source-compiled |
| 16–20 | Various encoding modules | 200–266K each | .so | Builtin (PostgreSQL core) |

---

## Extension Installation Strategy

### PGDG-Packaged Extensions (15 total)

Installed via `apt-get install postgresql-${PG_MAJOR}-<name>`. Benefits from Debian package management but includes distribution dependencies.

```
postgresql-18-cron=1.6.7-2.pgdg13+1
postgresql-18-pgaudit=18.0-2.pgdg13+1
postgresql-18-pgvector=0.8.1-2.pgdg13+1
postgresql-18-timescaledb=2.23.0+dfsg-1.pgdg13+1
postgresql-18-postgis-3=3.6.0+dfsg-2.pgdg13+1
postgresql-18-partman=5.3.1-1.pgdg13+1
postgresql-18-repack=1.5.3-1.pgdg13+1
postgresql-18-plpgsql-check=2.8.3-1.pgdg13+1
postgresql-18-hll=2.19-1.pgdg13+1
postgresql-18-http=1.7.0-3.pgdg13+1
postgresql-18-hypopg=1.4.2-2.pgdg13+1
postgresql-18-pgrouting=3.8.0-2.pgdg13+1
postgresql-18-rum=1.3.15-1.pgdg13+1
postgresql-18-set-user=4.2.0-1.pgdg13+1
postgresql-18-wal2json=2.6-3.pgdg13+1
```

**Build system:** All use PGXS (standard PostgreSQL extension build framework)  
**Size impact:** ~310MB total (binaries + dependencies)

### Source-Compiled Extensions (13 total)

Built from git-pinned commit SHAs using custom build scripts. Includes extensions not in PGDG or requiring specific versions.

```
Compiled from source (cargo-pgrx/pgxs/cmake/meson):
  ├── index_advisor         – pgxs build
  ├── pg_hashids            – pgxs build
  ├── pg_jsonschema         – cargo-pgrx (Rust)
  ├── pg_safeupdate         – pgxs build
  ├── pg_stat_monitor       – cargo-pgrx (Rust)
  ├── pgmq                  – cargo-pgrx (Rust)
  ├── pgroonga              – meson/cargo-pgrx (search engine)
  ├── pgsodium              – pgxs build (crypto)
  ├── supabase_vault        – pgxs build
  ├── supautils             – cargo-pgrx (Rust)
  ├── timescaledb_toolkit   – cargo-pgrx (Rust) — 13MB binary (optimized from 186MB in Phase 11)
  ├── vectorscale           – cargo-pgrx (Rust)
  └── wrappers              – pgxs build (foreign data wrapper)
```

**Build system:** Mix of PGXS (C-based) and cargo-pgrx (Rust)  
**Size impact:** ~200MB in binaries  
**Strategy:** Pinned commit SHAs prevent supply chain attacks (immutable, unlike tags)

### Builtin Extensions (130+)

Compiled as part of PostgreSQL core (no separate installation needed).

```
Examples: auto_explain, pg_stat_statements, pg_trgm, pg_cron, pgAudit,
          UUID, ltree, hstore, bloom, btree_gist, intarray, etc.

Size: ~5MB (included in PostgreSQL base image)
```

---

## Size Impact by Category

### By Functionality

| Category | Extensions | Size | Key Items |
|----------|-----------|------|-----------|
| **Time-series** | timescaledb, timescaledb_toolkit | 13.7MB (optimized from 186.7MB) | Toolkit is 13M (optimized from 186M in Phase 11); primarily analytics |
| **Geospatial** | postgis, postgis_raster, postgis_topology, address_standardizer | 2.6MB | Complex geometry types |
| **Search** | pgroonga, pg_jsonschema | 6.5MB | Full-text & JSON schema validation |
| **Vector/ML** | pgvector, vectorscale, pg_hashids | 1.8MB | Embedding search, hashing |
| **Observability** | pg_stat_monitor, pg_stat_statements, pg_cron | 292KB | Query monitoring, task scheduling |
| **Security** | pgAudit, pgsodium, pg_safeupdate, supabase_vault | 754KB | Audit logs, encryption, constraint checking |
| **Development Tools** | plpgsql_check, hypopg, pg_repack, wal2json | 218KB | Debugging, index simulation, replication |
| **Foreign Data** | wrappers, postgres_fdw, mysql_fdw | 595KB+ | External data access |

### Compression Characteristics

- **Bitcode directory:** 36MB of LLVM intermediate representation (NOT used at runtime, could be removed)
- **Encoding modules:** ~2.5MB (dict_snowball, UTF-8 variants) — rarely used unless internationalization required
- **Archive libraries:** 1.3MB (.a static libs for compilation, not runtime)

---

## The TimescaleDB Toolkit Outlier

### Why was `timescaledb_toolkit-1.22.0.so` 186MB (pre-Phase 11 optimization)?

**Original root cause (pre-Phase 11):** This was a **Rust extension** compiled with debug symbols and LLVM bitcode embedded.

**Original breakdown (pre-Phase 11):**
- **Unoptimized Rust binary:** Rust code compiles larger than C by default
- **Debug symbols:** Not stripped (`-g` flag retained)
- **LLVM IR embedded:** PostgreSQL 18's LLVM IR saves intermediate representation in `bitcode/` (36MB total across all extensions)

**Applied optimization (Phase 11):**
- **Rust optimization flags:** CARGO_PROFILE_RELEASE_OPT_LEVEL=s, LTO=thin, strip=symbols
- **Result:** 186MB → 13MB (-93.0% reduction)

**Comparison:**
```
timescaledb-2.23.0.so       719K   (C-based, optimized)
timescaledb_toolkit-1.22.0.so 186M  (Rust, unoptimized in pre-Phase 11 version)
timescaledb_toolkit-1.22.0.so 13M   (Rust, optimized in Phase 11 version)
```

**Impact (pre-optimization):** TimescaleDB Toolkit was **58% of all extension binary size** (186MB)

### Mitigation Strategies (not currently applied)

1. **Strip debug symbols:** `-c 'strip /usr/lib/postgresql/18/lib/timescaledb_toolkit-*.so'` could reduce by ~40–50%
2. **Remove LLVM bitcode:** Delete `/usr/lib/postgresql/18/lib/bitcode/` → saves 36MB (0% runtime impact)
3. **Use TimescaleDB Toolkit selectively:** Make it an optional layer or separate image variant

---

## Layer Size Summary

### Current Multi-Stage Build Flow

```
builder-base (Debian dev tools)
    ↓
builder-pgxs (compile PGXS/autotools extensions)
    → Copy to /opt/ext-out/
    ↓
builder-cargo (compile cargo-pgrx Rust extensions)
    → Copy to /opt/ext-out/
    ↓
Final stage (postgres:18-trixie base)
    ├── Install PGDG packages (294MB layer)
    ├── Install runtime deps (368MB layer)
    ├── COPY from builder-pgxs (245MB layer)
    ├── COPY from builder-cargo (42.7MB layer)
    └── Result: 247MB extension binaries on final image
```

### Why Two Builder Stages?

- **builder-pgxs:** Compiles standard PostgreSQL extensions (C-based, autotools/cmake/meson)
- **builder-cargo:** Compiles Rust extensions (cargo-pgrx) separately (Rust toolchain overhead)
- **Separation:** Allows independent caching and cleaner layer management

---

## Dependency Overhead (Runtime Packages)

The **368MB runtime layer** pulls in:

```
System dependencies for compiled extensions:
  - GEOS/PROJ (PostGIS geometry)
  - libcurl, libjson-c (http, pg_jsonschema, pgroonga)
  - libfuzzy (pgroonga FTS)
  - libsodium (pgsodium crypto)
  - Additional development headers
```

This is PGDG-specific overhead. A pure source-compiled image (without PGDG packages) would be **smaller but slower to build**.

---

## Recommendations

### If Size is Critical (lean image)

1. **Previously considered: Remove TimescaleDB Toolkit** (186MB pre-Phase 11 size) — No longer needed as optimization reduced size to 13MB
   - Keep `timescaledb` core (719K) if needed
   - Creates separate lightweight variant

2. **Remove Bitcode directory** (36MB, 0% impact)
   ```dockerfile
   RUN rm -rf /usr/lib/postgresql/18/lib/bitcode
   ```

3. **Strip extension binaries** (5–10% reduction)
   ```dockerfile
   RUN find /usr/lib/postgresql/18/lib -name '*.so' -exec strip {} \;
   ```

4. **Create multi-image variants**
   - `aza-pg:core` — minimal (PostGIS, pgvector only)
   - `aza-pg:analytics` — full TimescaleDB suite
   - `aza-pg:pgdg-opt` — current, all extensions

### If Performance is Critical (current approach)

- **Keep all extensions** (broader use cases)
- **Keep debug symbols** (easier troubleshooting in production)
- **Keep PGDG packages** (certified versions, dependency management)

### Size Monitoring

Track these metrics in CI/CD:

```bash
# Total .so size
du -sh /usr/lib/postgresql/18/lib

# Extension count
find /usr/lib/postgresql/18/lib -name '*.so' | wc -l

# Top 10 by size
find /usr/lib/postgresql/18/lib -name '*.so' -exec ls -lh {} \; | sort -k5 -hr | head -10

# Layer comparison
docker history --no-trunc <image> | grep -E "RUN|COPY"
```

---

## Appendix: Full Extension Inventory

### PGDG-Packaged (via apt-get)

1. pg_cron (1.6.7) — Task scheduler
2. pgAudit (18.0) — Security audit logging
3. pgvector (0.8.1) — Vector similarity search
4. TimescaleDB (2.23.0) — Time-series database
5. PostGIS (3.6.0) — Geospatial queries
6. pg_partman (5.3.1) — Partition management
7. pg_repack (1.5.3) — Online table rebuild
8. plpgsql_check (2.8.3) — PL/pgSQL validator
9. HLL (2.19) — HyperLogLog cardinality
10. pgsql-http (1.7.0) — HTTP client
11. HypoPG (1.4.2) — Hypothetical indexes
12. pgRouting (3.8.0) — Routing algorithms
13. RUM (1.3.15) — Reverse-use multi-column indexes
14. set_user (4.2.0) — Role switching
15. wal2json (2.6) — WAL replication decoder

### Source-Compiled (custom builds)

1. index_advisor — Index optimization recommendations
2. pg_hashids — Hashids encoding
3. pg_jsonschema — JSON schema validation
4. pg_safeupdate — Constraint enforcement
5. pg_stat_monitor — Query monitoring (Rust)
6. pgmq — Message queue (Rust)
7. pgroonga — Full-text search (Rust/C hybrid)
8. pgsodium — Cryptographic functions
9. supabase_vault — Secrets management
10. supautils — Utility functions (Rust)
11. TimescaleDB Toolkit — Analytics (Rust) — **13MB (optimized from 186MB pre-Phase 11)**
12. vectorscale — Vector operations (Rust)
13. wrappers — Foreign data wrapper (pgxs)

### Total: 28+ curated extensions, **319MB footprint**

---

## Conclusion

The `aza-pg:pgdg-opt` image aggressively bundles extensions for broad use cases. The **formerly largest item** was `timescaledb_toolkit` (186MB pre-Phase 11), now optimized to 13MB after applying Rust compilation flags.

**Current trade-offs:**
- ✅ Single image adapts to many workloads (vector, time-series, geospatial, search, security)
- ✅ Certified PGDG packages with security updates
- ✅ SHA-pinned source builds prevent supply chain attacks
- ❌ Large image size (~950MB with dependencies)
- ❌ TimescaleDB Toolkit dominates footprint

**Recommended next steps:** Evaluate creating lean variants or stripping debug artifacts if image size becomes a deployment constraint.

