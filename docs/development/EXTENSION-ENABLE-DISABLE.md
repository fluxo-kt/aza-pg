# Extension Enable/Disable Implementation Guide

**Status:** Design Document
**Version:** 1.0
**Last Updated:** 2025-11-08

---

## Problem Statement

The `aza-pg` image currently bundles **38 extensions** (6 builtin + 14 PGDG + 18 compiled from source) totaling **319MB** of extension content and **~1.14GB total image size**. While this provides broad functionality, it creates several issues:

### Current Pain Points

1. **Build Time:** ~12 minutes total (7 min PGXS/autotools, 5 min Rust cargo-pgrx)
2. **Image Size:** All 38 extensions built regardless of need
3. **No Granular Control:** Users cannot selectively disable extensions at build time
4. **Hardcoded Defaults:** 7 extensions enabled by default in `01-extensions.sql` (pg_stat_statements, pg_trgm, pgaudit, pg_cron, vector, timescaledb, supautils)
5. **Runtime vs Build Confusion:** `runtime.defaultEnable` only controls SQL `CREATE EXTENSION`, not whether extension is built/bundled

### What Users Need

- **Build-time control:** Skip compiling/bundling unused extensions (reduce build time + image size)
- **Image variants:** Lean images for specific workloads (AI-only, time-series-only, etc.)
- **Explicit defaults:** Clear distinction between "installed" vs "enabled at runtime"
- **Dependency validation:** Automatic detection when disabled extension is required by enabled extension

---

## Current State

### Extension Inventory (38 Total)

| Category            | Count | Examples                                                                                                                                                                                                                       | Build Method                  |
| ------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| **Builtin**         | 6     | auto_explain, pg_stat_statements, pg_trgm, btree_gin, btree_gist, plpgsql                                                                                                                                                      | N/A (PostgreSQL core)         |
| **PGDG Pre-built**  | 14    | pgvector, pg_cron, pgaudit, timescaledb, postgis, pg_partman, pg_repack, hll, http, hypopg, pgrouting, rum, set_user, plpgsql_check                                                                                            | APT package install (~10 sec) |
| **Source-compiled** | 18    | timescaledb_toolkit, pg_jsonschema, pgroonga, vectorscale, wrappers, pgsodium, pgmq, pgq, index_advisor, pg_hashids, pg_stat_monitor, supautils, supabase_vault, pgbackrest, pgbadger, pg_plan_filter, pg_safeupdate, wal2json | Git clone + build (~12 min)   |

### Default Runtime Enablement (7 Extensions)

Automatically created via `docker/postgres/docker-entrypoint-initdb.d/01-extensions.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;  -- builtin
CREATE EXTENSION IF NOT EXISTS pg_trgm;              -- builtin
CREATE EXTENSION IF NOT EXISTS pgaudit;              -- PGDG
CREATE EXTENSION IF NOT EXISTS pg_cron;              -- PGDG
CREATE EXTENSION IF NOT EXISTS vector;               -- PGDG (pgvector)
CREATE EXTENSION IF NOT EXISTS timescaledb;          -- PGDG
CREATE EXTENSION IF NOT EXISTS supautils;            -- source-compiled
```

### Manifest Schema (Current)

```typescript
// scripts/extensions/manifest-data.ts
export interface RuntimeSpec {
  sharedPreload?: boolean; // Requires shared_preload_libraries
  defaultEnable?: boolean; // Creates extension in 01-extensions.sql
  notes?: string[];
}

export interface ManifestEntry {
  name: string;
  displayName?: string;
  kind: "extension" | "tool" | "builtin";
  category: string;
  description: string;
  source: SourceSpec;
  build?: BuildSpec;
  runtime?: RuntimeSpec; // Controls SQL enablement only
  dependencies?: string[];
  install_via?: "pgdg";
}
```

**Key Gap:** No field to control build-time inclusion/exclusion.

### Build Logic (Current Flow)

**File:** `docker/postgres/build-extensions.sh`

```bash
# Main loop (line 373-375)
while IFS= read -r entry; do
  process_entry "$entry"
done < <(jq -c '.entries[]' "$MANIFEST_PATH")
```

