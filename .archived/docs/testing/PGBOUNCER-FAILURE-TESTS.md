# PgBouncer Failure Scenario Tests

Comprehensive test suite validating PgBouncer error handling, security boundaries, and failure recovery modes.

## Overview

**File:** `/opt/apps/art/infra/aza-pg/scripts/test/test-pgbouncer-failures.sh`

**Purpose:** Tests that PgBouncer properly handles failure scenarios, rejects invalid configurations, and provides meaningful error messages.

**Complement to:** `test-pgbouncer-healthcheck.sh` (happy path testing)

## Test Scenarios

### Test 1: Wrong Password Authentication

**What it tests:**

- Authentication fails when PgBouncer has wrong password for `pgbouncer_auth` user
- Proper error messages in logs when auth fails
- Database connection protection from unauthorized access

**How it works:**

1. Starts PostgreSQL with correct password
2. Creates `pgbouncer_auth` user
3. Alters user password in database to differ from `PGBOUNCER_AUTH_PASS` env var
4. Starts PgBouncer with mismatched password
5. Attempts connection through PgBouncer
6. Validates connection fails
7. Checks logs for authentication error messages

**Expected behavior:**

- ❌ Connection via PgBouncer fails
- ✅ Logs contain authentication/login/password error messages
- ✅ Database remains protected from unauthorized pooled connections

**Why it matters:**

- Prevents PgBouncer from proxying connections with stale/wrong credentials
- Validates SCRAM-SHA-256 authentication enforcement
- Tests password sync mechanism between env vars and database

---

### Test 2: Missing .pgpass File

**What it tests:**

- PgBouncer connections fail when `.pgpass` file is deleted/missing
- Healthcheck relies on `.pgpass` for authentication
- Password file dependency is clear

**How it works:**

1. Starts PostgreSQL and PgBouncer normally (both healthy)
2. Removes `/tmp/.pgpass` from PgBouncer container
3. Unsets `PGPASSFILE` environment variable
4. Attempts connection to PostgreSQL through PgBouncer
5. Validates connection fails without password file

**Expected behavior:**

- ❌ Connection fails without `.pgpass`
- ⚠️ May succeed if password is cached in existing connections (PARTIAL result)
- ✅ New connections cannot authenticate without `.pgpass`

**Why it matters:**

- Validates password file security pattern
- Tests that PgBouncer cannot authenticate without credentials
- Ensures healthcheck dependency on `.pgpass` is documented

**Note:** Password may be cached for existing connections. Test focuses on new connection attempts.

---

### Test 3: Invalid Listen Address

**What it tests:**

- PgBouncer rejects invalid IP addresses in `PGBOUNCER_LISTEN_ADDR`
- Entrypoint script validation prevents injection attacks
- Startup fails with clear error messages

**How it works:**

1. Sets `PGBOUNCER_LISTEN_ADDR=999.999.999.999` (invalid IP)
2. Starts PostgreSQL (succeeds)
3. Attempts to start PgBouncer
4. Checks if PgBouncer container exits or fails to start
5. Validates error message in logs

**Expected behavior:**

- ❌ PgBouncer container exits or never starts
- ✅ Logs contain `ERROR.*Invalid` or `ERROR.*PGBOUNCER_LISTEN_ADDR`
- ✅ Entrypoint script rejects address via regex validation

**Why it matters:**

- Prevents sed injection attacks (validation before `sed` substitution)
- Tests input validation in `pgbouncer-entrypoint.sh`
- Ensures invalid configs fail fast with clear errors

**Validation regex:** `/^[0-9.*]+$/` (digits, dots, wildcards only)

---

### Test 4: PostgreSQL Unavailable (depends_on Test)

**What it tests:**

- Docker Compose `depends_on` with healthcheck condition works
- PgBouncer waits for PostgreSQL to be healthy before starting
- Automatic dependency resolution

**How it works:**

