# TESTING CHECKLIST SUMMARY
## aza-pg Commits 8ee2f84, db306f8, 3654a4c

**Scope:** 3 comprehensive commits - Security fixes (Phase 1), Documentation (Phase 2), Hardening (Phase 3)  
**Total Issues Addressed:** 60 across 3 phases  
**Test Items:** ~150 individual verifications

---

## QUICK REFERENCE: CRITICAL TESTS (MUST PASS)

### Security Fixes
- [ ] **No hardcoded credentials in scripts** - `grep -r "dev_pgbouncer_auth_test_2025\|test_password_123" scripts/ || echo PASS`
- [ ] **.pgpass permissions = 600** - `docker compose exec pgbouncer stat -c "%a" /tmp/.pgpass` → `600`
- [ ] **pgsodium uses search_path=pg_catalog** - Check logs: `docker compose logs postgres | grep "search_path"`
- [ ] **PgBouncer health check passes** - `docker compose ps pgbouncer | grep "healthy"`

### Configuration
- [ ] **PGBOUNCER_SERVER_SSLMODE default = prefer** - `docker compose exec pgbouncer grep "server_ssl_mode" /tmp/pgbouncer.ini` → `prefer`
- [ ] **listen_addresses honors POSTGRES_BIND_IP** - If set to 10.0.0.5, verify `listen_addresses = '10.0.0.5'` (not 0.0.0.0)
- [ ] **max_worker_processes capped at 64** - Even on 128-core machine, max=64
- [ ] **All env vars in .env.example** - `docker compose config` shows no undefined variables

### Documentation
- [ ] **Memory table calculations correct** - Verify 64GB: effective_cache=49152MB (75%, not 54706MB)
- [ ] **timescaledb_toolkit size = 13MB** - Check actual image: `docker run aza-pg ls -lh /usr/lib/postgresql/18/lib/timescaledb_toolkit.so`
- [ ] **TLS guide in README** - README.md contains "Enabling TLS/SSL" section with steps
- [ ] **Init script order documented** - AGENTS.md lists: 01-extensions.sql → 02-replication.sh → 03-pgsodium-init.sh

---

## TESTING WORKFLOWS BY CATEGORY

### 1. SECURITY VERIFICATION (30 min)
```bash
# Test credentials removed
grep -r "dev_pgbouncer_auth_test_2025" scripts/ && echo "FAIL: Hardcoded cred found" || echo "PASS"

# Deploy and check .pgpass
docker compose -f stacks/primary/compose.yml up -d
sleep 30
docker compose exec pgbouncer stat -c "%a" /tmp/.pgpass | grep -q "^600$" && echo "PASS: perms correct"

# Verify search_path hardening
docker compose logs postgres | grep -q "search_path = pg_catalog" && echo "PASS: pgsodium hardened"

# Test health check
docker compose ps pgbouncer | grep -q "healthy" && echo "PASS: healthcheck works"
```

### 2. CONFIGURATION VERIFICATION (45 min)
```bash
# Test TLS mode configuration
unset PGBOUNCER_SERVER_SSLMODE
docker compose up -d && sleep 10
docker compose exec pgbouncer grep "server_ssl_mode" /tmp/pgbouncer.ini | grep -q "prefer" && echo "PASS: default=prefer"

# Test listen_addresses fix
export POSTGRES_BIND_IP=10.0.0.5
docker compose up -d && sleep 10
docker compose exec postgres grep "listen_addresses" /etc/postgresql/postgresql.conf | grep -q "10.0.0.5" && echo "PASS: honors IP"

# Test pool sizes
export MAX_CLIENT_CONN=500 DEFAULT_POOL_SIZE=50
docker compose up -d && sleep 10
docker compose exec pgbouncer grep -E "max_client_conn|default_pool_size" /tmp/pgbouncer.ini

# Verify all env vars documented
cp stacks/primary/.env.example stacks/primary/.env.test
docker compose --env-file stacks/primary/.env.test config >/dev/null 2>&1 && echo "PASS: all vars defined"
```

