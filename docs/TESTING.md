# Testing Guide

Comprehensive guide for testing PostgreSQL extensions in aza-pg, covering critical patterns, common pitfalls, functional testing strategies, and coverage metrics.

## Table of Contents

1. [Regression Testing](#regression-testing)
2. [Session Isolation Pattern](#session-isolation-pattern)
3. [Testing Extension Functionality](#testing-extension-functionality)
4. [Common Pitfalls](#common-pitfalls)
5. [Test Categories](#test-categories)
6. [Testing Strategy & Coverage](#testing-strategy-coverage)
7. [Running Tests](#running-tests)

## Regression Testing

**For comprehensive regression testing documentation, see [REGRESSION-TESTING.md](./REGRESSION-TESTING.md).**

### Overview

aza-pg includes a comprehensive regression testing framework with dual-mode architecture:

- **Production Mode**: Tests exact release image behavior (enabled extensions from manifest)
- **Regression Mode**: Tests all extensions including disabled ones (comprehensive catalog coverage)

### Test Tiers

| Tier       | Description                                 | Count         | Duration  |
| ---------- | ------------------------------------------- | ------------- | --------- |
| **Tier 1** | Core PostgreSQL regression (official tests) | 30 tests      | ~3-5 min  |
| **Tier 2** | Extension-specific regression               | 13 extensions | ~5-8 min  |
| **Tier 3** | Extension interaction tests                 | 14 scenarios  | ~2-4 min  |
| **Tier 4** | pgTAP unit tests (SQL-based)                | 82 tests      | ~5-10 min |

### Quick Start

```bash
# Run all regression tests (production mode)
bun test:regression:all

# Run specific tier
bun test:regression:core        # Tier 1: PostgreSQL core
bun test:regression:extensions  # Tier 2: Extension tests
bun test:regression:interactions # Tier 3: Interaction tests

# Run in regression mode (all extensions)
TEST_MODE=regression bun test:regression:all

# Use master runner with options
bun scripts/test/run-all-regression-tests.ts --tier=1 --fast
```

### Images

- **Production**: `aza-pg:pg18` (production Dockerfile, enabled extensions, 6 preloads)
- **Regression**: `aza-pg:pg18-regression` (separate Dockerfile, all catalog entries, 10 preloads, pgTAP)

Build regression image:

```bash
bun scripts/build.ts --regression
```

### Test Mode Detection

Tests automatically detect mode from:

1. `TEST_MODE` environment variable
2. `/etc/postgresql/version-info.json` (if in container)
3. Default: production

**See [REGRESSION-TESTING.md](./REGRESSION-TESTING.md) for complete documentation.**

---

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

#### Example 2: pg_plan_filter Query Execution

```typescript
await test(
  "pg_plan_filter - Execute queries with plan filter active",
  "safety",
  async () => {
    const result = await runSQL(`
    LOAD 'plan_filter';
    SELECT count(*) FROM pg_tables;
  `);
    const lines = result.stdout.split("\n").filter((l) => l.trim());
    const count = parseInt(lines[lines.length - 1]);
    assert(
      result.success && count > 0,
      "Query execution with pg_plan_filter failed"
    );
  }
);
```

**Why**: pg_plan_filter hook must be loaded in the same session where queries execute.

#### Example 3: HypoPG Hypothetical Indexes

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

#### Example 4: Session vs Persistent State

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
# pg_plan_filter requires shared_preload_libraries
POSTGRES_SHARED_PRELOAD_LIBRARIES="pg_stat_statements,auto_explain,pg_cron,pgaudit,pg_plan_filter"

# pg_safeupdate uses session_preload_libraries
psql -c "SET session_preload_libraries = 'pg_safeupdate'; UPDATE table SET col = 1;"

# supautils requires shared_preload_libraries for GUC parameters
POSTGRES_SHARED_PRELOAD_LIBRARIES="pg_stat_statements,auto_explain,pg_cron,pgaudit,supautils"
```

**Note**: Hook-based extensions don't use CREATE EXTENSION - they load via preload libraries.

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

- wrappers: Foreign data wrappers (Supabase)

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

- `scripts/test/test-all-extensions-functional.ts` - Comprehensive smoke tests for all enabled extensions
- `scripts/test/test-auto-config.ts` - Auto-config detection across 4 memory scenarios
- `scripts/test/test-pgbouncer-healthcheck.ts` - PgBouncer auth flow validation

### Test Coverage Matrix

| Category      | Extensions | Tests    | Coverage |
| ------------- | ---------- | -------- | -------- |
| AI/Vector     | 2          | 6        | 100%     |
| Analytics     | 1          | 2        | 100%     |
| CDC           | 1          | 3        | 100%     |
| GIS           | 2          | 6        | 100%     |
| Indexing      | 2          | 4        | 100%     |
| Integration   | 2          | 6        | 100%     |
| Language      | 1          | 4        | 100%     |
| Maintenance   | 2          | 5        | 100%     |
| Observability | 4          | 8        | 100%     |
| Operations    | 2          | 4        | 100%     |
| Performance   | 2          | 5        | 100%     |
| Quality       | 1          | 3        | 100%     |
| Queueing      | 1          | 4        | 100%     |
| Safety        | 3          | 6        | 100%     |
| Search        | 3          | 6        | 100%     |
| Security      | 4          | 10       | 100%     |
| Timeseries    | 2          | 5        | 100%     |
| Utilities     | 1          | 4        | 100%     |
| Validation    | 1          | 4        | 100%     |
| **TOTAL**     | **38**     | **117+** | **100%** |

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

- Happy path (8 tests): .pgpass file management, authentication via localhost/hostname, SHOW POOLS, healthcheck
- Failure scenarios (6 tests): wrong password, missing .pgpass, invalid listen address, PostgreSQL down, max connections, wrong permissions

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

### Comprehensive Test Suite (All Validations + Build + Functional)

The `test-all.ts` script orchestrates all validation checks, build tests, and functional tests:

```bash
# Run complete test suite (validation + build + functional)
bun run test:all
# OR: bun scripts/test-all.ts

# Fast mode - validation only (skips Docker build and functional tests)
bun run test:all:fast
# OR: bun scripts/test-all.ts --fast

# Skip build - run all tests except Docker build (useful if image exists)
bun scripts/test-all.ts --skip-build

# Show help
bun scripts/test-all.ts --help
```

**Test Categories:**

1. **Validation Checks** (run in parallel):
   - Manifest validation
   - TypeScript type checking
   - Code linting (oxlint)
   - Code formatting (prettier)
   - Documentation consistency
   - Smoke tests
   - ShellCheck (shell script linting)
   - Hadolint (Dockerfile linting)
   - YAML linting
   - Secret scanning

2. **Build Tests** (run sequentially):
   - Docker image build (with 15min timeout)
   - Extension binary size verification
   - Extension count verification (dynamically derived from manifest)

3. **Functional Tests** (run sequentially):
   - Basic extension loading (vector, pg_cron)
   - Auto-tuning tests (512MB, 2GB, 4GB memory limits)
   - Single-node stack deployment
   - Replica/cluster stack deployment
   - Comprehensive extension tests (all enabled extensions)

**Environment Variables:**

```bash
# Make optional checks non-critical (useful in environments without these tools)
ALLOW_MISSING_SHELLCHECK=1 bun scripts/test-all.ts
ALLOW_MISSING_HADOLINT=1 bun scripts/test-all.ts
ALLOW_MISSING_YAMLLINT=1 bun scripts/test-all.ts

# Use custom Docker image
POSTGRES_IMAGE=my-custom:tag bun scripts/test-all.ts
```

**Exit Codes:**

- `0`: All critical tests passed (non-critical failures are warnings)
- `1`: One or more critical tests failed

**Output Format:**

The script provides:

- Real-time progress indicators for each check
- Parallel execution for validation checks (faster)
- Sequential execution for build/functional tests (safer)
- Categorized summary at the end (Validation, Build, Functional)
- Timing for each test
- Highlighted failures with actionable error messages

### Extension Functional Tests

```bash
# Run all 117+ functional tests
bun run scripts/test/test-all-extensions-functional.ts

# Expected output:
# ✓ 117+/117+ tests passing
# ⏱ Duration: ~8-10 seconds
```

### Filter by Category

```bash
# Test only vector extensions
bun run scripts/test/test-all-extensions-functional.ts --category vector

# Test security extensions
bun run scripts/test/test-all-extensions-functional.ts --category security
```

### Auto-Config Testing

```bash
# Validate RAM/CPU detection and configuration injection
bun scripts/test/test-auto-config.ts [image-tag]

# Tests:
# - Manual override (POSTGRES_MEMORY=1536)
# - 512MB limit (minimum viable)
# - 2GB limit (typical production)
# - 64GB limit (high-end deployment)
# - CPU detection (2 cores)
# - Below minimum rejection (256MB)
# - Custom preload libraries
```

### PgBouncer Testing

```bash
# Validate PgBouncer auth flow and connection pooling
bun scripts/test/test-pgbouncer-healthcheck.ts [stack-dir]

# Tests:
# - .pgpass file existence and permissions
# - Authentication via localhost and hostname
# - SHOW POOLS verification
# - Healthcheck command execution
# - Connection pooling functional test
```

### Hook Extension Testing

```bash
# Validate hook-based extensions that load via shared_preload_libraries
bun scripts/test/test-hook-extensions.ts [image-tag]

# Extensions tested:
# - pg_plan_filter (hook-based, requires shared_preload_libraries)
# - pg_safeupdate (hook-based, uses session_preload_libraries)
# - supautils (GUC-based, optional shared_preload_libraries)

# Test cases:
# 1. pg_plan_filter without preload (should have no effect)
# 2. pg_plan_filter with preload (verify hook active)
# 3. pg_safeupdate session preload (blocks UPDATE/DELETE without WHERE)
# 4. supautils without preload (GUC params unavailable)
# 5. supautils with preload (GUC params available)
# 6. Combined preload (multiple hooks active simultaneously)
```

### Integration Testing

```bash
# Test extension combinations
bun run scripts/test/test-integration.ts

# Combinations tested:
# - timescaledb + pgvector (time-series + vector search)
# - postgis + pgroonga (spatial + full-text)
# - pgsodium + supabase_vault (encryption stack)
```

### Comprehensive Image Testing

```bash
# Comprehensive Docker image test harness
bun run test:image [image-tag]                      # Test aza-pg:latest (default)
bun run test:image aza-pg:18.1-202511142330        # Test specific image
bun scripts/docker/test-image.ts ghcr.io/fluxo-kt/aza-pg:18-single-node  # Full registry path

# Options:
# --no-cleanup   Keep container running after tests (for debugging)
# --fast         Skip time-consuming functional tests

# Test Phases:
# Phase 1: Filesystem Verification
#   - Extension directory structure exists
#   - Manifest file present in image
#   - Version info files present (txt, json)
#   - Enabled PGDG extensions present
#   - Disabled PGDG extensions not present
#
# Phase 2: Runtime Verification
#   - Version info counts correct (txt, json)
#   - Preloaded extensions in shared_preload_libraries
#   - Enabled extensions can be created
#   - Disabled extensions cannot be created
#   - PostgreSQL configuration valid
#
# Phase 3: Tools Verification
#   - Tools present (pgbackrest, pgbadger, wal2json, etc.)
#   - pgBackRest functional (version command)
#   - pgBadger functional (version command)
#
# Phase 4: Auto-Configuration Tests
#   - Auto-config applied (shared_buffers, work_mem, etc.)
#
# Phase 5: Functional Tests (Sample)
#   - Basic extension functionality (pgvector, pg_trgm, hstore)
#   - Skipped in --fast mode

# Example output:
# ============================================================
#   Comprehensive Docker Image Test Harness
# ============================================================
# ✅ Docker daemon is running
# ✅ Manifest loaded
# ✅ Test container started
# ✅ PostgreSQL ready in 5.23s
#
# ============================================================
#   Phase 1: Filesystem Verification
# ============================================================
# ✅ Extension directory structure (125ms)
# ✅ Manifest file present (89ms)
# ✅ Version info files present (72ms)
# ✅ Enabled PGDG extensions present (25 verified) (1.45s)
# ✅ Disabled PGDG extensions not present (2 verified) (345ms)
#
# [... additional phases ...]
#
# ============================================================
#   Test Summary
# ============================================================
# ✅ All tests passed!
# Total: 18 | Passed: 18 | Failed: 0
```

### CI Integration

GitHub Actions workflow runs all tests on:

- Platform: `linux/amd64`, `linux/arm64` (QEMU emulation for arm64 validation)
- Extension kinds: `compiled`, `pgdg`, `builtin`
- Auto-config scenarios: `manual`, `cgroup`, `minimum`, `high-memory`, `4GB`, `8GB`, `16GB`, `64GB`
- Stack deployments: `primary`, `replica`, `single`
- Failure scenarios: PgBouncer auth failures, connection limits, invalid configurations

## Test Organization

**Test Files:**

```
scripts/test/
├── test-all-extensions-functional.ts  (all enabled extensions, comprehensive smoke tests)
├── test-auto-config.ts                (10 auto-config scenarios: 512MB-64GB)
├── test-pgbouncer-healthcheck.ts      (8 PgBouncer auth flow tests)
├── test-pgbouncer-failures.ts         (6 failure scenario tests)
├── test-hook-extensions.ts            (6 hook-based extension tests)
├── test-replica-stack.ts              (7-step replication validation)
├── test-single-stack.ts               (7-step standalone validation)
├── test-extensions.ts                 (legacy baseline tests)
├── test-extension-performance.ts      (performance benchmarks)
├── test-integration-extension-combinations.ts
└── test-pgq-functional.ts             (pgmq queue tests)

scripts/docker/
└── test-image.ts                      (comprehensive image test harness)
```

## References

- **Extension tests:** `scripts/test/test-all-extensions-functional.ts`
- **Auto-config tests:** `scripts/test/test-auto-config.ts` (10 memory tier scenarios)
- **PgBouncer tests:** `scripts/test/test-pgbouncer-healthcheck.ts` (happy path)
- **PgBouncer failure tests:** `scripts/test/test-pgbouncer-failures.ts` (6 failure scenarios)
- **Hook extension tests:** `scripts/test/test-hook-extensions.ts`
- **Replica stack tests:** `scripts/test/test-replica-stack.ts` (replication validation)
- **Single stack tests:** `scripts/test/test-single-stack.ts` (standalone validation)
- **Image test harness:** `scripts/docker/test-image.ts` (comprehensive image validation)
- **Extension manifest:** `docker/postgres/extensions.manifest.json`
- **Auto-config entrypoint:** `docker/postgres/docker-auto-config-entrypoint.sh`
- **Commit 89de009**: Test restoration with session isolation fixes (4 tests restored, 1 added)
- **Commit 11c4d56**: pgsodium TCE security fix (enabled shared_preload_libraries)
- **Session Isolation**: See `scripts/test/test-all-extensions-functional.ts` lines 450-520 for examples
- **Init Order**: `docker/postgres/docker-entrypoint-initdb.d/` for extension creation sequence
- **Hook Extensions**: See `AGENTS.md` "Hook-Based Extensions & Tools" section for manifest patterns

---

**Key Takeaway**: When testing session-local PostgreSQL features (LOAD, SET, HypoPG, TEMP tables), always use multi-statement SQL blocks within a single `runSQL()` call. This preserves session state and prevents "feature not active" or "object not found" errors.

**Status:** Regression testing implemented. 100% extension coverage with functional smoke tests. All critical paths tested (extensions, auto-config, PgBouncer auth).