1. Attempts to start ONLY `pgbouncer` service (not `postgres`)
2. Checks if Docker Compose auto-starts `postgres` due to `depends_on`
3. Validates PgBouncer does not start without healthy PostgreSQL

**Expected behavior:**

- ✅ Docker Compose auto-starts PostgreSQL when `pgbouncer` requested
- ✅ `depends_on.postgres.condition: service_healthy` enforced
- ✅ PgBouncer does NOT start until PostgreSQL healthcheck passes

**Why it matters:**

- Validates stack orchestration (PgBouncer cannot start before PostgreSQL)
- Tests healthcheck dependency chain
- Ensures `compose.yml` `depends_on` configuration works correctly

**Config validated:**

```yaml
pgbouncer:
  depends_on:
    postgres:
      condition: service_healthy
```

---

### Test 5: Max Connections Exceeded

**What it tests:**

- PostgreSQL connection limits are enforced for pooled users
- PgBouncer properly surfaces connection limit errors
- Connection pooling respects per-role limits

**How it works:**

1. Starts PostgreSQL and PgBouncer normally
2. Sets very low connection limit on `pgbouncer_auth` user: `ALTER ROLE pgbouncer_auth CONNECTION LIMIT 1;`
3. Opens first connection (holds with `pg_sleep(2)`)
4. Attempts second connection while first is active
5. Validates second connection fails

**Expected behavior:**

- ✅ First connection succeeds
- ❌ Second connection fails (limit exceeded)
- ✅ Error message mentions "connection", "limit", or "too many"
- ⚠️ May succeed if connection pooling reuses first slot (PARTIAL result)

**Why it matters:**

- Tests per-user connection limit enforcement
- Validates PgBouncer error propagation from PostgreSQL
- Ensures connection exhaustion is handled gracefully

**Note:** Transaction mode pooling may reuse connections. Test focuses on concurrent connection attempts.

---

### Test 6: .pgpass Wrong Permissions (777)

**What it tests:**

- PostgreSQL client security checks `.pgpass` file permissions
- Insecure permissions (777 instead of 600) trigger warnings
- Password file must be owner-readable only

**How it works:**

1. Starts PostgreSQL and PgBouncer normally (`.pgpass` created with 600)
2. Changes `.pgpass` permissions to 777 (world-readable/writable)
3. Attempts connection using insecure `.pgpass`
4. Checks for security warning or connection failure

**Expected behavior:**

- ⚠️ PostgreSQL client warns: `WARNING: password file "..." has group or world access`
- ✅ Connection may still work (warning only, not fatal)
- ✅ Security issue is surfaced to operator

**Why it matters:**

- Tests PostgreSQL client security validation
- Ensures password file security is enforced
- Validates `umask 077` in `pgbouncer-entrypoint.sh` prevents this scenario

**Standard behavior:** `.pgpass` MUST be mode 0600 (owner-read-write only). PostgreSQL warns but may not reject.

**Current entrypoint protection:**

```bash
umask 077  # Ensures .pgpass created with 600 permissions
printf '...' > /tmp/.pgpass
```

---

## Running the Tests

### Basic Usage

```bash
# From project root
./scripts/test/test-pgbouncer-failures.sh

# Explicit stack path
./scripts/test/test-pgbouncer-failures.sh stacks/primary
```

### Prerequisites

- Docker daemon running
- Docker Compose available (`docker compose` or `docker-compose`)
- `jq` installed (JSON parsing)
- Image built: `aza-pg:pg18` (local tag)
- No conflicting containers using test project names

### Test Isolation

Each test uses a unique Docker Compose project name:

- `pgbouncer-test-wrong-pass`
- `pgbouncer-test-no-pgpass`
- `pgbouncer-test-invalid-addr`
- `pgbouncer-test-no-postgres`
- `pgbouncer-test-max-conn`
- `pgbouncer-test-pgpass-perms`

Tests run sequentially, cleanup after each scenario (no parallel conflicts).

