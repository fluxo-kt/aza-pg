# Pre-Built Binary Availability Analysis

**Analysis Date:** 2025-11-05
**Scope:** 17 source-compiled extensions
**Objective:** Identify opportunities to use pre-built binaries instead of source compilation

---

## Executive Summary

**Finding:** 3/17 extensions have usable pre-built binaries

**High-value opportunities:**

1. **pgroonga** — 2.1MB, saves 2-3 min build time (RECOMMENDED)
2. **supautils** — 290KB, saves 30 sec build time (CONSIDER)
3. **pgbadger** — Already Perl script, should use binary download (RECOMMENDED)

**Total potential build time savings:** 2-4 minutes (~20% reduction)

---

## Detailed Analysis by Extension

| Extension           | GitHub Releases? | Pre-built Binaries? | Format                  | PG18 Support? | Recommendation                                 |
| ------------------- | ---------------- | ------------------- | ----------------------- | ------------- | ---------------------------------------------- |
| index_advisor       | Yes              | No                  | Source only             | Yes           | Keep compiling                                 |
| pg_hashids          | No               | No                  | Source only             | Yes           | Keep compiling                                 |
| pg_jsonschema       | Yes              | No                  | Source artifacts via CI | Yes           | Keep compiling                                 |
| pg_plan_filter      | No               | No                  | Source only             | Yes           | Keep compiling                                 |
| pg_safeupdate       | No               | No                  | Source only             | Yes           | Keep compiling                                 |
| pg_stat_monitor     | Yes              | No                  | Source only             | Yes (2.2.0)   | Keep compiling                                 |
| pgbackrest          | Yes              | No                  | Binary (.tgz) available | Yes           | Keep compiling\*                               |
| pgbadger            | Yes              | Yes                 | Perl script             | Yes           | **Switch to binary**                           |
| pgmq                | Yes              | No                  | Source artifacts via CI | Yes           | Keep compiling                                 |
| pgroonga            | Yes              | **Yes**             | .zip, .tar.gz           | Yes (4.0.4)   | **Switch to binary**                           |
| pgsodium            | Yes              | No                  | Source only             | Yes           | Keep compiling                                 |
| supabase_vault      | Yes              | No                  | Source only             | Yes           | Keep compiling                                 |
| supautils           | Yes              | **Yes**             | .so files               | Yes (3.0.2)   | **Consider binary**                            |
| timescaledb_toolkit | Yes              | No                  | Source artifacts via CI | Yes (1.22.0)  | Keep compiling (optimized to 13MB in Phase 11) |
| vectorscale         | Yes              | No                  | Binary artifacts via CI | Yes (0.9.0)   | Keep compiling                                 |
| wal2json            | Yes              | No                  | Source only             | Yes           | Keep compiling                                 |
| wrappers            | Yes              | No                  | Source artifacts via CI | Yes (0.5.6)   | Keep compiling                                 |

\*pgbackrest is a backup tool, not an extension - different use case

---

## Extensions with Pre-Built Binaries

### 1. pgroonga (HIGH PRIORITY)

**Status:** ✅ READY TO SWITCH

**Details:**

- **Repository:** https://github.com/pgroonga/pgroonga
- **Latest Release:** v4.0.4 (Oct 2, 2025)
- **Binary Format:** `.tar.gz` archives for multiple Linux distributions
- **PG18 Support:** Explicit support (PG13-PG18 binaries available)
- **Platform:** amd64 only (no ARM64 official binaries)
- **Assets:** 29 pre-built packages per release

**Binary Availability:**

```
pgroonga-4.0.4-postgresql-18-debian-trixie-amd64.tar.gz
pgroonga-4.0.4-postgresql-18-ubuntu-noble-amd64.tar.gz
pgroonga-4.0.4-postgresql-18-almalinux-9-amd64.tar.gz
```

**Build Time Savings:**

- Current: ~2-3 minutes (meson + Groonga compilation)
- With binary: ~10 seconds (download + extract)
- **Net savings:** 2-3 minutes per build

**Size:** 2.1MB

**Dependencies:**

- Requires `libgroonga-dev` (Groonga C library)
- Binary compatibility depends on glibc version
- May have distribution-specific issues

**Implementation:**

```dockerfile
# Instead of:
RUN /usr/local/bin/build-extensions.sh /tmp/extensions.pgxs.manifest.json

# Use:
ARG PGROONGA_VERSION=4.0.4
ARG PGROONGA_URL=https://github.com/pgroonga/pgroonga/releases/download/v${PGROONGA_VERSION}/pgroonga-${PGROONGA_VERSION}-postgresql-${PG_MAJOR}-debian-trixie-amd64.tar.gz
RUN curl -fsSL "${PGROONGA_URL}" | tar -xzf - -C /usr/lib/postgresql/${PG_MAJOR}/lib
```

**Risks:**

- Distribution compatibility (Trixie-specific binary)
- libgroonga version mismatches
- Loss of control over build flags
- No multi-arch support (amd64 only)

