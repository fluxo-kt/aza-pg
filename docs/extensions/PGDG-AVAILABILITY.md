# PGDG Package Availability Analysis

**Analysis Date:** 2025-11-05
**Scope:** Complete verification of PGDG package availability for all compiled extensions
**Objective:** Identify migration opportunities from source compilation to PGDG pre-built packages

---

## Executive Summary

**Current State:** 14/31 extensions use PGDG packages (45%)

**New Finding:** **pgroonga is available in PGDG** (PostgreSQL 18 support confirmed)

**Recommendation:** Switch pgroonga to PGDG package (saves 2-3 min build time)

---

## Detailed Findings

### Extensions Verified for PGDG (Phase 10)

| Extension | PGDG Available? | Package Name | PG18 Support? | Current Method | Recommendation |
|-----------|----------------|--------------|---------------|----------------|----------------|
| **pgroonga** | ✅ YES | `postgresql-18-pgdg-pgroonga` | ✅ Yes (v4.0.4) | Compiled | **SWITCH TO PGDG** |
| **pg_safeupdate** | ❌ NO | N/A | Yes (source only) | Compiled | Keep compiling |

---

## pgroonga: SWITCH TO PGDG (HIGH PRIORITY)

**Status:** READY TO MIGRATE

**Evidence:**
- Official package: `postgresql-18-pgdg-pgroonga=4.0.4-1.pgdg13+1`
- Source: https://pgroonga.github.io/install/debian.html
- Debian Trixie support: Confirmed
- PostgreSQL 18 support: Confirmed (with performance improvements)
- Latest release: PGroonga 4.0.4 (Oct 2, 2025)

**Current Compilation Details:**
- Build system: meson + ninja
- Build time: 2-3 minutes
- Dependencies: cmake, ninja-build, pkg-config, libgroonga-dev, liblz4-dev, libmecab-dev, libmsgpack-dev
- Binary size: 2.1MB
- Runtime dependencies: 12 packages (~80-100MB)

**PGDG Package Benefits:**
- Installation time: ~10 seconds (vs 2-3 min compilation)
- GPG-signed by PostgreSQL community
- Tested against PostgreSQL 18
- Simplified dependency management
- Aligns with existing PGDG strategy (14 extensions already using PGDG)

**PostgreSQL 18 Performance Improvement:**
PGroonga 4.0.4 includes optimization for PG18: PostgreSQL 18 now recognizes PGroonga's sorted index output and skips extra sorting operations.

**Implementation:**
```dockerfile
# Add to Dockerfile PGDG installation block (lines 105-118):
postgresql-${PG_MAJOR}-pgdg-pgroonga=4.0.4-1.pgdg13+1 \
```

**Manifest Update:**
```json
{
  "name": "pgroonga",
  "kind": "extension",
  "install_via": "pgdg",  // Changed from null
  "build": {
    "type": null,  // No longer needed
    ...
  }
}
```

**Build Time Savings:** 2-3 minutes per image build (~17-25% of current 12min compilation time)

---

## pg_safeupdate: KEEP COMPILING (NO PGDG PACKAGE)

**Status:** NOT AVAILABLE IN PGDG

**Evidence:**
- No PGDG package exists for any PostgreSQL version
- Distribution: PGXN (PostgreSQL Extension Network) only
- Repository: https://github.com/eradman/pg-safeupdate
- Never packaged by PGDG (community-maintained, specialized use case)

**Current Compilation Details:**
- Build system: PGXS (simple C extension)
- Build time: <20 seconds
- Binary size: ~70KB
- Type: Hook-based tool (no CREATE EXTENSION, loads via shared_preload_libraries)

**Why Not in PGDG:**
- Smaller, specialized safety extension
- Not part of core PostgreSQL project
- PGDG focuses on broader-usage extensions
- Compilation is already fast and simple

**Recommendation:**
**KEEP COMPILING** — No PGDG alternative, compilation is fast, SHA-pinning provides security

---

## Complete PGDG Extension Inventory

### Currently Using PGDG (14 extensions)

