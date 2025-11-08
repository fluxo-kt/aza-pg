# Hook-Based Extensions Testing Guide

Comprehensive guide for testing PostgreSQL extensions that load via hooks (`shared_preload_libraries` or `session_preload_libraries`) instead of the standard `CREATE EXTENSION` pattern.

## Overview

Hook-based extensions integrate directly into PostgreSQL's execution flow through hooks or GUC (Grand Unified Configuration) parameters. They don't provide `.control` files and cannot be installed via `CREATE EXTENSION`.

### Extension Categories

**Hook-Based Extensions (3):**

1. **pg_plan_filter** - Query plan filtering
   - **Type**: Hook-based (no .control file)
   - **Load method**: `shared_preload_libraries`
   - **Purpose**: Filters query plans based on configurable rules
   - **Manifest**: `"kind": "tool"`, `"sharedPreload": true`

2. **pg_safeupdate** - UPDATE/DELETE safety guard
   - **Type**: Hook-based (no .control file)
   - **Load method**: `session_preload_libraries`
   - **Purpose**: Prevents UPDATE/DELETE without WHERE clause
   - **Manifest**: `"kind": "tool"`, `"sharedPreload": false`

3. **supautils** - Superuser guards
   - **Type**: GUC-based (no CREATE EXTENSION)
   - **Load method**: `shared_preload_libraries` (optional)
   - **Purpose**: Event trigger hooks and managed roles for hosted Postgres
   - **Manifest**: `"kind": "tool"`, `"sharedPreload": true`

## Testing Strategy

### Test Coverage Matrix

| Extension      | Without Preload  | With Preload     | Functional Test     | Combined Load   |
| -------------- | ---------------- | ---------------- | ------------------- | --------------- |
| pg_plan_filter | ✅ No effect     | ✅ Hook active   | ✅ Query execution  | ✅ Multi-hook   |
| pg_safeupdate  | ✅ Unrestricted  | ✅ Blocks unsafe | ✅ WHERE validation | ✅ Session load |
| supautils      | ✅ No GUC params | ✅ GUC available | ✅ Basic operation  | ✅ Multi-hook   |

### Test Script

**Location:** `/opt/apps/art/infra/aza-pg/scripts/test/test-hook-extensions.sh`

**Usage:**

```bash
# Use default image tag (aza-pg:pg18)
./scripts/test/test-hook-extensions.sh

# Use custom image tag
./scripts/test/test-hook-extensions.sh my-registry/postgres:latest
```

**Test Cases:**

1. **pg_plan_filter without preload** - Verify .so exists, no CREATE EXTENSION support
2. **pg_plan_filter with preload** - Verify hook loads, queries execute successfully
3. **pg_safeupdate session preload** - Test UPDATE/DELETE blocking without WHERE clause
4. **supautils without preload** - Verify GUC parameters unavailable
5. **supautils with preload** - Verify GUC parameters available
6. **Combined preload** - Multiple hooks active simultaneously

## Key Testing Patterns

### Pattern 1: Verify .so File Exists

Hook extensions must have compiled shared libraries even if they lack .control files:

```bash
# Test that .so file exists
docker exec $container test -f /usr/lib/postgresql/18/lib/pg_plan_filter.so
```

**Why**: Confirms extension compiled successfully even without CREATE EXTENSION support.

### Pattern 2: Test Without Preload (Baseline)

Verify extension has no effect when not loaded:

```bash
# Without preload, UPDATE without WHERE should succeed
docker exec $container psql -U postgres -c "UPDATE test_table SET id = 1;"
```

**Why**: Establishes baseline behavior before hook activation.

### Pattern 3: Test With Preload (Hook Active)

Verify hook modifies behavior when loaded:

```bash
# With session preload, UPDATE without WHERE should FAIL
docker exec $container psql -U postgres -c \
  "SET session_preload_libraries = 'pg_safeupdate'; UPDATE test_table SET id = 1;"
```

**Why**: Confirms hook intercepts execution and modifies behavior.

### Pattern 4: Functional Validation

Test actual hook behavior, not just loading:

