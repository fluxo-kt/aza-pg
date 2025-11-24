# Extension Regression Tests (Tier 2)

Deterministic regression tests for PostgreSQL extensions using SQL + expected output comparison (pg_regress pattern).

## Structure

```
extensions/
├── {extension-name}/
│   ├── sql/
│   │   └── basic.sql      # SQL test commands
│   └── expected/
│       └── basic.out      # Expected psql output
└── README.md
```

## Test Coverage

### Production Mode (Top 10 Extensions)

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

### Comprehensive Mode (Additional 3 Extensions)

11. **postgis** - Spatial data types and operations
12. **pgrouting** - Graph routing algorithms (Dijkstra)
13. **pgq** - High-performance queue operations

## Generating Expected Outputs

Expected output files must be generated from a known-good build:

```bash
# Build production image
bun run build

# Generate expected outputs for production extensions
bun scripts/test/test-extension-regression.ts --mode=production --generate-expected

# Generate expected outputs for comprehensive extensions (requires comprehensive build)
bun scripts/test/test-extension-regression.ts --mode=comprehensive --generate-expected
```

**IMPORTANT**: Expected outputs are deterministic and should be committed to the repository.
They serve as the regression baseline for future test runs.

## Running Tests

### Production Mode

```bash
# Test top 10 production extensions
bun scripts/test/test-extension-regression.ts --mode=production
```

### Comprehensive Mode

```bash
# Test all extensions (requires comprehensive build with postgis, pgrouting, pgq enabled)
bun scripts/test/test-extension-regression.ts --mode=comprehensive
```

### Specific Extensions

```bash
# Test specific extensions only
bun scripts/test/test-extension-regression.ts --extensions=vector,timescaledb,pg_cron
```

### Using Existing Container

```bash
# Use existing running container
bun scripts/test/test-extension-regression.ts --container=my-postgres-container
```

## Test Design Principles

1. **Simplicity**: Each test is < 50 lines of SQL, focuses on core functionality
2. **Determinism**: No random values, timestamps use fixed dates, outputs are predictable
3. **Self-contained**: Tests create and clean up their own data
4. **Basic coverage**: Tests verify extension works, not comprehensive feature coverage

## Adding New Extension Tests

1. Create directory: `tests/regression/extensions/{extension-name}/{sql,expected}/`
2. Write SQL test: `sql/basic.sql` (see existing tests as templates)
3. Generate expected output: `--generate-expected` flag
4. Add extension to `TOP_10_EXTENSIONS` or `COMPREHENSIVE_ONLY_EXTENSIONS` in `test-extension-regression.ts`
5. Commit SQL + expected output files

## Test Execution Details

- Uses `psql -X -a -q` for consistent output format
- Output normalization handles psql formatting variations
- Diff generation uses `diff -c` (context diff) for readability
- Failed tests generate `extension-regression.diffs` file

## Related Documentation

- **Tier 1 Tests**: `tests/regression/core/` - PostgreSQL core regression tests
- **Functional Tests**: `scripts/test/test-all-extensions-functional.ts` - 117+ extension tests
- **Regression Runner**: `scripts/test/lib/regression-runner.ts` - Shared test infrastructure
