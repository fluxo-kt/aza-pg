# Phase 1: Investigation Findings

**Date**: 2025-11-15
**Scope**: Infrastructure audit - disabled extensions, CI/CD workflows, pgflow schema analysis

---

## Executive Summary

This document contains comprehensive findings from the Phase 1 investigation into omitted functionality, disabled extensions, and CI/CD gaps in the aza-pg PostgreSQL image project.

### Critical Findings

1. **Zero automated testing in CI pipelines** - 23 test files (11,887 lines) exist but are NOT run
2. **pgflow completely external** - Critical workflow feature is optional-only, not in manifest or Docker image
3. **4 disabled extensions** need documentation explaining why they're disabled
4. **4 production tools undocumented** - Users don't know these utilities exist

---

## 1. Disabled Extensions Analysis

### 1.1 PostGIS (Geospatial Extension)

| Property          | Value                                                                            |
| ----------------- | -------------------------------------------------------------------------------- |
| **Status**        | Disabled                                                                         |
| **Version**       | 3.6.1                                                                            |
| **Disabled Date** | 2025-11-11 (commit `cd45a8a`)                                                    |
| **Reason**        | Strategic optimization: reduce build time (8-10 min) and image size (200-300MB)  |
| **Dependencies**  | 14 APT packages (libge os-dev, libproj-dev, libgdal-dev, etc.)                   |
| **Fixable?**      | **YES** - Fully functional on PG18, no technical issues                          |
| **Re-enable**     | Set `enabled: true` in manifest-data.ts, run `bun run generate && bun run build` |

**Trade-offs:**

- ✅ Enables spatial data support (points, polygons, geographic queries)
- ❌ +8-10 minutes build time
- ❌ +200-300MB final image size

---

### 1.2 pgRouting (Routing/Network Analysis)

| Property          | Value                                                        |
| ----------------- | ------------------------------------------------------------ |
| **Status**        | Disabled                                                     |
| **Version**       | v4.0.0 (major release, breaking changes from v3.x)           |
| **Disabled Date** | 2025-11-11 (commit `cd45a8a`)                                |
| **Reason**        | Depends on PostGIS which is disabled; cascading optimization |
| **Dependencies**  | PostGIS (hard requirement), libboost-graph-dev               |
| **Fixable?**      | **YES** - Conditional on PostGIS being enabled               |
| **Re-enable**     | Enable PostGIS first, then set `enabled: true` for pgrouting |

**Trade-offs:**

- ✅ Enables graph/network routing algorithms (Dijkstra, A\*, etc.)
- ❌ +4-5 minutes build time (on top of PostGIS)
- ❌ +50-100MB image size
- ⚠️ Requires PostGIS to be enabled

**Note:** Version 4.0.0 introduced breaking API changes, C++17 upgrade, and 10 experimental functions promoted to stable.

---

### 1.3 pgq (Queue Extension)

| Property          | Value                                                                             |
| ----------------- | --------------------------------------------------------------------------------- |
| **Status**        | Disabled                                                                          |
| **Version**       | v3.5.1                                                                            |
| **Disabled Date** | 2025-11-10 (commit `72d7e87`)                                                     |
| **Reason**        | Optimization: not critical for most users (~2-3 min build time savings)           |
| **Dependencies**  | None                                                                              |
| **Fixable?**      | **YES** - Simple enablement, no technical blockers                                |
| **Re-enable**     | Set `enabled: true` in manifest-data.ts                                           |
| **Alternative**   | pgmq (enabled by default) provides similar queue functionality with more features |

**Trade-offs:**

- ✅ Pure PL/pgSQL implementation (PostgreSQL 10-18 compatible)
- ✅ Fast build (~2-3 minutes)
- ✅ No external dependencies
- ❌ Minimal image size impact (~10-20MB)
- ℹ️ pgmq (enabled) is a more modern alternative

**Note:** Not available in PGDG for PostgreSQL 18; compiled from source.

---

