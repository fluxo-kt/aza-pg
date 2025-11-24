# Regression Testing

Comprehensive regression testing framework for aza-pg PostgreSQL infrastructure.

## Overview

The regression testing system provides multi-tier validation to ensure correctness, reliability, and robustness of PostgreSQL and extensions across release lifecycle.

**Test Coverage:**

- **Tier 1**: Core PostgreSQL regression (30 official tests from postgres/postgres)
- **Tier 2**: Extension-specific regression (13 extensions, SQL-based tests)
- **Tier 3**: Extension interaction tests (14 interaction scenarios)
- **Tier 4**: pgTAP unit tests (82 SQL-based tests)

**Dual-Mode Architecture:**

- **Production mode**: Tests exact release image behavior (enabled extensions from manifest)
- **Regression mode**: Tests all catalog entries including disabled extensions (comprehensive coverage)

## Quick Start

```bash
# Run all regression tests (production mode)
bun test:regression:all

# Run specific tier
bun test:regression:core        # Tier 1: PostgreSQL core
bun test:regression:extensions  # Tier 2: Extension tests
bun test:regression:interactions # Tier 3: Interaction tests

# Run in regression mode (all extensions)
TEST_MODE=regression bun test:regression:all

# Use master runner for advanced options
bun scripts/test/run-all-regression-tests.ts --help
```

## Test Modes

### Production Mode

Tests exact release image behavior with enabled extensions only.

**Configuration:**

- Extensions: Enabled extensions from manifest (runtime.defaultEnable=true)
- Preload libraries: 6 default (auto_explain, pg_cron, pg_stat_monitor, pg_stat_statements, pgaudit, timescaledb)
- Image: `aza-pg:pg18` (production Dockerfile)

**Use cases:**

- Pre-release validation
- CI/CD fast feedback
- Release candidate testing

**Activation:**

```bash
# Default mode
bun test:regression:all

# Explicit
TEST_MODE=production bun test:regression:all
bun scripts/test/run-all-regression-tests.ts --mode=production
```

### Regression Mode

Tests all extensions including disabled ones for comprehensive coverage.

**Configuration:**

- Extensions: All catalog entries from manifest (both enabled and disabled for comprehensive testing)
- Preload libraries: 10 total (6 default + 4 optional: safeupdate, pgsodium, set_user, pg_partman)
- Image: `aza-pg:pg18-regression` (separate regression.Dockerfile)
- pgTAP: Pre-installed for SQL unit testing

**Use cases:**

- Comprehensive nightly testing
- Extension compatibility validation
- Pre-deployment full validation

**Activation:**

```bash
TEST_MODE=regression bun test:regression:all
bun scripts/test/run-all-regression-tests.ts --mode=regression

# Build regression image
bun scripts/build.ts --regression
```

## Test Tiers

### Tier 1: Core PostgreSQL Regression

Official PostgreSQL regression tests from postgres/postgres repository.

**Coverage:** 30 critical tests

- Data types: boolean, int2, int4, int8, float4, float8, numeric, text, varchar
- Operations: select, insert, update, delete, join, union, subselect
- Features: constraints, triggers, indexes, transactions, aggregates, copy, prepare
- Advanced: json, jsonb, arrays, strings, btree_index

**Runner:** `scripts/test/test-postgres-core-regression.ts`

**Usage:**

```bash
# Run all 30 tests
bun test:regression:core

# Run specific tests
bun scripts/test/test-postgres-core-regression.ts --tests=boolean,int2,int4

# Fast mode (4 tests only)
bun scripts/test/test-postgres-core-regression.ts --fast

# Generate diffs for failures
bun scripts/test/test-postgres-core-regression.ts --generate-diffs
```

**Test Lifecycle:**

1. Auto-fetch missing tests from GitHub (cached locally)
2. Start temporary PostgreSQL container
3. Execute tests via psql
4. Normalize output (platform variations)
5. Compare against expected output
6. Generate regression.diffs for failures

**Test Location:** `tests/regression/core/pg-official/`

### Tier 2: Extension Regression

