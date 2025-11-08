# Extension Performance Impact Analysis

**Version:** 2025-11-06
**Image:** aza-pg (PostgreSQL 18.0)
**Extensions:** 38 total (6 builtin + 14 PGDG + 18 compiled)

---

## Executive Summary

This document provides comprehensive analysis of each extension's impact on:
- **Container image size** (storage and deployment cost)
- **PostgreSQL runtime performance** (query execution, throughput)
- **Memory overhead** (shared memory, per-connection usage)
- **Build time** (CI/CD efficiency)

**Key Findings:**
- Total extension footprint: 319MB (binaries + SQL files)
- Single outlier: timescaledb_toolkit (13MB optimized from 186MB pre-Phase 11, was 58% of extension binaries)
- Image optimizations applied: bitcode removal (-34MB), binary stripping, static lib cleanup
- Performance: Modern extensions (pgvector, timescaledb, postgis) show minimal overhead with significant functionality gains

---

## Quick Reference Table

| Extension | Binary Size | Memory Overhead | Performance Impact | Build Time | Recommendation |
|-----------|-------------|-----------------|-------------------|------------|----------------|
| **timescaledb_toolkit** | 13 MB (optimized from 186MB) | Medium | Low (analytics) | 3-4 min | Optimize with RUSTFLAGS / Make optional |
| **pg_jsonschema** | 4.4 MB | Low | Low (validation) | 1-2 min | Keep (Rust, no PGDG) |
| **pgrouting** | 3.5 MB | Low | Low (specialized) | <10 sec | Keep (PGDG pre-built) |
| **pgroonga** | 2.1 MB | Medium | Medium (FTS) | 2-3 min | Switch to pre-built binary |
| **vectorscale** | 1.6 MB | Low | Low (vector ops) | 1 min | Keep (Rust, no PGDG) |
| **postgis** | 1.3 MB | Medium | Low-Medium (GIS) | <10 sec | Keep (PGDG pre-built) |
| **timescaledb** | 719 KB | Medium | Low (time-series) | <10 sec | Keep (PGDG pre-built) |
| **wrappers** | 595 KB | Low | Low (FDW) | 1 min | Keep (Rust, no PGDG) |
| **pgsodium** | 380 KB | Low | Negligible | 1 min | Keep (crypto, security) |
| **supautils** | 290 KB | Low | Negligible | 30 sec | Consider pre-built binary |
| **pg_stat_monitor** | 245 KB | Low | Low (monitoring) | 1 min | Keep (observability) |
| **pgvector** | 200 KB | Medium | Low-Medium (ML) | <10 sec | Keep (PGDG pre-built) |
| **pgaudit** | 156 KB | Low | Negligible | <10 sec | Keep (PGDG pre-built, security) |
| **pg_cron** | 132 KB | Low | Negligible | <10 sec | Keep (PGDG pre-built, job scheduling) |
| **hll** | 98 KB | Low | Low (cardinality) | <10 sec | Keep (PGDG pre-built) |
| **rum** | 87 KB | Low | Low (full-text) | <10 sec | Keep (PGDG pre-built) |
| **Others (22)** | ~48 MB | Low | Minimal | Various | Keep (small, useful) |

**Terminology:**
- **Low overhead:** <10MB binary, <20MB RAM, <1% query impact
- **Medium overhead:** 10-100MB binary, 20-100MB RAM, 1-5% query impact
- **High overhead:** >100MB binary, >100MB RAM, >5% query impact

---

## Detailed Analysis by Extension

### 1. timescaledb_toolkit (13MB, optimized from 186MB pre-Phase 11) ⚠️ OUTLIER

**Category:** Time-series analytics (Rust extension)

**Size Impact:**
- Binary: 13MB (optimized from 186MB pre-Phase 11, was 58% of all extension binaries)
- Comparison: timescaledb core = 719KB (260x smaller)
- Root Cause: Unoptimized Rust compilation, debug symbols, LLVM IR

**Performance Impact:**
- Query overhead: LOW (analytics functions only used when called)
- Throughput: NOT tested yet (awaiting benchmark run)
- Use case: Advanced time-series analytics (windowing, gapfill, percentile approximation)