**Gate 1: Builtin Check (line 232-235)**

```bash
if [[ "$kind" == "builtin" ]]; then
  log "Skipping builtin extension $name"
  return
fi
```

**Gate 2: PGDG Check (line 237-242)**

```bash
if [[ "$install_via" == "pgdg" ]]; then
  log "Skipping $name (installed via PGDG)"
  return
fi
```

**Result:** Only **18 source-compiled extensions** actually run through build logic. Builtin (6) and PGDG (14) are installed elsewhere (PostgreSQL core / Dockerfile APT layer).

### Build Time Breakdown

```
PGDG package install:       ~10 sec   (14 extensions via APT)
PGXS/autotools/cmake:       ~7 min    (C-based extensions)
Rust (cargo-pgrx):          ~5 min    (6 Rust extensions)
  ├── timescaledb_toolkit:  ~3-4 min  (major contributor)
  ├── pg_jsonschema:        ~1-2 min
  └── Others:               ~1 min combined
──────────────────────────────────────
Total:                      ~12 min
```

---

## Proposed Solution

### 1. Manifest Schema Extension

Add `enabled` field to control build-time inclusion:

```typescript
// scripts/extensions/manifest-data.ts
export interface ManifestEntry {
  name: string;
  displayName?: string;
  kind: "extension" | "tool" | "builtin";
  category: string;
  description: string;

  // NEW: Build-time control
  enabled?: boolean; // Default: true (build + bundle extension)
  disabledReason?: string; // Optional: Why disabled (for docs/logs)

  source: SourceSpec;
  build?: BuildSpec;
  runtime?: RuntimeSpec; // Separate: Controls SQL CREATE EXTENSION
  dependencies?: string[];
  install_via?: "pgdg";
}
```

**Semantic Difference:**

| Field                   | Scope          | Default | Effect                                                          |
| ----------------------- | -------------- | ------- | --------------------------------------------------------------- |
| `enabled`               | **Build-time** | `true`  | Controls whether extension is compiled/bundled into image       |
| `runtime.defaultEnable` | **Runtime**    | `false` | Controls whether `CREATE EXTENSION` runs in `01-extensions.sql` |

**Example: Disabled Extension**

```typescript
{
  name: "pgq",
  kind: "extension",
  category: "queueing",
  description: "Generic high-performance lockless queue.",
  enabled: false,  // NEW
  disabledReason: "Not needed for AI workloads. Use pgmq instead.",  // NEW
  source: {
    type: "git",
    repository: "https://github.com/pgq/pgq.git",
    tag: "v3.5.1",
  },
  build: { type: "pgxs" },
  runtime: { sharedPreload: false, defaultEnable: false },
}
```

### 2. Build Logic Changes (4 Gates)

**File:** `docker/postgres/build-extensions.sh`

**NEW Gate 0: Enabled Check (insert at line 228)**

```bash
process_entry() {
  local entry=$1
  local name kind enabled

  name=$(jq -r '.name' <<<"$entry")
  kind=$(jq -r '.kind' <<<"$entry")

  # ──────────────────────────────────────────────────────────────────────────
  # GATE 0: BUILD-TIME ENABLED CHECK (NEW)
  # ──────────────────────────────────────────────────────────────────────────
  # Check if extension is disabled at build-time
  enabled=$(jq -r '.enabled // true' <<<"$entry")
  if [[ "$enabled" != "true" ]]; then
    local reason
    reason=$(jq -r '.disabledReason // "No reason specified"' <<<"$entry")
    log "Skipping $name (disabled: $reason)"
    return
  fi

  # GATE 1: Builtin check (existing)
  if [[ "$kind" == "builtin" ]]; then
    log "Skipping builtin extension $name"
    return
  fi

  # GATE 2: PGDG check (existing)
  local install_via
  install_via=$(jq -r '.install_via // ""' <<<"$entry")
  if [[ "$install_via" == "pgdg" ]]; then
    log "Skipping $name (installed via PGDG)"
    return
  fi

  # GATE 3: Source type validation (existing, line 244-267)
  # ...

  # GATE 4: Build type dispatch (existing, line 329-368)
  # ...
}
```