Extension-specific functionality tests.

**Coverage:** 13 extensions

- Production (10): vector, timescaledb, pgmq, pg_cron, pg_stat_monitor, pgsodium, timescaledb_toolkit, pgaudit, hypopg, pg_trgm
- Regression-only (3): postgis, pgrouting, pgq

**Runner:** `scripts/test/test-extension-regression.ts`

**Usage:**

```bash
# Run all extension tests
bun test:regression:extensions

# Run specific extensions
bun scripts/test/test-extension-regression.ts --extensions=vector,timescaledb

# Generate expected outputs
bun scripts/test/test-extension-regression.ts --generate-expected

# Verbose mode
bun scripts/test/test-extension-regression.ts --verbose
```

**Test Structure:**

```
tests/regression/extensions/{extension}/
├── sql/
│   └── basic.sql           # Extension test SQL
└── expected/
    └── basic.out           # Expected output
```

**Extension Test Examples:**

```sql
-- tests/regression/extensions/vector/sql/basic.sql
CREATE EXTENSION vector;
CREATE TABLE items (embedding vector(3));
INSERT INTO items VALUES ('[1,2,3]'), ('[4,5,6]');
SELECT * FROM items ORDER BY embedding <-> '[3,1,2]' LIMIT 1;
```

### Tier 3: Extension Interaction Tests

Tests combinations of extensions and edge cases.

**Coverage:** 14 interaction scenarios

- Production (4): TimescaleDB+pgvector, hypopg+pg_stat_statements, pgsodium+vault, all preloads
- Regression (+10): PostGIS combinations, partition compatibility, etc.

**Runner:** `scripts/test/test-extension-interactions.ts`

**Usage:**

```bash
# Run all interaction tests
bun test:regression:interactions

# Verbose mode
bun scripts/test/test-extension-interactions.ts --verbose
```

**Interaction Test Examples:**

```typescript
// TimescaleDB + pgvector: Time-series vector search
await client.query(`CREATE EXTENSION timescaledb CASCADE`);
await client.query(`CREATE EXTENSION vector`);
await client.query(`
  CREATE TABLE ts_vectors (
    time TIMESTAMPTZ NOT NULL,
    embedding vector(3)
  )
`);
await client.query(`SELECT create_hypertable('ts_vectors', 'time')`);
```

### Tier 4: pgTAP Unit Tests

SQL-based unit tests using pgTAP framework.

**Coverage:** 82 tests across 5 files

- `01_extensions_availability.sql` (15 tests): Extension availability
- `02_schema_and_objects.sql` (20 tests): Schema, tables, functions, triggers
- `03_vector_extension.sql` (12 tests): pgvector functionality
- `04_timescaledb_extension.sql` (15 tests): TimescaleDB time-series
- `05_security_and_permissions.sql` (20 tests): Roles, RLS, permissions

**Location:** `tests/regression/pgtap/`

**Usage:**

```bash
# Using psql
psql -U postgres -d test_db -f tests/regression/pgtap/01_extensions_availability.sql

# Using pg_prove (TAP harness)
pg_prove -U postgres -d test_db tests/regression/pgtap/*.sql

# In Docker container
docker exec pg-regression psql -U postgres -f /tests/regression/pgtap/01_extensions_availability.sql
```

**Test Structure:**

```sql
BEGIN;
SELECT plan(15);

SELECT has_extension('vector', 'pgvector should be available');
SELECT has_table('public', 'test_table', 'table should exist');
SELECT is(2 + 2, 4, 'arithmetic should work');

SELECT * FROM finish();
ROLLBACK;
```

## Master Test Runner

Orchestrates all regression test tiers with flexible execution modes.

**Script:** `scripts/test/run-all-regression-tests.ts`

**Options:**

```bash
--mode=MODE           # Test mode: production or regression (default: production)
--tier=TIER           # Run specific tier only: 1, 2, or 3
--fast                # Skip slow tests (use minimal test sets)
--no-cleanup          # Don't cleanup containers after tests
--generate-expected   # Generate expected outputs for extension tests
--verbose             # Show detailed output
--help                # Show help message
```

