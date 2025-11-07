# Technical Debt Tracking

This document tracks known technical debt, temporary workarounds, and upstream dependencies that require monitoring.

## Extension Build Patches (HIGH PRIORITY)

### Issue 1: pg_jsonschema pgrx Version Mismatch
**Location:** `docker/postgres/build-extensions.sh:251-254`

**Problem:** pg_jsonschema uses pgrx 0.16.0 but PostgreSQL 18 requires pgrx 0.16.1+

**Current Workaround:** Sed-based Cargo.toml patching during build:
```bash
sed -i 's/pgrx = "0\.16\.0"/pgrx = "=0.16.1"/' "$dest/Cargo.toml"
sed -i 's/pgrx-tests = "0\.16\.0"/pgrx-tests = "=0.16.1"/' "$dest/Cargo.toml"
```

**Impact:** Fragile build process, patches may break with upstream changes

**Resolution Path:**
1. Monitor https://github.com/supabase/pg_jsonschema for pgrx 0.16.1+ update
2. Test build without patch after upstream update
3. Remove sed commands from build script
4. Update manifest.json commit SHA to patched version

**Last Checked:** 2025-01-07

---

### Issue 2: wrappers pgrx Version Mismatch
**Location:** `docker/postgres/build-extensions.sh:255-260`

**Problem:** Supabase wrappers uses pgrx 0.16.0, needs 0.16.1+ for PG18

**Current Workaround:** Sed-based patching across 2 Cargo.toml files:
```bash
sed -i 's/pgrx = { version = "=0\.16\.0"/pgrx = { version = "=0.16.1"/' \
  "$dest/supabase-wrappers/Cargo.toml"
# ... (4 total sed commands)
```

**Impact:** Complex multi-file patching, high maintenance burden

**Resolution Path:**
1. Monitor https://github.com/supabase/wrappers for pgrx 0.16.1+ update
2. Verify both supabase-wrappers/ and wrappers/ Cargo.toml updated
3. Test build without patches
4. Remove all 4 sed commands
5. Update manifest.json commit SHA

**Last Checked:** 2025-01-07

---

### Issue 3: supautils Static Keyword Missing
**Location:** `docker/postgres/build-extensions.sh:261-263`

**Problem:** Variable `log_skipped_evtrigs` should be `static bool` not `bool`

**Current Workaround:** Sed-based source code patching:
```bash
sed -i 's/^bool[[:space:]]\{1,\}log_skipped_evtrigs/static bool log_skipped_evtrigs/' \
  "$dest/src/supautils.c"
```

**Impact:** Modifies C source at build time, non-standard approach

**Resolution Path:**
1. Monitor https://github.com/supabase/supautils for static keyword fix
2. Alternative: Submit upstream PR with fix
3. Test build without patch after merge
4. Remove sed command
5. Update manifest.json commit SHA

**Last Checked:** 2025-01-07

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
**Status:** Evaluation needed (not blocking)
**Details:** 19MB Bun/TypeScript toolchain generates 171 lines of config
**See:** Audit report Phase 4.1

### Manifest.json Duplication
**Status:** Evaluation needed (not blocking)
**Details:** 852-line JSON duplicates Dockerfile metadata
**See:** Audit report Phase 4.2

---

**Last Updated:** 2025-01-07
