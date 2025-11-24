# PostgreSQL Official Regression Tests

This directory contains cached PostgreSQL regression tests fetched from the official postgres/postgres repository.

## Structure

```
pg-official/
├── sql/          # SQL test files (fetched from src/test/regress/sql/)
├── expected/     # Expected output files (fetched from src/test/regress/expected/)
└── README.md     # This file
```

## Fetching Tests

Tests are fetched on-demand and cached locally. To fetch tests:

```bash
# Fetch all default tests (~30 core tests)
bun scripts/ci/fetch-pg-regression-tests.ts

# Fetch specific tests
bun scripts/ci/fetch-pg-regression-tests.ts --tests=boolean,int2,int4

# Force re-download (ignore cache)
bun scripts/ci/fetch-pg-regression-tests.ts --force
```

## Source

- Repository: `postgres/postgres`
- Branch: `REL_18_STABLE`
- Path: `src/test/regress/`

## Cache Policy

Test files are **not committed** to the repository (see `.gitignore`).

They are:

- Fetched automatically when running tests (if missing)
- Cached locally for faster subsequent runs
- Safe to delete (will be re-fetched as needed)

## Default Test Set

The default set includes ~30 critical PostgreSQL regression tests covering:

- **Data types**: boolean, int2, int4, int8, float4, float8, numeric, text, varchar
- **Core operations**: select, insert, update, delete, join, union, subselect
- **Essential features**: constraints, triggers, create_index, create_table, transactions, aggregates, copy, prepare
- **Advanced features**: json, jsonb, arrays, strings, numerology, btree_index

See `scripts/ci/fetch-pg-regression-tests.ts` for the complete list.