**Examples:**

```bash
# All tiers, production mode
bun scripts/test/run-all-regression-tests.ts

# All tiers, regression mode
bun scripts/test/run-all-regression-tests.ts --mode=regression
TEST_MODE=regression bun scripts/test/run-all-regression-tests.ts

# Tier 1 only, fast mode (PR validation)
bun scripts/test/run-all-regression-tests.ts --tier=1 --fast

# Generate expected outputs for Tier 2
bun scripts/test/run-all-regression-tests.ts --tier=2 --generate-expected

# Verbose output for debugging
bun scripts/test/run-all-regression-tests.ts --verbose
```

## CI/CD Integration

### PR Validation (ci.yml)

Fast feedback for pull requests.

**Strategy:**

- Tier 1 only (fast mode): ~2-3 minutes
- Production mode only
- 4 core tests: boolean, int2, int4, select

**Trigger:** All PRs

### Release Validation (regression-tests.yml)

Comprehensive validation for release candidates.

**Strategy:**

- All tiers (Tier 1-3)
- Production mode
- Full test sets
- Duration: ~10-15 minutes

**Trigger:** Manual dispatch, release tags

### Nightly Regression (nightly-regression.yml)

Comprehensive nightly testing for early issue detection.

**Strategy:**

- All tiers (Tier 1-4)
- Regression mode (all extensions)
- pgTAP tests included
- Duration: ~20-30 minutes

**Trigger:** Nightly schedule (2 AM UTC)

## Docker Images

### Production Image

**Image:** `aza-pg:pg18`
**Dockerfile:** `docker/postgres/Dockerfile`
**Extensions:** Enabled from manifest (runtime.defaultEnable=true)
**Preloads:** 6 default
**pgTAP:** Not included

**Build:**

```bash
bun scripts/build.ts
```

### Regression Test Image

**Image:** `aza-pg:pg18-regression`
**Dockerfile:** `docker/postgres/regression.Dockerfile`
**Extensions:** All catalog entries from manifest (comprehensive coverage)
**Preloads:** 10 total (default + optional)
**pgTAP:** Pre-installed v1.3.3

**Build:**

```bash
bun scripts/build.ts --regression
```

**Features:**

- Separate Dockerfile (no production contamination)
- All extensions enabled (including postgis, pgrouting, pgq)
- All optional preload libraries configured
- testMode marker in `/etc/postgresql/version-info.json`

**Verification:**

```bash
docker run --rm aza-pg:pg18-regression cat /etc/postgresql/version-info.json | jq .testMode
# Output: "regression"

docker run --rm aza-pg:pg18-regression psql -U postgres -c "CREATE EXTENSION pgtap;"
# Output: CREATE EXTENSION
```

## Test Mode Detection

Tests automatically detect mode from:

1. `TEST_MODE` environment variable
2. `/etc/postgresql/version-info.json` (if in container)
3. Default: production

**Implementation:** `scripts/test/lib/test-mode.ts`

```typescript
import { detectTestMode, getEnabledExtensions } from "./lib/test-mode.ts";

const mode = await detectTestMode();
const extensions = getEnabledExtensions(mode);
```

**version-info.json:**

```json
{
  "postgresVersion": "18.1",
  "pgMajor": "18",
  "buildDate": "2025-11-24T...",
  "vcsRef": "abc123",
  "testMode": "regression"
}
```

## Test Output Normalization

Regression tests handle platform-specific output variations.

**Normalizations:**

- Line endings (CRLF → LF)
- psql prompts and formatting
- Floating-point precision
- Timestamp formats
- Whitespace normalization

**Implementation:** `scripts/test/lib/output-normalizer.ts`

## Generating Expected Outputs

Extension tests require expected output files for comparison.

**Generate for all extensions:**

```bash
bun scripts/test/test-extension-regression.ts --generate-expected
```

**Generate for specific extensions:**

```bash
bun scripts/test/test-extension-regression.ts --extensions=vector,timescaledb --generate-expected
```