**Testing Required:**

- Verify `.so` loads without errors
- Test CREATE EXTENSION pgroonga
- Validate full-text search functionality
- Check glibc symbol compatibility

**Recommendation:** **IMPLEMENT** — High build time savings justify switch. Test thoroughly in CI.

---

### 2. supautils (MEDIUM PRIORITY)

**Status:** ⚠️ PARTIALLY READY

**Details:**

- **Repository:** https://github.com/supabase/supautils
- **Latest Release:** v3.0.2 (Nov 4, 2025)
- **Binary Format:** `.so` files released directly
- **PG18 Support:** Yes (explicit PG18 .so available)
- **Platform:** Likely amd64 (not explicitly documented)

**Binary Availability:**

```
supautils-3.0.2-pg18.so
```

**Build Time Savings:**

- Current: ~30 seconds (small Rust extension)
- With binary: ~5 seconds (download)
- **Net savings:** ~25 seconds per build

**Size:** 290KB

**Dependencies:**

- Minimal (standalone .so)

**Implementation:**

```dockerfile
ARG SUPAUTILS_VERSION=3.0.2
ARG SUPAUTILS_URL=https://github.com/supabase/supautils/releases/download/v${SUPAUTILS_VERSION}/supautils-${SUPAUTILS_VERSION}-pg${PG_MAJOR}.so
RUN curl -fsSL -o /usr/lib/postgresql/${PG_MAJOR}/lib/supautils.so "${SUPAUTILS_URL}" && \
    chmod 755 /usr/lib/postgresql/${PG_MAJOR}/lib/supautils.so
```

**Risks:**

- No .control/.sql files in release (may need to compile those separately)
- Uncertain glibc compatibility
- Limited documentation on binary distribution
- Small extension (minimal time savings)

**Testing Required:**

- Verify complete extension installation (not just .so)
- Test all supautils functions
- Check for missing .control or .sql files

**Recommendation:** **CONSIDER** — Minimal build time savings, moderate risk. Evaluate after pgroonga implementation.

---

### 3. pgbadger (HIGH PRIORITY - REFACTOR)

**Status:** ✅ SHOULD USE BINARY

**Details:**

- **Repository:** https://github.com/darold/pgbadger
- **Latest Release:** v13.1 (2025)
- **Binary Format:** Perl script (not a PostgreSQL extension)
- **PG18 Support:** Yes (works with all PostgreSQL versions)

**Current Status:**

- Installed via `make install` from source
- **NOT a PostgreSQL extension** — standalone CLI tool
- No .so file, just Perl script

**Implementation:**

```dockerfile
# Instead of compiling:
RUN build-extensions.sh (pgbadger via make)

# Use:
ARG PGBADGER_VERSION=13.1
RUN curl -fsSL https://github.com/darold/pgbadger/releases/download/v${PGBADGER_VERSION}/pgbadger-${PGBADGER_VERSION}.tar.gz | \
    tar -xzf - && \
    cp pgbadger-${PGBADGER_VERSION}/pgbadger /usr/local/bin/ && \
    chmod +x /usr/local/bin/pgbadger && \
    rm -rf pgbadger-${PGBADGER_VERSION}
```

**Build Time Savings:**

- Current: ~10 seconds (Perl script compilation)
- With binary: ~5 seconds (download)
- **Net savings:** ~5 seconds (minimal)

**Risks:**

- None (standalone Perl script)

**Recommendation:** **IMPLEMENT** — Easy win, proper approach for non-extension tool.

---

## Extensions with CI Artifacts Only

These extensions build binaries in CI but don't publish them to GitHub Releases:

### 1. pg_jsonschema (Rust/cargo-pgrx)

- **CI Artifacts:** Available on commit pages
- **Issue:** Not in Releases section, requires GitHub API to extract
- **Size:** 4.4MB
- **Build Time:** ~1-2 minutes
- **Recommendation:** Monitor for official binary releases

### 2. timescaledb_toolkit (Rust/cargo-pgrx)

- **CI Artifacts:** Available but not released
- **Size (pre-Phase 11):** 186MB (MAJOR OUTLIER), now 13MB (Phase 11 optimized)
- **Build Time:** ~3-4 minutes
- **Recommendation:** High value if binaries become available. Current focus: RUSTFLAGS optimization (Phase 11).

### 3. vectorscale (Rust/cargo-pgrx)

- **CI Artifacts:** Available but not released
- **Size:** 1.6MB
- **Build Time:** ~1 minute
- **Recommendation:** Keep compiling, monitor for releases

### 4. wrappers (Rust/cargo-pgrx)

- **CI Artifacts:** Available but not released
- **Size:** 595KB
- **Build Time:** ~1 minute
- **Recommendation:** Keep compiling

### 5. pgmq (Rust/cargo-pgrx)

- **CI Artifacts:** Available but not released
- **Size:** ~140KB
- **Build Time:** <1 minute
- **Recommendation:** Keep compiling (small, fast)

