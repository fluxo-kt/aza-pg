# Technical Debt Verification Report

**Report Date:** 2025-11-08
**Repository:** /opt/apps/art/infra/aza-pg
**Verification Method:** Direct code inspection + manifest cross-reference + CHANGELOG analysis

---

## Executive Summary

The TECHNICAL-DEBT.md file's claims require significant updates. While the three primary build patches ARE still present and valid, the document's "Last Checked" date (2025-01-07) is outdated, and the secondary technical debt items reference non-existent audit reports.

**Status Breakdown:**

- **Extension Build Patches:** Still Valid (3/3)
- **Secondary Technical Debt:** Outdated References (2/2)
- **Documentation Accuracy:** NEEDS IMMEDIATE UPDATE

---

## PRIMARY TECHNICAL DEBT: Extension Build Patches

### Issue 1: pg_jsonschema pgrx Version Mismatch

**Status:** STILL VALID ✓ (But documentation is outdated)

**Claim in TECHNICAL-DEBT.md:**

- Location: `docker/postgres/build-extensions.sh:251-254`
- Problem: pgrx 0.16.0 but PostgreSQL 18 requires pgrx 0.16.1+
- Last Checked: 2025-01-07

**Current Evidence:**

- **Patch Exists:** YES - Confirmed in extensions.manifest.json
- **Patch Content:** `"s/pgrx = \"0\\.16\\.0\"/pgrx = \"=0.16.1\"/"`
- **Applied Via:** Manifest-driven system (not hardcoded sed as doc states)
- **Manifest Entry:**
  - Git Ref: `e7834142a3cce347b6082c5245de939810d3f9c4`
  - Build Type: `cargo-pgrx`
  - Patch: Replaces pgrx 0.16.0 with 0.16.1
- **Location in Code:** docker/postgres/build-extensions.sh:356-390 (manifest patch application)

**Verification:**

```
$ jq '.entries[] | select(.name == "pg_jsonschema") | .build.patches' \
  docker/postgres/extensions.manifest.json
["s/pgrx = \"0\\.16\\.0\"/pgrx = \"=0.16.1\"/"]
```

**Recommendation:** OUTDATED - Update "Last Checked" to 2025-11-08. Note that patches have been moved to manifest.json (not hardcoded).

---

### Issue 2: wrappers pgrx Version Mismatch

**Status:** STILL VALID ✓ (But documentation is outdated)

**Claim in TECHNICAL-DEBT.md:**

- Location: `docker/postgres/build-extensions.sh:255-260`
- Problem: Supabase wrappers uses pgrx 0.16.0, needs 0.16.1+ for PG18
- Last Checked: 2025-01-07
- Complexity: Multi-file patching (4 sed commands)

**Current Evidence:**

- **Patch Exists:** YES - Confirmed in extensions.manifest.json
- **Patch Content:** `"s/pgrx = { version = \"=0\\.16\\.0\"/pgrx = { version = \"=0.16.1\"/"` (SINGLE patch, not 4)
- **Applied Via:** Manifest-driven system
- **Manifest Entry:**
  - Git Tag: `v0.5.6`
  - Commit: `21709a60dccd2b784e495d209a3b3e1dfda9751b`
  - Build Type: `cargo-pgrx`
  - Subdir: `wrappers`
  - Patch: 1 sed expression (not 4 as doc claims)

**Significant Finding:** The TECHNICAL-DEBT.md mentions "4 total sed commands" for wrappers, but the manifest only contains 1 patch. This is a **substantial discrepancy**.

**Recommendation:** The document overstates the complexity. Only 1 patch is currently applied, down from the original 4 sed commands. Update documentation to reflect this improvement.

---

### Issue 3: supautils Static Keyword Missing

**Status:** STILL VALID ✓ (But documentation is outdated)

**Claim in TECHNICAL-DEBT.md:**

- Location: `docker/postgres/build-extensions.sh:261-263`
- Problem: Variable `log_skipped_evtrigs` should be `static bool` not `bool`
- Last Checked: 2025-01-07