**Process:**

1. Start production image container
2. Run extension test SQL
3. Capture normalized output
4. Write to `tests/regression/extensions/{ext}/expected/basic.out`

## Debugging Test Failures

### View Detailed Output

```bash
# Verbose mode
bun scripts/test/test-postgres-core-regression.ts --verbose

# Generate diffs
bun scripts/test/test-postgres-core-regression.ts --generate-diffs
cat tests/regression/core/regression.diffs
```

### Test Locally

```bash
# Start container with test image
docker run --name pg-test -d -e POSTGRES_PASSWORD=postgres aza-pg:pg18-regression

# Run test manually
docker exec -it pg-test psql -U postgres -f /tests/regression/pgtap/01_extensions_availability.sql

# Cleanup
docker stop pg-test && docker rm pg-test
```

### Common Issues

**Extension not available:**

- Check test mode (production vs regression)
- Verify extension enabled in manifest
- Regenerate Dockerfile: `bun run generate`

**Output mismatch:**

- Platform-specific output (locale, timezone)
- Regenerate expected outputs: `--generate-expected`
- Check output normalizer coverage

**Container startup failure:**

- Check Docker resources (memory, CPU)
- Review container logs: `docker logs <container>`
- Verify image built correctly: `docker images | grep aza-pg`

## Best Practices

### Test Development

1. **Test isolation**: Use transactions (BEGIN/ROLLBACK) for cleanup
2. **Deterministic data**: Use fixed timestamps, sorted results
3. **Clear assertions**: Descriptive test names and error messages
4. **Mode awareness**: Adapt tests to production/regression modes

### CI/CD Strategy

1. **Fast feedback**: Use Tier 1 fast mode for PRs (~2-3 min)
2. **Release validation**: Full test suite before releases (~10-15 min)
3. **Nightly regression**: Comprehensive testing for early detection (~20-30 min)
4. **Parallel execution**: Run independent tiers in parallel when possible

### Maintenance

1. **Update expected outputs**: After PostgreSQL version upgrades
2. **Add new tests**: When adding extensions or features
3. **Review failures**: Investigate all regression test failures immediately
4. **Keep tests fast**: Optimize slow tests, use minimal data sets

## References

- [PostgreSQL Regression Tests](https://www.postgresql.org/docs/current/regress.html)
- [pgTAP Documentation](https://pgtap.org/)
- [TAP Protocol](https://testanything.org/)
- [Testing Best Practices](https://wiki.postgresql.org/wiki/Testing)

## Package.json Scripts

```json
{
  "test:regression:core": "bun scripts/test/test-postgres-core-regression.ts",
  "test:regression:extensions": "bun scripts/test/test-extension-regression.ts",
  "test:regression:interactions": "bun scripts/test/test-extension-interactions.ts",
  "test:regression:all": "bun scripts/test/run-all-regression-tests.ts",
  "test:regression:production": "TEST_MODE=production bun test:regression:all",
  "test:regression:comprehensive": "TEST_MODE=regression bun test:regression:all"
}
```

## Architecture Decisions

### Separate Dockerfile for Regression

**Decision:** Use `regression.Dockerfile` instead of multi-stage target in production Dockerfile.

**Rationale:**

- Production builds unaffected (no regression artifacts)
- Better layer caching (independent build paths)
- Cleaner separation of concerns
- CI can build images in parallel

### Dual-Mode Testing

**Decision:** Single test codebase adapts to production/regression modes.

**Rationale:**

- Reduces duplication
- Tests self-documenting (mode-aware assertions)
- Easy mode switching (environment variable)
- Comprehensive coverage without separate test suites

### Four-Tier Test Structure

**Decision:** Tier 1 (PostgreSQL core), Tier 2 (Extensions), Tier 3 (Interactions), Tier 4 (pgTAP).

**Rationale:**

- Incremental validation (fast feedback → comprehensive coverage)
- Clear separation of concerns
- Flexible CI/CD strategies (fast PR → full release → nightly)
- Easy to add new tests within appropriate tier