### 1.4 supautils (Supabase Utilities)

| Property          | Value                                                                   |
| ----------------- | ----------------------------------------------------------------------- |
| **Status**        | Disabled                                                                |
| **Version**       | v3.0.2                                                                  |
| **Disabled Date** | 2025-11-09 (commit `6c98d5c`)                                           |
| **Reason**        | **Build failure**: sed patching unreliable for missing `static` keyword |
| **Dependencies**  | pg_cron, pg_net (Supabase ecosystem)                                    |
| **Fixable?**      | **POSSIBLY** - Requires upstream fix or robust patching                 |

**Technical Issue:**

```c
// Source code has:
bool log_skipped_evtrigs;  // Missing 'static' keyword

// Should be:
static bool log_skipped_evtrigs;
```

**Current sed pattern (unreliable):**

```bash
s/^bool[[:space:]]\\{1,\\}log_skipped_evtrigs/static bool log_skipped_evtrigs/
```

**Fix Options:**

1. **Wait for upstream** (RECOMMENDED)
   - File issue with `supabase/supautils`
   - Unlikely given Supabase's product focus
   - Timeline: Uncertain

2. **Manual Git patch**
   - Replace sed with `git apply` + patch file
   - More robust than sed regex
   - Complexity: Medium

3. **Improved sed pattern**

   ```bash
   s/^\s*bool\s+log_skipped_evtrigs/static bool log_skipped_evtrigs/
   ```

   - Still fragile to upstream changes
   - Complexity: Low

**Recommendation:** Leave disabled until upstream fix. Users needing Supabase compatibility can fork and apply custom patches.

---

## 2. CI/CD Workflow Analysis

### 2.1 Current ci.yml (PRs and pushes to main/dev)

**File**: `.github/workflows/ci.yml`
**Total Lines**: 94
**Execution Time**: ~10 minutes

**What Runs:**

1. ✅ Fast validation (`bun run validate`): oxlint, prettier, tsc
2. ✅ Manifest validation (up-to-date check)
3. ✅ Generated files verification (Dockerfile, configs, docs)
4. ✅ Repository health check (file existence)

**What Does NOT Run:**

- ❌ Extension functional tests (37+ extensions)
- ❌ Auto-config tests (90 unit + 35 integration)
- ❌ Security tests (pgaudit, SCRAM-SHA-256, auth)
- ❌ PgBouncer tests
- ❌ Stack deployment tests
- ❌ Performance benchmarks
- ❌ Negative scenario tests

**Critical Gap:** No Docker build or functional validation in PR workflow. Extensions could be completely broken and CI would pass.

---

### 2.2 Current publish.yml (Release to production)

**File**: `.github/workflows/publish.yml`
**Total Lines**: 935
**Execution Time**: ~60 minutes
**Trigger**: Push to `release` branch

**What Runs:**

1. ✅ Manifest validation
2. ✅ Multi-arch build (amd64 + arm64, native runners)
3. ✅ Image testing (`scripts/docker/test-image.ts --fast`)
4. ✅ Security scanning (Trivy + Dockle)
5. ✅ Cosign signing
6. ✅ Tag promotion to production

**What test-image.ts --fast Actually Tests:**

- Basic image startup
- PostgreSQL version check
- Extension availability check (CREATE EXTENSION smoke test)

**What Does NOT Run:**

- ❌ Comprehensive extension functional tests
- ❌ Auto-config validation (different memory tiers, workload types)
- ❌ Security hardening verification
- ❌ PgBouncer integration tests
- ❌ pgflow functional tests
- ❌ Performance regression tests

**Critical Gap:** `--fast` flag skips comprehensive testing. Production images are promoted without validating that extensions actually work correctly.

---

## 3. pgflow Schema Analysis

**File**: `examples/pgflow/10-pgflow.sql`
**Lines**: 1,353
**Version**: v0.7.2 (extracted from Supabase migrations)

### 3.1 Schema Components