### Cleanup

Automatic cleanup via `trap EXIT`:

- Removes all Docker containers for test project
- Deletes volumes (`-v` flag)
- Removes `.env.test-*` files from stack directory

Manual cleanup if interrupted:

```bash
cd stacks/primary
docker compose -p pgbouncer-test-wrong-pass down -v
docker compose -p pgbouncer-test-no-pgpass down -v
# ... (repeat for all project names)
rm -f .env.test-*
```

---

## Expected Output

### Successful Run

```
========================================
PgBouncer Failure Scenario Tests
========================================
Stack: stacks/primary

[INFO] Test 1: Wrong Password Authentication
----------------------------------------
[INFO] Starting PostgreSQL with correct password...
[SUCCESS] PostgreSQL started successfully
[INFO] Starting PgBouncer with mismatched password...
[SUCCESS] Test PASSED: Authentication properly failed with wrong password

[INFO] Test 2: Missing .pgpass File
----------------------------------------
[INFO] Starting services...
[INFO] Removing .pgpass file from PgBouncer container...
[SUCCESS] Test PASSED: Connection properly failed without .pgpass

[INFO] Test 3: Invalid Listen Address
----------------------------------------
[INFO] Starting PostgreSQL...
[INFO] Starting PgBouncer with invalid listen address...
[SUCCESS] Test PASSED: PgBouncer properly rejected invalid listen address

[INFO] Test 4: PostgreSQL Unavailable (depends_on test)
----------------------------------------
[INFO] Starting PgBouncer WITHOUT PostgreSQL...
[SUCCESS] Test PASSED: Docker Compose automatically started PostgreSQL (depends_on working)

[INFO] Test 5: Max Connections Exceeded
----------------------------------------
[INFO] Starting services...
[INFO] Setting very low connection limit on pgbouncer_auth user...
[INFO] Opening first connection...
[INFO] Attempting second connection (should fail)...
[SUCCESS] Test PASSED: Connection properly rejected (connection limit enforced)

[INFO] Test 6: .pgpass Wrong Permissions (777)
----------------------------------------
[INFO] Starting services...
[INFO] Changing .pgpass permissions to 777 (insecure)...
[SUCCESS] Test PASSED: PostgreSQL client warned about insecure .pgpass permissions

========================================
Test Summary
========================================
Tests run:    6
Tests passed: 6
Tests failed: 0

✅ All PgBouncer failure scenario tests completed successfully!

Tested scenarios:
  ✅ Wrong password authentication (properly rejected)
  ✅ Missing .pgpass file (connection fails without credentials)
  ✅ Invalid listen address (startup prevented)
  ✅ PostgreSQL unavailable (depends_on healthcheck works)
  ✅ Max connections exceeded (limit enforced)
  ✅ .pgpass wrong permissions (security warning/rejection)
```

### Partial Results

Some tests may show `PARTIAL` results instead of `PASSED`:

- **Test 2 (Missing .pgpass):** Password cached in existing connections
- **Test 5 (Max connections):** Transaction mode pooling reuses slots
- **Test 6 (Wrong permissions):** Connection succeeds with warning only

These are acceptable outcomes that validate relaxed but still correct behavior.

---

## Implementation Details

### Test Architecture

**Pattern:** Isolated Docker Compose projects per test

- Each test creates unique `.env.test-*` file
- Each test uses unique `COMPOSE_PROJECT_NAME`
- Cleanup between tests prevents state contamination

**Utilities from `common.sh`:**

- `log_info()`, `log_success()`, `log_error()`, `log_warning()`
- `check_command()` - Validates Docker/jq availability
- `check_docker_daemon()` - Ensures Docker is running

**Custom helpers:**

```bash
wait_for_container_status()  # Polls container health/state with timeout
check_logs_for_pattern()     # Searches service logs for error patterns
```

### Environment Variables Used

**Core credentials:**

