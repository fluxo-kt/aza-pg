# Testing Guide

Comprehensive guide for testing PostgreSQL extensions in aza-pg, covering critical patterns, common pitfalls, and functional testing strategies.

## Table of Contents

1. [Session Isolation Pattern](#session-isolation-pattern)
2. [Testing Extension Functionality](#testing-extension-functionality)
3. [Common Pitfalls](#common-pitfalls)
4. [Test Categories](#test-categories)
5. [Running Tests](#running-tests)

## Session Isolation Pattern

### Critical Concept

PostgreSQL session-local state (LOAD, SET, hypothetical indexes) does **not persist** across separate SQL invocations. Each `runSQL()` call creates a new `psql` session.

### The Problem

```typescript
// ❌ WRONG - Session state lost between calls
await runSQL("LOAD 'auto_explain'");
await runSQL("SET auto_explain.log_min_duration = 0");
await runSQL("SELECT count(*) FROM test_table");  // auto_explain NOT active
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
await test("pg_plan_filter - Execute queries with plan filter active", "safety", async () => {
  const result = await runSQL(`
    LOAD 'plan_filter';
    SELECT count(*) FROM pg_tables;
  `);
  const lines = result.stdout.split('\n').filter(l => l.trim());
  const count = parseInt(lines[lines.length - 1]);
  assert(result.success && count > 0, "Query execution with pg_plan_filter failed");
});
```

**Why**: pg_plan_filter hook must be loaded in the same session where queries execute.

#### Example 3: HypoPG Hypothetical Indexes

```typescript
await test("hypopg - Create and verify hypothetical index", "performance", async () => {
  // Create and verify in same session (hypothetical indexes are session-local)
  const result = await runSQL(`
    SELECT * FROM hypopg_create_index('CREATE INDEX ON test_hypopg (val)');
    SELECT count(*) FROM hypopg_list_indexes;
  `);
  const lines = result.stdout.split('\n').filter(l => l.trim());
  const count = parseInt(lines[lines.length - 1]);
  assert(result.success && count > 0, "Failed to create hypothetical index");
});

await test("hypopg - Verify planner uses hypothetical index", "performance", async () => {
  const result = await runSQL(`
    SELECT * FROM hypopg_create_index('CREATE INDEX ON test_hypopg (val)');
    EXPLAIN SELECT * FROM test_hypopg WHERE val = 500;
  `);
  assert(result.success, "EXPLAIN query failed with hypothetical index");
});
```

**Why**: HypoPG indexes exist **only in the current session**. Creating an index in one `runSQL()` call means it's gone by the next call.

**Pattern**: Each test creates its own hypothetical index within the same session where it's used, since indexes don't persist.

#### Example 4: Session vs Persistent State

```typescript
// ✅ Persistent state - can split across calls
await runSQL("CREATE TABLE test_table (id int)");
await runSQL("INSERT INTO test_table VALUES (1)");
await runSQL("SELECT * FROM test_table");  // Table persists

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
const list = await runSQL("SELECT * FROM hypopg_list_indexes");  // Empty!

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
const lines = result.stdout.split('\n').filter(l => l.trim());
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

## Test Categories

### Core Extensions (6)
PostgreSQL builtins that should always work:
- btree_gist, btree_gin, pg_trgm, fuzzystrmatch, unaccent, uuid-ossp

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

## Running Tests

### Full Test Suite

```bash
# Run all 100 functional tests
bun run scripts/test/test-all-extensions-functional.ts

# Expected output:
# ✓ 100/100 tests passing
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
./scripts/test/test-auto-config.sh

# Tests:
# - Manual override (POSTGRES_MEMORY=1024)
# - 512MB limit (minimum viable)
# - 2GB limit (typical production)
# - 64GB limit (high-end deployment)
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

## Test Coverage Requirements

### Critical Coverage
- ✅ All 37 extensions functional
- ✅ Session isolation patterns handled
- ✅ Hook-based extensions verified
- ✅ Replication slots cleaned up
- ✅ Multi-statement SQL blocks working

### Pending Coverage
- ⏳ Auto-config RAM/CPU detection
- ⏳ PGFlow function signatures (v0.7.2 API)
- ⏳ Extension combination interactions
- ⏳ pg_partman after pgsodium TCE fix

## References

- **Commit 89de009**: Test restoration with session isolation fixes (4 tests restored, 1 added)
- **Commit 11c4d56**: pgsodium TCE security fix (enabled shared_preload_libraries)
- **Session Isolation**: See `scripts/test/test-all-extensions-functional.ts` lines 450-520 for examples
- **Extension Manifest**: `docker/postgres/extensions.manifest.json` for extension metadata
- **Init Order**: `docker/postgres/docker-entrypoint-initdb.d/` for extension creation sequence

---

**Key Takeaway**: When testing session-local PostgreSQL features (LOAD, SET, HypoPG, TEMP tables), always use multi-statement SQL blocks within a single `runSQL()` call. This preserves session state and prevents "feature not active" or "object not found" errors.