```bash
# pg_safeupdate blocks DELETE without WHERE
assert_sql_fails "DELETE FROM test_table;" "DELETE requires a WHERE clause"

# But allows DELETE with WHERE
assert_sql_success "DELETE FROM test_table WHERE id = 1;"
```

**Why**: Verifies hook implements expected functionality, not just loads without errors.

### Pattern 5: Isolation Testing

Test hooks independently and in combination:

```bash
# Test 1: pg_plan_filter alone
POSTGRES_SHARED_PRELOAD_LIBRARIES="pg_stat_statements,auto_explain,pg_cron,pgaudit,pg_plan_filter"

# Test 2: supautils alone
POSTGRES_SHARED_PRELOAD_LIBRARIES="pg_stat_statements,auto_explain,pg_cron,pgaudit,supautils"

# Test 3: Both together
POSTGRES_SHARED_PRELOAD_LIBRARIES="pg_stat_statements,auto_explain,pg_cron,pgaudit,pg_plan_filter,supautils"
```

**Why**: Ensures hooks don't interfere with each other and PostgreSQL remains stable.

## Common Pitfalls

### Pitfall 1: Expecting CREATE EXTENSION to Work

**Problem:**

```bash
# ❌ WRONG - Hook extensions don't have .control files
CREATE EXTENSION pg_plan_filter;
# ERROR: could not open extension control file
```

**Solution:**

```bash
# ✅ CORRECT - Load via shared_preload_libraries
POSTGRES_SHARED_PRELOAD_LIBRARIES="...,pg_plan_filter"
```

### Pitfall 2: Wrong Preload Scope

**Problem:**

```bash
# ❌ WRONG - pg_safeupdate requires session_preload_libraries
POSTGRES_SHARED_PRELOAD_LIBRARIES="...,pg_safeupdate"
```

**Solution:**

```bash
# ✅ CORRECT - Use session_preload_libraries
SET session_preload_libraries = 'pg_safeupdate';
```

### Pitfall 3: Not Testing Hook Behavior

**Problem:**

```bash
# ❌ WRONG - Only checks loading, not functionality
docker exec $container psql -U postgres -c "SHOW shared_preload_libraries;"
# ✅ Test passes but hook may not work
```

**Solution:**

```bash
# ✅ CORRECT - Test actual hook behavior
docker exec $container psql -U postgres -c \
  "SET session_preload_libraries = 'pg_safeupdate'; UPDATE test SET id = 1;"
# Should fail with "UPDATE requires a WHERE clause"
```

### Pitfall 4: Session State Not Preserved

**Problem:**

```bash
# ❌ WRONG - session_preload_libraries lost between commands
docker exec $container psql -c "SET session_preload_libraries = 'pg_safeupdate';"
docker exec $container psql -c "UPDATE test SET id = 1;"  # Hook not active
```

**Solution:**

```bash
# ✅ CORRECT - Single SQL block preserves session
docker exec $container psql -c "SET session_preload_libraries = 'pg_safeupdate'; UPDATE test SET id = 1;"
```

## Implementation Details

### Test Structure

```bash
test_extension_name() {
  local container=$1

  # 1. Verify .so file exists
  assert_so_exists "/usr/lib/postgresql/18/lib/extension.so"

  # 2. Test without preload (baseline)
  assert_baseline_behavior

  # 3. Test with preload (hook active)
  assert_hook_behavior

  # 4. Functional validation
  assert_specific_functionality

  # 5. Cleanup
  cleanup_test_data
}
```

### Assertion Functions

**assert_sql_success** - Command should succeed:

```bash
assert_sql_success "$container" "SELECT 1;" "Basic query works"
```

**assert_sql_fails** - Command should fail with expected error:

```bash
assert_sql_fails "$container" \
  "UPDATE test SET id = 1;" \
  "UPDATE requires a WHERE clause" \
  "pg_safeupdate blocks unsafe UPDATE"
```

**assert_sql_contains** - Output matches pattern:

```bash
assert_sql_contains "$container" \
  "SHOW shared_preload_libraries;" \
  "pg_plan_filter" \
  "pg_plan_filter loaded"
```

**assert_log_contains** - Container logs match pattern:

```bash
assert_log_contains "$logs" \
  "pg_plan_filter.*initialized" \
  "Extension initialized on startup"
```

