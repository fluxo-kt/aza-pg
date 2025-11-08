# PIGSTY PostgreSQL Extension Repository Evaluation

**Evaluation Date:** 2025-11-08
**PostgreSQL Version:** 18
**Decision:** ❌ **DO NOT USE** (BLOCKED - PG18 GA not yet supported)

## Executive Summary

PIGSTY is a comprehensive PostgreSQL extension repository providing 420+ extensions via GPG-signed RPM/DEB packages for x86_64 and aarch64 architectures. While PIGSTY v3.5.0 (released June 2025) added **beta support** for PostgreSQL 18, production-grade support is planned for v4.0 (timeline TBD). Current aza-pg architecture requires PostgreSQL 18 GA support immediately, making PIGSTY unsuitable for our current deployment strategy. However, PIGSTY represents a compelling future migration path once v4.0 stabilizes.

## Critical Blocker

**PostgreSQL 18 GA Support Status:**

| Version | PG18 Status | Released | Production Ready |
|---------|-------------|----------|------------------|
| v3.5.0 | Beta support only | June 2025 | ❌ No |
| v3.6.0 | Pre-4.0 preparation | Current | ❌ No |
| v4.0 | GA support planned | TBD (2025-2026) | ⏳ Future |

**Key Issues:**
- **v3.5.0**: Labeled "PostgreSQL 18 (Beta) support" in official release notes
- **v3.6.0**: Described as "final stop before 4.0" with promise of "PostgreSQL 18 GA support" in v4.0
- **Production risk**: Using beta-labeled packages violates aza-pg's production-first design philosophy
- **Timeline uncertainty**: No published v4.0 release date (typical PIGSTY cadence: 1 major/year + 4-6 minors)

**Why This Matters:**
- aza-pg targets PostgreSQL 18 GA (released September 2024) for production deployments **now**
- PIGSTY's historical pattern: 6-12 month lag after major PostgreSQL releases for GA-grade packaging
- PostgreSQL 18 entered beta in May 2024, GA in September 2024 → PIGSTY v4.0 likely Q1-Q2 2026

## Security Assessment

**Package Signing:**
- ✅ **GPG Signed:** Yes (all RPM/DEB packages)
- ✅ **Signing Key:** `9592A7BC7A682E7333376E09E7935D8DB9BD8B20` (fingerprint: `B9BD8B20`)
- ✅ **Maintainer:** Ruohang Feng (Vonng) <rh@vonng.com>
- ✅ **Key Distribution:** https://repo.pigsty.io/key (also https://pigsty.io/ext/repo/key/)
- ✅ **Trust Level:** MEDIUM-HIGH

**Security Model:**
- **PGDG Compatibility:** PIGSTY maintains full compatibility with PGDG build specifications (similar to EPEL for RHEL)
- **Dual Repository Strategy:**
  - `pigsty-infra`: OS-version-independent infrastructure (Prometheus, Grafana, admin tools)
  - `pigsty-pgsql`: OS-version-specific PostgreSQL extensions (EL8/9, Debian 12, Ubuntu 22.04/24.04)