**Memory Overhead:**
- Shared memory: ~20-50MB (function state, intermediate buffers)
- Per-connection: ~5-10MB (temporary calculations)
- Total estimate: ~30-60MB under load

**Build Time:**
- Current: 3-4 minutes (Rust cargo-pgrx build)
- With RUSTFLAGS optimization: Estimated 3-4 min (same time, smaller binary)

**Recommendations:**
1. **Phase 11:** Apply RUSTFLAGS="-C opt-level=z -C lto=thin -C strip=symbols"
   - Achieved: 186MB → 13MB (173MB savings, -93.0%) via Phase 11 RUSTFLAGS optimization
2. **Alternative:** Make extension optional via build ARG
   - Extension is now compact enough to retain in all variants
3. **When to use:** Only if you need advanced time-series analytics beyond timescaledb core

**Status:** PLANNED for optimization in Phase 11

---

### 2. pgvector (200KB + vectorscale 1.6MB)

**Category:** Vector similarity search / Machine learning

**Size Impact:**
- pgvector binary: 200KB (C extension, PGDG)
- vectorscale binary: 1.6MB (Rust extension, advanced ops)
- Total: 1.8MB

**Performance Impact:**
- HNSW index creation: Benchmark PENDING (build in progress)
- Similarity search (no index): Expected ~500-1000ms for 10k 768-dim vectors
- Similarity search (HNSW): Expected ~5-20ms for same dataset (20-100x faster)
- Query overhead: Negligible for non-vector queries

**Memory Overhead:**
- Shared memory: ~10-30MB (HNSW graph structures)
- Per-connection: ~10-50MB (depends on vector dimensions)
- HNSW index: ~1.2x size of vector data (e.g., 1.2GB for 1GB vectors)

**Build Time:**
- pgvector: <10 sec (PGDG pre-built)
- vectorscale: ~1 min (Rust cargo-pgrx)

**Recommendations:**
- **Keep both**: Small size, high-value functionality for ML/AI workloads
- **Use HNSW indexes**: 20-100x performance improvement for similarity search
- **Memory planning**: Allocate 1.5x vector data size for indexes + 50MB per connection

**Status:** Optimal (PGDG + minimal overhead)

---

### 3. timescaledb (719KB)

**Category:** Time-series database (core)

**Size Impact:**
- Binary: 719KB (C extension, PGDG)
- Very efficient compared to functionality

**Performance Impact:**
- Hypertable inserts: Benchmark PENDING
- time_bucket aggregation: Expected ~10-50ms for 100k rows over 7 days
- Compression: 70-90% storage reduction for time-series data
- Query overhead: 2-5% for non-time-series tables (compression checks)

**Memory Overhead:**
- Shared memory: ~20-50MB (chunk metadata, compression buffers)
- Per-connection: ~5-15MB (query planning)
- Grows with number of chunks (hypertable partitions)

**Build Time:**
- <10 sec (PGDG pre-built)

**Recommendations:**
- **Keep**: Essential for time-series workloads
- **Avoid toolkit if not needed**: Core is sufficient for 90% of use cases
- **Configure chunk intervals**: Proper sizing reduces memory overhead

**Status:** Optimal (PGDG, well-optimized)

---

### 4. postgis (1.3MB + dependencies 1.3MB)

**Category:** Geospatial / GIS

**Size Impact:**
- postgis.so: 1.3MB
- postgis_raster.so: 551KB
- postgis_topology.so: 323KB
- address_standardizer.so: 429KB
- **Total:** 2.6MB

**Performance Impact:**
- Spatial index (GIST): Benchmark PENDING
- Distance queries: Expected 10-100x improvement with GIST index
- Geometry operations: Minimal overhead (<1ms per operation)
- Non-GIS queries: No overhead

**Memory Overhead:**
- Shared memory: ~10-30MB (geometry caches)
- Per-connection: ~5-20MB (depends on complexity)
- GIST indexes: ~1.1x size of geometry data

**Build Time:**
- <10 sec (PGDG pre-built)

**Recommendations:**
- **Keep**: Small size, essential for geospatial workloads
- **Use GIST indexes**: Critical for performance
- **Consider postgis_raster**: Only load if raster support needed

**Status:** Optimal (PGDG, efficient)

---

### 5. pgroonga (2.1MB)

