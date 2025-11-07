# Testing Documentation

Test suites and validation procedures for aza-pg PostgreSQL stack.

## Test Scripts

### PgBouncer Tests

**Location:** `scripts/test/`

#### Happy Path Tests
- **File:** `test-pgbouncer-healthcheck.sh`
- **Purpose:** Validates PgBouncer authentication, connection pooling, and healthcheck in normal operation
- **Scenarios:** 8 tests covering `.pgpass` creation, correct permissions, localhost/network auth, SHOW POOLS, healthcheck command
- **Runtime:** ~60-90s
- **Status:** Production-ready

#### Failure Scenario Tests
- **File:** `test-pgbouncer-failures.sh`
- **Documentation:** [PGBOUNCER-FAILURE-TESTS.md](PGBOUNCER-FAILURE-TESTS.md)
- **Purpose:** Validates error handling, security boundaries, and failure recovery
- **Scenarios:** 6 tests covering wrong password, missing `.pgpass`, invalid config, dependency handling, connection limits, permissions
- **Runtime:** ~3-5 minutes
- **Status:** Production-ready

## Test Categories

### Unit Tests
- Configuration validation (entrypoint scripts)
- Environment variable handling
- File permission enforcement

### Integration Tests
- PgBouncer ↔ PostgreSQL authentication flow
- Docker Compose dependency chains (`depends_on`)
- Healthcheck propagation

### Security Tests
- Password file permissions (0600 enforcement)
- Input validation (listen address regex)
- Authentication rejection (wrong credentials)
- Connection limit enforcement

### Failure Mode Tests
- Invalid configuration rejection
- Service unavailability handling
- Resource exhaustion (max connections)
- Credential mismatch scenarios

## Running Tests

### Quick Start

```bash
# From project root
./scripts/test/test-pgbouncer-healthcheck.sh    # Happy path
./scripts/test/test-pgbouncer-failures.sh       # Failure scenarios
```

### Prerequisites

- Docker daemon running
- Docker Compose v2 (`docker compose` command)
- `jq` installed for JSON parsing
- Local image built: `aza-pg:pg18`

### CI/CD Integration

**Current status:** Manual runs only

**Recommended for CI:**
1. Add to pre-release validation workflow
2. Trigger on PgBouncer config changes
3. Run after successful image build
4. Gate production deployments on test success

**Not in automated CI because:**
- Requires full Docker Compose environment
- Takes 3-5 minutes total (not fast unit tests)
- Needs Docker daemon and volume cleanup

## Test Isolation

All tests use unique Docker Compose project names:
- `aza-pg-healthcheck-test` (happy path)
- `pgbouncer-test-wrong-pass` (failure test 1)
- `pgbouncer-test-no-pgpass` (failure test 2)
- `pgbouncer-test-invalid-addr` (failure test 3)
- `pgbouncer-test-no-postgres` (failure test 4)
- `pgbouncer-test-max-conn` (failure test 5)
- `pgbouncer-test-pgpass-perms` (failure test 6)

**Benefits:**
- No state contamination between tests
- Can run tests in sequence without conflicts
- Automatic cleanup via `trap EXIT`

## Documentation

- [PGBOUNCER-FAILURE-TESTS.md](PGBOUNCER-FAILURE-TESTS.md) - Comprehensive failure test documentation

## Future Test Coverage

### Planned Tests

**Auto-config validation:**
- Memory detection accuracy (cgroup v2, manual override, /proc/meminfo fallback)
- CPU detection and worker scaling
- Config parameter calculation (shared_buffers, effective_cache, work_mem)

**Extension loading:**
- All 38 extensions CREATE EXTENSION success
- Functional queries per extension (vector search, cron jobs, audit logs)
- Extension upgrade paths (ALTER EXTENSION UPDATE)

**Replication tests:**
- Primary → Replica streaming replication
- Replication slot creation and consumption
- Failover scenarios (promote replica to primary)

**Backup/restore:**
- pgBackRest basic backup
- Point-in-time recovery (PITR)
- pg_dump/pg_restore validation

**Performance tests:**
- Connection pool saturation (default_pool_size + reserve_pool_size)
- Query throughput via PgBouncer vs direct connection
- Memory consumption under load

### Test Infrastructure Needs

**For auto-config tests:**
- Docker `--memory` flag variations (512m, 1g, 2g, 4g, 8g, 64g)
- Manual `POSTGRES_MEMORY` override testing
- Log parsing for detected RAM/CPU values

**For replication tests:**
- Multi-container stacks (primary + replica)
- Network partition simulation
- WAL shipping validation

**For performance tests:**
- pgbench integration
- Prometheus metrics collection
- Baseline performance data

## Troubleshooting

### Common Issues

**Test failure: PostgreSQL failed to start**
- Cause: Port conflict (previous test didn't cleanup)
- Fix: `docker ps -a | grep pgbouncer-test` and remove manually

**Test failure: PgBouncer container not found**
- Cause: Container exited immediately (config error)
- Fix: Check logs `docker compose -p <project> logs pgbouncer`

**Test failure: jq command not found**
- Cause: Missing dependency
- Fix: `brew install jq` (macOS) or `apt-get install jq` (Debian/Ubuntu)

### Cleanup

**Automatic cleanup:** Handled by `trap EXIT` in test scripts

**Manual cleanup:**
```bash
# Remove all test containers
docker ps -a --filter "name=pgbouncer-test" -q | xargs docker rm -f

# Remove test volumes
docker volume ls --filter "name=pgbouncer-test" -q | xargs docker volume rm

# Remove test env files
rm -f stacks/primary/.env.test-*
```

## Contributing

### Adding New Tests

1. Create test script in `scripts/test/`
2. Use unique `COMPOSE_PROJECT_NAME` per test
3. Source `scripts/lib/common.sh` for utilities
4. Implement `cleanup()` function with `trap EXIT`
5. Document in `docs/testing/` with comprehensive guide
6. Test locally before committing
7. Update this README with new test info

### Test Naming Convention

- `test-<component>-<aspect>.sh` (e.g., `test-pgbouncer-failures.sh`)
- Documentation: `<COMPONENT>-<ASPECT>-TESTS.md` (all caps)
- Project names: `<component>-test-<scenario>` (e.g., `pgbouncer-test-wrong-pass`)

### Quality Standards

- All tests must cleanup after themselves (volumes, containers, temp files)
- Tests must be idempotent (can run multiple times)
- Error messages must guide user to resolution
- Documentation must include troubleshooting section
- Test output must be parseable (clear PASS/FAIL/PARTIAL)

## Related Documentation

- [Architecture Overview](../CLAUDE.md) - PgBouncer auth pattern, auto-config logic
- [CI/CD Documentation](../ci/README.md) - Build pipeline integration
- [Extension Documentation](../extensions/) - Extension testing procedures

## Changelog

**2025-11-07**
- Added comprehensive PgBouncer failure scenario tests (6 tests)
- Created testing documentation structure
- Established test isolation patterns
- Documented troubleshooting procedures