**Execution Order:**

1. **Gate 0 (NEW):** `enabled == false` → Skip (logs reason)
2. **Gate 1:** `kind == "builtin"` → Skip (no build needed)
3. **Gate 2:** `install_via == "pgdg"` → Skip (APT handles it)
4. **Gate 3:** Clone source repository
5. **Gate 4:** Dispatch to build system (pgxs/cargo-pgrx/cmake/etc.)

### 3. Dependency Validation

**Algorithm:**

```typescript
// scripts/extensions/validate-manifest.ts (add new function)
function validateDependencies(entries: ManifestEntry[]): void {
  const enabledExtensions = new Set(
    entries.filter((e) => e.enabled !== false).map((e) => e.name)
  );

  const errors: string[] = [];

  for (const entry of entries) {
    // Skip disabled extensions
    if (entry.enabled === false) continue;

    // Check each dependency
    for (const dep of entry.dependencies ?? []) {
      if (!enabledExtensions.has(dep)) {
        errors.push(
          `Extension "${entry.name}" depends on "${dep}", but "${dep}" is disabled`
        );
      }
    }
  }

  if (errors.length > 0) {
    console.error("❌ Dependency validation failed:\n");
    errors.forEach((err) => console.error(`  - ${err}`));
    process.exit(1);
  }
}
```

**Example Dependency Chain:**

```
index_advisor → hypopg  (if index_advisor enabled, hypopg must be enabled)
vectorscale → vector    (if vectorscale enabled, vector must be enabled)
supabase_vault → pgsodium
timescaledb_toolkit → timescaledb
wrappers → pg_stat_statements
pgrouting → postgis
```

**Integration Point:**

```bash
# scripts/extensions/generate-manifest.ts
import { validateDependencies } from './validate-manifest.ts';

// After loading manifest data, before writing JSON
validateDependencies(MANIFEST_ENTRIES);
```

### 4. Runtime SQL Generation

**File:** `docker/postgres/docker-entrypoint-initdb.d/01-extensions.sql` (generated)

**Current (hardcoded):**

```sql
-- File: 01-extensions.sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgaudit;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS supautils;
```

**Proposed (generated from manifest):**

```typescript
// scripts/extensions/generate-init-sql.ts (NEW FILE)
import { MANIFEST_ENTRIES } from "./manifest-data.ts";

const enabledExtensions = MANIFEST_ENTRIES.filter(
  (e) => e.enabled !== false && e.runtime?.defaultEnable === true
);

const sql = enabledExtensions
  .map((e) => `CREATE EXTENSION IF NOT EXISTS ${e.name};`)
  .join("\n");

await Bun.write(
  "docker/postgres/docker-entrypoint-initdb.d/01-extensions.sql",
  `-- Auto-generated from extensions.manifest.json\n-- DO NOT EDIT MANUALLY\n\n${sql}\n`
);
```

**Run via:**

```bash
bun scripts/extensions/generate-manifest.ts  # Updates manifest.json
bun scripts/extensions/generate-init-sql.ts  # Updates 01-extensions.sql
```

---

## Critical Risks (7 Identified)

### 1. Dependency Cascade Failures

**Risk:** Disabling `hypopg` breaks `index_advisor` at runtime (SQL `CREATE EXTENSION` fails).

**Mitigation:**

- Pre-build validation in `generate-manifest.ts`
- Fail fast with clear error: `"index_advisor depends on hypopg, but hypopg is disabled"`
- Document dependencies in `docs/EXTENSIONS.md`

### 2. PGDG Extensions Not Affected

**Risk:** `enabled: false` has NO EFFECT on PGDG extensions (Gate 2 skips before Gate 0).

**Mitigation:**

- Move Gate 0 (enabled check) **BEFORE** Gate 2 (PGDG check)
- Also filter PGDG packages in Dockerfile APT install layer
- Add Dockerfile logic: `jq -r '.entries[] | select(.enabled != false and .install_via == "pgdg") | .name'`

**Dockerfile Change Required:**