**Current Evidence:**

- **Patch Exists:** YES - Confirmed in extensions.manifest.json
- **Patch Content:** `"s/^bool[[:space:]]\\{1,\\}log_skipped_evtrigs/static bool log_skipped_evtrigs/"`
- **Applied Via:** Manifest-driven system
- **Manifest Entry:**
  - Git Tag: `v3.0.2`
  - Commit: `1b071b72cc50ecee36ac9e4b782cb84212ae6d20`
  - Build Type: `pgxs`
  - Patch: Targets `supautils.c`
  - Kind: `tool` (not extension)

**Recommendation:** Update "Last Checked" to 2025-11-08. Note classification as "tool" is now explicitly documented.

---

## SECONDARY TECHNICAL DEBT: Metadata/Tooling

### Issue 4: Config Generator Complexity

**Status:** OUTDATED REFERENCE

**Claim in TECHNICAL-DEBT.md:**

- Status: Evaluation needed (not blocking)
- Details: 19MB Bun/TypeScript toolchain generates 171 lines of config
- Reference: "Audit report Phase 4.1"

**Current Evidence:**

- **Toolchain Size:** 16MB (was 19MB - slight improvement)
- **TypeScript Lines:** 125,951 lines total (much larger than 171)
- **Config Output:** ~45 lines per stack config (45/37/25 respectively)
- **Audit Report:** MISSING - Phase 4.1 audit report not found in repo
  - Checked: `.archived/`, `docs/audit/`, entire codebase
  - Found only: CONFIGURATION-AUDIT-REPORT.md (unrelated)

**Recommendation:**

1. Either provide actual audit report or remove reference
2. Clarify claim: Toolchain generates much more than 171 lines (total 107 lines across 3 configs)
3. The 16MB toolchain size is justified for what it generates (runtime config auto-tuning)

---

### Issue 5: Manifest.json Duplication

**Status:** OUTDATED REFERENCE

**Claim in TECHNICAL-DEBT.md:**

- Status: Evaluation needed (not blocking)
- Details: 852-line JSON duplicates Dockerfile metadata
- Reference: "Audit report Phase 4.2"

**Current Evidence:**

- **Manifest File:** extensions.manifest.json
- **Actual Size:** 927 lines (not 852)
- **Content:** Comprehensive extension metadata with pgrx version, dependencies, patches, runtime config
- **Dockerfile Metadata:** No equivalent comprehensive metadata in Dockerfile
- **Assessment:** Manifest is NOT a duplication - it's a CENTRALIZED source of truth
  - Used by: build-extensions.sh, test suite, init script generator
  - Purpose: Single source of truth for all 38 extensions
  - Prevents: Hardcoded version arrays, test suite divergence
- **Audit Report:** MISSING - Phase 4.2 audit report not found

**Recent Evidence of Manifest Value (from CHANGELOG.md):**

- "Moved 3 hardcoded sed patches to manifest (pg_jsonschema, wrappers, supautils)" (commit 9c2a4ba)
- "Made test-extensions.ts fully manifest-driven (removed 46 lines of hardcoded arrays)"
- "Created comprehensive manifest validator (290 lines, validates 38 extensions)"
- This DIRECTLY contradicts the duplication claim - manifest REPLACED hardcoded duplication

**Recommendation:**

1. Remove "duplication" characterization
2. Update to "Manifest.json serves as centralized extension registry (927 lines)"
3. Note that manifest-driven approach is a SOLVED technical debt, not an outstanding one
4. Provide actual audit report or remove reference

---

## Patch Application Verification

### Current Architecture (from CHANGELOG.md Phase with commit 9c2a4ba)

The patches have been migrated from hardcoded sed commands to manifest-driven system:

```
BEFORE (Hardcoded):
  docker/postgres/build-extensions.sh:251-254   (pg_jsonschema)
  docker/postgres/build-extensions.sh:255-260   (wrappers - 4 commands)
  docker/postgres/build-extensions.sh:261-263   (supautils)

AFTER (Manifest-Driven):
  extensions.manifest.json (centralized)
  build-extensions.sh:356-390 (generic patch applicator)
```