| Component             | Tables                        | Functions                             | Purpose             |
| --------------------- | ----------------------------- | ------------------------------------- | ------------------- |
| **Core DAG**          | flows, steps, deps            | create_flow, add_step                 | Workflow definition |
| **Execution**         | runs, step_states, step_tasks | start_flow, start_ready_steps         | Runtime execution   |
| **Task Management**   | workers                       | start_tasks, complete_task, fail_task | Task lifecycle      |
| **Queue Integration** | (pgmq tables)                 | read_with_poll, poll_for_tasks        | Message polling     |

### 3.2 Dependencies

**Required:**

- `pgmq` extension (PostgreSQL Message Queue) - **ENABLED in manifest ✓**
- PostgreSQL 14+ (gen_random_uuid, jsonb functions)

**Optional/Stubbed:**

- `realtime.send()` - No-op stub for standalone PostgreSQL (Supabase-specific)

### 3.3 Key Features

✅ **DAG Workflow Execution** - Define flows with step dependencies
✅ **Task Queuing** - Uses pgmq for reliable task queuing
✅ **Retry Logic** - Exponential backoff with configurable max attempts
✅ **Worker Tracking** - Worker heartbeat and task assignment
✅ **State Management** - Flow/step/task status tracking

❌ **Map Steps** - Phases 9-11 not included (parallel array processing)
❌ **opt_start_delay** - Phase 7 not included
❌ **Realtime Events** - Stubbed (Supabase Edge Functions required)

### 3.4 Limitations in Truncated Schema

This file contains **Phases 1-3 only**. Missing from Phases 4-11:

- set_vt_batch optimization
- Function search_path fixes
- opt_start_delay support
- Worker deprecation changes
- Map step type (parallel processing)

**Impact:**

- Core functionality works (DAG, retries, queuing)
- Advanced features unavailable
- Requires testing for specific workflows

### 3.5 Integration Requirements

**To make pgflow first-class:**

1. Add to manifest-data.ts as "schema-based" extension
2. Copy 10-pgflow.sql to proper initdb location
3. Ensure execution order (after pgmq, before user scripts)
4. Generate documentation
5. Add to CI test suite

---

## 4. Test Coverage Gaps

**Total Test Files**: 23
**Total Lines**: 11,887
**Files in CI**: 0 ❌

### 4.1 Untested Categories

| Category        | Test Files | Lines  | Impact if Broken                     |
| --------------- | ---------- | ------ | ------------------------------------ |
| **Extensions**  | 11 files   | ~4,500 | 37+ extensions could fail silently   |
| **Auto-Config** | 2 files    | 2,018  | Wrong RAM/CPU settings in production |
| **Security**    | 1 file     | 460    | Auth bypass, privilege escalation    |
| **PgBouncer**   | 3 files    | 1,852  | Connection pooling failures          |
| **pgflow**      | 2 files    | 1,126  | Workflow orchestration broken        |
| **Stacks**      | 2 files    | 1,123  | Replication/deployment failures      |
| **Performance** | 1 file     | 640    | Degradation unnoticed                |

### 4.2 High-Risk Untested Features

1. **Extension Compatibility** - 37 extensions × PG 18 = 37 potential breakage points
2. **Auto-Tuning** - 4 memory tiers × 4 workload types × 3 storage types = 48 configurations
3. **Replication** - Primary/replica stack completely untested in CI
4. **Security Hardening** - SCRAM-SHA-256, pgAudit, auth_query not validated
5. **Hook Extensions** - pg_plan_filter, pg_safeupdate (preload modules)

---

## 5. Undocumented Production Tools

**Location**: `scripts/tools/`
**User-Facing**: YES
**Documented**: NO ❌

| Tool                      | Purpose                                          | Lines | Mentioned in Docs? |
| ------------------------- | ------------------------------------------------ | ----- | ------------------ |
| **promote-replica.ts**    | Promote PostgreSQL replica to primary (failover) | ~200  | ❌ No              |
| **backup-postgres.ts**    | Backup database with pg_dump                     | ~150  | ❌ No              |
| **restore-postgres.ts**   | Restore from backup dump                         | ~150  | ❌ No              |
| **generate-ssl-certs.ts** | Generate self-signed SSL certificates            | ~100  | ❌ No              |