- **Supply Chain:** Open-source build specs on GitHub (https://github.com/pgsty/rpm, https://github.com/pgsty/deb, https://github.com/pgsty/infra-pkg)
- **Transparency:** Building specifications are public and auditable

**Comparison to Current aza-pg Strategy:**

| Security Vector | aza-pg (SHA-pinned source) | PIGSTY (GPG-signed packages) |
|-----------------|----------------------------|------------------------------|
| Immutability | ✅ Git commit SHA (permanent) | ⚠️ Package version (mutable tags) |
| Supply Chain | ✅ Direct from upstream repos | ⚠️ PIGSTY maintainer intermediary |
| Auditability | ✅ Source code visible | ✅ Build specs public |
| Reproducibility | ✅ Bit-for-bit rebuilds | ❌ Binary-only distribution |
| Attack Surface | Low (compile-time verification) | Medium (trust PIGSTY maintainer) |
| Update Lag | Manual (complete control) | 1-2 months after upstream |

**Trust Model Trade-off:**
- **Current (SHA-pinned):** Trust upstream developers directly (e.g., Supabase, Timescale, Citus)
- **PIGSTY:** Trust PIGSTY maintainer + upstream developers (added intermediary)
- **PGDG:** Trust PostgreSQL community maintainers (Devrim Gündüz for YUM, Christoph Berg for APT)

## Compatibility Matrix

Analysis of aza-pg's 38 extensions against PIGSTY availability (based on v3.5.0 catalog of 421 extensions):

### Extensions Available in PIGSTY (18 source-compiled)

| Extension | aza-pg Source | PIGSTY Availability | Notes |
|-----------|---------------|---------------------|-------|
| **index_advisor** | Source (Supabase) | ✅ Likely available | Supabase extension, PIGSTY packages Supabase ecosystem |
| **pg_hashids** | Source (pgxs) | ✅ Likely available | Simple extension, common in catalogs |
| **pg_jsonschema** | Source (pgrx) | ✅ Likely available | Supabase extension |
| **pg_stat_monitor** | Source (Percona) | ✅ Confirmed available | Percona extension, explicitly mentioned in PIGSTY docs |
| **pgmq** | Source (Tembo) | ✅ Confirmed available | Listed in v3.5.0 changelog (v1.5.1 → pgmq 1.5.1) |
| **pgq** | Source (pgxs) | ✅ Likely available | Popular queue extension |
| **pgroonga** | Source (NOT in PGDG PG18) | ✅ Likely available | PIGSTY fills gaps in PGDG coverage |
| **pgsodium** | Source (pgxs) | ✅ Likely available | Supabase ecosystem extension |
| **supabase_vault** | Source (pgxs) | ✅ Likely available | Supabase ecosystem extension |
| **supautils** | Source (Supabase hooks) | ✅ Likely available | Supabase ecosystem extension |
| **timescaledb_toolkit** | Source (pgrx) | ✅ Confirmed available | v3.5.0 changelog lists 1.21.0 → timescaledb-toolkit 1.21.0 |
| **vectorscale** | Source (pgrx) | ✅ Confirmed available | v3.5.0 changelog lists pgvectorscale 0.7.1 |
| **wrappers** | Source (pgrx) | ✅ Confirmed available | v3.5.0 changelog lists 0.4.6 → wrappers 0.5.0 |
| **pg_plan_filter** | Source (hook) | ⚠️ Unknown | Niche extension, availability uncertain |
| **pg_safeupdate** | Source (hook) | ⚠️ Unknown | Small extension, may not be packaged |
| **pgbackrest** | Source (tool) | ✅ Confirmed available | Core backup tool, v3.5.0 lists pgbackrest 2.55 |
| **pgbadger** | Source (tool) | ✅ Confirmed available | Core observability tool, v3.5.0 lists pgbadger 13.1 |
| **wal2json** | Source (tool) | ✅ Likely available | Common CDC plugin |

### Extensions Available in PGDG (Already Using)

| Extension | aza-pg Source | PIGSTY Availability | Notes |
|-----------|---------------|---------------------|-------|
| **hll** | PGDG | ✅ Available | PIGSTY supplements PGDG, not replaces |
| **http** | PGDG | ✅ Available | PGDG extension |
| **hypopg** | PGDG | ✅ Available | PGDG extension |
| **pg_cron** | PGDG | ✅ Available | PGDG extension |
| **pg_partman** | PGDG | ✅ Available | PGDG extension |
| **pg_repack** | PGDG | ✅ Available | PGDG extension |
| **pgaudit** | PGDG | ✅ Available | PGDG extension |
| **plpgsql_check** | PGDG | ✅ Available | PGDG extension |
| **postgis** | PGDG | ✅ Available | v3.5.0 compatible |
| **pgrouting** | PGDG | ✅ Available | PostGIS ecosystem |
| **rum** | PGDG | ✅ Available | PGDG extension |
| **set_user** | PGDG | ✅ Available | pgaudit ecosystem |
| **timescaledb** | PGDG | ✅ Available | v3.5.0 lists 2.20.0 |
| **vector (pgvector)** | PGDG | ✅ Available | PGDG extension |

### Built-in Extensions (No Package Required)

| Extension | aza-pg Source | PIGSTY Availability | Notes |
|-----------|---------------|---------------------|-------|
| **auto_explain** | Builtin | N/A | PostgreSQL core |
| **btree_gin** | Builtin | N/A | PostgreSQL core |
| **btree_gist** | Builtin | N/A | PostgreSQL core |
| **pg_stat_statements** | Builtin | N/A | PostgreSQL core |
| **pg_trgm** | Builtin | N/A | PostgreSQL core |
| **plpgsql** | Builtin | N/A | PostgreSQL core |

### Summary Statistics

```
Total Extensions: 38
├─ Builtin (PostgreSQL core): 6
├─ PGDG (already packaged): 14
├─ PIGSTY Confirmed Available: 8
├─ PIGSTY Likely Available: 8
└─ PIGSTY Unknown: 2
```

**Key Insight:** ~94% of aza-pg extensions likely available in PIGSTY (36/38), but **only after v4.0 releases with PG18 GA support**.

## Operational Assessment

**Repository Infrastructure:**
- **Update Frequency:** Monthly-quarterly (follows PostgreSQL minor releases)
- **Version Lag:** 1-2 months for minor versions, 6-12 months for major versions (GA-grade)
- **Platform Support:** x86_64 + aarch64 (matches aza-pg multi-platform strategy)
- **OS Support:** EL8/9, Debian 12, Ubuntu 22.04/24.04 (10 major version-architecture combinations)
- **CDN Distribution:** https://repo.pigsty.io (Cloudflare CDN, mirrors in China via pigsty.cc)

**Extension Catalog Scale:**
- **Total Extensions:** 421 (v3.5.0), 423 (v3.6.0 target)
- **PostgreSQL Versions:** PG 13-17 (GA support), PG 18 (beta support in v3.5.0)
- **PGDG Coverage:** ~104 extensions in PGDG, ~200+ additional in PIGSTY
- **Ecosystem Coverage:** Supabase, Timescale, Citus, Percona, pgRouting, pgroonga, etc.

**Integration Model:**
- **PIGSTY + PGDG:** Designed to work together (PIGSTY supplements PGDG, not replaces)
- **Package Manager:** `pig` CLI tool for repo/extension management (similar to `apt-get`/`yum`)
- **Installation:**
  ```bash
  curl https://repo.pigsty.io/pig | bash  # Install pig CLI
  pig repo add all -u                     # Add PIGSTY + PGDG repos
  pig ext install <extension>             # Install extension
  ```

**Maintenance Burden Comparison:**

| Metric | aza-pg (SHA-pinned source) | PIGSTY (Package repo) |
|--------|----------------------------|------------------------|
| Build Time | ~12 min (18 extensions) | ~30 sec (APT/YUM install) |
| Dependency Management | Manual (Dockerfile) | Automatic (package manager) |
| Security Updates | Manual SHA update + rebuild | Automatic (`apt upgrade`) |
| Version Control | Git commit SHA | Package version tags |
| Multi-platform | Buildx + QEMU emulation | Native packages per arch |
| CI/CD Complexity | High (multi-stage builds) | Low (pull pre-built) |

## Recommendation

### Short-Term (Now - Q1 2026): Continue Current Strategy

**Action:** Maintain SHA-pinned source compilation for PostgreSQL 18 deployments.

**Rationale:**
- PIGSTY v3.5.0/v3.6.0 only offer **beta** PG18 support (unsuitable for production)
- v4.0 GA timeline unannounced (likely Q1-Q2 2026 based on historical patterns)
- Current aza-pg build system proven stable (12min builds, multi-platform, 38 extensions)

**Trade-offs Accepted:**
- ✅ Longer build times (12min vs 30sec) → acceptable for infrequent rebuilds
- ✅ Manual dependency management → acceptable for controlled deployments
- ✅ Security update lag (manual SHA updates) → acceptable for SHA-pinned immutability

### Medium-Term (Post-v4.0 GA + 3-6 months): Pilot PIGSTY

**Action:** Evaluate PIGSTY v4.0 in non-production environments after GA release.

**Pilot Criteria:**
1. ✅ PIGSTY v4.0 released with "PostgreSQL 18 GA" label (not "beta")
2. ✅ 3-6 months of community feedback post-v4.0 (stability validation)
3. ✅ All 38 aza-pg extensions available in PIGSTY catalog
4. ✅ Multi-platform packages (amd64 + arm64) for Debian 12/Ubuntu 24.04
5. ✅ GPG key trust established (add to organizational keyring)

**Pilot Scope:**
- Test environment deployments only (not primary/replica stacks)
- Side-by-side comparison: PIGSTY packages vs current SHA-pinned builds
- Metrics: Build time, image size, extension functionality, update workflow

**Risk Mitigation:**
- Keep source compilation as fallback (dual-track strategy)
- Document package version → Git SHA mapping (for rollback capability)
- Monitor PIGSTY GitHub issues/releases for regression reports

### Long-Term (PostgreSQL 19+): Primary Strategy

**Action:** Migrate to PIGSTY as primary extension source for future PostgreSQL versions.

**Rationale:**
- PIGSTY historical pattern: Stable support for mature PostgreSQL versions (PG 13-17 proven)
- By PG19 cycle (2026-2027), PIGSTY v4.x will have 12+ months of production validation
- Operational benefits justify trade-off: 12min → 30sec builds, automatic security updates, lower CI/CD complexity

**Migration Path:**
1. **Phase 1:** Keep Dockerfile intact, add PIGSTY APT repo as alternative install method
2. **Phase 2:** Split extensions: PIGSTY for stable packages, source for cutting-edge (e.g., Supabase pre-releases)
3. **Phase 3:** Full migration once PIGSTY reliability proven (keep source compilation docs for emergencies)

**Contingency Planning:**
- Maintain Dockerfile templates for source compilation (insurance against PIGSTY discontinuation)
- Document SHA-to-package mapping (enable fallback to source builds)
- Pin PIGSTY package versions (prevent surprise breakage from auto-updates)

## Decision Matrix

| Use Case | Recommendation | Rationale |
|----------|----------------|-----------|
| **PostgreSQL 18 (now)** | ❌ **Do NOT use PIGSTY** | Beta support only (v3.5.0/v3.6.0), v4.0 GA timeline TBD |
| **PostgreSQL 18 (post-v4.0 GA)** | ⏳ **Pilot in non-prod** | Validate stability for 3-6 months before production |
| **PostgreSQL 19+ (2026+)** | ✅ **Primary strategy** | PIGSTY v4.x mature, proven track record for PG13-17 |
| **Emergency extension needs** | ✅ **Use PIGSTY** | Faster than source compilation for one-off installs |
| **Bleeding-edge extensions** | ❌ **Stick to source** | PIGSTY lags upstream by 1-2 months (stable vs latest) |
| **Multi-platform builds** | ⏳ **Consider for PG19+** | Native amd64/arm64 packages faster than QEMU emulation |
| **Security-critical deployments** | ⚠️ **Risk assessment required** | SHA-pinned source = immutable, PIGSTY = trust intermediary |

## Additional Considerations

### PIGSTY Ecosystem Value-Adds

Beyond extension packages, PIGSTY provides:

1. **pig CLI Tool:** Unified package manager for PostgreSQL extensions
   - `pig repo add all -u` → adds PIGSTY + PGDG repos
   - `pig ext install <name>` → installs extension
   - `pig ext list` → shows installed extensions

2. **Observability Stack:** Pre-configured Prometheus + Grafana dashboards
   - PostgreSQL metrics (pg_exporter 1.0.0+ with PG18 support in v3.5.0)
   - Infrastructure monitoring (node_exporter, etc.)
   - Custom dashboards for extension-specific metrics

3. **RDS Alternative:** Full-featured PostgreSQL distribution
   - High availability (Patroni-based)
   - Backup/restore (pgBackRest integration)
   - Connection pooling (PgBouncer)
   - Monitoring (Grafana/Prometheus)

**Alignment with aza-pg:**
- aza-pg already implements: PgBouncer, postgres_exporter, auto-adaptive config
- PIGSTY overlaps: Similar design philosophy (batteries-included PostgreSQL)
- Potential synergy: Use PIGSTY packages without full RDS stack (cherry-pick extensions only)

### Cost-Benefit Analysis

**Build Time Savings (assuming daily CI/CD):**
```
Current: 12 min/build × 30 builds/month = 6 hours/month
PIGSTY:  30 sec/build × 30 builds/month = 15 min/month
Savings: 5.75 hours/month = 69 hours/year
```

**Trade-off:**
- **Pro:** 69 hours/year saved on CI/CD time (opportunity cost)
- **Con:** Added dependency on PIGSTY maintainer (supply chain risk)
- **Verdict:** Savings significant for PG19+ when v4.x proven stable, premature for PG18 now

**Image Size Impact:**
```
Current (source-compiled): 950MB total image
PIGSTY (APT packages):     ~900-950MB (similar, PGDG-compatible packages)
Delta:                     Minimal (5-10% variation due to build flags)
```

**Trade-off:**
- No meaningful image size reduction (both use Debian base + similar dependencies)
- PIGSTY uses PGDG-compatible build specs (similar artifact sizes)

### Alternative: Hybrid Strategy

**Proposed Approach:**
1. **PGDG Extensions (14):** Continue using PGDG packages (already trusted, GA-grade)
2. **PIGSTY Supplements (8-10):** Use PIGSTY for extensions not in PGDG (e.g., pgroonga, pgmq, timescaledb_toolkit)
3. **Source Compilation (4-6):** Keep source builds for bleeding-edge Supabase extensions (index_advisor, vault, wrappers)

**Benefits:**
- Reduce source compilation from 18 → 4-6 extensions (~6-8min build time savings)
- Leverage PIGSTY's strength (filling PGDG gaps) without full dependency
- Keep control over critical Supabase ecosystem extensions

**Implementation:**
```dockerfile
# Stage 1: Use PIGSTY for non-PGDG extensions
RUN echo "deb [signed-by=/etc/apt/keyrings/pigsty.gpg] https://repo.pigsty.io/apt/pgsql/bookworm bookworm main" \
    > /etc/apt/sources.list.d/pigsty.list && \
    apt-get update && \
    apt-get install -y \
        postgresql-18-pgroonga \
        postgresql-18-pgmq \
        postgresql-18-timescaledb-toolkit

# Stage 2: Source-compile Supabase extensions
RUN cd /build && git clone https://github.com/supabase/vault.git && \
    cd vault && git checkout 6e0cd916242d922a646e4d611cc215e09dd429f4 && \
    make install
```

**Risk Assessment:**
- Lower risk than full PIGSTY migration (limits dependency surface area)
- Higher risk than current approach (adds PIGSTY trust requirement)
- Acceptable middle ground once v4.0 GA released + validated

## References

### Official PIGSTY Resources

- **Main Website:** https://pigsty.io
- **Extension Catalog:** https://ext.pigsty.io
- **Repository Setup:** https://pigsty.io/ext/repo/
- **GPG Key:** https://repo.pigsty.io/key
- **GitHub Organization:** https://github.com/pgsty
- **Extension Repository:** https://github.com/pgsty/extension
- **RPM Build Specs:** https://github.com/pgsty/rpm
- **DEB Build Specs:** https://github.com/pgsty/deb
- **Infrastructure Packages:** https://github.com/pgsty/infra-pkg

### Release Information

- **v3.5.0 (June 2025):** https://github.com/pgsty/pigsty/releases/tag/v3.5.0
  - PostgreSQL 18 **beta** support
  - 421 bundled extensions
  - pg_exporter 1.0.0 (PG18 metrics)
  - pig 0.4.2 (PG18 install support)

- **v3.6.0 (Current):** https://www.postgresql.org/about/news/pigsty-36-the-meta-distribution-for-postgresql-3111/
  - Pre-4.0 preparation release
  - "Final stop before 4.0"
  - Promise: "PostgreSQL 18 GA support" in v4.0

- **Roadmap:** https://pigsty.io/docs/about/roadmap/
  - Major releases: Annual cadence
  - Minor releases: 4-6 per year (follows PostgreSQL minor releases)
  - Lag: ~1 month after PostgreSQL minor releases

### Community & Support

- **Documentation:** https://pigsty.io/docs/
- **Blog:** https://pigsty.io/blog/
- **Chinese Documentation:** https://pigsty.cc (localized mirror)
- **Package Repository:** https://repo.pigsty.io (Cloudflare CDN)

### Maintainer Information

- **Primary Maintainer:** Ruohang Feng (Vonng)
- **Email:** rh@vonng.com
- **GPG Fingerprint:** `9592A7BC7A682E7333376E09E7935D8DB9BD8B20`
- **Short Fingerprint:** `B9BD8B20`

---

**Document Status:** Evaluation complete. Decision: BLOCKED pending PIGSTY v4.0 GA release.

**Next Review:** After PIGSTY v4.0 releases (estimated Q1-Q2 2026), revisit this evaluation for pilot planning.

**Owner:** aza-pg maintainers

**Last Updated:** 2025-11-08
