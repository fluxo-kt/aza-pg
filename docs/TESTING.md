# Testing Guide

Comprehensive guide for testing PostgreSQL extensions in aza-pg, covering critical patterns, common pitfalls, functional testing strategies, and coverage metrics.

## Table of Contents

1. [Writing a Docker Suite](#writing-a-docker-suite)
2. [Regression Testing](#regression-testing)
3. [Regression Test Suites](#regression-test-suites)
   - [Extension Regression Tests (Tier 2)](#extension-regression-tests-tier-2)
4. [Session Isolation Pattern](#session-isolation-pattern)
5. [Testing Extension Functionality](#testing-extension-functionality)
6. [Common Pitfalls](#common-pitfalls)
7. [Coverage](#coverage)
8. [Running Tests](#running-tests)

## Writing a Docker Suite

Name and register a suite as [Adding a Test](#adding-a-test) says; never name a Docker suite `*.test.ts`, because the unit-test glob runs those without Docker. Image checks that share one container belong in `scripts/docker/test-image-lib.ts`, not a new suite.

Every suite must:

- [ ] Test behaviour an operator would notice (a wrong value, a refused connection, lost data). A check that an extension exists or loads is not a test: the `CREATE EXTENSION` a behaviour check runs already fails when it does not.
- [ ] Run what ships: the image's defaults, with the reason inline for any override that is the subject under test.
- [ ] Pass `POSTGRES_PASSWORD`, or the container exits at once.
- [ ] Observe readiness with `await waitForPostgres({ container, timeout })` (`scripts/utils/docker.ts`), never a fixed sleep.
- [ ] Name containers with `generateUniqueContainerName()` and remove them with `docker rm -f -v` in `finally`, never only on the success path.

### Common Pitfalls

| Pitfall                               | Symptom                                                         | Fix                                                                              |
| ------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **No POSTGRES_PASSWORD**              | Container exits immediately: "superuser password not specified" | Add `POSTGRES_PASSWORD: "test"` to env                                           |
| **No waitForPostgres()**              | "connection refused" or "No such file or directory" for socket  | Add `await waitForPostgres({ container, timeout })`                              |
| **Override preload without defaults** | Extensions fail to load: "must be in shared_preload_libraries"  | Don't set `POSTGRES_SHARED_PRELOAD_LIBRARIES` unless you understand implications |
| **Timeout cargo-culting**             | Increase timeout without understanding why it failed            | Add logging, measure actual time, understand root cause                          |

### Template for New Test Files

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

import { $ } from "bun";
import { generateUniqueContainerName, waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";

const container = generateUniqueContainerName("aza-pg-my-feature");

async function run(): Promise<void> {
  await $`docker run -d --name ${container} -e POSTGRES_PASSWORD=postgres ${resolveImageTag()}`.quiet();
  await waitForPostgres({ container, timeout: 120 });
  // Feature checks: throw on the first wrong result.
}

let failure: string | null = null;
try {
  await run();
} catch (err) {
  failure = err instanceof Error ? err.message : String(err);
} finally {
  // Removal runs in finally, never in a process "exit" handler: an exit handler cannot wait for async work.
  await $`docker rm -f -v ${container}`.quiet().nothrow();
}
if (failure) {
  console.error(`FAIL: my feature: ${failure}`);
  process.exit(1);
}
console.log("PASS: my feature");
```

---

## Regression Testing

**→ See [REGRESSION-TESTING.md](./REGRESSION-TESTING.md) for comprehensive regression testing documentation.**

Quick reference:

```bash
bun scripts/test-all.ts --group regression           # Both suites, production mode
bun scripts/test/test-extension-regression.ts        # Tier 2: extension SQL vs expected output
bun scripts/test-all.ts --group nightly              # Regression mode (optional preloads added)
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

**Which suites run:** every directory whose manifest entry is not `enabled: false` (`selectSuites` in `scripts/test/test-extension-regression.ts`); a directory naming no manifest entry fails the run. `--mode=production` (default) starts the image with its own default preload list, `--mode=regression` (nightly) adds optional preload libraries; neither mode runs a disabled extension.

**Generating Expected Outputs:** from a known-good image, then read the result before committing: an error in the output (an extension missing from the image, say) becomes the expectation.

```bash
bun run build
bun scripts/test/test-extension-regression.ts --generate-expected --extensions=hll
```

**Running Tests:**

```bash
bun scripts/test/test-extension-regression.ts                              # every enabled directory
bun scripts/test/test-extension-regression.ts --extensions=hll,pg_partman # some of them
bun scripts/test/test-extension-regression.ts --container=my-postgres      # an existing container
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
4. Commit SQL + expected output files; the directory runs from then on

**Test Execution Details:**

- Uses `psql -X -a -q` for consistent output format
- Output normalization handles psql formatting variations
- Diff generation uses `diff -c` (context diff) for readability
- Failed tests generate `extension-regression.diffs` file

**Related Documentation:**

- **Extension behaviour**: `scripts/docker/test-image-lib.ts`, run by `scripts/docker/test-image.ts`
- **Regression Runner**: `scripts/test/lib/regression-runner.ts` - Shared test infrastructure

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

Image checks are `test<Name>(container)` functions in `scripts/docker/test-image-lib.ts` returning a `TestResult`, run by `scripts/docker/test-image.ts` against one shared container. Inside them, `psql(container, statements)` returns `{ ok, out, err }` and `sqlOk()` throws with psql's error; statements passed as one array run in one session.

Each check asserts a value only a working extension produces (a ranked result, a decrypted plaintext, a row a scheduled job wrote). Never assert only that `CREATE EXTENSION` succeeded or that a version is set: the first already fails any behaviour check, and `scripts/test/test-extension-versions.ts` owns versions.

`docker/postgres/docker-entrypoint-initdb.d/01-extensions.sql` creates the precreated extensions in dependency order.

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

## Coverage

The extension catalogue is the generated table in [EXTENSIONS.md](EXTENSIONS.md). What each suite proves is written in its header and its group in [Running Tests](#running-tests); no hand-kept count or matrix is kept here, because one goes stale with every added check.

**When to update tests:**

- Extension added or changed → its behaviour check in `scripts/docker/test-image-lib.ts`, and a regression directory if its SQL output is worth pinning ([tests/regression/extensions/README.md](../tests/regression/extensions/README.md))
- Auto-config logic changed → `scripts/test/test-auto-config.ts` and `scripts/test/test-auto-config-units.test.ts`

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

| Group        | Proves                                                                               |
| ------------ | ------------------------------------------------------------------------------------ |
| `extensions` | every enabled extension and tool works in the image; disabled ones are absent        |
| `security`   | authentication, roles, pgAudit and network binding defaults                          |
| `stacks`     | the compose stacks (PgBouncer, exporters, replica) in private staged copies          |
| `features`   | auto-config, backup/restore, pgflow and its upgrade command, pg_cron, error handling |
| `regression` | each enabled extension's SQL against its expected output, and extension interactions |
| `nightly`    | the same in regression mode (optional preloads added); weekly workflow only          |

Suites run in parallel up to the CPU count, each in its own process with its own containers, volumes, networks and ports, so order and neighbours must not matter (`--shuffle` checks that). Each suite's full output is printed when it finishes; any failed suite makes the run exit 1.

### Adding a Test

- **Docker-free unit test:** `scripts/**/<name>.test.ts`; `bun run validate` finds it by glob.
- **Docker suite:** `scripts/**/test-<name>.ts` plus one `{ path, group }` line in `SUITES`. `validate` fails while a `test-*.ts` file is neither in `SUITES` nor imported or run by a suite that is (`scripts/validate/check-suite-registry.ts`), and when a workflow starts a suite file itself. A file that imports `bun:test` is run with `bun test` automatically.
- **Image:** read it with `resolveImageTag()` from `scripts/test/image-resolver.ts` (argument, `--image=`, then `POSTGRES_IMAGE`); `test-all.ts` passes `POSTGRES_IMAGE`.
- **Docker names:** name every container, volume, network and compose project with `generateUniqueContainerName`/`generateUniqueProjectName` from `scripts/utils/docker.ts`, or a string built from one. They carry the suite's test-all scope, so test-all removes whatever a killed suite left and fails a passing suite that left anything; a hand-built name escapes both and collides across concurrent runs.

## References

- **Extension tests:** `scripts/docker/test-image-lib.ts` (run by `scripts/docker/test-image.ts`)
- **Auto-config tests:** `scripts/test/test-auto-config.ts`
- **PgBouncer tests:** `scripts/test/test-pgbouncer-healthcheck.ts` (happy path)
- **PgBouncer failure tests:** `scripts/test/test-pgbouncer-failures.ts` (PgBouncer entrypoint input rejections)
- **Hook extension tests:** `scripts/test/test-hook-extensions.ts`
- **Replica stack tests:** `scripts/test/test-replica-stack.ts` (replication validation)
- **Single stack tests:** `scripts/test/test-single-stack.ts` (standalone validation)
- **Image test harness:** `scripts/docker/test-image.ts` (comprehensive image validation)
- **Extension manifest:** `docker/postgres/extensions.manifest.json`
- **Auto-config entrypoint:** `docker/postgres/docker-auto-config-entrypoint.sh`
- **Init Order**: `docker/postgres/docker-entrypoint-initdb.d/` for extension creation sequence

---

**Key Takeaway**: When testing session-local PostgreSQL features (LOAD, SET, HypoPG, TEMP tables), always use multi-statement SQL blocks within a single `runSQL()` call. This preserves session state and prevents "feature not active" or "object not found" errors.