```dockerfile
# Before (installs all PGDG extensions)
RUN apt-get install -y --no-install-recommends \
  postgresql-${PG_MAJOR}-cron=1.6.7-2.pgdg13+1 \
  postgresql-${PG_MAJOR}-pgaudit=18.0-2.pgdg13+1 \
  # ... all 14 PGDG extensions

# After (filters based on manifest)
RUN export PGDG_EXTENSIONS=$(jq -r '.entries[] | select(.enabled != false and .install_via == "pgdg") | "postgresql-${PG_MAJOR}-" + .name' /tmp/extensions.manifest.json | tr '\n' ' ') && \
    apt-get install -y --no-install-recommends $PGDG_EXTENSIONS
```

### 3. Builtin Extensions Cannot Be Disabled

**Risk:** Setting `enabled: false` on builtin extensions (pg_stat_statements, pg_trgm) has NO EFFECT (part of PostgreSQL core).

**Mitigation:**

- Validate in `validate-manifest.ts`: Error if builtin extension has `enabled: false`
- Document: "Builtin extensions cannot be disabled (part of PostgreSQL binary)"

### 4. Runtime Preload vs Build Enabled Confusion

**Risk:** Users set `runtime.sharedPreload: true` but `enabled: false`, expecting it to work.

**Mitigation:**

- Validate: If `runtime.sharedPreload: true`, then `enabled` MUST NOT be `false`
- Error message: `"pg_cron requires sharedPreload but is disabled. Enable it or remove from shared_preload_libraries"`

### 5. Init SQL Generation Must Run After Manifest Changes

**Risk:** Developers update manifest but forget to regenerate `01-extensions.sql`, causing runtime failures.

**Mitigation:**

- CI check: Verify `01-extensions.sql` matches manifest (hash comparison)
- Pre-commit hook: Auto-run `generate-init-sql.ts`
- Documentation: Add step to `docs/development/EXTENSION-ENABLE-DISABLE.md`

### 6. Image Size Savings Only for Source-Compiled Extensions

**Risk:** Disabling PGDG extensions doesn't save much space (APT packages share dependencies).

**Reality Check:**

| Extension Type  | Count | Image Size        | Savings if Disabled                         |
| --------------- | ----- | ----------------- | ------------------------------------------- |
| Builtin         | 6     | ~5MB (in PG core) | **0 MB** (cannot disable)                   |
| PGDG            | 14    | ~294MB layer      | **~10-50MB** (shared lib overhead, minimal) |
| Source-compiled | 18    | ~247MB binaries   | **~10-200MB** (varies by extension)         |

**Example:** Disabling `timescaledb_toolkit` saves 13MB. Disabling `pg_cron` (PGDG) saves ~2MB.

### 7. Shared Preload Libraries Runtime Override

**Risk:** User sets `POSTGRES_SHARED_PRELOAD_LIBRARIES=pg_cron,pgaudit` but `pg_cron` disabled at build-time → PostgreSQL fails to start.

**Mitigation:**

- Entrypoint validation: Check if preloaded extension exists
- Dockerfile: Generate list of available preload extensions
- Startup script: Filter `POSTGRES_SHARED_PRELOAD_LIBRARIES` to only include available extensions
- Log warning: `"pg_cron requested in shared_preload_libraries but not installed, removing from list"`

---

## Implementation Plan (3 Phases)

### Phase 1: Manifest Schema + Validation (Week 1)

**Goal:** Add `enabled` field, validate dependencies, NO build logic changes yet.

**Tasks:**

1. Update `scripts/extensions/manifest-data.ts`:
   - Add `enabled?: boolean` to `ManifestEntry`
   - Add `disabledReason?: string`
   - Default `enabled = true` (backward compatible)

2. Create `scripts/extensions/validate-manifest.ts`:
   - Dependency validation function
   - Builtin constraint check (cannot disable)
   - Preload + disabled conflict check

3. Update `scripts/extensions/generate-manifest.ts`:
   - Call `validateDependencies()` before writing JSON
   - Fail build if validation errors

4. Test validation:
   ```bash
   # Should fail: index_advisor enabled, hypopg disabled
   # Should fail: pg_stat_statements enabled=false (builtin)
   # Should pass: All current defaults
   ```

**Deliverables:**