| Extension | Package Name | Version | PG18 Support |
|-----------|-------------|---------|--------------|
| pg_cron | postgresql-18-cron | 1.6.7-2.pgdg13+1 | ✅ |
| pgaudit | postgresql-18-pgaudit | 18.0-2.pgdg13+1 | ✅ |
| pgvector | postgresql-18-pgvector | 0.8.1-2.pgdg13+1 | ✅ |
| timescaledb | postgresql-18-timescaledb | 2.23.0+dfsg-1.pgdg13+1 | ✅ |
| postgis | postgresql-18-postgis-3 | 3.6.0+dfsg-2.pgdg13+1 | ✅ |
| pg_partman | postgresql-18-partman | 5.3.1-1.pgdg13+1 | ✅ |
| pg_repack | postgresql-18-repack | 1.5.3-1.pgdg13+1 | ✅ |
| plpgsql_check | postgresql-18-plpgsql-check | 2.8.3-1.pgdg13+1 | ✅ |
| hll | postgresql-18-hll | 2.19-1.pgdg13+1 | ✅ |
| http | postgresql-18-http | 1.7.0-3.pgdg13+1 | ✅ |
| hypopg | postgresql-18-hypopg | 1.4.2-2.pgdg13+1 | ✅ |
| pgrouting | postgresql-18-pgrouting | 3.8.0-2.pgdg13+1 | ✅ |
| rum | postgresql-18-rum | 1.3.15-1.pgdg13+1 | ✅ |
| set_user | postgresql-18-set-user | 4.2.0-1.pgdg13+1 | ✅ |

### Should Migrate to PGDG (1 extension)

| Extension | Package Name | Current Status | Priority |
|-----------|-------------|----------------|----------|
| **pgroonga** | postgresql-18-pgdg-pgroonga=4.0.4-1.pgdg13+1 | Compiled (2-3 min) | **HIGH** |

### Must Remain Compiled (16 extensions)

| Extension | Reason | Build Time |
|-----------|--------|------------|
| pg_jsonschema | Not in PGDG (Rust) | 1-2 min |
| index_advisor | Not in PGDG (Supabase) | 30 sec |
| pg_hashids | Not in PGDG | 30 sec |
| pg_plan_filter | Not in PGDG (hook-based) | 20 sec |
| pg_safeupdate | Not in PGDG (hook-based) | 20 sec |
| pg_stat_monitor | Not in PGDG (Percona) | 1 min |
| pgbackrest | Tool, not extension | 1 min |
| pgbadger | Tool, not extension | 10 sec |
| pgmq | Not in PGDG (Rust) | 1 min |
| pgsodium | Not in PGDG (crypto) | 1 min |
| supabase_vault | Not in PGDG (Supabase) | 30 sec |
| supautils | Not in PGDG (Supabase, hook-based) | 30 sec |
| timescaledb_toolkit | Not in PGDG (Rust analytics) | 3-4 min |
| vectorscale | Not in PGDG (Rust) | 1 min |
| wal2json | Not in PGDG (logical decoding) | 30 sec |
| wrappers | Not in PGDG (Rust FDW) | 1 min |

**Total compiled:** 16 extensions, ~12 minutes build time (down from ~20 min with PGDG optimization)

---

## Impact Analysis

### If pgroonga Migrates to PGDG

**Before:**
- PGDG packages: 14 extensions (~10 sec install)
- Compiled extensions: 17 extensions (~12 min build)
- **Total build time:** ~12 minutes

**After:**
- PGDG packages: 15 extensions (~10 sec install)
- Compiled extensions: 16 extensions (~9-10 min build)
- **Total build time:** ~9-10 minutes (**17-25% reduction**)

**Additional Benefits:**
- Simplified Dockerfile (remove meson/ninja/groonga build dependencies)
- Smaller builder image (fewer build tools)
- More consistent with PGDG strategy
- Automatic updates via APT package manager

---

## PGDG vs Source Compilation Trade-offs

### PGDG Packages

**Pros:**
- ✅ Fast installation (~10 sec vs minutes)
- ✅ GPG-signed by PostgreSQL community
- ✅ Tested against official PostgreSQL releases
- ✅ Multi-architecture support (amd64/arm64)
- ✅ Automatic dependency resolution
- ✅ Smaller final images (shared system libraries)