### 3. AUTO-CONFIG VERIFICATION (45 min)
```bash
# Test CPU coring capping
docker run --cpus=128 -e POSTGRES_MEMORY=65536 aza-pg:test bash -c \
  "source docker-auto-config-entrypoint.sh && echo max_worker_processes=$MAX_WORKER_PROCESSES" | grep "=64"

# Test memory allocation
docker run -e POSTGRES_MEMORY=65536 aza-pg:test bash -c \
  "source docker-auto-config-entrypoint.sh && echo cache=$EFFECTIVE_CACHE_MB" | grep "49152"

# Test fallback warnings
docker run -e POSTGRES_MEMORY=unset aza-pg:test bash -c \
  "source docker-auto-config-entrypoint.sh" 2>&1 | grep -q "meminfo fallback" && echo "PASS"
```

### 4. DOCUMENTATION VERIFICATION (30 min)
```bash
# Verify memory table values
awk '/^[|].*RAM.*shared_buffers/{found=1} found && /^[|].*64GB/{print; exit}' AGENTS.md | \
  grep -q "49152MB" && echo "PASS: 64GB cache correct"

# Check timescaledb_toolkit references
grep -r "186MB" docs/ | grep -i "timescaledb_toolkit" | grep -v "Phase 11" && echo "FAIL: unupdated refs" || echo "PASS"

# Verify TLS section exists
grep -q "### Enabling TLS/SSL" README.md && echo "PASS: TLS guide present"

# Verify init script docs
grep -q "03-pgsodium-init.sh" AGENTS.md && echo "PASS: pgsodium script documented"
```

### 5. EDGE CASES & STRESS TESTING (60 min)
```bash
# Test with special characters in password
export PGBOUNCER_AUTH_PASS="P@ssw0rd:with\&special#chars"
docker compose up -d && sleep 10
docker compose ps pgbouncer | grep -q "healthy" && echo "PASS: special chars work"

# Test with 1-core limit
docker run --cpus=1 -e POSTGRES_MEMORY=512 aza-pg:test bash -c \
  "source docker-auto-config-entrypoint.sh && echo cores=$CPU_CORES" | grep "cores=1"

# Test with 256-core limit
docker run --cpus=256 -e POSTGRES_MEMORY=256000 aza-pg:test bash -c \
  "source docker-auto-config-entrypoint.sh && echo cores=$CPU_CORES" | grep "cores=128"

# Test .pgpass permission verification
docker compose exec pgbouncer stat -c "%a %n" /tmp/.pgpass | grep "^600 /tmp/.pgpass$"

# Test fallback warning messages
docker run aza-pg:test bash -c "source docker-auto-config-entrypoint.sh" 2>&1 | \
  grep -E "WARNING.*meminfo|WARNING.*nproc" && echo "PASS: fallback warnings"
```

---

## PRIORITY MATRIX

| Priority | Category | Tests | Time |
|----------|----------|-------|------|
| **CRITICAL** | Security (credentials, .pgpass, pgsodium) | 4 tests | 15 min |
| **CRITICAL** | Config (sslmode, listen_addresses, capping) | 4 tests | 20 min |
| **HIGH** | Auto-config (memory, CPU, workers) | 6 tests | 25 min |
| **HIGH** | Documentation accuracy | 4 tests | 15 min |
| **MEDIUM** | Edge cases (special chars, limits, warnings) | 8 tests | 30 min |
| **MEDIUM** | Integration tests | 5 tests | 30 min |
| **LOW** | Regression tests | 4 tests | 15 min |

**Total Estimated Time:** 2.5-3 hours for full comprehensive test

---

## BREAKING CHANGES TO VERIFY

### 1. PGBOUNCER_SERVER_SSLMODE: require → prefer (Default Change)
- **Old Behavior:** TLS mandatory between PgBouncer and PostgreSQL
- **New Behavior:** TLS optional (can connect without encryption)
- **Impact:** Deployments NOT explicitly setting PGBOUNCER_SERVER_SSLMODE will change behavior
- **Verification:**
  ```bash
  # Deploy without setting PGBOUNCER_SERVER_SSLMODE
  docker compose up -d
  docker compose exec pgbouncer grep "server_ssl_mode" /tmp/pgbouncer.ini
  # Should show: server_ssl_mode = prefer (not require)
  ```
