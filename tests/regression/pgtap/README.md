# pgTAP Regression Tests

SQL-based unit tests using pgTAP for PostgreSQL and extension functionality.

## Overview

pgTAP is a TAP-compliant testing framework for PostgreSQL. These tests verify core PostgreSQL functionality, extension behavior, and security features.

## Test Files

| File                              | Description                                  | Tests |
| --------------------------------- | -------------------------------------------- | ----- |
| `01_extensions_availability.sql`  | Extension availability verification          | 15    |
| `02_schema_and_objects.sql`       | Schema, tables, functions, triggers          | 20    |
| `03_vector_extension.sql`         | pgvector functionality and similarity search | 12    |
| `04_timescaledb_extension.sql`    | TimescaleDB hypertables and time-series      | 15    |
| `05_security_and_permissions.sql` | Roles, RLS, permissions, audit               | 20    |

**Total: 82 tests**

## Running Tests

### Using psql

```bash
# Run all pgTAP tests
psql -U postgres -d test_db -f tests/regression/pgtap/01_extensions_availability.sql

# Run specific test file
psql -U postgres -d test_db -f tests/regression/pgtap/03_vector_extension.sql
```

### Using pg_prove

```bash
# Install pg_prove (if not already installed)
sudo cpan TAP::Parser::SourceHandler::pgTAP

# Run all tests
pg_prove -U postgres -d test_db tests/regression/pgtap/*.sql

# Run specific test
pg_prove -U postgres -d test_db tests/regression/pgtap/03_vector_extension.sql

# Verbose output
pg_prove -v -U postgres -d test_db tests/regression/pgtap/*.sql
```

### In Docker Container

```bash
# Start regression test image
docker run --name pg-regression -d -e POSTGRES_PASSWORD=postgres aza-pg:pg18-regression

# Run tests
docker exec pg-regression psql -U postgres -c "CREATE EXTENSION pgtap;"
docker exec pg-regression psql -U postgres -f /tests/regression/pgtap/01_extensions_availability.sql
```

## Test Modes

- **Production Mode**: Tests enabled extensions only (24 extensions)
- **Regression Mode**: Tests all extensions including disabled ones (27 extensions)

Some tests automatically adapt based on available extensions (e.g., `age`, `pgq`, `postgis` are regression-only).

## Test Structure

Each test file follows this structure:

```sql
BEGIN;

SELECT plan(N);  -- Declare number of tests

-- Test assertions
SELECT has_extension('vector', 'pgvector should be available');
SELECT is(2 + 2, 4, 'arithmetic should work');
SELECT ok(condition, 'description');

SELECT * FROM finish();

ROLLBACK;
```

## pgTAP Assertions Used

- **Schema**: `has_schema()`, `schema_owner_is()`
- **Tables**: `has_table()`, `has_column()`, `col_not_null()`, `col_is_unique()`
- **Indexes**: `has_index()`, `has_pk()`
- **Functions**: `has_function()`, `function_returns()`, `function_lang_is()`
- **Triggers**: `has_trigger()`
- **Extensions**: `has_extension()`
- **Permissions**: `schema_privs_are()`, `table_privs_are()`
- **Roles**: `has_role()`, `is_superuser()`, `isnt_superuser()`
- **General**: `ok()`, `is()`, `isnt()`, `pass()`, `skip()`

## Requirements

- PostgreSQL 18.x
- pgTAP extension (pre-installed in regression test image)
- Enabled extensions (varies by test mode)

## References

- [pgTAP Documentation](https://pgtap.org/)
- [TAP Protocol](https://testanything.org/)
- [PostgreSQL Testing Best Practices](https://wiki.postgresql.org/wiki/Testing)