## Integration with CI/CD

### GitHub Actions Workflow

```yaml
- name: Test Hook Extensions
  run: |
    ./scripts/test/test-hook-extensions.sh aza-pg:test
```

### Expected Output

```
========================================
Hook-Based Extensions Test Suite
========================================
Image tag: aza-pg:pg18

Test 1: pg_plan_filter without preload
=======================================
✅ pg_plan_filter NOT in default shared_preload_libraries (expected)
✅ pg_plan_filter.so exists at /usr/lib/postgresql/18/lib/pg_plan_filter.so
✅ pg_plan_filter correctly requires preload (no CREATE EXTENSION)

Test 2: pg_plan_filter with preload
====================================
✅ pg_plan_filter loaded via shared_preload_libraries
✅ PostgreSQL operational with pg_plan_filter preloaded
✅ Query execution successful with pg_plan_filter hook active
✅ Cleanup test table

Test 3: pg_safeupdate session preload
======================================
✅ pg_safeupdate.so exists at /usr/lib/postgresql/18/lib/pg_safeupdate.so
✅ Create test table for pg_safeupdate
✅ UPDATE without WHERE succeeds (pg_safeupdate not loaded)
✅ Reset test table
✅ pg_safeupdate blocks UPDATE without WHERE
✅ UPDATE with WHERE succeeds with pg_safeupdate loaded
✅ pg_safeupdate blocks DELETE without WHERE
✅ DELETE with WHERE succeeds with pg_safeupdate loaded
✅ Cleanup safeupdate test table

Test 4: supautils without preload
==================================
✅ supautils NOT in default shared_preload_libraries (expected)
✅ supautils.so exists at /usr/lib/postgresql/18/lib/supautils.so
✅ supautils GUC parameters not available without preload (expected)

Test 5: supautils with preload
===============================
✅ supautils loaded via shared_preload_libraries
✅ supautils GUC parameters available (supautils.reserved_roles: ...)
✅ PostgreSQL operational with supautils preloaded
✅ Basic queries work with supautils hooks active

Test 6: Combined preload (pg_plan_filter + supautils)
======================================================
Loaded shared libraries: pg_stat_statements,auto_explain,pg_cron,pgaudit,pg_plan_filter,supautils
✅ pg_plan_filter loaded
✅ supautils loaded
✅ pg_safeupdate works alongside other preloaded extensions
✅ PostgreSQL stable with multiple hook extensions loaded
✅ Cleanup combined test

========================================
✅ All hook extension tests passed!
✅ Total: 6 test cases
========================================

Summary:
  - pg_plan_filter: Hook-based, requires shared_preload_libraries
  - pg_safeupdate: Hook-based, uses session_preload_libraries
  - supautils: GUC-based, optional shared_preload_libraries
  - All extensions verified for loading, functionality, and isolation
```

## References

- **Test script:** `/opt/apps/art/infra/aza-pg/scripts/test/test-hook-extensions.sh`
- **Manifest:** `/opt/apps/art/infra/aza-pg/docker/postgres/extensions.manifest.json`
- **AGENTS.md:** "Hook-Based Extensions & Tools" section
- **Common library:** `/opt/apps/art/infra/aza-pg/scripts/lib/common.sh`

## Maintenance

### Adding New Hook Extensions

1. Update manifest: `docker/postgres/extensions.manifest.json`

   ```json
   {
     "name": "new_hook_ext",
     "kind": "tool",
     "runtime": {
       "sharedPreload": true,
       "defaultEnable": false
     }
   }
   ```

2. Add test case to `test-hook-extensions.sh`
3. Verify .so file location
4. Test without preload (baseline)
5. Test with preload (hook active)
6. Test functional behavior
7. Update this document

### Updating Tests

When hook extensions change:

1. **API changes:** Update functional tests to match new behavior
2. **GUC parameters:** Update parameter checks if new settings added
3. **Dependencies:** Update combined preload tests if hooks interact
4. **Load method:** Update preload scope (shared vs session) if changed

---

**Status:** Comprehensive hook extension testing implemented. All 3 hook-based extensions covered with 6 test cases validating loading, functionality, and isolation.
