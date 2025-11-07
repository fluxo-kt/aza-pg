# Extension Testing Strategy

## Current State

**CI Testing Coverage:**
- Only 5 baseline extensions are tested in CI:
  - `pg_stat_statements` (builtin)
  - `pgvector` (compiled)
  - `pg_cron` (PGDG)
  - `pgaudit` (PGDG)
  - `pg_trgm` (builtin)

**Test Script:** `scripts/test/test-extensions.ts`

**What's Tested:**
1. `CREATE EXTENSION` succeeds
2. Basic functional query works (e.g., vector distance, cron job scheduling)
3. Extension shows in `pg_available_extensions`

## Testing Gap

**Problem:** 33 of 38 extensions are built but never verified:
- 17 compiled-from-source extensions (beyond pgvector)
- 14 PGDG extensions (beyond pg_cron/pgaudit)
- 2 builtin extensions (beyond pg_stat_statements/pg_trgm)

**Risk:**
- Build failures may go unnoticed (compilation succeeds but extension broken)
- Version mismatches discovered only in production
- Missing dependencies not caught until runtime

**Current Workaround:**
- Manual testing during development
- Production smoke tests after deployment
- Assumed correctness if build succeeds

## Proposed Strategy

### 1. Matrix Testing Approach

Test all 38 extensions across three dimensions:
1. **CREATE EXTENSION**: Load extension successfully
2. **Functional test**: Extension-specific smoke test
3. **Metadata check**: Verify version matches expected

### 2. Extension-Specific Smoke Tests

**Compiled Extensions (17):**
- **pg_jsonschema**: Validate JSON against schema
- **index_advisor**: Analyze query for index suggestions
- **pg_hashids**: Encode/decode hashid
- **pg_plan_filter**: Check GUC setting (hook-based, no CREATE EXTENSION)
- **pg_safeupdate**: Verify UPDATE protection (hook-based)
- **pg_stat_monitor**: Query `pg_stat_monitor` view
- **pgbackrest**: Check binary exists and version
- **pgbadger**: Verify binary exists
- **pgmq**: Create queue and send message
- **pgroonga**: Create GIN index on text column
- **pgsodium**: Generate random bytes
- **supabase_vault**: Create secret and verify encryption
- **supautils**: Check GUC settings (hook-based)
- **timescaledb_toolkit**: Use a toolkit function
- **vectorscale**: Create vector index
- **wal2json**: Check plugin is available (no CREATE EXTENSION)
- **wrappers**: Create foreign data wrapper

**PGDG Extensions (13 remaining):**
- **timescaledb**: Create hypertable
- **postgis**: Query geometry functions
- **pg_partman**: Create partitioned table
- **pg_repack**: Check binary exists
- **plpgsql_check**: Check function body
- **hll**: Create HyperLogLog
- **http**: Fetch URL (http_get)
- **hypopg**: Create hypothetical index
- **pgrouting**: Query routing function
- **rum**: Create RUM index
- **set_user**: Check SET ROLE behavior

**Builtin Extensions (4 remaining):**
- **btree_gist**: Create GiST index
- **citext**: Test case-insensitive text
- **pgcrypto**: Hash password
- **uuid-ossp**: Generate UUID

### 3. Test Organization

**File Structure:**
```
scripts/test/
├── test-extensions.ts (orchestrator)
├── test-all-extensions-functional.ts (comprehensive smoke tests)
├── test-extension-performance.ts (performance benchmarks)
├── test-integration-extension-combinations.ts (integration tests)
└── run-extension-smoke.sh (helper script)
```

**Test Format:**
```bash
test_extension() {
  local ext_name="$1"
  local test_sql="$2"

  psql -c "CREATE EXTENSION IF NOT EXISTS $ext_name;"
  psql -c "$test_sql"

  # Verify version matches manifest.json
  verify_extension_version "$ext_name"
}
```

### 4. CI Integration

**Add to `.github/workflows/test.yml`:**
```yaml
- name: Test all extensions
  run: |
    bun run scripts/test/test-extensions.ts --all
```

**Matrix dimensions:**
- Platform: `linux/amd64`, `linux/arm64`
- Extension kind: `compiled`, `pgdg`, `builtin`

### 5. Performance Considerations

**Parallel execution:**
- Independent extensions tested concurrently
- ~10-15 minutes for full test suite (vs 30+ minutes sequential)

**Failure handling:**
- Continue testing other extensions on failure
- Report all failures at end (don't exit early)
- Mark flaky tests with retry logic

### 6. Maintenance

**When to update tests:**
- New extension added to manifest.json → add smoke test
- Extension version upgraded → verify test still valid
- Upstream API changes → update functional test

**Who maintains:**
- Developer adding extension writes smoke test
- CI enforces test exists before merge

## Implementation Plan

**Phase 1: Foundation (1-2 days)**
- Extract existing 5 tests into modular format
- Create test helper utilities
- Set up parallel test runner

**Phase 2: Expand Coverage (3-5 days)**
- Add smoke tests for 32 remaining extensions
- Verify all tests pass locally
- Document test expectations

**Phase 3: CI Integration (1 day)**
- Update GitHub Actions workflow
- Add test coverage reporting
- Set up failure notifications

**Phase 4: Hardening (ongoing)**
- Monitor flaky tests
- Add retry logic where needed
- Refine smoke tests based on production issues

## Deferred to Future Work

**Not in scope for immediate implementation:**
- Performance benchmarking (query speed, index build time)
- Stress testing (high load, connection pooling)
- Integration testing (multi-extension interactions)
- Security testing (SQL injection, privilege escalation)

**Rationale:**
- Focus on correctness first (does extension load?)
- Avoid scope creep (testing strategy, not full QA suite)
- Ship incremental improvements (baseline → comprehensive over time)

## References

- **Current test script:** `scripts/test/test-extensions.ts`
- **Extension manifest:** `docker/postgres/extensions.manifest.json`
- **Audit finding:** `VERIFICATION_REPORT.md` finding #23

---

**Status:** Documented strategy, implementation deferred to future work.

**Last Updated:** 2025-11-05