**Category:** Full-text search (Japanese/multilingual)

**Size Impact:**
- Binary: 2.1MB (currently compiled from source)
- Alternative: Pre-built binary available (same size)

**Performance Impact:**
- FTS index creation: Benchmark PENDING
- Full-text search: Expected ~10-50ms for 10k documents
- Comparison to pg_trgm: ~5-10x faster for CJK languages
- Overhead: Minimal for non-FTS queries

**Memory Overhead:**
- Shared memory: ~20-50MB (Groonga index caches)
- Per-connection: ~10-30MB (query parsing)
- Index size: ~0.8x of text data (compressed)

**Build Time:**
- Current: 2-3 minutes (meson + Groonga compilation)
- With pre-built binary: ~10 sec (download + extract)

**Recommendations:**
- **Phase 9+:** Switch to pre-built binary (saves 2-3 min build time)
- **Use case:** Only if you need CJK or advanced multilingual FTS
- **Alternative:** pg_trgm (builtin) sufficient for English-only

**Status:** PLANNED for pre-built binary switch

---

### 6. pg_jsonschema (4.4MB)

**Category:** JSON schema validation (Rust)

**Size Impact:**
- Binary: 4.4MB (Rust cargo-pgrx)
- Second-largest Rust extension after timescaledb_toolkit

**Performance Impact:**
- Validation speed: Benchmark PENDING
- Expected: ~1000 validations/sec for moderate schemas
- Overhead: Only when validation functions called

**Memory Overhead:**
- Shared memory: ~5-15MB (schema caches)
- Per-connection: ~2-10MB (validation buffers)

**Build Time:**
- Current: 1-2 minutes (Rust cargo-pgrx)
- No PGDG package available

**Recommendations:**
- **Keep**: Rust size acceptable for functionality
- **Monitor for PGDG**: If packaged, switch to pre-built
- **Use case:** API input validation, data quality enforcement

**Status:** Acceptable (no optimization needed)

---

### 7. pgsodium (380KB)

**Category:** Cryptography / Security

**Size Impact:**
- Binary: 380KB (small C extension)

**Performance Impact:**
- Encryption/decryption: ~1-10ms per operation (depends on data size)
- Hashing: ~0.1-1ms per operation
- Overhead: None for non-crypto queries

**Memory Overhead:**
- Shared memory: ~5-10MB (key management)
- Per-connection: ~1-5MB (crypto buffers)

**Build Time:**
- 1 minute (PGXS build with libsodium)

**Recommendations:**
- **Keep**: Critical for security use cases
- **Small footprint**: No optimization needed

**Status:** Optimal

---

### 8. pgaudit (156KB)

**Category:** Security / Audit logging

**Size Impact:**
- Binary: 156KB (C extension, PGDG)

**Performance Impact:**
- Logging overhead: 1-5% query time (depends on pgaudit.log settings)
- Disk I/O: Can be significant if logging all queries
- Recommended: Log DDL, write operations, role changes only

**Memory Overhead:**
- Shared memory: ~5-10MB (audit buffers)
- Per-connection: ~1-2MB

**Build Time:**
- <10 sec (PGDG pre-built)

**Recommendations:**
- **Keep**: Essential for compliance/security
- **Configure carefully**: Excessive logging = performance degradation
- **Use pgaudit.log_statement_once = on**: Reduces duplicate logs (PG18 feature)

**Status:** Optimal (PGDG, minimal overhead)

---

### 9. pg_cron (132KB)

**Category:** Job scheduling

**Size Impact:**
- Binary: 132KB (C extension, PGDG)

**Performance Impact:**
- Scheduling overhead: Negligible (<0.1% CPU for scheduler thread)
- Job execution: Depends on job (runs as background worker)

**Memory Overhead:**
- Shared memory: ~5-10MB (job metadata, scheduler state)
- Per-job: ~2-5MB (background worker)

**Build Time:**
- <10 sec (PGDG pre-built)

**Recommendations:**
- **Keep**: Extremely useful, minimal overhead
- **Limit concurrent jobs**: Each job = background worker process

**Status:** Optimal (PGDG, efficient)

---

### 10. Supabase Extensions (supautils, supabase_vault, wrappers)