- Schema updated
- Validation catches common errors
- Backward compatible (all extensions enabled by default)

**Estimated Time:** 4-6 hours

---

### Phase 2: Build Script Integration (Week 2)

**Goal:** Respect `enabled` field in build process, filter PGDG packages.

**Tasks:**

1. **Modify `docker/postgres/build-extensions.sh`:**
   - Add Gate 0 (enabled check) at line 228
   - Move before Gate 1 (builtin) and Gate 2 (PGDG)
   - Log `disabledReason` when skipping

2. **Update `docker/postgres/Dockerfile`:**
   - Replace hardcoded PGDG package list with jq filter

   ```dockerfile
   RUN export ENABLED_PGDG=$(jq -r '.entries[] | select(.enabled != false and .install_via == "pgdg") | "postgresql-${PG_MAJOR}-" + .name' /tmp/extensions.manifest.json | tr '\n' ' ') && \
       apt-get install -y --no-install-recommends $ENABLED_PGDG
   ```

3. **Create test variant:**
   - Disable 3 extensions: `pgq`, `pgroonga`, `timescaledb_toolkit`
   - Expected savings: ~17MB (2.1MB + 2MB + 13MB)
   - Build time reduction: ~4-6 min (pgroonga 2-3 min, toolkit 3-4 min, pgq 30 sec)

4. **Verify:**
   ```bash
   ./scripts/build.sh
   docker run --rm aza-pg:latest psql -c "\dx"  # Should NOT list disabled extensions
   ```

**Deliverables:**

- Build script respects `enabled` field
- PGDG filtering works
- Measurable size/time savings

**Estimated Time:** 8-12 hours

---

### Phase 3: Runtime SQL Generation + Documentation (Week 3)

**Goal:** Auto-generate `01-extensions.sql`, update docs, CI validation.

**Tasks:**

1. **Create `scripts/extensions/generate-init-sql.ts`:**

   ```typescript
   const sql = MANIFEST_ENTRIES.filter(
     (e) => e.enabled !== false && e.runtime?.defaultEnable === true
   )
     .map((e) => `CREATE EXTENSION IF NOT EXISTS ${e.name};`)
     .join("\n");
   ```

2. **Update entrypoint script:**
   - Add validation: Check if `POSTGRES_SHARED_PRELOAD_LIBRARIES` references disabled extensions
   - Filter out unavailable extensions
   - Log warnings

3. **CI Integration:**
   - Add check: `01-extensions.sql` hash matches manifest
   - Fail if out of sync

4. **Documentation:**
   - Update `docs/EXTENSIONS.md` with disable instructions
   - Add `docs/development/EXTENSION-ENABLE-DISABLE.md` (this document)
   - Update `CLAUDE.md` with new workflow

5. **Testing:**
   - Disable all optional extensions (keep only 7 defaults)
   - Verify PostgreSQL starts
   - Verify `CREATE EXTENSION` for disabled extension fails with clear error

**Deliverables:**

- Automated SQL generation
- Runtime safety checks
- Complete documentation

**Estimated Time:** 8-12 hours

---

## Testing Strategy

### Unit Tests (Validation Logic)

**File:** `scripts/extensions/validate-manifest.test.ts`

```typescript
import { test, expect } from "bun:test";
import { validateDependencies } from "./validate-manifest.ts";

test("should fail when dependency is disabled", () => {
  const entries = [
    { name: "hypopg", enabled: false, dependencies: [] },
    { name: "index_advisor", enabled: true, dependencies: ["hypopg"] },
  ];

  expect(() => validateDependencies(entries)).toThrow(
    "index_advisor depends on hypopg, but hypopg is disabled"
  );
});

test("should pass when all dependencies enabled", () => {
  const entries = [
    { name: "hypopg", enabled: true, dependencies: [] },
    { name: "index_advisor", enabled: true, dependencies: ["hypopg"] },
  ];

  expect(() => validateDependencies(entries)).not.toThrow();
});

test("should fail when builtin extension disabled", () => {
  const entries = [
    { name: "pg_stat_statements", kind: "builtin", enabled: false },
  ];

  expect(() => validateBuiltinConstraints(entries)).toThrow(
    "Builtin extension pg_stat_statements cannot be disabled"
  );
});
```

