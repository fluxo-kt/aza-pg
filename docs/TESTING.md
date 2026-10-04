# Testing Guide

Comprehensive guide for testing PostgreSQL extensions in aza-pg, covering critical patterns, common pitfalls, functional testing strategies, and coverage metrics.

## Table of Contents

1. [Smoke Test Pattern (Critical - Read This First!)](#smoke-test-pattern-critical-read-this-first)
2. [Regression Testing](#regression-testing)
3. [Regression Test Suites](#regression-test-suites)
   - [Extension Regression Tests (Tier 2)](#extension-regression-tests-tier-2)
   - [Expected Output Generation Status](#expected-output-generation-status)
   - [pgTAP](#pgtap)
4. [Session Isolation Pattern](#session-isolation-pattern)
5. [Testing Extension Functionality](#testing-extension-functionality)
6. [Common Pitfalls](#common-pitfalls)
7. [Test Categories](#test-categories)
8. [Testing Strategy & Coverage](#testing-strategy-coverage)
9. [Running Tests](#running-tests)

## Smoke Test Pattern (Critical - Read This First!)

**Why this matters**: Tests that skip environment validation waste hours debugging infrastructure issues instead of finding real bugs.

### The Problem

When writing tests for extensions or new features, it's tempting to immediately write comprehensive test cases. However, **tests can fail for two completely different reasons**:

1. **Infrastructure failure**: Container won't start, extension not preloaded, missing dependencies
2. **Functional failure**: The feature you're testing has a bug

**Without smoke tests, you can't tell which is which.**

### Real-World Example

From recent work on extension update tests:

**Original approach** (failed):

- Wrote 56 tests across 4 files in parallel
- 28/56 tests (50%) failed due to infrastructure issues:
  - Missing `POSTGRES_PASSWORD` → container exit
  - Missing `waitForReady()` → "connection refused" errors
  - pg_cron not preloaded → container crash during init

**Time wasted**: 2+ hours debugging infrastructure, not testing extensions.

**Correct approach** (would have succeeded):

- Write ONE smoke test first
- Run it → discover `POSTGRES_PASSWORD` missing
- Fix → discover `waitForReady()` missing
- Fix → discover pg_cron issue
- **Total time**: 15 minutes, then write comprehensive tests with confidence

### The Smoke Test Pattern

Every test file MUST start with this structure:

```typescript
describe("Feature X Tests", () => {
  let container: string;

  // PHASE 0: Environment Validation (MANDATORY)
  beforeAll(async () => {
    // Validate prerequisites BEFORE starting container
    // Example: Check image exists, required files present, etc.
  });

  // PHASE 1: Smoke Test (MANDATORY - RUN THIS FIRST)
  test("SMOKE: Container starts and PostgreSQL is ready", async () => {
    const start = Date.now();

    container = await harness.startContainer("feature-x-test", {
      POSTGRES_PASSWORD: "test", // ALWAYS required
      // Add other required env vars
    });

    await harness.waitForReady(container); // ALWAYS required

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(120000); // 120s reasonable limit

    console.log(`✓ Smoke test passed (${elapsed}ms)`);
  });

  // PHASE 2: Extension/Feature Loading (if applicable)
  test("Extension loads successfully", async () => {
    await harness.runSQL(container, "CREATE EXTENSION IF NOT EXISTS my_ext;");

    const version = await harness.runSQL(
      container,
      "SELECT extversion FROM pg_extension WHERE extname = 'my_ext';"
    );

    expect(version).toBeTruthy();
  });

  // PHASE 3: Basic Functionality
  test("Basic feature works", async () => {
    // Test simplest use case
  });

  // PHASE 4: Edge Cases (only after Phases 1-3 pass)
  test("Edge case 1", async () => {
    /* ... */
  });
  test("Edge case 2", async () => {
    /* ... */
  });
});
```

### Required Elements Checklist

Before writing ANY functional tests, your test file MUST include:

- [ ] `POSTGRES_PASSWORD` in startContainer() environment
- [ ] `await harness.waitForReady(container)` after startContainer()
- [ ] Smoke test that verifies container starts (Phase 1)
- [ ] Extension load test if testing an extension (Phase 2)
- [ ] At least ONE basic functionality test before edge cases (Phase 3)

### Common Pitfalls (Learn from These Mistakes)

| Pitfall                               | Symptom                                                            | Fix                                                                              |
| ------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| **No POSTGRES_PASSWORD**              | Container exits immediately: "superuser password not specified"    | Add `POSTGRES_PASSWORD: "test"` to env                                           |
| **No waitForReady()**                 | "connection refused" or "No such file or directory" for socket     | Add `await harness.waitForReady(container)`                                      |
| **Override preload without defaults** | Extensions fail to load: "must be in shared_preload_libraries"     | Don't set `POSTGRES_SHARED_PRELOAD_LIBRARIES` unless you understand implications |
| **No smoke test**                     | Spend hours debugging 50 test failures that are all infrastructure | Write smoke test FIRST                                                           |
| **Parallel test creation**            | Multiple test files fail for same infrastructure reason            | Write ONE test file, validate, THEN parallelize                                  |
| **Timeout cargo-culting**             | Increase timeout without understanding why it failed               | Add logging, measure actual time, understand root cause                          |

### Anti-Patterns to Avoid

❌ **Writing all tests first, running later**

```typescript
// DON'T DO THIS
test("feature A", ...);
test("feature B", ...);
test("feature C", ...);
// Run all at once → 3 failures, can't tell if infrastructure or logic
```

✅ **Write → Run → Pass → Next**

```typescript
test("SMOKE: container starts", ...);  // Write & run
// ✓ Passes → confident infrastructure works

test("feature A", ...);  // Write & run
// ✓ Passes → add next test

test("feature B", ...);  // Write & run
```

❌ **Assuming environment state**

```typescript
// DON'T DO THIS
test("extension works", async () => {
  // Assumes container started, PostgreSQL ready, extension loaded
  await runSQL("SELECT my_extension_function()");
});
```

✅ **Explicit validation**

```typescript
test("extension works", async () => {
  // Explicitly verify prerequisites
  expect(container).toBeDefined();

  const loaded = await runSQL(
    "SELECT 1 FROM pg_extension WHERE extname = 'my_ext'"
  );
  expect(loaded).toBe("1");

  // NOW test the function
  await runSQL("SELECT my_extension_function()");
});
```

### Progressive Complexity Model

Tests should progress through complexity levels:

```text
Level 0: Environment validated (prerequisites exist)
         ↓
Level 1: Container starts and PostgreSQL ready (smoke test)
         ↓
Level 2: Extension/feature loads (if applicable)
         ↓
Level 3: Basic happy-path functionality works
         ↓
Level 4: Edge cases, error conditions, performance
```

**Never skip to Level 4 before validating Levels 0-3.**

### When to Stop and Investigate

If you see these patterns, **STOP writing tests and investigate**:

- Container takes >60s to start → Why? Add logging, measure phases
- Multiple unrelated tests fail with same error → Infrastructure issue, not test logic
- Error messages mention sockets, files, or "not running" → PostgreSQL not ready
- Tests pass individually but fail in suite → Cleanup/isolation issue

### Template for New Test Files

Save this as a template when creating new test files:

```typescript
#!/usr/bin/env bun
/**
 * [Feature Name] Test Suite
 *
 * Tests [brief description of what this tests]
 *
 * Prerequisites:
 * - [List any image requirements]
 * - [List any preload requirements]
 */

import { TestHarness } from "./harness";

const harness = new TestHarness();
let container: string;

// MANDATORY: Smoke test FIRST
describe("Smoke Tests", () => {
  test("Container starts successfully", async () => {
    const start = Date.now();

    container = await harness.startContainer("my-test", {
      POSTGRES_PASSWORD: "test",
    });

    await harness.waitForReady(container);

    const elapsed = Date.now() - start;
    console.log(`✓ Container ready in ${elapsed}ms`);
    expect(elapsed).toBeLessThan(120000);
  });
});

// Feature tests (only after smoke test passes)
describe("[Feature Name] Functional Tests", () => {
  // Your tests here
});

// Cleanup
afterAll(async () => {
  await harness.cleanupAll();
});
```

### Key Takeaway

**Structure tests to make infrastructure failures impossible by design:**

1. Explicit environment validation
2. Smoke test that proves infrastructure works
3. Progressive complexity (simple → complex)
4. Clear error messages when assumptions violated

This pattern adds 2 minutes to test writing but saves hours of debugging.

---

## Regression Testing

**→ See [REGRESSION-TESTING.md](./REGRESSION-TESTING.md) for comprehensive regression testing documentation.**

Quick reference:

```bash
bun scripts/test/run-all-regression-tests.ts          # All tiers
bun scripts/test/run-all-regression-tests.ts --tier=2   # Tier 2: Extension tests
bun scripts/test/run-all-regression-tests.ts --mode=regression  # Regression mode (all extensions)
```

---

## Regression Test Suites

PostgreSQL's own regression suite is not run: the image copies PGDG's server binary unchanged, so no image defect could fail it.

### Extension Regression Tests (Tier 2)

Deterministic regression tests for PostgreSQL extensions using SQL + expected output comparison (pg_regress pattern).

**Structure:**

```
tests/regression/extensions/
├── {extension-name}/
│   ├── sql/
│   │   └── basic.sql      # SQL test commands
│   └── expected/
│       └── basic.out      # Expected psql output
└── README.md
```

**Test Coverage:**

**Production Mode (Top 10 Extensions):**

1. **vector** (pgvector) - Vector similarity search, distance operators
2. **timescaledb** - Hypertable creation, time-series data
3. **pg_cron** - Job scheduling infrastructure
4. **pgsodium** - Cryptographic functions, encryption
5. **pgaudit** - Security auditing configuration
6. **pg_stat_monitor** - Enhanced query metrics
7. **hypopg** - Hypothetical index creation
8. **pg_trgm** - Trigram similarity, fuzzy search
9. **pgmq** - Message queue operations
10. **timescaledb_toolkit** - Time-series hyperfunctions

**Comprehensive Mode (Additional 3 Extensions):**

11. **postgis** - Spatial data types and operations
12. **pgrouting** - Graph routing algorithms (Dijkstra)
13. **pgq** - High-performance queue operations

**Generating Expected Outputs:**

Expected output files must be generated from a known-good build:

```bash
# Build production image
bun run build

# Generate expected outputs for production extensions
bun scripts/test/test-extension-regression.ts --mode=production --generate-expected

# Generate expected outputs for comprehensive extensions (requires comprehensive build)
bun scripts/test/test-extension-regression.ts --mode=comprehensive --generate-expected
```

**IMPORTANT**: Expected outputs are deterministic and should be committed to the repository. They serve as the regression baseline for future test runs.

**Running Tests:**

**Production Mode:**

```bash
# Test top 10 production extensions
bun scripts/test/test-extension-regression.ts --mode=production
```

**Comprehensive Mode:**

```bash
# Test all extensions (requires comprehensive build with postgis, pgrouting, pgq enabled)
bun scripts/test/test-extension-regression.ts --mode=comprehensive
```

**Specific Extensions:**

```bash
# Test specific extensions only
bun scripts/test/test-extension-regression.ts --extensions=vector,timescaledb,pg_cron
```

**Using Existing Container:**

```bash
# Use existing running container
bun scripts/test/test-extension-regression.ts --container=my-postgres-container
```

**Test Design Principles:**

1. **Simplicity**: Each test is < 50 lines of SQL, focuses on core functionality
2. **Determinism**: No random values, timestamps use fixed dates, outputs are predictable
3. **Self-contained**: Tests create and clean up their own data
4. **Basic coverage**: Tests verify extension works, not comprehensive feature coverage

**Adding New Extension Tests:**

1. Create directory: `tests/regression/extensions/{extension-name}/{sql,expected}/`
2. Write SQL test: `sql/basic.sql` (see existing tests as templates)
3. Generate expected output: `--generate-expected` flag
4. Add extension to `TOP_10_EXTENSIONS` or `COMPREHENSIVE_ONLY_EXTENSIONS` in `test-extension-regression.ts`
5. Commit SQL + expected output files

**Test Execution Details:**

- Uses `psql -X -a -q` for consistent output format
- Output normalization handles psql formatting variations
- Diff generation uses `diff -c` (context diff) for readability
- Failed tests generate `extension-regression.diffs` file

**Related Documentation:**

- **Extension behaviour**: `scripts/docker/test-image-lib.ts`, run by `scripts/docker/test-image.ts`
- **Regression Runner**: `scripts/test/lib/regression-runner.ts` - Shared test infrastructure

### Expected Output Generation Status

This tracks which extension regression tests have generated expected outputs.

**Generation Instructions:**

Expected output files (`.out`) must be generated from a clean, known-good build:

```bash
# 1. Build production image
bun run build

# 2. Generate expected outputs for production mode
bun scripts/test/test-extension-regression.ts --mode=production --generate-expected

# 3. For comprehensive mode (requires PostGIS/pgRouting/PgQ enabled)
# Edit scripts/extensions/manifest-data.ts to enable postgis, pgrouting, pgq
# bun run generate && bun run build
# bun scripts/test/test-extension-regression.ts --mode=comprehensive --generate-expected
```

**Status:**

**Production Extensions (Top 10):**

- [ ] **vector** - `expected/basic.out` - NEEDS GENERATION
- [ ] **timescaledb** - `expected/basic.out` - NEEDS GENERATION
- [ ] **pg_cron** - `expected/basic.out` - NEEDS GENERATION
- [ ] **pgsodium** - `expected/basic.out` - NEEDS GENERATION
- [ ] **pgaudit** - `expected/basic.out` - NEEDS GENERATION
- [ ] **pg_stat_monitor** - `expected/basic.out` - NEEDS GENERATION
- [ ] **hypopg** - `expected/basic.out` - NEEDS GENERATION
- [ ] **pg_trgm** - `expected/basic.out` - NEEDS GENERATION
- [ ] **pgmq** - `expected/basic.out` - NEEDS GENERATION
- [ ] **timescaledb_toolkit** - `expected/basic.out` - NEEDS GENERATION

**Comprehensive-Only Extensions:**

- [ ] **postgis** - `expected/basic.out` - NEEDS GENERATION (requires comprehensive build)
- [ ] **pgrouting** - `expected/basic.out` - NEEDS GENERATION (requires comprehensive build)
- [ ] **pgq** - `expected/basic.out` - NEEDS GENERATION (requires comprehensive build)
- [x] **wrappers** - `expected/basic.out` - GENERATED (6 assertions)

**Notes:**

- Expected outputs are deterministic and should remain stable across builds
- Non-deterministic values (random(), now()) avoided in tests
- All SQL test files (`sql/basic.sql`) are ready and committed
- Expected outputs will be generated during next production build validation

### pgTAP

The regression image (`regression.Dockerfile`) installs pgTAP for ad-hoc SQL tests; the repository ships no pgTAP test files.

## Session Isolation Pattern

### Critical Concept

PostgreSQL session-local state (LOAD, SET, hypothetical indexes) does **not persist** across separate SQL invocations. Each `runSQL()` call creates a new `psql` session.

### The Problem

```typescript
// ❌ WRONG - Session state lost between calls
await runSQL("LOAD 'auto_explain'");
await runSQL("SET auto_explain.log_min_duration = 0");
await runSQL("SELECT count(*) FROM test_table"); // auto_explain NOT active
```

Each `runSQL()` creates a new session. The `LOAD` and `SET` commands execute in one session, then that session closes. The final SELECT runs in a completely different session where auto_explain was never loaded.

### The Solution

```typescript
// ✅ CORRECT - Single session preserves state
await runSQL(`
  LOAD 'auto_explain';
  SET auto_explain.log_min_duration = 0;
  SELECT count(*) FROM test_table;  -- auto_explain IS active
`);
```

Use multi-statement SQL blocks within a single `runSQL()` call. All commands execute in the same session, preserving state throughout.

### Real-World Examples

#### Example 1: auto_explain Plan Logging

```typescript
await test("auto_explain - Verify plan logging", "observability", async () => {
  // Execute query in same session where auto_explain is loaded
  const result = await runSQL(`
    LOAD 'auto_explain';
    SET auto_explain.log_min_duration = 0;
    SELECT count(*) FROM test_vectors;
  `);
  assert(result.success, "Query execution with auto_explain failed");
});
```

**Why**: `LOAD 'auto_explain'` and `SET` commands must be in same session as the SELECT query they affect.

#### Example 2: HypoPG Hypothetical Indexes

```typescript
await test(
  "hypopg - Create and verify hypothetical index",
  "performance",
  async () => {
    // Create and verify in same session (hypothetical indexes are session-local)
    const result = await runSQL(`
    SELECT * FROM hypopg_create_index('CREATE INDEX ON test_hypopg (val)');
    SELECT count(*) FROM hypopg_list_indexes;
  `);
    const lines = result.stdout.split("\n").filter((l) => l.trim());
    const count = parseInt(lines[lines.length - 1]);
    assert(result.success && count > 0, "Failed to create hypothetical index");
  }
);

await test(
  "hypopg - Verify planner uses hypothetical index",
  "performance",
  async () => {
    const result = await runSQL(`
    SELECT * FROM hypopg_create_index('CREATE INDEX ON test_hypopg (val)');
    EXPLAIN SELECT * FROM test_hypopg WHERE val = 500;
  `);
    assert(result.success, "EXPLAIN query failed with hypothetical index");
  }
);
```

**Why**: HypoPG indexes exist **only in the current session**. Creating an index in one `runSQL()` call means it's gone by the next call.

**Pattern**: Each test creates its own hypothetical index within the same session where it's used, since indexes don't persist.

#### Example 3: Session vs Persistent State

```typescript
// ✅ Persistent state - can split across calls
await runSQL("CREATE TABLE test_table (id int)");
await runSQL("INSERT INTO test_table VALUES (1)");
await runSQL("SELECT * FROM test_table"); // Table persists

// ❌ Session-local state - MUST be in one call
await runSQL(`
  CREATE TEMP TABLE session_table (id int);
  INSERT INTO session_table VALUES (1);
  SELECT * FROM session_table;  -- Must query in same session
`);
```

**Rule**: If it's session-local (TEMP tables, LOAD, SET, HypoPG), keep it in one `runSQL()` block.

## Testing Extension Functionality

### Test Structure

```typescript
await test("extension_name - What it tests", "category", async () => {
  // 1. Setup (if needed)
  await runSQL("CREATE TABLE IF NOT EXISTS test_data (...)");

  // 2. Execute functionality
  const result = await runSQL("SELECT extension_function(...)");

  // 3. Assert results
  assert(result.success, "Operation failed");
  assert(condition, "Expected behavior not met");
});
```

### Categories

- **core**: Basic CREATE EXTENSION and infrastructure
- **vector**: Vector search and similarity (pgvector, vectorscale)
- **fulltext**: Text search (pg_trgm, pgroonga)
- **spatial**: Geographic data (postgis, pgrouting)
- **timeseries**: Time-series data (timescaledb, timescaledb_toolkit)
- **observability**: Monitoring and logging (pg_stat_monitor, auto_explain)
- **security**: Encryption and audit (pgsodium, pgaudit, set_user)
- **performance**: Query optimization (pg_stat_statements, hypopg, index_advisor)
- **cdc**: Change Data Capture (wal2json)
- **integration**: Foreign data wrappers (wrappers)
- **safety**: Query safety (pg_safeupdate, pg_plan_filter)
- **utilities**: General tools (http, pg_cron, pg_partman)

### Functional Testing Checklist

For each extension, verify:

1. ✅ **CREATE EXTENSION** succeeds
2. ✅ **Basic functionality** works (function calls, queries)
3. ✅ **Data operations** complete successfully
4. ✅ **Expected output** matches documentation
5. ✅ **Session isolation** handled correctly (if applicable)

### Testing Extensions with Dependencies

Some extensions require other extensions to be created first:

```typescript
// pgvector depends on base vector type
await runSQL("CREATE EXTENSION IF NOT EXISTS vector");
await runSQL("CREATE EXTENSION IF NOT EXISTS pgvector");

// supabase_vault depends on pgsodium
await runSQL("CREATE EXTENSION IF NOT EXISTS pgsodium");
await runSQL("CREATE EXTENSION IF NOT EXISTS supabase_vault");
```

Check `docker/postgres/docker-entrypoint-initdb.d/01-extensions.sql` for the canonical extension creation order.

## Common Pitfalls

### 1. Session State Lost

**Symptom**: Extension works in manual testing but fails in automated tests.

**Cause**: Session-local state not preserved across `runSQL()` calls.

**Fix**: Use multi-statement SQL blocks in single `runSQL()` call.

### 2. HypoPG Indexes Disappear

**Symptom**: `hypopg_list_indexes` returns 0 rows after creating index.

**Cause**: Index created in different session than where it's queried.

**Fix**: Create and query hypothetical indexes in same `runSQL()` call.

```typescript
// ❌ WRONG
await runSQL("SELECT * FROM hypopg_create_index('...')");
const list = await runSQL("SELECT * FROM hypopg_list_indexes"); // Empty!

// ✅ CORRECT
const result = await runSQL(`
  SELECT * FROM hypopg_create_index('...');
  SELECT * FROM hypopg_list_indexes;
`);
```

### 3. Output Parsing Errors

**Symptom**: Test fails with `parseInt(NaN)` or "count is not a number".

**Cause**: Unexpected output format from query.

**Fix**: Filter empty lines, handle headers, parse last line:

```typescript
const lines = result.stdout.split("\n").filter((l) => l.trim());
const count = parseInt(lines[lines.length - 1]);
assert(!isNaN(count), "Failed to parse count");
```

### 4. LOAD Commands Not Active

**Symptom**: Hook-based extension (auto_explain, pg_plan_filter) has no effect.

**Cause**: `LOAD` executed in different session than query.

**Fix**: Load extension in same SQL block as query:

```typescript
await runSQL(`
  LOAD 'auto_explain';
  SELECT * FROM data;
`);
```

### 5. Replication Slot Already Exists

**Symptom**: `ERROR: replication slot "test_slot" already exists`

**Cause**: Previous test didn't clean up replication slot.

**Fix**: Drop slot after test OR check existence before creating:

```typescript
// Cleanup after test
await runSQL("SELECT pg_drop_replication_slot('test_wal2json_slot')");

// Or check before creating
await runSQL(`
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = 'test_slot')
    THEN pg_create_logical_replication_slot('test_slot', 'wal2json')
  END
`);
```

### 6. Temp Tables Not Found

**Symptom**: `ERROR: relation "temp_table" does not exist`

**Cause**: Temp table created in different session.

**Fix**: Create and use temp tables in same `runSQL()` call:

```typescript
await runSQL(`
  CREATE TEMP TABLE session_data (id int);
  INSERT INTO session_data VALUES (1);
  SELECT * FROM session_data;
`);
```

### 7. Hook Extensions Not Working

**Symptom**: pg_safeupdate doesn't block UPDATE without WHERE, or supautils GUC parameters not found.

**Cause**: Extension not preloaded via `shared_preload_libraries` or `session_preload_libraries`.

**Fix**: Load hook extensions at appropriate scope:

```bash
# pg_plan_filter requires shared_preload_libraries. The variable replaces the default list, so keep it whole.
POSTGRES_SHARED_PRELOAD_LIBRARIES="auto_explain,pg_cron,pg_net,pg_stat_monitor,pg_stat_statements,pgaudit,pgsodium,safeupdate,supabase_vault,timescaledb,plan_filter"

# pg_safeupdate uses session_preload_libraries
psql -c "SET session_preload_libraries = 'pg_safeupdate'; UPDATE table SET col = 1;"

# supautils requires shared_preload_libraries for GUC parameters
POSTGRES_SHARED_PRELOAD_LIBRARIES="auto_explain,pg_cron,pg_net,pg_stat_monitor,pg_stat_statements,pgaudit,pgsodium,safeupdate,supabase_vault,timescaledb,supautils"
```

**Note**: Hook-based extensions don't use CREATE EXTENSION - they load via preload libraries.

### 8. Docker Credential Helper Not Found

**Symptom**: PgBouncer tests fail with error: `docker-credential-osxkeychain: executable file not found in $PATH`

**Cause**: System Docker config (`~/.docker/config.json`) references credential helper but the binary is not installed or not in PATH.

**Fix Option 1** - Remove credential helper from Docker config (Quick):

```bash
# Edit ~/.docker/config.json and remove the "credsStore" line:
{
  "auths": {
    "ghcr.io": {}
  }
}
```

**Fix Option 2** - Install credential helper (Permanent):

```bash
# macOS
brew install docker-credential-helper

# Linux (Ubuntu/Debian)
sudo apt-get install docker-credential-helpers

# Arch Linux
sudo pacman -S docker-credential-helpers
```

**Automatic Fallback**: Test scripts automatically detect missing credential helpers and create isolated test configurations. No manual intervention required unless you want to fix the system-level configuration.

### 9. Overriding Image Default Preload

**Symptom**: Extension tests fail with "extension requires preload" errors even though extension works in production.

**Cause**: Test script hardcodes `POSTGRES_SHARED_PRELOAD_LIBRARIES` with incomplete list.

**Why This Happens**: The image has a built-in `DEFAULT_SHARED_PRELOAD_LIBRARIES` in the entrypoint (auto-generated from manifest). When tests override this env var, they may miss required modules.

**Image Default** (auto-generated from manifest):

```
auto_explain,pg_cron,pg_net,pg_stat_monitor,pg_stat_statements,pgaudit,pgsodium,safeupdate,supabase_vault,timescaledb
```

**Fix**: Don't override unless testing override behavior:

```typescript
// ❌ WRONG - Hardcoded list gets out of sync
const exitCode = await dockerRunLive([
  "run",
  "-d",
  "-e",
  "POSTGRES_PASSWORD=test",
  "-e",
  "POSTGRES_SHARED_PRELOAD_LIBRARIES=auto_explain,pg_cron,pgaudit", // Missing modules!
  image,
]);

// ✅ CORRECT - Use image default
const exitCode = await dockerRunLive([
  "run",
  "-d",
  "-e",
  "POSTGRES_PASSWORD=test",
  // No POSTGRES_SHARED_PRELOAD_LIBRARIES - uses image built-in default
  image,
]);
```

**Exception**: Only override when explicitly testing preload behavior (e.g., testing what happens when a module is NOT loaded).

## Test Categories

### Core Extensions (5)

PostgreSQL builtins that should always work:

- btree_gist, btree_gin, pg_trgm, fuzzystrmatch, unaccent

> **Note:** uuid-ossp is intentionally NOT enabled. PostgreSQL 18 includes the superior built-in `uuidv7()` function for time-ordered UUIDs with better indexing performance.

### Vector Search (2)

- pgvector: Vector similarity search, distance functions
- vectorscale: DiskANN indexing for large-scale vector search

### Full-Text Search (1)

- pgroonga: Multi-language full-text search with indexing

### Spatial (2)

- postgis: Geographic objects, spatial queries
- pgrouting: Network routing algorithms

### Time-Series (2)

- timescaledb: Hypertables, continuous aggregates
- timescaledb_toolkit: Time-series analytics functions

### Observability (8)

- pg_stat_statements: Query performance tracking
- pg_stat_monitor: Enhanced query monitoring (1000-query buffer)
- auto_explain: Automatic query plan logging
- pg_stat_kcache: Kernel cache hit statistics
- plpgsql_check: PL/pgSQL code validation
- pg_top: Real-time activity monitoring
- pgbadger: Log analyzer (tool)
- pg_plan_filter: Query plan filtering

### Security (4)

- pgsodium: Libsodium encryption
- supabase_vault: Encrypted secrets storage
- pgaudit: Audit logging
- set_user: Superuser privilege control

### Performance (6)

- index_advisor: Index recommendation
- hypopg: Hypothetical indexes (session-local)
- pg_qualstats: Predicate statistics
- pg_wait_sampling: Wait event sampling
- hll: HyperLogLog cardinality estimation
- rum: Full-text search indexes

### CDC (1)

- wal2json: JSON output plugin for logical replication

### Integration (1)

- wrappers: Foreign data wrappers (Supabase) - 10 functional tests, 1 regression suite (6 assertions)

### Safety (2)

- pg_safeupdate: Prevent UPDATE/DELETE without WHERE
- pg_plan_filter: Block queries by plan characteristics

### Utilities (11)

- pg_cron: Job scheduler
- pg_partman: Partition management
- pg_repack: Online table repacking
- http: HTTP client for REST APIs
- pg_hashids: Encode/decode hashids
- pg_jsonschema: JSON Schema validation
- pgmq: Message queue
- supautils: Superuser utility functions
- pg_net: Async HTTP (Supabase, requires worker)
- pgjwt: JWT generation (Supabase, requires pg_net)
- wal2json: Logical decoding (tool)

## Testing Strategy & Coverage

### Current State

**Comprehensive CI Testing Coverage:**

All enabled extensions have functional tests with 100% coverage across three dimensions (CREATE EXTENSION, functional test, metadata check).

**Test Suite:**

- `scripts/docker/test-image.ts` - extension behaviour for every enabled extension (checks in `test-image-lib.ts`)
- `scripts/test/test-auto-config.ts` - auto-config dry-run table on the real image plus two real boots
- `scripts/test/test-pgbouncer-healthcheck.ts` - PgBouncer auth flow validation

### Test Coverage Matrix

| Category      | Extensions | Tests  | Coverage |
| ------------- | ---------- | ------ | -------- |
| AI/Vector     | 2          | 6      | 100%     |
| Analytics     | 1          | 2      | 100%     |
| CDC           | 1          | 3      | 100%     |
| GIS           | 2          | 6      | 100%     |
| Indexing      | 2          | 4      | 100%     |
| Integration   | 2          | 13     | 100%     |
| Language      | 1          | 4      | 100%     |
| Maintenance   | 2          | 5      | 100%     |
| Observability | 4          | 8      | 100%     |
| Operations    | 2          | 4      | 100%     |
| Performance   | 2          | 5      | 100%     |
| Quality       | 1          | 3      | 100%     |
| Queueing      | 1          | 4      | 100%     |
| Safety        | 3          | 6      | 100%     |
| Search        | 3          | 6      | 100%     |
| Security      | 4          | 10     | 100%     |
| Timeseries    | 2          | 5      | 100%     |
| Utilities     | 1          | 4      | 100%     |
| Validation    | 1          | 4      | 100%     |
| **TOTAL**     | **37**     | **98** | **100%** |

> **Note:** For current extension counts (enabled/disabled/total), see `docs/.generated/docs-data.json`.

### Auto-Config Test Coverage

Comprehensive auto-config validation covers 10 memory scenarios from 256MB to 64GB:

| Scenario          | RAM    | CPU     | Detection          | Config Injection                    | Status  |
| ----------------- | ------ | ------- | ------------------ | ----------------------------------- | ------- |
| Manual override   | 1536MB | -       | ✅ POSTGRES_MEMORY | shared_buffers, max_connections     | Passing |
| Cgroup v2 limit   | 2GB    | -       | ✅ cgroup v2       | shared_buffers, max_connections     | Passing |
| Minimum supported | 512MB  | -       | ✅ cgroup v2       | shared_buffers, max_connections     | Passing |
| Large node        | 64GB   | -       | ✅ POSTGRES_MEMORY | shared_buffers, max_connections     | Passing |
| CPU detection     | 2GB    | 2 cores | ✅ nproc           | worker processes                    | Passing |
| Below minimum     | 256MB  | -       | ✅ Detection       | FATAL error                         | Passing |
| Custom preload    | 1GB    | -       | ✅ Override        | shared_preload_libraries            | Passing |
| Medium production | 4GB    | -       | ✅ cgroup v2       | shared_buffers 1024MB, max_conn 200 | Passing |
| Large production  | 8GB    | -       | ✅ cgroup v2       | shared_buffers 2048MB, max_conn 200 | Passing |
| High-load         | 16GB   | -       | ✅ cgroup v2       | shared_buffers 3276MB, max_conn 200 | Passing |

Details:

1. **Manual override (1536MB)** - Respects POSTGRES_MEMORY env var, shared_buffers 25%, connection tier 120
2. **2GB cgroup limit** - Detects via cgroup v2, shared_buffers 512MB, connection tier 120
3. **512MB minimum** - Minimum supported deployment, shared_buffers 128MB, connection tier 80
4. **64GB manual override** - Large-node tuning, shared_buffers ~9830MB, connection tier 200
5. **4GB tier** - Medium production, shared_buffers 1024MB (25%), connection tier 200
6. **8GB tier** - Large production, shared_buffers 2048MB (25%), connection tier 200
7. **16GB tier** - High-load deployment, shared_buffers 3276MB (20%), connection tier 200

For comprehensive memory allocation table with all RAM tiers and formulas, see [AGENTS.md Auto-Config section](../AGENTS.md#auto-config).

### PgBouncer Test Coverage

Comprehensive PgBouncer auth flow validation:

1. **.pgpass file existence** - Verified at /tmp/.pgpass with 600 permissions
2. **.pgpass entries** - Configured for localhost:6432 and pgbouncer:6432
3. **Authentication** - Tested via localhost and hostname
4. **SHOW POOLS** - Verified pool status and database entries
5. **Healthcheck** - Validated healthcheck command execution
6. **Connection pooling** - Functional integration testing

See `scripts/test/test-pgbouncer-healthcheck.ts` for end-to-end stack testing.

### Test Quality Metrics

**Functional Test Coverage:**

- All enabled extensions tested across 3 dimensions: CREATE EXTENSION, functional test, metadata check
- Comprehensive smoke test suite with assertions
- 100% extension coverage (no deferred testing)

**Auto-Config Test Coverage:**

- 10 test scenarios covering RAM/CPU detection (256MB to 64GB)
- 7 memory tiers (512MB, 1GB, 2GB, 4GB, 8GB, 16GB, 64GB)
- Manual override, cgroup v2 detection, CPU scaling
- Edge cases (below-minimum rejection, custom shared_preload_libraries)

**PgBouncer Test Coverage:**

- Happy path: .pgpass file management, authentication via localhost/hostname, SHOW POOLS, healthcheck
- Failure scenarios: wrong password, missing .pgpass, invalid listen address, PostgreSQL down, max connections, wrong permissions

**Stack Deployment Test Coverage:**

- **Primary stack**: Auto-config, PgBouncer auth, postgres_exporter, pgbouncer_exporter
- **Replica stack** (7 steps): Replication slot creation, standby mode verification, hot standby queries, WAL sync, postgres_exporter
- **Single stack** (7 steps): Standalone mode, extension availability, connection limits, auto-config, no pooler verification

**Hook Extension Test Coverage:**

- pg_plan_filter: Without/with preload, functional validation
- pg_safeupdate: Session preload, functional query blocking
- supautils: Without/with preload, GUC-based configuration
- Multi-hook stability testing

### Maintenance

**When to update tests:**

- New extension added to manifest.json → add smoke test to test-all-extensions-functional.ts
- Extension version upgraded → verify test still valid
- Upstream API changes → update functional test
- Auto-config logic changes → update test-auto-config.ts

**Who maintains:**

- Developer adding extension writes smoke test
- CI enforces all tests pass before merge

## Running Tests

`SUITES` in `scripts/test-all.ts` is the only list of Docker suites; each suite belongs to one group. CI, publish, nightly and the manual build workflow run suites only as `bun scripts/test-all.ts --group <group> --image <ref>`.

```bash
bun run test                                  # every routine group against the local build (aza-pg:pg18)
bun run test:all                              # build + validate:all + every routine group
bun scripts/test-all.ts --group stacks        # one group; comma-separate several
bun scripts/test-all.ts --image ghcr.io/fluxo-kt/aza-pg:18
bun scripts/test-all.ts --shuffle             # random order; prints the seed, replay with --shuffle=<seed>
bun scripts/test/test-pgflow.ts [image]       # one suite on its own
```

| Group        | Proves                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `extensions` | every enabled extension and tool works in the image; disabled ones are absent                   |
| `security`   | authentication, roles, pgAudit and network binding defaults                                     |
| `stacks`     | the compose stacks (PgBouncer, exporters, replica) in private staged copies                     |
| `features`   | auto-config, backup/restore, pgflow and its upgrade command, pg_cron, error handling            |
| `regression` | each enabled extension's SQL against its expected output, and extension interactions            |
| `nightly`    | the same in regression mode against the regression image (all extensions); weekly workflow only |

Suites run in parallel up to the CPU count, each in its own process with its own containers, volumes, networks and ports, so order and neighbours must not matter (`--shuffle` checks that). Each suite's full output is printed when it finishes; any failed suite makes the run exit 1.

### Adding a Test

- **Docker-free unit test:** `scripts/**/<name>.test.ts`; `bun run validate` finds it by glob.
- **Docker suite:** `scripts/**/test-<name>.ts` plus one `{ path, group }` line in `SUITES`. `validate` fails while a `test-*.ts` file is neither in `SUITES` nor imported or run by a suite that is (`scripts/validate/check-suite-registry.ts`), and when a workflow starts a suite file itself. A file that imports `bun:test` is run with `bun test` automatically.
- **Image:** read it with `resolveImageTag()` from `scripts/test/image-resolver.ts` (argument, `--image=`, then `POSTGRES_IMAGE`); `test-all.ts` passes `POSTGRES_IMAGE`.

## References

- **Extension tests:** `scripts/docker/test-image-lib.ts` (run by `scripts/docker/test-image.ts`)
- **Auto-config tests:** `scripts/test/test-auto-config.ts`
- **PgBouncer tests:** `scripts/test/test-pgbouncer-healthcheck.ts` (happy path)
- **PgBouncer failure tests:** `scripts/test/test-pgbouncer-failures.ts` (6 failure scenarios)
- **Hook extension tests:** `scripts/test/test-hook-extensions.ts`
- **Replica stack tests:** `scripts/test/test-replica-stack.ts` (replication validation)
- **Single stack tests:** `scripts/test/test-single-stack.ts` (standalone validation)
- **Image test harness:** `scripts/docker/test-image.ts` (comprehensive image validation)
- **Extension manifest:** `docker/postgres/extensions.manifest.json`
- **Auto-config entrypoint:** `docker/postgres/docker-auto-config-entrypoint.sh`
- **Init Order**: `docker/postgres/docker-entrypoint-initdb.d/` for extension creation sequence
- **Hook Extensions**: See `AGENTS.md` "Hook-Based Extensions & Tools" section for manifest patterns

---

**Key Takeaway**: When testing session-local PostgreSQL features (LOAD, SET, HypoPG, TEMP tables), always use multi-statement SQL blocks within a single `runSQL()` call. This preserves session state and prevents "feature not active" or "object not found" errors.

**Status:** Regression testing implemented. 100% extension coverage with functional smoke tests. All critical paths tested (extensions, auto-config, PgBouncer auth).