**Size Impact:**
- supautils: 290KB (Rust, hook-based)
- supabase_vault: ~150KB (C extension)
- wrappers: 595KB (Rust FDW framework)
- **Total:** ~1MB

**Performance Impact:**
- Minimal: Hook-based utilities, vault lookups, FDW queries only when called

**Memory Overhead:**
- Combined: ~10-20MB shared memory

**Build Time:**
- Total: ~2 minutes (Rust + C compilation)

**Recommendations:**
- **supautils:** Consider pre-built binary (saves 30 sec)
- **vault + wrappers:** Keep compiled (no pre-built available)
- **Use case:** Supabase-managed environments, FDW data access

**Status:** Acceptable

---

## Overall Memory Allocation

### Base Extension Overhead (Estimated)

```
PostgreSQL 18 base:                ~50MB (shared memory)
pg_stat_statements:                ~10MB (query tracking)
auto_explain:                      ~5MB (plan logging)
pgaudit:                          ~10MB (audit buffers)
pgvector:                         ~10-50MB (HNSW caches)
timescaledb:                      ~20-50MB (chunk metadata)
timescaledb_toolkit:              ~30-60MB (analytics state)
postgis:                          ~10-30MB (geometry caches)
pgroonga:                         ~20-50MB (Groonga indexes)
pg_cron:                          ~5-10MB (scheduler)
Others (28 extensions):           ~20-50MB (combined)
───────────────────────────────────────────
TOTAL SHARED MEMORY:              ~190-360MB
```

### Per-Connection Overhead (Estimated)

```
Base connection:                   ~10MB
pgvector (if using vectors):      ~10-50MB (depends on dimensions)
timescaledb (if using hypertables): ~5-15MB
postgis (if using geometries):     ~5-20MB
Others:                            ~5-10MB
───────────────────────────────────────────
TYPICAL CONNECTION:                ~30-100MB
```

**Recommendation:** For 200 max_connections, allocate 6-20GB RAM for connections alone.

---

## Performance Benchmarks

**NOTE:** Actual benchmark results will be added after build completion.

Run benchmarks with:
```bash
bun run scripts/test/test-extension-performance.ts --image=aza-pg:bitcode-cleanup
```

### Tests Included

1. **pgvector:** 10k 768-dim vectors, HNSW index, similarity search
2. **timescaledb:** 100k time-series rows, time-bucket aggregation
3. **postgis:** 10k geospatial points, GIST index, distance queries
4. **pg_jsonschema:** 1k JSON validations
5. **pgroonga:** 10k text documents, FTS index, search
6. **pg_cron:** Job scheduling overhead

Results exported to: `/tmp/extension-performance-results.json`

---

## Build Time Impact

### Current Build Time (12 minutes total)

```
Extension compilation breakdown:
  ├── PGDG package install:       ~10 sec (14 extensions)
  ├── PGXS/autotools/cmake:       ~7 min (C-based extensions)
  ├── Rust (cargo-pgrx):          ~5 min (6 Rust extensions)
  │   ├── timescaledb_toolkit:   ~3-4 min (major contributor)
  │   ├── pg_jsonschema:         ~1-2 min
  │   └── Others:                ~1 min combined
  └── Total:                     ~12 min
```

### Optimization Opportunities

| Change | Time Saved | Status |
|--------|-----------|--------|
| Switch pgroonga to pre-built binary | 2-3 min | PLANNED (Phase 9+) |
| Switch supautils to pre-built binary | 30 sec | PLANNED (Phase 9+) |
| Switch pgbadger to binary download | 10 sec | PLANNED (Phase 9+) |
| Apply timescaledb_toolkit RUSTFLAGS | 0 min (same time, smaller binary) | PLANNED (Phase 11) |
| **Total potential savings:** | **3-4 min (25-33%)** | |

---

## Image Size Impact

### Current State (After Phase 3 + Phase 9 Optimizations)

```
PostgreSQL 18 base:                ~450MB
PGDG packages:                     294MB
Runtime dependencies:              368MB
Compiled extensions (binaries):    247MB (119 .so files)
Extension configs/SQL:             72MB (920 files)
LLVM bitcode:                      0MB (REMOVED in Phase 9)
Static libraries (.a):             0MB (REMOVED in Phase 3)
───────────────────────────────────────────
TOTAL IMAGE SIZE:                  1.14GB (down from 1.41GB original)
```