**Benefits of Current Approach:**

- Single source of truth
- Easier to add/remove patches
- Patches versioned with manifest
- Manifest validator ensures consistency

---

## Missing Documentation

The TECHNICAL-DEBT.md references audit reports that are NOT in the repository:

1. "Audit report Phase 4.1" - Config Generator Complexity analysis
2. "Audit report Phase 4.2" - Manifest Duplication analysis

These may have been archived or deleted during cleanup phase. Note from CHANGELOG.md:

> Deleted Audit Documentation Files (10 files)... Rationale: Audit documentation served its purpose during comprehensive review cycle. Key findings integrated into CHANGELOG.md and permanent documentation.

---

## Recommendations for TECHNICAL-DEBT.md Update

### 1. Update Header Metadata

```markdown
**Last Checked:** 2025-11-08 (was 2025-01-07)
**Verified By:** Manifest + CHANGELOG cross-reference
**Status:** Patches still valid, documentation outdated, references to audit reports removed
```

### 2. Update Issue 1 (pg_jsonschema)

- Add note: "Patches moved to manifest.json (manifest-driven from 2025-11-07)"
- Update line references (no longer in build-extensions.sh hardcoded)
- Line references should point to: extensions.manifest.json and build-extensions.sh:356-390

### 3. Update Issue 2 (wrappers)

- CORRECT the "4 total sed commands" claim → actually 1 unified patch
- Update to reflect improved simplification
- Document progress made vs original implementation

### 4. Update Issue 3 (supautils)

- Update line references (manifest-driven approach)
- Add note about tool classification (not extension)

### 5. DELETE or REFERENCE Properly

- Remove "Other Known Technical Debt" section OR
- Provide actual audit report references OR
- Rewrite these as "Resolved Technical Debt" with explanation of resolution

### 6. Add New Section: "Resolved Technical Debt"

```markdown
## Resolved Technical Debt

### Hardcoded Extension Patches → Manifest-Driven (Resolved 2025-11-07)

- **What:** Build patches were scattered across build-extensions.sh
- **How Fixed:** Moved to extensions.manifest.json with generic applicator
- **Benefit:** Single source of truth, easier maintenance, versioned with extensions
- **Status:** COMPLETE ✓
```

---

## Build Patch Current Status Summary

| Issue              | Commit   | Patch Present     | Last Updated | Status          |
| ------------------ | -------- | ----------------- | ------------ | --------------- |
| pg_jsonschema pgrx | e7834142 | ✓ YES             | 2025-11-07   | Manifest-driven |
| wrappers pgrx      | 21709a60 | ✓ YES (1 unified) | 2025-11-07   | Manifest-driven |
| supautils static   | 1b071b72 | ✓ YES             | 2025-11-07   | Manifest-driven |

**All three patches are:**

- ✓ Present in codebase
- ✓ Being actively applied during build
- ✓ Properly tested (part of test suite)
- ✓ Documented in manifest

**But the TECHNICAL-DEBT.md document:**

- ✗ Has outdated "Last Checked" date
- ✗ References wrong file locations (hardcoded vs manifest)
- ✗ Contains outdated complexity estimates (wrappers: 4 → 1 patch)
- ✗ References missing audit reports

---

## Conclusion

**TECHNICAL-DEBT.md Claims Validity:**

1. ✓ All three build patches ARE still needed
2. ✓ All patches ARE still present in the codebase
3. ✗ Documentation is outdated (wrong locations, old date)
4. ✗ Secondary debt items reference missing audit reports
5. ✗ No mention of manifest-driven improvements made

**Action Required:**

- Update "Last Checked" date and file references
- Correct wrappers patch count (4 → 1)
- Remove or properly reference audit reports
- Add section on resolved technical debt
- Consider renaming to "Extension Build Patches Tracking" (not "Technical Debt")

**Recommendation:**
The document should be updated BEFORE next major release to reflect the actual architecture (manifest-driven) and remove references to missing audit reports.