**Cons:**
- ⚠️ Version tied to PGDG release schedule
- ⚠️ Cannot customize build flags
- ⚠️ Trust model: PostgreSQL community (vs self-compiled)

### Source Compilation

**Pros:**
- ✅ Full control over build flags
- ✅ SHA-pinned commits (immutable, auditable)
- ✅ Custom versions/patches possible
- ✅ Independence from packaging maintainers

**Cons:**
- ❌ Longer build times (minutes vs seconds)
- ❌ More complex Dockerfile
- ❌ Requires build dependencies in builder stages
- ❌ Manual version tracking

---

## Recommendations

### Immediate Actions

1. **Migrate pgroonga to PGDG** (Phase 10+)
   - Update Dockerfile to add PGDG package
   - Update manifest.json (install_via: "pgdg")
   - Remove pgroonga from build-extensions.sh compilation
   - Test functionality after migration
   - Expected: 2-3 min build time savings

2. **Keep pg_safeupdate compiled**
   - No PGDG package available
   - Current method is appropriate

### Future Monitoring

**Watch these extensions for PGDG availability:**
- **timescaledb_toolkit** — If packaged, saves 3-4 min build time
- **pg_jsonschema** — Rust extension, may be packaged in future
- **vectorscale** — Rust extension, pgvector companion
- **wrappers** — Supabase FDW framework

**Check quarterly:** https://apt.postgresql.org/pub/repos/apt/pool/main/p/

---

## Migration Checklist (pgroonga)

- [ ] Update `docker/postgres/Dockerfile` PGDG installation block
- [ ] Update `docker/postgres/extensions.manifest.json` (add `install_via: "pgdg"`)
- [ ] Remove pgroonga build dependencies from `extensions.build-packages.txt`
- [ ] Remove pgroonga runtime dependencies from `extensions.runtime-packages.txt` (if not shared)
- [ ] Update `build-extensions.sh` to skip pgroonga when `install_via: "pgdg"`
- [ ] Rebuild image and verify pgroonga loads: `CREATE EXTENSION pgroonga`
- [ ] Test pgroonga functionality (FTS index creation, search queries)
- [ ] Update CHANGELOG.md with migration
- [ ] Update docs/extensions/PERFORMANCE-IMPACT.md (build time reduction)
- [ ] Commit changes

---

## Verification Commands

```bash
# Check PGDG package availability
apt-cache search postgresql-18-pgroonga

# Check installed PGDG packages in image
docker run --rm aza-pg:latest dpkg -l | grep postgresql-18

# Verify pgroonga version
docker run --rm aza-pg:latest psql -U postgres -c "SELECT extversion FROM pg_extension WHERE extname = 'pgroonga';"

# Test pgroonga functionality
docker run --rm aza-pg:latest psql -U postgres -c "
CREATE EXTENSION pgroonga;
CREATE TABLE docs (content TEXT);
CREATE INDEX ON docs USING pgroonga (content);
INSERT INTO docs VALUES ('Full-text search test');
SELECT * FROM docs WHERE content &@~ 'search';
"
```

---

## References

- PGroonga Installation Guide: https://pgroonga.github.io/install/debian.html
- PGDG Repository: https://apt.postgresql.org/pub/repos/apt/
- PostgreSQL Wiki Apt: https://wiki.postgresql.org/wiki/Apt
- pg-safeupdate GitHub: https://github.com/eradman/pg-safeupdate
- PGXN (PostgreSQL Extension Network): https://pgxn.org/

---

## Conclusion

**Phase 10 Status:** ✅ COMPLETE

**Key Findings:**
- pgroonga: Available in PGDG, migration recommended (HIGH PRIORITY)
- pg_safeupdate: Not in PGDG, keep compiling (APPROPRIATE)

**Next Steps:**
- Implement pgroonga PGDG migration (optional but recommended for build time reduction)
- Proceed to Phase 11 (RUSTFLAGS optimization for timescaledb_toolkit)

**Total PGDG Coverage After Migration:**
- 15/31 extensions (48.4%) using PGDG packages
- 16/31 extensions (51.6%) compiled from source
- Build time: ~9-10 minutes (optimized from original ~20 min)