**Run:** `bun test scripts/extensions/validate-manifest.test.ts`

### Integration Tests (Build Process)

**Test 1: Disabled Extension Not Built**

```bash
# Set pgq to disabled
jq '.entries[] | select(.name == "pgq") | .enabled = false' \
  docker/postgres/extensions.manifest.json > /tmp/manifest.json

# Build image
./scripts/build.sh --load

# Verify pgq NOT present
docker run --rm aza-pg:latest ls /usr/lib/postgresql/18/lib | grep -q "pgq.so"
# Should exit 1 (not found)
```

**Test 2: Dependency Validation Catches Errors**

```bash
# Disable hypopg (index_advisor depends on it)
jq '.entries[] | select(.name == "hypopg") | .enabled = false' \
  docker/postgres/extensions.manifest.json > /tmp/manifest.json

# Should fail at manifest generation
bun scripts/extensions/generate-manifest.ts
# Expected: Error "index_advisor depends on hypopg, but hypopg is disabled"
```

**Test 3: Runtime CREATE EXTENSION Fails Gracefully**

```bash
# Disable vectorscale at build
# Start container
docker run -d --name test-pg aza-pg:latest

# Try to create disabled extension
docker exec test-pg psql -U postgres -c "CREATE EXTENSION vectorscale;"
# Expected: ERROR:  extension "vectorscale" is not available
```

**Test 4: PGDG Filtering Works**

```bash
# Disable pg_cron (PGDG extension)
jq '.entries[] | select(.name == "pg_cron") | .enabled = false' \
  docker/postgres/extensions.manifest.json > /tmp/manifest.json

# Build image
./scripts/build.sh --load

# Verify pg_cron NOT installed
docker run --rm aza-pg:latest dpkg -l | grep -q "postgresql-18-cron"
# Should exit 1 (not found)
```

### Performance Tests (Size/Time Savings)

**Test 5: Measure Size Impact**

```bash
# Baseline: All 38 extensions enabled
./scripts/build.sh --load
BASELINE_SIZE=$(docker images aza-pg:latest --format "{{.Size}}")

# Variant: Disable 10 extensions (timescaledb_toolkit, pgroonga, pgq, etc.)
# ... modify manifest ...
./scripts/build.sh --load
VARIANT_SIZE=$(docker images aza-pg:latest --format "{{.Size}}")

echo "Baseline: $BASELINE_SIZE"
echo "Variant: $VARIANT_SIZE"
echo "Savings: $((BASELINE_SIZE - VARIANT_SIZE)) bytes"
```

**Test 6: Measure Build Time Reduction**

```bash
# Baseline
time ./scripts/build.sh --load
# Expected: ~12 minutes

# Disable timescaledb_toolkit + pgroonga
time ./scripts/build.sh --load
# Expected: ~5-6 minutes (50% reduction)
```

---

## Migration Guide

### For Current Users (No Action Required)

**Default Behavior (Backward Compatible):**

- All 38 extensions remain `enabled: true` by default
- Same 7 extensions enabled at runtime
- No image size or behavior changes

**Opt-In Customization:**

1. Fork/clone `aza-pg` repository
2. Edit `scripts/extensions/manifest-data.ts`
3. Set `enabled: false` for unwanted extensions
4. Regenerate manifest: `bun scripts/extensions/generate-manifest.ts`
5. Build custom image: `./scripts/build.sh`

### For New Image Variants

**Scenario 1: AI/ML Workload (Lean Image)**

**Goal:** Only vector search, no time-series, no GIS.

**Changes:**

