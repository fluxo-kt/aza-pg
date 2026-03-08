# Regression Expected Outputs

This file documents the status of regression expected output files (`expected/basic.out`).

## Generation Instructions

To regenerate expected output files from a known-good build:

```bash
# 1. Build production image
bun run build

# 2. Generate expected outputs
bun scripts/test/test-extension-regression.ts --mode=production --generate-expected
```

## Extension Coverage

### Nightly Test Set (Top 10 — run in CI nightly)

These extensions have generated and verified expected outputs:

- **vector** — `expected/basic.out` ✓
- **timescaledb** — `expected/basic.out` ✓
- **pg_cron** — `expected/basic.out` ✓
- **pgsodium** — `expected/basic.out` ✓
- **pgaudit** — `expected/basic.out` ✓
- **pg_stat_monitor** — `expected/basic.out` ✓
- **hypopg** — `expected/basic.out` ✓
- **pg_trgm** — `expected/basic.out` ✓
- **pgmq** — `expected/basic.out` ✓
- **timescaledb_toolkit** — `expected/basic.out` ✓

### Also Generated (in nightly or comprehensive test sets)

- **hll** — `expected/basic.out` ✓
- **pg_net** — `expected/basic.out` ✓
- **pg_partman** — `expected/basic.out` ✓
- **pgrouting** — `expected/basic.out` ✓ (comprehensive mode only — requires PostGIS)
- **pgq** — `expected/basic.out` ✓ (comprehensive mode only — disabled extension)
- **pgsodium** — `expected/basic.out` ✓
- **postgis** — `expected/basic.out` ✓ (comprehensive mode only — disabled, too large)
- **supabase_vault** — `expected/basic.out` ✓
- **vectorscale** — `expected/basic.out` ✓
- **wrappers** — `expected/basic.out` ✓

## Notes

- Expected outputs are deterministic — non-deterministic values (`random()`, `now()`) are avoided in SQL tests
- All SQL test files (`sql/basic.sql`) must have matching `expected/basic.out` files
- **Version strings are hard-coded in `.out` files** — update when upgrading extensions (see AGENTS.md Gotchas)
- Disabled extensions (postgis, pgrouting, pgq) have expected outputs reflecting "extension not available" errors — those tests are never run in production or nightly modes