- `POSTGRES_PASSWORD` - PostgreSQL superuser password
- `PGBOUNCER_AUTH_PASS` - PgBouncer auth user password
- `PG_REPLICATION_PASSWORD` - Replication user password (unused in tests)

**Configuration:**

- `POSTGRES_IMAGE=aza-pg:pg18` - Local image tag
- `POSTGRES_MEMORY_LIMIT=512m` - Minimal memory for tests
- `COMPOSE_PROJECT_NAME` - Unique per test for isolation
- `PGBOUNCER_LISTEN_ADDR` - Test 3 sets to invalid value

### Timing Considerations

**Typical test duration:** ~3-5 minutes total

- PostgreSQL startup: ~15-30s per test
- PgBouncer startup: ~5-10s
- Cleanup between tests: ~5s

**Timeouts:**

- PostgreSQL healthcheck wait: 60s max
- Container status polling: 30s default
- Connection attempts: 5s timeout

**Why slow?** Each test starts/stops full PostgreSQL instance (no shared state).

---

## Integration with CI/CD

### Recommended Usage

**Manual runs only (for now):**

```bash
# Local development
./scripts/test/test-pgbouncer-failures.sh

# CI pipeline (future)
scripts/test/test-pgbouncer-failures.sh || exit 1
```

**Not currently in CI** because:

- Requires full Docker Compose environment (not just image build)
- Takes 3-5 minutes (slower than unit tests)
- Needs cleanup of persistent volumes
- Best suited for pre-release validation

**Future CI integration:**

1. Add as optional manual trigger workflow
2. Run on PgBouncer config changes (`stacks/*/configs/pgbouncer.ini.template`, entrypoint)
3. Combine with `test-pgbouncer-healthcheck.sh` in full suite

---

## Troubleshooting

### Test Failures

**Symptom:** Test FAILED: PostgreSQL failed to start
**Cause:** Previous test didn't cleanup, port 5432/6432 in use
**Fix:**

```bash
docker ps -a | grep pgbouncer-test
docker rm -f $(docker ps -a -q --filter "name=pgbouncer-test")
```

**Symptom:** Test FAILED: PgBouncer container not found
**Cause:** Container exited immediately (check logs)
**Fix:**

```bash
docker compose -p pgbouncer-test-invalid-addr logs pgbouncer
```

**Symptom:** jq: command not found
**Cause:** `jq` not installed
**Fix:**

```bash
# macOS
brew install jq

# Ubuntu/Debian
apt-get install jq
```

### Environment Issues

**Symptom:** compose.yml not found in stacks/primary
**Cause:** Running from wrong directory
**Fix:** Always run from project root: `./scripts/test/test-pgbouncer-failures.sh`

**Symptom:** Image not found: aza-pg:pg18
**Cause:** Local image not built
**Fix:**

```bash
./scripts/build.sh  # Build local image
```

---

## Maintenance

### Adding New Failure Scenarios

**Pattern:**

1. Create unique project name: `PROJECT_NAME="pgbouncer-test-new-scenario"`
2. Set `CLEANUP_PROJECT="$PROJECT_NAME"` before starting containers
3. Create `.env.test-new-scenario` with test-specific config
4. Start services, induce failure condition
5. Validate expected failure mode
6. Check logs for error patterns
7. Cleanup: `COMPOSE_PROJECT_NAME="$PROJECT_NAME" docker compose down -v`
8. Reset: `CLEANUP_PROJECT=""` before next test

**Example new test:**