**Impact:** Users don't know these utilities exist. No usage examples, no safety warnings, no troubleshooting guides.

**Recommended Actions:**

1. Create `docs/OPERATIONS.md` with comprehensive tool documentation
2. Add "Operations" section to README
3. Include safety warnings (especially for promote-replica)
4. Provide usage examples for each tool

---

## 6. Documentation Rot

### 6.1 Broken References

| File                        | Line | Reference                                      | Status                |
| --------------------------- | ---- | ---------------------------------------------- | --------------------- |
| `docs/EXTENSIONS.md`        | 303  | `.archived/docs/analysis/PIGSTY-EVALUATION.md` | ❌ File doesn't exist |
| `examples/pgflow/README.md` | ~40  | `docs/pgflow/INTEGRATION.md`                   | ❌ File doesn't exist |

### 6.2 Orphaned Documents

| File                               | Status    | Issue                                     |
| ---------------------------------- | --------- | ----------------------------------------- |
| `docs/GITHUB_ENVIRONMENT_SETUP.md` | ✅ Exists | ❌ No incoming links (invisible to users) |

---

## 7. Examples Directory Status

| Example         | Integration   | In Manifest?          | In CI? | Documentation               |
| --------------- | ------------- | --------------------- | ------ | --------------------------- |
| **backup/**     | ✅ Integrated | ✅ pgbackrest (tool)  | ❌ No  | ✅ Complete (282 lines)     |
| **pgflow/**     | ❌ Optional   | ❌ No (only pgmq dep) | ❌ No  | ⚠️ Incomplete (broken refs) |
| **grafana/**    | N/A External  | N/A                   | ❌ No  | ✅ Guide only (96 lines)    |
| **prometheus/** | N/A External  | N/A                   | ❌ No  | ✅ Config templates         |

---

## 8. Recommendations

### 8.1 Immediate Actions (Critical)

1. **Integrate pgflow into manifest** as schema-based extension
2. **Add comprehensive CI testing** - All 23 test files must run
3. **Document production tools** - Create OPERATIONS.md
4. **Document disabled extensions** - Add explanations to EXTENSIONS.md
5. **Fix broken documentation references**

### 8.2 Medium Priority

1. **Add test coverage tracking** - Know what's tested vs untested
2. **Add performance baselines** - Regression detection
3. **Stack deployment validation** - At least single-stack in CI
4. **Link orphaned docs** - Make GITHUB_ENVIRONMENT_SETUP.md discoverable

### 8.3 Future Considerations

1. **Re-evaluate disabled extensions** - PostGIS/pgrouting may be needed by users
2. **pgq vs pgmq** - Document why pgmq is preferred
3. **supautils fix** - Monitor upstream for patch or use git apply
4. **pgflow schema completion** - Evaluate need for Phases 4-11

---

## Appendix A: Git Commit References

| Extension | Disabled Commit | Date       | Description                                                   |
| --------- | --------------- | ---------- | ------------------------------------------------------------- |
| postgis   | `cd45a8a`       | 2025-11-11 | Enable pg_stat_monitor/vectorscale, disable PostGIS/pgrouting |
| pgrouting | `cd45a8a`       | 2025-11-11 | Same as postgis (cascading dependency)                        |
| pgq       | `72d7e87`       | 2025-11-10 | Phase 1 critical fixes - added `enabled: false`               |
| supautils | `6c98d5c`       | 2025-11-09 | Disable due to compilation patch failure                      |

---

## Appendix B: Test File Inventory

**Total Files**: 23
**Total Lines**: 11,887
**In CI**: 0
**In package.json**: Some (but not called from CI)

See full test file analysis in audit report for details.

---

**END OF PHASE 1 FINDINGS**