- **Documentation:** Check README for breaking change note
- **Mitigation:** Set `PGBOUNCER_SERVER_SSLMODE=require` if TLS enforcement needed

### 2. POSTGRES_BIND_IP Interpretation: 0.0.0.0 → Actual IP (Behavioral Change)
- **Old Behavior:** POSTGRES_BIND_IP=10.0.0.5 → listen_addresses=0.0.0.0 (all interfaces)
- **New Behavior:** POSTGRES_BIND_IP=10.0.0.5 → listen_addresses=10.0.0.5 (specific IP)
- **Impact:** Deployments using POSTGRES_BIND_IP for network access will now listen on exact IP
- **Verification:**
  ```bash
  export POSTGRES_BIND_IP=10.0.0.5
  docker compose up -d
  docker compose exec postgres grep "listen_addresses" /etc/postgresql/postgresql.conf
  # Should show: listen_addresses = '10.0.0.5' (not 0.0.0.0)
  ```
- **Documentation:** Verify AGENTS.md documents this change

---

## KNOWN ISSUES NOT YET FIXED

### Issue #2: Insecure .pgpass Permission Test
- **File:** `scripts/test/test-pgbouncer-failures.sh` line ~461
- **Status:** ⚠️ INTENTIONAL (test behavior, not a vulnerability)
- **Details:** Test intentionally sets chmod 777 to verify PostgreSQL rejects insecure .pgpass
- **Risk:** Low - test-only code, but still in production repo
- **Mitigation:** Code is clearly commented as test behavior

### Issue #3: Missing .pgpass Permission Post-Verification (Phase 1, Minor)
- **File:** `stacks/primary/scripts/pgbouncer-entrypoint.sh`
- **Status:** ✅ FIXED in Phase 3 (commit 3654a4c)
- **Fix:** Added explicit chmod 600 + stat verification
- **Verification:** Lines 36-46 show permission check implementation

---

## PASS/FAIL CRITERIA

### PASS Criteria
- All security tests pass (no hardcoded credentials, permissions correct, functions use search_path)
- All configuration variables apply correctly to generated config files
- Auto-config calculations match documented values within margin of error (±1%)
- Documentation values match actual code behavior
- Container health checks pass
- Breaking changes are documented and accounted for

### FAIL Criteria
- Any hardcoded password patterns found in scripts
- .pgpass permissions not exactly 600
- Config values don't apply (e.g., sslmode still shows old value)
- Memory/CPU calculations don't match documented table
- Documentation references outdated values (186MB instead of 13MB)
- Health checks timeout or fail
- Breaking changes not documented

---

## TEST EXECUTION CHECKLIST

Before running tests:
- [ ] Git worktree clean (no uncommitted changes affecting tests)
- [ ] Docker daemon running with sufficient resources (4GB RAM min for full stack)
- [ ] Current working directory: `/opt/apps/art/infra/aza-pg`
- [ ] `.env` file does not exist in `stacks/primary/` (will be created from example)

Run tests in this order:
1. [ ] Syntax validation (bash -n, yaml lint) - 5 min
2. [ ] Security verification - 15 min
3. [ ] Configuration verification - 30 min
4. [ ] Auto-config verification - 30 min
5. [ ] Documentation verification - 20 min
6. [ ] Edge cases - 30 min
7. [ ] Integration tests - 30 min
8. [ ] Cleanup - 10 min

**Total: ~3 hours**

---

## REFERENCE COMMITS

| Commit | Type | Changes | Files |
|--------|------|---------|-------|
| `8ee2f84` | Security + Config + Fixes | 12 critical changes across security, config, auto-config, docs | 17 files |
| `db306f8` | Documentation | Memory table fixes, timescaledb_toolkit size updates, TLS guide | 9 files |
| `3654a4c` | Hardening | Permission verification, fallback warnings, .gitignore patterns | 5 files |

---

**Generated:** 2025-11-08  
**Intended Use:** Pre-deployment testing, regression verification, CI/CD integration  
**Maintenance:** Update when new commits modify tested areas