```bash
# Test 7: TLS Certificate Missing
log_info "Test 7: TLS Certificate Missing"
TESTS_RUN=$((TESTS_RUN + 1))
PROJECT_NAME="pgbouncer-test-no-tls"
CLEANUP_PROJECT="$PROJECT_NAME"

# Set sslmode=require in env
cat > "$STACK_PATH/.env.test-no-tls" << 'EOF'
POSTGRES_PASSWORD=test_pass
PGBOUNCER_AUTH_PASS=test_pass
POSTGRES_IMAGE=aza-pg:pg18
POSTGRES_MEMORY_LIMIT=512m
EOF
echo "COMPOSE_PROJECT_NAME=$PROJECT_NAME" >> "$STACK_PATH/.env.test-no-tls"

# Modify pgbouncer.ini.template to enforce sslmode=require
# Start services
# Attempt connection without TLS certs
# Validate connection fails
# Check logs for TLS/SSL error

COMPOSE_PROJECT_NAME="$PROJECT_NAME" docker compose down -v >/dev/null 2>&1
CLEANUP_PROJECT=""
```

### Updating for Config Changes

**When to update tests:**

- `pgbouncer-entrypoint.sh` changes (Test 3 validation logic)
- `pgbouncer.ini.template` changes (connection limits, auth settings)
- `compose.yml` dependency changes (Test 4 depends_on)
- New environment variables added

**Version tracking:**

- Tests are tied to PgBouncer v1.24.1-p1 (current image)
- PostgreSQL 18 healthcheck format (`pg_isready`)
- Docker Compose v2 syntax (`docker compose`, not `docker-compose`)

---

## Security Considerations

### Test Safety

**Safe patterns:**

- All tests use isolated Docker networks (no external exposure)
- Passwords are ephemeral (generated per test, destroyed with containers)
- No persistent data (volumes deleted via `-v` flag)
- No port binding to 0.0.0.0 (all localhost)

**NOT safe for production:**

- Test passwords are predictable (`test_postgres_pass_123`)
- `.env.test-*` files written to disk (deleted in cleanup)
- Containers run with default Docker security (no AppArmor/SELinux)

**Why tests don't use secrets management:**

- Ephemeral test environments don't need Docker secrets
- Environment variables are simpler for test validation
- Cleanup guarantees no credential leakage

### Validation Logic

**Input validation tested:**

- `PGBOUNCER_LISTEN_ADDR` regex: `/^[0-9.*]+$/` (Test 3)
- Password escaping: `:` and `\` characters (implicit in Test 1)
- File permissions: 0600 enforced via `umask 077` (Test 6)

**NOT validated by tests:**

- SQL injection in `pgbouncer_lookup()` function (SECURITY DEFINER)
- Network segmentation between containers
- Host-level firewall rules

---

## Related Documentation

- **Happy path tests:** `scripts/test/test-pgbouncer-healthcheck.sh`
- **PgBouncer setup:** `stacks/primary/configs/initdb/03-pgbouncer-auth.sh`
- **Entrypoint security:** `stacks/primary/scripts/pgbouncer-entrypoint.sh`
- **Compose config:** `stacks/primary/compose.yml`
- **Architecture:** `CLAUDE.md` (PgBouncer Auth Pattern section)

---

## Future Enhancements

**Potential new tests:**

1. **TLS certificate validation** - Test sslmode=require without certs
2. **Pool exhaustion** - Exceed `default_pool_size` + `reserve_pool_size`
3. **Query timeout** - Test `query_wait_timeout` enforcement
4. **Transaction mode violations** - Attempt prepared statements (should fail)
5. **Auth query failure** - Make `pgbouncer_lookup()` function return invalid data
6. **Container restart recovery** - Kill PgBouncer, verify auto-restart and reconnection
7. **Network partition** - Disconnect PostgreSQL mid-transaction
8. **Memory limit exceeded** - Constrain PgBouncer to <100MB, create many connections

**Monitoring integration:**

- Add Prometheus metrics scraping during tests
- Validate `pgbouncer_exporter` reports failures
- Check for metrics like `pgbouncer_pools_server_login_errors`

---

## Changelog

**2025-11-07 - Initial Release**

- 6 comprehensive failure scenario tests
- Isolated Docker Compose projects per test
- Automatic cleanup on success/failure
- PARTIAL result handling for non-fatal failures
- Complete documentation with troubleshooting guide