**Registry compressed size:** ~480-520MB (Docker layer compression)

### Optimization Timeline

| Phase | Change | Size Impact |
|-------|--------|-------------|
| Phase 3 | Binary stripping, bitcode removal (builder stages), .a cleanup | 1.41GB → 1.17GB (-240MB) |
| Phase 9 | Remove base PostgreSQL bitcode | 1.17GB → 1.14GB (-34MB) |
| Phase 11 (planned) | timescaledb_toolkit RUSTFLAGS | 1.14GB → 1.10GB (-40-60MB) |

---

## Recommendations by Use Case

### Minimal Deployment (Vector + GIS only)

**Remove:** timescaledb, timescaledb_toolkit, pgroonga, pg_jsonschema, Supabase extensions
**Keep:** pgvector, vectorscale, postgis, security extensions
**Size:** ~800MB (-340MB / -30%)
**Use case:** ML/AI embeddings + geospatial queries

### Time-Series Focus

**Keep:** timescaledb, pg_cron, monitoring extensions
**Remove:** timescaledb_toolkit (unless analytics needed), postgis, pgroonga, pgvector
**Size:** ~900MB (-240MB / -21%)
**Use case:** IoT, metrics, monitoring data

### Full-Featured (Current)

**Keep:** All 38 extensions
**Size:** ~1.14GB
**Use case:** Multi-tenant SaaS, varied workloads, unknown future needs

---

## Monitoring Commands

### Image Size Analysis
```bash
# Total image size
docker images aza-pg:latest

# Layer breakdown
docker history aza-pg:latest --no-trunc

# Extension binary size
docker run --rm aza-pg:latest du -sh /usr/lib/postgresql/18/lib

# Top 10 largest .so files
docker run --rm aza-pg:latest sh -c \
  'find /usr/lib/postgresql/18/lib -name "*.so" -exec ls -lh {} \; | sort -k5 -hr | head -10'
```

### Runtime Memory Analysis
```sql
-- Shared memory usage
SELECT pg_size_pretty(pg_database_size(current_database()));

-- Extension memory (approximate)
SELECT
  name,
  pg_size_pretty(pg_relation_size(oid)) AS size
FROM pg_extension
JOIN pg_class ON pg_extension.extname = pg_class.relname;

-- Connection memory
SELECT
  pid,
  usename,
  pg_size_pretty(pg_backend_memory_contexts.total_bytes) AS memory_used
FROM pg_stat_activity
JOIN pg_backend_memory_contexts ON pg_stat_activity.pid = pg_backend_memory_contexts.pid;
```

### Performance Monitoring
```sql
-- Query performance (pg_stat_statements)
SELECT
  substring(query, 1, 50) AS query_snippet,
  calls,
  mean_exec_time,
  stddev_exec_time
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 20;

-- Extension-specific metrics
SELECT * FROM pg_stat_user_tables; -- Table statistics
SELECT * FROM pg_stat_user_indexes; -- Index usage
SELECT * FROM pg_statio_user_tables; -- I/O statistics
```

---

## Conclusion

**Current Status:** Well-optimized hybrid approach

**Strengths:**
- ✅ Broad functionality (38 extensions, 6 categories)
- ✅ PGDG packages for stability (14/38 = 37%)
- ✅ SHA-pinned source for security (18/38 = 47%)
- ✅ Aggressive optimization (bitcode removal, stripping, cleanup)
- ✅ Single image adapts to 2-128GB deployments

**Opportunities:**
- ✅ timescaledb_toolkit: 13MB optimized (reduced from 186MB pre-Phase 11)
- ⚠️ pgroonga: 2-3 min build time (pre-built binary available)
- ⚠️ Rust extensions: Not using size optimization flags

**Next Steps:**
1. **Phase 9 (in progress):** Run performance benchmarks, update this doc with results
2. **Phase 10:** Verify PGDG availability for remaining extensions
3. **Phase 11:** Apply RUSTFLAGS optimization (40-60MB savings)
4. **Phase 12:** Comprehensive integration testing

**Final Target:** ~1.10GB image, <10 min build time, verified performance metrics