```typescript
// scripts/extensions/manifest-data.ts
export const MANIFEST_ENTRIES: ManifestEntry[] = [
  // KEEP: Vector extensions
  { name: "vector", enabled: true, ... },
  { name: "vectorscale", enabled: true, ... },

  // DISABLE: Time-series
  { name: "timescaledb", enabled: false, disabledReason: "Not needed for AI workloads" },
  { name: "timescaledb_toolkit", enabled: false, disabledReason: "Not needed for AI workloads" },

  // DISABLE: GIS
  { name: "postgis", enabled: false, disabledReason: "Not needed for AI workloads" },
  { name: "pgrouting", enabled: false, disabledReason: "Not needed for AI workloads" },

  // DISABLE: Search (use pgvector instead)
  { name: "pgroonga", enabled: false, disabledReason: "pgvector sufficient for AI search" },
  { name: "rum", enabled: false, disabledReason: "pgvector sufficient for AI search" },

  // ... other extensions ...
];
```

**Expected Savings:**

- Build time: 12 min → 7 min (-42%)
- Image size: 1.14GB → 900MB (-21%)
- Extensions: 38 → 28 (-10)

**Build:**

```bash
bun scripts/extensions/generate-manifest.ts
./scripts/build.sh --load -t aza-pg:18-ai
```

---

**Scenario 2: Time-Series Workload**

**Goal:** TimescaleDB + monitoring, no vector search, no GIS.

**Changes:**

```typescript
// Disable vector
{ name: "vector", enabled: false, disabledReason: "Not needed for time-series workloads" },
{ name: "vectorscale", enabled: false, disabledReason: "Not needed for time-series workloads" },

// Keep time-series
{ name: "timescaledb", enabled: true, ... },
{ name: "timescaledb_toolkit", enabled: true, ... },
{ name: "pg_stat_monitor", enabled: true, ... },

// Disable GIS
{ name: "postgis", enabled: false, disabledReason: "Not needed for time-series workloads" },
```

**Expected Savings:**

- Build time: 12 min → 10 min (-17%)
- Image size: 1.14GB → 1.00GB (-12%)
- Extensions: 38 → 32 (-6)

---

**Scenario 3: Minimal Core (Essential Only)**

**Goal:** Smallest possible image, only critical extensions.

**Changes:**

```typescript
// KEEP: Essential (7 defaults)
{ name: "pg_stat_statements", enabled: true, ... },  // builtin
{ name: "pg_trgm", enabled: true, ... },             // builtin
{ name: "pgaudit", enabled: true, ... },             // security
{ name: "pg_cron", enabled: true, ... },             // operations
{ name: "vector", enabled: true, ... },              // AI
{ name: "timescaledb", enabled: true, ... },         // time-series
{ name: "supautils", enabled: true, ... },           // safety

// DISABLE: All optional extensions (31 total)
{ name: "timescaledb_toolkit", enabled: false, disabledReason: "Minimal core" },
{ name: "pgroonga", enabled: false, disabledReason: "Minimal core" },
// ... 29 more ...
```

**Expected Savings:**

- Build time: 12 min → 2 min (-83%)
- Image size: 1.14GB → 700MB (-39%)
- Extensions: 38 → 7 (-31)

---

### Workflow Changes

**Before (Hardcoded):**

```bash
# Modify extension: Update Dockerfile ARG + build script logic
vim docker/postgres/Dockerfile
vim docker/postgres/build-extensions.sh
./scripts/build.sh
```

**After (Manifest-Driven):**

```bash
# Modify extension: Edit manifest-data.ts
vim scripts/extensions/manifest-data.ts

# Regenerate derived files
bun scripts/extensions/generate-manifest.ts  # Updates manifest.json
bun scripts/extensions/generate-init-sql.ts  # Updates 01-extensions.sql

# Build
./scripts/build.sh
```

---

## Appendix: Reference Examples

### Example 1: Disable Single Extension

```typescript
// scripts/extensions/manifest-data.ts

// Before
{
  name: "pgq",
  kind: "extension",
  category: "queueing",
  description: "Generic high-performance lockless queue.",
  source: { type: "git", repository: "https://github.com/pgq/pgq.git", tag: "v3.5.1" },
  build: { type: "pgxs" },
  runtime: { sharedPreload: false, defaultEnable: false },
}

// After
{
  name: "pgq",
  kind: "extension",
  category: "queueing",
  description: "Generic high-performance lockless queue.",
  enabled: false,  // NEW
  disabledReason: "Use pgmq instead (more features, same performance)",  // NEW
  source: { type: "git", repository: "https://github.com/pgq/pgq.git", tag: "v3.5.1" },
  build: { type: "pgxs" },
  runtime: { sharedPreload: false, defaultEnable: false },
}
```

