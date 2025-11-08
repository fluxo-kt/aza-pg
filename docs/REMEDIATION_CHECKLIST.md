# REMEDIATION CHECKLIST
Specific fixes needed for audit discrepancies

## CRITICAL FIXES (Must do before production use)

### Fix 1: Healthcheck start_period (Issue #46)
**Affected Files:** 3 files
- `stacks/primary/compose.yml`
- `stacks/replica/compose.yml`
- `stacks/single/compose.yml`

**Change Required:**
```yaml
# Find this in postgres section:
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U ${POSTGRES_USER:-postgres}']
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 60s          # ← CHANGE THIS

# Change to:
      start_period: 120s         # ← CHANGED
```

**Justification:** Commit 8ee2f84 claims this was fixed to support large database startup delays.

---

### Fix 2: PgBouncer healthcheck timeout (Issue #47)
**Affected Files:** 3 files
- `stacks/primary/compose.yml`
- `stacks/replica/compose.yml`
- `stacks/single/compose.yml`

**Change Required:**
```yaml
# Find pgbouncer section healthcheck:
  pgbouncer:
    healthcheck:
      test:
        [
          'CMD-SHELL',
          'PGPASSWORD="${PGBOUNCER_AUTH_PASS}" psql -U pgbouncer_auth -d postgres -h localhost -p 6432 -c "SELECT 1" || exit 1',
        ]
      interval: 30s
      timeout: 5s                # ← CHANGE THIS
      retries: 3

# Change to:
      timeout: 10s               # ← CHANGED
```

**Justification:** Commit 8ee2f84 claims this was fixed to account for SCRAM-SHA-256 overhead.

---

### Fix 3: Remove !override documentation (Issue #51)

**File 1:** `README.md`
```markdown
# Line 17 - REMOVE ENTIRELY OR CHANGE TO:

# Old:
- Docker Engine 24+ with Docker Compose v2.24.4+ (required for `!override` tag support)

# New:
- Docker Engine 24+ with Docker Compose v2.x+
```

**File 2:** `AGENTS.md`
```markdown
# Line 151 - REMOVE THE ENTIRE SENTENCE ABOUT !override:

# Old:
**Pattern:** `compose.yml` (prod: private IPs, limits) + `compose.dev.yml` (dev: localhost, test memory). Use `!override` tag to replace arrays (ports) vs merge. Base compose now relies on `mem_limit`/`mem_reservation` so Docker applies cgroup limits; keep those values aligned with auto-config expectations.

# New:
**Pattern:** `compose.yml` (prod: private IPs, limits) + `compose.dev.yml` (dev: localhost, test memory). Standard Docker Compose merge behavior applies (dev values override base). Base compose now relies on `mem_limit`/`mem_reservation` so Docker applies cgroup limits; keep those values aligned with auto-config expectations.
```

---

## HIGH PRIORITY FIXES

### Fix 4: Update healthcheck documentation (conditional on Fix 1)

If you implement Fix 1 (120s/10s), no documentation changes needed.

If you keep 60s/5s, search for and update these references:

**Files to search:**
- `AGENTS.md` - Search for "60s→120s" or "Increase PostgreSQL healthcheck"
- `README.md` - Search for healthcheck timeout mentions
- `docs/PRODUCTION.md` - If it mentions healthcheck values

---

## MEDIUM PRIORITY FIXES

### Fix 5: Move chmod 777 test code (Issue #2)

**Current Location:** `scripts/test/test-pgbouncer-failures.sh` line 461-465

**Option A: Move to separate test-only file**
```bash
# Create new file: scripts/test/security-tests/test-pgpass-insecure-rejection.sh
# Move the chmod 777 block and surrounding test logic there
# Update scripts/test/test-pgbouncer-failures.sh to call it or skip it
```

**Option B: Replace with safer test**
Replace chmod 777 with a test that:
- Creates a file with wrong permissions intentionally
- Verifies PostgreSQL rejects it
- Uses isolated test container
- Doesn't modify existing files

---

### Fix 6: Update AUDIT_CHECKLIST_2025-11-08.md (Informational)

These status corrections document the verification findings:

| Issue | Old Status | New Status | Reason |
|-------|-----------|-----------|--------|
| #3 | ❌ NOT FIXED | ✅ FIXED | Phase 3 added verification |
| #13 | ⚠️ PARTIAL | ✅ FIXED | All patterns now present |
| #46 | ✅ FIXED | ❌ NOT FIXED | Code doesn't match claim |
| #47 | ✅ FIXED | ❌ NOT FIXED | Code doesn't match claim |
| #51 | ✅ FIXED | ⚠️ PARTIAL | Code OK, docs wrong |

---

## VERIFICATION CHECKLIST

After making changes, verify:

- [ ] All 3 compose files have start_period: 120s
- [ ] All 3 compose files have timeout: 10s for pgbouncer
- [ ] README.md doesn't mention !override requirement
- [ ] AGENTS.md doesn't mention !override usage
- [ ] Documentation healthcheck values match code
- [ ] `docker compose config` outputs correct values
- [ ] Local stack spins up without timeout errors
- [ ] Large database test case still completes within 120s

---

## COMMIT MESSAGE TEMPLATE

```
fix(config): Correct healthcheck timeouts and documentation

SECURITY:
- Match commit 8ee2f84 intent: increase healthcheck timeouts
  * PostgreSQL start_period: 60s → 120s (support large database startup)
  * PgBouncer timeout: 5s → 10s (SCRAM-SHA-256 overhead)

DOCUMENTATION:
- Remove incorrect !override tag requirements
  * Update README.md to remove Docker Compose v2.24.4+ requirement
  * Update AGENTS.md to document actual merge behavior
  
- Clarify healthcheck timeouts in documentation

FIXES:
- Address audit verification discrepancies (Issue #46, #47, #51)
- Reconcile commit message claims with actual code
```

---

## TESTING COMMANDS

After changes, run these to verify:

```bash
# Validate YAML syntax
docker compose -f stacks/primary/compose.yml config > /dev/null && echo "✓ primary"
docker compose -f stacks/replica/compose.yml config > /dev/null && echo "✓ replica"
docker compose -f stacks/single/compose.yml config > /dev/null && echo "✓ single"

# Verify timeout values are present
grep "start_period: 120s" stacks/*/compose.yml
grep -A 20 "pgbouncer:" stacks/primary/compose.yml | grep "timeout: 10s"

# Check documentation
! grep -n "!override" README.md AGENTS.md
```