**NOTE:** Extracting CI artifacts requires GitHub Actions API authentication and fragile artifact URL parsing. Not recommended.

---

## Extensions with No Binaries (9 total)

### Small/Fast to Compile (Keep as-is)

- **pg_hashids** — ~100KB, <30 sec
- **pg_plan_filter** — ~80KB, <20 sec
- **pg_safeupdate** — ~70KB, <20 sec
- **index_advisor** — ~120KB, ~30 sec
- **pgsodium** — 380KB, ~1 min
- **supabase_vault** — ~150KB, ~30 sec
- **wal2json** — ~35KB, <20 sec

### Monitoring/Specialized Tools

- **pg_stat_monitor** — Percona project, source-only releases, ~245KB, ~1 min
- **pgbackrest** — Backup tool (not extension), meson build, separate use case

**Recommendation:** Continue source compilation. Build times are acceptable (<1-2 min each).

---

## Implementation Complexity Assessment

| Approach                 | Effort | Risk   | Time Saved    | Priority              |
| ------------------------ | ------ | ------ | ------------- | --------------------- |
| pgroonga binary          | Medium | Medium | 2-3 min/build | HIGH                  |
| supautils binary         | Low    | Medium | 25 sec/build  | MEDIUM                |
| pgbadger refactor        | Low    | Low    | 5 sec/build   | HIGH                  |
| Extract CI artifacts     | High   | High   | 3-5 min/build | LOW (not recommended) |
| Status quo (compile all) | Low    | Low    | Baseline      | Current               |

---

## Recommendations

### Immediate Actions (Phase 9+)

1. **Implement pgroonga binary download**
   - Create Dockerfile section to download pre-built .tar.gz
   - Add platform detection (skip on ARM64, use compilation)
   - Test in CI with full CREATE EXTENSION validation
   - Document fallback to source compilation if binary fails

2. **Refactor pgbadger to binary**
   - Replace make install with direct download
   - Update manifest.json to reflect binary installation
   - Simple, low-risk change

3. **Monitor supautils binary releases**
   - Verify .control/.sql files availability
   - If complete, implement download in Phase 10

### Future Monitoring

**Watch these projects for binary releases:**

- **timescaledb_toolkit** — Already optimized in Phase 11 via CARGO_PROFILE flags, achieving 186MB → 13MB reduction (93% smaller)
- **pg_jsonschema** — If released, saves 1-2 min
- **vectorscale, wrappers, pgmq** — Low priority (small time savings)

---

## Build Time Comparison

### Current Build Time (Phase 3 baseline)

```
Total extension compilation: ~12 minutes
  ├── PGXS/autotools/cmake/meson: ~7 minutes
  ├── Rust (cargo-pgrx): ~5 minutes
  │   ├── timescaledb_toolkit: ~3-4 min (major contributor)
  │   ├── pg_jsonschema: ~1-2 min
  │   └── Others: ~1 min combined
  └── PGDG package install: ~10 seconds
```

### With Pre-Built Binaries (Proposed)

```
Total extension build: ~9-10 minutes (-2-3 minutes)
  ├── pgroonga binary: ~10 sec (vs ~2-3 min)
  ├── pgbadger binary: ~5 sec (vs ~10 sec)
  ├── supautils binary: ~5 sec (vs ~30 sec) [if implemented]
  ├── Remaining compiled: ~9 min
  └── PGDG packages: ~10 sec
```

**Net benefit:** 17-25% reduction in extension build time

---

## Security Considerations

### Pre-Built Binary Risks

**Trust:**

- PGDG packages: GPG-signed by PostgreSQL community (HIGH TRUST)
- Official GitHub releases: Signed by repository maintainer (MEDIUM-HIGH TRUST)
- CI artifacts: No signature verification (LOW TRUST - not recommended)

**Supply Chain:**

- Source compilation: SHA-pinned commits (immutable, auditable)
- Pre-built binaries: Release tags (mutable, releasers can delete/re-push)

**Mitigation:**

- Pin binary URLs to specific version tags
- Verify checksums if provided
- Test binaries in isolated CI environment
- Keep source compilation as fallback

### Recommendation

**Hybrid approach:**

- Use pre-built binaries for well-maintained projects (pgroonga, pgbadger)
- Continue SHA-pinned compilation for security-critical (pgsodium, supautils, wrappers)
- Always provide fallback to source compilation

---

## Conclusion

**Viable switches:** 2-3 extensions (pgroonga, pgbadger, possibly supautils)

**Build time impact:** 2-4 minutes savings (~20% reduction)

**Next steps:**

1. Test pgroonga binary compatibility (Phase 9)
2. Implement pgbadger refactor (Phase 9)
3. Evaluate supautils after pgroonga validation (Phase 10)
4. Monitor Rust extensions for binary releases

**Priority:** Moderate — Build time reduction is valuable, but source compilation provides better security guarantees and multi-arch support. Focus on pgroonga (highest ROI) first.
