# Technical Debt Tracking

This document tracks known technical debt, temporary workarounds, and upstream dependencies that require monitoring.

## Extension Build Patches (HIGH PRIORITY)

### Issue 1: pg_jsonschema pgrx Version Mismatch

**Location:** `docker/postgres/extensions.manifest.json` (pg_jsonschema.build.patches)

**Problem:** pg_jsonschema uses pgrx 0.16.0 but PostgreSQL 18 requires pgrx 0.16.1+

**Current Workaround:** Manifest-driven Cargo.toml patching:

```json
"patches": [
  "s/pgrx = \"0\\.16\\.0\"/pgrx = \"=0.16.1\"/"
]
```

**Impact:** Requires build-time patching; may break with upstream Cargo.toml changes

**Resolution Path:**

1. Monitor https://github.com/supabase/pg_jsonschema for pgrx 0.16.1+ update
2. Test build without patch after upstream update
3. Remove patches array from manifest.json
4. Update manifest.json commit SHA to fixed upstream version

**Last Verified:** 2025-11-09

---

### Issue 2: wrappers pgrx Version Mismatch

**Location:** `docker/postgres/extensions.manifest.json` (wrappers.build.patches)

**Problem:** Supabase wrappers uses pgrx 0.16.0, needs 0.16.1+ for PG18

**Current Workaround:** Manifest-driven Cargo.toml patching:

```json
"patches": [
  "s/pgrx = { version = \"=0\\.16\\.0\"/pgrx = { version = \"=0.16.1\"/"
]
```

**Impact:** Requires build-time patching; may break with upstream Cargo.toml changes

**Resolution Path:**

1. Monitor https://github.com/supabase/wrappers for pgrx 0.16.1+ update
2. Test build without patches after upstream update
3. Remove patches array from manifest.json
4. Update manifest.json commit SHA to fixed upstream version

**Last Verified:** 2025-11-09

---

### Issue 3: supautils Static Keyword Missing

**Location:** `docker/postgres/extensions.manifest.json` (supautils.build.patches)

**Problem:** Variable `log_skipped_evtrigs` should be `static bool` not `bool`

**Current Workaround:** Manifest-driven C source patching:

```json
"patches": [
  "s/^bool[[:space:]]\\{1,\\}log_skipped_evtrigs/static bool log_skipped_evtrigs/"
]
```

**Impact:** Modifies C source at build time via sed; non-standard but automated

**Resolution Path:**

1. Monitor https://github.com/supabase/supautils for static keyword fix
2. Alternative: Submit upstream PR with fix
3. Test build without patches after merge
4. Remove patches array from manifest.json
5. Update manifest.json commit SHA to fixed upstream version

**Last Verified:** 2025-11-09

---

## Monitoring Schedule

**Weekly:** Check upstream repositories for relevant commits
**Monthly:** Attempt builds without patches to verify if fixed
**On Release:** Test immediately when new upstream versions released

---

## How to Track

To create GitHub issues for these items:

```bash
# Issue 1: pg_jsonschema pgrx version
gh issue create --title "Remove pg_jsonschema pgrx patch when upstream fixes" \
  --body "See docs/TECHNICAL-DEBT.md Issue 1" \
  --label "technical-debt,upstream-dependency"

# Issue 2: wrappers pgrx version
gh issue create --title "Remove wrappers pgrx patch when upstream fixes" \
  --body "See docs/TECHNICAL-DEBT.md Issue 2" \
  --label "technical-debt,upstream-dependency"

# Issue 3: supautils static keyword
gh issue create --title "Remove supautils static keyword patch when upstream fixes" \
  --body "See docs/TECHNICAL-DEBT.md Issue 3" \
  --label "technical-debt,upstream-dependency"
```

---

## Other Known Technical Debt

### Config Generator Complexity

**Status:** Acceptable trade-off
**Details:** 19MB Bun/TypeScript toolchain generates 171 lines of config

**Trade-off Analysis:**

- **Pros**: Type-safe config generation, single source of truth, automated consistency
- **Cons**: Requires Bun runtime for config regeneration (19MB overhead)
- **Assessment**: The type safety and maintainability benefits outweigh the minimal toolchain overhead
- **Alternative rejected**: Hand-written configs would be error-prone and harder to maintain

### Manifest.json Duplication

**Status:** Acceptable by design
**Details:** 852-line JSON duplicates Dockerfile metadata

**Rationale:**

- Manifest serves as machine-readable extension catalog for validation and documentation
- Dockerfile is the build source of truth
- Duplication is intentional to support automated validation and doc generation
- Trade-off: Consistency is enforced by validate-manifest.ts cross-referencing checks

---

**Last Updated:** 2025-11-09