**Build Log:**

```
[ext-build] Skipping pgq (disabled: Use pgmq instead (more features, same performance))
```

---

### Example 2: Disable Extension with Dependents (Error)

```typescript
// Disable hypopg (index_advisor depends on it)
{
  name: "hypopg",
  kind: "extension",
  enabled: false,
  disabledReason: "Not needed",
  // ...
}

// index_advisor still enabled
{
  name: "index_advisor",
  kind: "extension",
  enabled: true,
  dependencies: ["hypopg"],
  // ...
}
```

**Validation Error:**

```bash
$ bun scripts/extensions/generate-manifest.ts

❌ Dependency validation failed:

  - Extension "index_advisor" depends on "hypopg", but "hypopg" is disabled

Fix: Either enable "hypopg" or disable "index_advisor"
```

---

### Example 3: Disable PGDG Extension

```typescript
{
  name: "pg_cron",
  kind: "extension",
  install_via: "pgdg",
  enabled: false,  // NEW
  disabledReason: "Using external cron for scheduled jobs",  // NEW
  // ...
}
```

**Dockerfile Effect:**

```dockerfile
# Before (installs pg_cron)
RUN apt-get install -y postgresql-18-cron=1.6.7-2.pgdg13+1

# After (skips pg_cron)
RUN export ENABLED_PGDG=$(jq -r '.entries[] | select(.enabled != false and .install_via == "pgdg") | "postgresql-${PG_MAJOR}-" + .name' /tmp/extensions.manifest.json | tr '\n' ' ') && \
    apt-get install -y $ENABLED_PGDG
# Result: pg_cron NOT installed
```

---

### Example 4: Runtime Check (Shared Preload Libraries)

```bash
# User sets environment variable
POSTGRES_SHARED_PRELOAD_LIBRARIES="pg_stat_statements,pg_cron,pgaudit,timescaledb"

# But pg_cron disabled at build-time
# Entrypoint script validates:

#!/bin/bash
# docker-auto-config-entrypoint.sh

AVAILABLE_PRELOAD=$(jq -r '.entries[] | select(.enabled != false and .runtime.sharedPreload == true) | .name' /etc/extensions.manifest.json)

for ext in ${POSTGRES_SHARED_PRELOAD_LIBRARIES//,/ }; do
  if ! echo "$AVAILABLE_PRELOAD" | grep -q "^$ext$"; then
    echo "WARNING: $ext requested in shared_preload_libraries but not installed, removing"
    POSTGRES_SHARED_PRELOAD_LIBRARIES="${POSTGRES_SHARED_PRELOAD_LIBRARIES//$ext,/}"
  fi
done

exec postgres -c shared_preload_libraries="$POSTGRES_SHARED_PRELOAD_LIBRARIES"
```

**Result:** PostgreSQL starts successfully with filtered list (pg_cron removed).

---

## Summary

**Key Principles:**

1. **Backward Compatible:** All extensions enabled by default (`enabled: true`)
2. **Build-Time Control:** `enabled` field in manifest-data.ts
3. **Runtime Separate:** `runtime.defaultEnable` controls SQL CREATE EXTENSION
4. **Dependency Validation:** Fail fast if dependency disabled
5. **PGDG Filtering:** Dockerfile respects `enabled` field for APT packages
6. **Automated Generation:** SQL init scripts generated from manifest
7. **Clear Errors:** Explicit `disabledReason` logged during build

**Benefits:**

- **Flexibility:** Users can create lean images for specific workloads
- **Safety:** Dependency validation prevents runtime failures
- **Maintainability:** Single source of truth (manifest-data.ts)
- **Performance:** Measurable build time and image size reductions
- **Clarity:** Explicit distinction between build-time and runtime enablement

**Next Steps:**

1. Review this document with stakeholders
2. Implement Phase 1 (validation logic)
3. Test validation catches common errors
4. Proceed to Phase 2 (build integration) after validation proven
5. Document user-facing workflows in `docs/EXTENSIONS.md`
