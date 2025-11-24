# Expected Output Generation Status

This file tracks which extension regression tests have generated expected outputs.

## Generation Instructions

Expected output files (`.out`) must be generated from a clean, known-good build:

```bash
# 1. Build production image
bun run build

# 2. Generate expected outputs for production mode
bun scripts/test/test-extension-regression.ts --mode=production --generate-expected

# 3. For regression mode (requires PostGIS/pgRouting/PgQ enabled)
# Edit scripts/extensions/manifest-data.ts to enable postgis, pgrouting, pgq
# bun run generate && bun run build
# bun scripts/test/test-extension-regression.ts --mode=comprehensive --generate-expected
```

## Status

### Production Extensions (Top 10)

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

### Comprehensive-Only Extensions

- [ ] **postgis** - `expected/basic.out` - NEEDS GENERATION (requires comprehensive build)
- [ ] **pgrouting** - `expected/basic.out` - NEEDS GENERATION (requires comprehensive build)
- [ ] **pgq** - `expected/basic.out` - NEEDS GENERATION (requires comprehensive build)

## Notes

- Expected outputs are deterministic and should remain stable across builds
- Non-deterministic values (random(), now()) avoided in tests
- All SQL test files (`sql/basic.sql`) are ready and committed
- Expected outputs will be generated during next production build validation
