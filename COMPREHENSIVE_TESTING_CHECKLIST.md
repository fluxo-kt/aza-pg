# COMPREHENSIVE TESTING CHECKLIST
## aza-pg Production PostgreSQL Stack - Commits 8ee2f84, db306f8, 3654a4c

**Last Updated:** 2025-11-08  
**Scope:** Last 3 commits covering security fixes, documentation corrections, and operational hardening

---

## 1. SECURITY FIXES TO TEST

### 1.1 Hardcoded Credentials Removal
**Commit:** 8ee2f84  
**File Modified:** `.github/workflows/build-postgres-image.yml`, `scripts/test/test-*.sh`

**Changes Made:**
- Removed hardcoded test password `dev_pgbouncer_auth_test_2025` from all scripts
- Credentials now generated at runtime: `test_pgbouncer_$(date +%s)_$$` format
- Unique passwords per test run in CI workflows

**Tests to Run:**
- [ ] **Test CI credentials generation** (file: .github/workflows/build-postgres-image.yml)
  - Verify: Run CI workflow twice, check both runs create DIFFERENT credentials in logs
  - Command: `git log --oneline -1 | grep -i "test\|cred"` then inspect workflow logs
  - Expected: Each run generates `test_pgb_<RUN_ID>_<timestamp>` format

- [ ] **Verify no hardcoded password patterns in scripts** (file: scripts/test/*.sh)
  - Verify: Grep all test scripts for literal password strings
  - Command: `grep -r "pgbouncer_auth_test\|test_password_123\|replication_test" scripts/test/ || echo "PASS: No hardcoded credentials found"`
  - Expected: Returns empty (grep finds nothing), or only comments/documentation

- [ ] **Test local script execution with env vars** (file: scripts/test/test-pgbouncer-healthcheck.sh)
  - Verify: Set PGBOUNCER_AUTH_PASS env var, run test script locally
  - Command: `export PGBOUNCER_AUTH_PASS="custom_secure_pass_2025"; ./scripts/test/test-pgbouncer-healthcheck.sh`
  - Expected: Script uses provided password, does not fall back to hardcoded value

**Edge Cases:**
- [ ] **Empty credential variable handling**
  - Set `PGBOUNCER_AUTH_PASS=""` and run test
  - Expected: Script fails with clear error message about missing credentials

---

### 1.2 pgsodium Search Path Hardening
**Commit:** 8ee2f84  
**File Modified:** `docker/postgres/docker-entrypoint-initdb.d/03-pgsodium-init.sh`

**Changes Made:**
- Added `SET LOCAL search_path = pg_catalog;` before pgsodium initialization
- Prevents schema injection via user-created schemas during pgsodium setup
- Ensures unqualified function calls resolve only to system catalog

**Tests to Run:**
- [ ] **Verify search_path enforcement** (file: docker/postgres/docker-entrypoint-initdb.d/03-pgsodium-init.sh)
  - Verify: Deploy postgres stack, check logs for search_path SET command
  - Command: `docker compose logs postgres 2>&1 | grep "search_path\|pgsodium"`
  - Expected: See "SET LOCAL search_path = pg_catalog" in initialization logs

- [ ] **Create malicious schema and verify it doesn't affect pgsodium** 
  - Verify: Create a user schema with same name as system function, verify pgsodium doesn't use it
  - Commands:
    ```bash
    docker compose exec postgres psql -U postgres -c "CREATE SCHEMA IF NOT EXISTS public;"
    docker compose exec postgres psql -U postgres -c "CREATE FUNCTION public.pgbouncer_lookup(name) RETURNS TABLE (...) AS 'SELECT 1;' LANGUAGE SQL;" || true
    docker compose exec postgres psql -U postgres -c "SELECT * FROM pg_extension WHERE extname='pgsodium';"
    ```
  - Expected: pgsodium extension exists and was initialized correctly (not confused by malicious schema function)

- [ ] **Verify function resolution order**
  - Verify: After pgsodium init, confirm functions use correct schema prefix
  - Command: `docker compose exec postgres psql -U postgres -c "SELECT proname, pronamespace FROM pg_proc WHERE proname LIKE '%sodium%' LIMIT 5;"`
  - Expected: All functions are in pg_catalog namespace (oid 11), not public

**Edge Cases:**
- [ ] **Test with multiple schemas** (verify isolation)
  - Create 3-4 user schemas, all with functions
  - Restart postgres container
  - Expected: pgsodium initialization still succeeds, uses only catalog functions

---

### 1.3 PgBouncer .pgpass Permission Verification
**Commit:** 3654a4c  
**File Modified:** `stacks/primary/scripts/pgbouncer-entrypoint.sh`

**Changes Made:**
- Added explicit chmod 600 call after .pgpass file creation
- Added post-creation permission verification using stat command
- Handles both Linux (stat -c) and macOS (stat -f) stat command variants
- Fails container startup if permissions cannot be set or are incorrect

**Tests to Run:**
- [ ] **Verify .pgpass created with 600 permissions**
  - Verify: Deploy primary stack, check .pgpass file permissions inside container
  - Command: `docker compose exec pgbouncer stat -c "%a" /tmp/.pgpass 2>/dev/null || docker compose exec pgbouncer stat -f "%OLp" /tmp/.pgpass | tail -c 4`
  - Expected: Output is exactly `600` (or similar for macOS format)

- [ ] **Verify chmod failure causes container startup failure**
  - Verify: Modify pgbouncer-entrypoint.sh temporarily to fail chmod, start container
  - Command: Add `chmod 600 /nonexistent/.pgpass` to script, deploy
  - Expected: pgbouncer container fails to start with clear error message about permission failure
  - Cleanup: Revert script change

- [ ] **Test permission verification on both Linux and macOS stat output**
  - Verify: Script handles both `stat -c "%a"` (Linux) and `stat -f "%OLp"` (macOS)
  - Expected: Works correctly on both platforms without conditional errors

- [ ] **Verify fallback to "unknown" when stat fails**
  - Verify: Permission check still works even if stat command is unavailable
  - Expected: Script detects unexpected permissions and fails appropriately

**Edge Cases:**
- [ ] **Read-only filesystem test**
  - Create .pgpass on read-only volume, verify script detects chmod failure
  - Expected: Clear error "Failed to set .pgpass permissions", container exits

- [ ] **Different umask inheritance**
  - Run test with different umask values (e.g., umask 077, umask 022, umask 002)
  - Expected: Script always sets exactly 600 regardless of umask

---

### 1.4 PgBouncer Health Check Authentication
**Commit:** 8ee2f84  
**File Modified:** `stacks/primary/compose.yml`

**Changes Made:**
- Health check now uses PGPASSWORD environment variable for authentication
- Moved from assuming hardcoded test credentials to using actual runtime password
- Allows health checks to work with any password value

**Tests to Run:**
- [ ] **Verify health check uses PGPASSWORD env var**
  - Verify: Check compose.yml healthcheck definition includes PGPASSWORD
  - Command: `grep -A 5 "healthcheck:" stacks/primary/compose.yml | grep -i "pgpassword"`
  - Expected: PGPASSWORD is set in healthcheck environment

- [ ] **Test health check with custom password**
  - Verify: Set custom PGBOUNCER_AUTH_PASS, deploy stack, verify health checks pass
  - Commands:
    ```bash
    export PGBOUNCER_AUTH_PASS="custom_secure_password_2025"
    docker compose -f stacks/primary/compose.yml up -d
    sleep 30
    docker compose -f stacks/primary/compose.yml ps pgbouncer | grep "healthy"
    ```
  - Expected: PgBouncer container shows "healthy" status

- [ ] **Test health check failure with wrong password**
  - Verify: Change PGPASSWORD after startup, container still recognizes unhealthy
  - Expected: Health check fails, container marked unhealthy within 30 seconds

**Edge Cases:**
- [ ] **Special characters in password**
  - Test with password containing special chars: `P@ssw0rd!#$%&*()`
  - Expected: Health check still works correctly

---

## 2. CONFIGURATION CHANGES TO TEST

### 2.1 PgBouncer TLS Mode env-configurable
**Commit:** 8ee2f84  
**Files Modified:** `stacks/primary/configs/pgbouncer.ini.template`, `stacks/primary/scripts/pgbouncer-entrypoint.sh`

**Changes Made:**
- PGBOUNCER_SERVER_SSLMODE parameter introduced (default: `prefer`)
- Breaking change: Changed from `require` (TLS mandatory) to `prefer` (TLS optional)
- All sslmode values validated: disable, allow, prefer, require, verify-ca, verify-full

**Tests to Run:**
- [ ] **Test default sslmode value (prefer)**
  - Verify: Don't set PGBOUNCER_SERVER_SSLMODE, check config file
  - Command: `docker compose exec pgbouncer grep "server_ssl_mode" /tmp/pgbouncer.ini`
  - Expected: Output shows `server_ssl_mode = prefer`

- [ ] **Test sslmode override to require**
  - Verify: Set PGBOUNCER_SERVER_SSLMODE=require, verify config applies
  - Commands:
    ```bash
    export PGBOUNCER_SERVER_SSLMODE=require
    docker compose up -d
    docker compose exec pgbouncer grep "server_ssl_mode" /tmp/pgbouncer.ini
    ```
  - Expected: Shows `server_ssl_mode = require`

- [ ] **Test invalid sslmode value rejection**
  - Verify: Set PGBOUNCER_SERVER_SSLMODE=invalid, container fails to start
  - Commands:
    ```bash
    export PGBOUNCER_SERVER_SSLMODE=invalid
    docker compose up -d 2>&1 | grep -i "invalid\|sslmode"
    ```
  - Expected: Container fails with error message about invalid sslmode

- [ ] **Test all valid sslmode values**
  - Verify: Test each of disable, allow, prefer, require, verify-ca, verify-full
  - For each value:
    ```bash
    export PGBOUNCER_SERVER_SSLMODE=<value>
    docker compose up -d && sleep 10
    docker compose ps pgbouncer | grep -i "up\|running"
    ```
  - Expected: All valid values allow container to start

**Breaking Change Verification:**
- [ ] **BREAKING CHANGE: sslmode default changed from require→prefer**
  - Verify: Users relying on TLS enforcement must now explicitly set PGBOUNCER_SERVER_SSLMODE=require
  - Documentation test: Check README/AGENTS.md documents this breaking change with upgrade instructions
  - Command: `grep -i "breaking\|sslmode\|prefer\|require" README.md AGENTS.md | head -20`
  - Expected: Clear documentation of the change and how to restore old behavior

---

### 2.2 PgBouncer Pool Sizes env-configurable
**Commit:** 8ee2f84  
**Files Modified:** `stacks/primary/configs/pgbouncer.ini.template`, `stacks/primary/scripts/pgbouncer-entrypoint.sh`

**Changes Made:**
- MAX_CLIENT_CONN parameter introduced (default: 200)
- DEFAULT_POOL_SIZE parameter introduced (default: 25)
- Both validated and applied during PgBouncer startup

**Tests to Run:**
- [ ] **Test default pool sizes**
  - Verify: Don't set pool size vars, check defaults applied
  - Commands:
    ```bash
    unset MAX_CLIENT_CONN DEFAULT_POOL_SIZE
    docker compose up -d postgres pgbouncer
    sleep 10
    docker compose exec pgbouncer grep -E "max_client_conn|default_pool_size" /tmp/pgbouncer.ini
    ```
  - Expected: Shows `max_client_conn = 200` and `default_pool_size = 25`

- [ ] **Test MAX_CLIENT_CONN override**
  - Verify: Set MAX_CLIENT_CONN=500, verify in config
  - Commands:
    ```bash
    export MAX_CLIENT_CONN=500
    docker compose up -d && sleep 10
    docker compose exec pgbouncer grep "max_client_conn" /tmp/pgbouncer.ini
    ```
  - Expected: Shows `max_client_conn = 500`

- [ ] **Test DEFAULT_POOL_SIZE override**
  - Verify: Set DEFAULT_POOL_SIZE=50, verify in config
  - Commands:
    ```bash
    export DEFAULT_POOL_SIZE=50
    docker compose up -d && sleep 10
    docker compose exec pgbouncer grep "default_pool_size" /tmp/pgbouncer.ini
    ```
  - Expected: Shows `default_pool_size = 50`

- [ ] **Test performance with different pool sizes**
  - Verify: Create 100+ simultaneous connections with different pool sizes
  - Expected: With smaller pool_size=10, connections queue properly; with pool_size=100, more parallel execution

**Edge Cases:**
- [ ] **Invalid pool size values (non-numeric)**
  - Set MAX_CLIENT_CONN=abc
  - Expected: Script detects invalid value and fails with clear error

- [ ] **Unrealistic pool sizes (0, negative)**
  - Set MAX_CLIENT_CONN=0 or DEFAULT_POOL_SIZE=-1
  - Expected: Validation fails or PgBouncer rejects at startup

---

### 2.3 Environment Variables Added to .env.example
**Commit:** 8ee2f84  
**File Modified:** `stacks/primary/.env.example`

**Changes Made:**
- Added POSTGRES_MEMORY (previously missing)
- Added POSTGRES_SHARED_PRELOAD_LIBRARIES (previously missing)
- Added PGBOUNCER_SERVER_SSLMODE with documentation
- Added PGBOUNCER_MAX_CLIENT_CONN with documentation
- Added PGBOUNCER_DEFAULT_POOL_SIZE with documentation
- Added password complexity guidance

**Tests to Run:**
- [ ] **Verify all required env vars in .env.example**
  - Verify: Check that all vars used in compose.yml/scripts have examples
  - Command: `diff <(grep -oE '\$\{[A-Z_]+' stacks/primary/compose.yml | sort -u) <(grep -E '^[A-Z_]+=' stacks/primary/.env.example | sort -u)`
  - Expected: All variables used in compose.yml are documented in .env.example

- [ ] **Create .env from example and verify all vars defined**
  - Verify: cp .env.example .env and check that compose.yml doesn't show undefined variable warnings
  - Commands:
    ```bash
    cp stacks/primary/.env.example stacks/primary/.env.test
    docker compose --env-file stacks/primary/.env.test config > /tmp/config-output.yaml 2>&1
    grep -i "undefined\|unset" /tmp/config-output.yaml || echo "PASS: All variables defined"
    ```
  - Expected: No undefined variable warnings

- [ ] **Verify password guidance in .env.example**
  - Verify: Check for comment about password complexity
  - Command: `grep -i "password\|complex\|strong" stacks/primary/.env.example | head -5`
  - Expected: See guidance about password strength, length, character types

**Documentation Accuracy:**
- [ ] **Verify comments are clear and actionable**
  - Read through .env.example and verify each comment explains:
    1. What the variable controls
    2. Default value (if any)
    3. When to change it
    4. Example values
  - Expected: Comments are clear enough for new users to configure without external docs

---

### 2.4 Remove Non-Standard !override YAML Tag
**Commit:** 8ee2f84  
**File Modified:** `stacks/primary/compose.dev.yml`

**Changes Made:**
- Removed !override tag from compose.dev.yml
- This is a non-standard Docker Compose feature that may not be supported in all versions

**Tests to Run:**
- [ ] **Verify no !override tags remain in compose files**
  - Command: `grep -r "!override" stacks/primary/ docs/ || echo "PASS: No !override tags found"`
  - Expected: Returns "PASS" (no matches)

- [ ] **Verify compose.dev.yml merges correctly without !override**
  - Verify: Both old and new merge behavior work
  - Commands:
    ```bash
    docker compose -f stacks/primary/compose.yml -f stacks/primary/compose.dev.yml config > /tmp/merged.yaml
    grep -c "postgres:" /tmp/merged.yaml  # Should show all services
    ```
  - Expected: All services present, no merge errors

- [ ] **Test on different Docker Compose versions**
  - Verify: Works on Docker Compose v2.5+
  - Command: `docker compose version`
  - Expected: Version is v2.x or later

---

## 3. SCRIPT FIXES TO TEST

### 3.1 Auto-Config CPU Core Sanity Check & Capping
**Commit:** 8ee2f84  
**File Modified:** `docker/postgres/docker-auto-config-entrypoint.sh`

**Changes Made:**
- Added clamp for CPU cores between 1-128 (prevent misconfiguration)
- Added warnings when clamping occurs
- Added max_worker_processes cap at 64 (PostgreSQL hard limit)
- Enhanced logging of computed worker values

**Tests to Run:**
- [ ] **Test CPU core detection on 1-core machine**
  - Deploy with `--cpus=1`, verify logs show "Detected CPU cores: 1"
  - Command: 
    ```bash
    docker run --cpus=1 -e POSTGRES_MEMORY=1024 -it postgres:18 bash -c "source /usr/local/bin/docker-auto-config-entrypoint.sh && echo CPU: $CPU_CORES"
    ```
  - Expected: CPU_CORES=1, no warnings

- [ ] **Test CPU core detection on high-core machine (256+ cores)**
  - Deploy with `--cpus=256` (or simulate via env if available)
  - Expected: Logs show warning "Detected CPU cores (256) exceeds maximum (128) - clamping to 128"
  - Check: CPU_CORES=128 in logs

- [ ] **Test max_worker_processes capping at 64**
  - Deploy with 64+ cores, verify max_worker_processes doesn't exceed 64
  - Expected: Even with 128 cores, max_worker_processes=64

- [ ] **Verify logging includes exact computed values**
  - Deploy and check logs for detailed worker values
  - Command: `docker compose logs postgres 2>&1 | grep "AUTO-CONFIG.*RAM.*CPU" | head -1`
  - Expected: Log line includes all: max_worker_processes, max_parallel_workers, max_parallel_workers_per_gather values

- [ ] **Test low CPU count edge case (nproc=1 fallback)**
  - Deploy in minimal environment, trigger nproc detection
  - Expected: Uses 1 core, no errors, appropriate logging

**Edge Cases:**
- [ ] **Test on 0-core scenario (unlikely but possible in container)**
  - Simulate by modifying detection to return 0
  - Expected: Clamped to 1, warning logged

- [ ] **Test with explicit CPU limit via docker run**
  - Commands:
    ```bash
    docker run --cpus=4 -e POSTGRES_MEMORY=2048 postgres:18-latest
    # Check logs for: CPU_CORES=4, max_worker_processes=8 (capped at min(4*2, 64))
    ```
  - Expected: Correct scaling based on actual CPU limit

---

### 3.2 Auto-Config listen_addresses Fix
**Commit:** 8ee2f84  
**File Modified:** `docker/postgres/docker-auto-config-entrypoint.sh`

**Changes Made:**
- Changed from forcing 0.0.0.0 when POSTGRES_BIND_IP is set
- Now honors specific IP address provided instead
- If POSTGRES_BIND_IP=192.168.1.10, listen_addresses=192.168.1.10 (not 0.0.0.0)

**Tests to Run:**
- [ ] **Test default behavior (localhost only)**
  - Deploy without POSTGRES_BIND_IP, verify listen_addresses=127.0.0.1
  - Command: `docker compose exec postgres grep "^listen_addresses" /etc/postgresql/postgresql.conf | grep "127.0.0.1"`
  - Expected: Shows listen_addresses = '127.0.0.1'

- [ ] **Test specific IP binding**
  - Deploy with POSTGRES_BIND_IP=10.0.0.5
  - Expected: listen_addresses = '10.0.0.5' (not 0.0.0.0)
  - Command: `docker compose exec postgres grep "^listen_addresses" /etc/postgresql/postgresql.conf`
  - Expected: Shows `listen_addresses = '10.0.0.5'`

- [ ] **Test 0.0.0.0 binding (all interfaces)**
  - Deploy with POSTGRES_BIND_IP=0.0.0.0
  - Expected: listen_addresses = '0.0.0.0'

- [ ] **Test network access respects listen_addresses**
  - Deploy with POSTGRES_BIND_IP=127.0.0.1, try remote connection
  - Expected: Connection from external IP fails (as expected, listening only on localhost)
  - Deploy with POSTGRES_BIND_IP=0.0.0.0, try remote connection
  - Expected: Connection succeeds (from same network)

**Breaking Change (if any):**
- [ ] **Verify change doesn't break existing deployments**
  - Old behavior: POSTGRES_BIND_IP=10.0.0.5 → listen_addresses=0.0.0.0
  - New behavior: POSTGRES_BIND_IP=10.0.0.5 → listen_addresses=10.0.0.5
  - Test: Deployments expecting the old behavior may break - check if this is documented

---

### 3.3 max_worker_processes Capping
**Commit:** 8ee2f84  
**File Modified:** `docker/postgres/docker-auto-config-entrypoint.sh`

**Changes Made:**
- Added hard cap at 64 for max_worker_processes
- Formula: `$((CPU_CORES * 2))` capped at 64
- Example: 40 cores → 80 would-be workers, capped to 64

**Tests to Run:**
- [ ] **Verify capping formula**
  - Test multiple CPU counts:
    - 1 CPU: 1*2=2 (no cap applied)
    - 16 CPU: 16*2=32 (no cap applied)
    - 32 CPU: 32*2=64 (at cap, no change)
    - 64 CPU: 64*2=128 (capped to 64)
    - 128 CPU: 128*2=256 (capped to 64)
  - Command: `grep "MAX_WORKER_PROCESSES=" /tmp/auto-config-output.txt` for each scenario
  - Expected: Values match formula with 64 cap

- [ ] **Test with explicit CPU limit**
  - Commands:
    ```bash
    for cpus in 1 2 4 8 16 32 64; do
      docker run --cpus=$cpus -e POSTGRES_MEMORY=2048 postgres:18-latest bash -c "echo Testing $cpus CPUs" 2>&1 | grep -i "worker\|parallel"
    done
    ```
  - Expected: All output shows reasonable worker process values

---

### 3.4 PostgreSQL Healthcheck Timing Fixes
**Commit:** 8ee2f84  
**File Modified:** `docker/postgres/Dockerfile`

**Changes Made:**
- PostgreSQL healthcheck start_period: 60s → 120s
- Reason: Support for large databases that take longer to initialize
- PgBouncer healthcheck timeout: 5s → 10s
- Reason: SCRAM-SHA-256 authentication adds overhead

**Tests to Run:**
- [ ] **Verify healthcheck timing with large databases**
  - Deploy with 2GB+ database import, measure initialization time
  - Expected: Container reaches "healthy" status within ~120 seconds (was timing out at 60s before fix)

- [ ] **Test healthcheck on smaller databases**
  - Deploy standard stack without large DB
  - Expected: Container reaches healthy status in <60s (well before new timeout)

- [ ] **Verify PgBouncer timeout increase handles SCRAM-SHA-256**
  - Deploy and check SCRAM-SHA-256 auth performance
  - Command: `docker compose logs pgbouncer 2>&1 | grep -i "scram\|auth"`
  - Expected: Auth completes in <10 seconds even with SCRAM-SHA-256

- [ ] **Test under network latency**
  - Simulate network delay, verify healthchecks still pass with new timeouts
  - Expected: 5s was sometimes too tight under latency; 10s provides buffer

**Edge Cases:**
- [ ] **Very slow initialization (3-minute DB restore)**
  - Create large database, verify 120s timeout is sufficient
  - If not, document that users need custom healthcheck settings

---

## 4. DOCUMENTATION ACCURACY TO VERIFY

### 4.1 TLS/SSL Configuration Guide (NEW)
**Commit:** db306f8  
**File Modified:** `README.md` (Security section)

**Changes Made:**
- Added "Enabling TLS/SSL" subsection with step-by-step guide
- Includes certificate mounting instructions
- Documents PGBOUNCER_SERVER_SSLMODE configuration
- Links to docs/PRODUCTION.md for complete setup

**Tests to Run:**
- [ ] **Follow TLS guide step-by-step**
  - Read README.md "Enabling TLS/SSL" section
  - Attempt to follow exact steps:
    1. Generate certificates (using script or openssl)
    2. Mount in compose.yml
    3. Enable in postgresql-base.conf
    4. Set PGBOUNCER_SERVER_SSLMODE=require
  - Expected: All steps are clear and work end-to-end

- [ ] **Verify certificate mounting instructions are accurate**
  - Command: Check if certificate paths in README match actual mount locations in Dockerfile
  - Expected: Paths /etc/ssl/certs/ssl-cert-snakeoil.pem and /etc/ssl/private/ssl-cert-snakeoil.key are correct

- [ ] **Test TLS enablement with self-signed certs**
  - Generate self-signed certs, mount them, enable TLS
  - Expected: PostgreSQL accepts TLS connections with self-signed certs

- [ ] **Verify PGBOUNCER_SERVER_SSLMODE explanation is clear**
  - Read documentation about prefer vs require
  - Expected: Clear explanation that prefer = optional, require = mandatory after TLS setup

---

### 4.2 Memory Allocation Table Corrections
**Commit:** db306f8  
**File Modified:** `AGENTS.md`, `docs/analysis/*.md`

**Changes Made:**
- Fixed 10 incorrect values in memory allocation table
- Corrected effective_cache_size cap documentation (64GB: 54706MB→49152MB)
- Fixed 32GB row (80%→75% cap)
- Standardized percentage rounding across all memory tiers

**Tests to Run:**
- [ ] **Verify memory table values against source code**
  - Compare values in AGENTS.md with actual formulas in docker/postgres/docker-auto-config-entrypoint.sh
  - For each RAM tier, calculate:
    - shared_buffers = RAM * 0.25 (capped at 32GB)
    - effective_cache = RAM * 0.75 (hard cap)
    - maintenance_work_mem = max(32MB, RAM * 0.03) capped at 2GB
  - Expected: All table values match calculated values

- [ ] **Test 64GB effective_cache_size**
  - Deploy with POSTGRES_MEMORY=65536 (64GB)
  - Check actual effective_cache_size setting
  - Command: `docker compose exec postgres psql -U postgres -c "SHOW effective_cache_size;"`
  - Expected: Shows ~49152MB (75% of 65536), not 54706MB (old incorrect value)

- [ ] **Test 32GB effective_cache percentage**
  - Deploy with POSTGRES_MEMORY=32768 (32GB)
  - Calculate: 32768 * 0.75 = 24576MB
  - Command: `docker compose exec postgres psql -U postgres -c "SHOW effective_cache_size;"`
  - Expected: Shows 24576MB, confirming 75% cap (not 80%)

- [ ] **Verify percentage standardization**
  - Read AGENTS.md memory table
  - Check all percentages are consistently rounded (e.g., "3%" not "3.1%")
  - Expected: Consistent rounding across all rows

**Calculations to Verify:**
- 512MB: shared_buffers=128MB (25%), effective_cache=384MB (75%), work_mem=1MB ✓
- 1GB: shared_buffers=256MB (25%), effective_cache=768MB (75%), work_mem=2MB ✓
- 2GB: shared_buffers=512MB (25%), effective_cache=1536MB (75%), work_mem=4MB ✓
- 4GB: shared_buffers=1024MB (25%), effective_cache=3072MB (75%), work_mem=5MB ✓
- 8GB: shared_buffers=2048MB (25%), effective_cache=6144MB (75%), work_mem=10MB ✓
- 16GB: shared_buffers=3276MB (20%), effective_cache=12288MB (75%), work_mem=20MB ✓
- 32GB: shared_buffers=6553MB (20%), effective_cache=24576MB (75%), work_mem=32MB ✓
- 64GB: shared_buffers=9830MB (15%), effective_cache=49152MB (75%), work_mem=32MB ✓

---

### 4.3 timescaledb_toolkit Size Documentation Updates
**Commit:** db306f8  
**Files Modified:** 8 documentation files (52 references updated)

**Changes Made:**
- Updated from 186MB → 13MB (Phase 11 optimization achieved)
- Preserved historical context showing pre-Phase 11 state
- Updated percentages in all references (186MB was 58%, 13MB is ~5%)
- Files updated:
  - docs/analysis/EXECUTIVE-SUMMARY.txt
  - docs/analysis/OPTIMIZATION-ROADMAP.md
  - docs/analysis/README.md
  - docs/analysis/extension-size-analysis.md
  - docs/extensions/PERFORMANCE-IMPACT.md
  - docs/extensions/SIZE-ANALYSIS.md
  - docs/extensions/PREBUILT-BINARIES-ANALYSIS.md
  - docs/analysis/*.md

**Tests to Run:**
- [ ] **Verify timescaledb_toolkit actual size in image**
  - Build image and check actual .so file size
  - Command: `docker run aza-pg ls -lh /usr/lib/postgresql/18/lib/timescaledb_toolkit* 2>/dev/null || echo "Not found"`
  - Expected: Shows ~13MB (or similar, actual Phase 11 optimization result)

- [ ] **Count total references to 186MB**
  - Verify all instances of "186MB" for timescaledb_toolkit are either:
    - Changed to 13MB, or
    - Marked as "pre-Phase 11" historical context
  - Command: `grep -r "186MB\|186 MB" docs/ | grep -i "timescale\|toolkit" || echo "PASS: No unupdated 186MB references"`
  - Expected: Either changed or clearly marked as historical

- [ ] **Verify percentage updates are consistent**
  - Check all files mentioning timescaledb_toolkit size percentage
  - Expected: All reference 13MB as ~5% (or 5%), not 186MB as 58%

- [ ] **Verify historical context is preserved**
  - Read docs to confirm pre-Phase 11 state is mentioned for context
  - Expected: Documents show "optimized from 186MB in Phase 11" or similar notation

---

### 4.4 Init Script Execution Order Documentation
**Commit:** db306f8  
**File Modified:** `AGENTS.md`

**Changes Made:**
- Added 03-pgsodium-init.sh to shared script order documentation
- Now documents complete 3-script sequence:
  1. 01-extensions.sql
  2. 02-replication.sh
  3. 03-pgsodium-init.sh

**Tests to Run:**
- [ ] **Verify documentation matches actual script files**
  - List actual files in docker/postgres/docker-entrypoint-initdb.d/
  - Command: `ls docker/postgres/docker-entrypoint-initdb.d/ | grep -E "^[0-9]"`
  - Expected: Lists 01-extensions.sql, 02-replication.sh, 03-pgsodium-init.sh, and any others

- [ ] **Verify script execution order**
  - Deploy postgres container, check logs for script execution order
  - Command: `docker compose logs postgres 2>&1 | grep -E "^\[.*\] Running.*\|^\[.*\] .*init" | head -10`
  - Expected: Scripts execute in correct numerical order (01 before 02 before 03)

- [ ] **Test that pgsodium init happens after extensions**
  - Verify pgsodium extension is loaded before init script runs
  - Expected: No "extension does not exist" errors in logs

- [ ] **Verify stack-specific scripts respect ordering**
  - Check that primary stack's 03-pgbouncer-auth.sh runs after shared 03-pgsodium-init.sh
  - Expected: All 03-* scripts execute in correct order

---

## 5. EDGE CASES TO CHECK

### 5.1 Memory Detection & Fallback Warnings (Phase 3)
**Commit:** 3654a4c  
**File Modified:** `docker/postgres/docker-auto-config-entrypoint.sh`

**Changes Made:**
- Added warning when /proc/meminfo fallback is used (no cgroup limit set)
- Recommends setting POSTGRES_MEMORY for deterministic tuning
- Added warning when nproc fallback is used for CPU detection

**Tests to Run:**
- [ ] **Test /proc/meminfo fallback warning**
  - Deploy container without memory limit (no -m flag)
  - Check logs for warning about /proc/meminfo fallback
  - Command: `docker compose logs postgres 2>&1 | grep -i "meminfo\|fallback"`
  - Expected: See warning "WARNING: Using /proc/meminfo fallback for RAM detection"

- [ ] **Test POSTGRES_MEMORY override skips fallback warning**
  - Deploy with POSTGRES_MEMORY=2048 env var
  - Check logs for no fallback warning
  - Expected: Logs show RAM source = "POSTGRES_MEMORY" (explicit), no warning

- [ ] **Test nproc fallback warning**
  - Deploy in environment with no CPU quota (shared cloud VM)
  - Expected: See warning "WARNING: Using nproc fallback for CPU detection"

- [ ] **Test cgroup v2 detection (preferred)**
  - Deploy with proper memory limit, verify no fallback warning
  - Command: Deploy with `mem_limit: 2gb` in compose.yml
  - Expected: Logs show "cgroup v2" as RAM source, no fallback warning

- [ ] **Test recommendation to set POSTGRES_MEMORY**
  - Deploy without limits, check warning text
  - Expected: Warning includes recommendation "set POSTGRES_MEMORY to override"

**Edge Cases:**
- [ ] **Test with cgroup v1 containers** (older Docker versions)
  - If environment supports cgroup v1, verify detection still works
  - Expected: Falls back to /proc/meminfo with appropriate warning

- [ ] **Test with conflicting memory sources**
  - Set both cgroup limit AND POSTGRES_MEMORY (different values)
  - Expected: POSTGRES_MEMORY takes precedence, logs show "POSTGRES_MEMORY" as source

---

### 5.2 .gitignore Security Pattern Additions
**Commit:** 3654a4c  
**File Modified:** `.gitignore`

**Changes Made:**
- Added certificate patterns: *.key, *.crt, *.pem, *.csr, *.p12, *.pfx, certs/
- Added backup patterns: *.dump, *.sql.gz, *.backup
- Added test log patterns: test-results-*.log
- Reorganized with clear section comments

**Tests to Run:**
- [ ] **Verify certificate files are ignored**
  - Create test certificate files
  - Command: `touch test.key test.crt test.pem certs/server.key`
  - Git check: `git check-ignore test.key test.crt certs/server.key`
  - Expected: All files are ignored (return code 0)

- [ ] **Verify backup files are ignored**
  - Create test backup files
  - Command: `touch backup.dump database.sql.gz old.backup`
  - Git check: `git check-ignore backup.dump database.sql.gz old.backup`
  - Expected: All files are ignored

- [ ] **Verify test log patterns are ignored**
  - Create test result files
  - Command: `touch test-results-001.log test-results-abc.log`
  - Git check: `git check-ignore test-results-*.log`
  - Expected: Files are ignored

- [ ] **Verify .env files still ignored**
  - Confirm original patterns still work
  - Command: `touch .env .env.local .env.production`
  - Git check: All should be ignored
  - Expected: Return code 0 for all

- [ ] **Verify exceptions still work** (!.env.example)
  - .env.example should NOT be ignored
  - Command: `git check-ignore .env.example; echo $?`
  - Expected: Return code 1 (not ignored)

**Security Verification:**
- [ ] **Test that accidentally committed secrets are caught**
  - Commit a .key file that should have been ignored
  - Run pre-commit hook if available
  - Expected: Hook should warn about committing secrets

---

### 5.3 Password Complexity & Escape Handling
**Commit:** 8ee2f84 (pgbouncer-entrypoint.sh) + 3654a4c

**Tests to Run:**
- [ ] **Test passwords with special characters**
  - Passwords containing: @, &, #, $, %, :, \, ', ", `, newline
  - Deploy with PGBOUNCER_AUTH_PASS="P@ssw0rd:with&special#chars"
  - Expected: .pgpass file correctly escapes colons and backslashes, auth works

- [ ] **Test very long passwords (256+ chars)**
  - Set PGBOUNCER_AUTH_PASS to 512-character random string
  - Expected: .pgpass handles length correctly, auth works

- [ ] **Test passwords matching regex patterns**
  - Passwords that might match hostname/IP patterns (to test escaping)
  - Expected: No parsing errors in .pgpass

- [ ] **Test null/empty password edge case**
  - Set PGBOUNCER_AUTH_PASS="" (empty)
  - Expected: Script detects and fails with clear error

- [ ] **Test unicode/multi-byte characters**
  - Password with emoji or unicode: "P@ss🔐word你好"
  - Expected: Either works correctly or fails with clear error message

---

### 5.4 Health Check Robustness
**Commits:** 8ee2f84, 3654a4c

**Tests to Run:**
- [ ] **Health check with authentication failure**
  - Set wrong PGBOUNCER_AUTH_PASS after startup
  - Expected: Health check fails, container marked unhealthy within 2-3 checks

- [ ] **Health check with database restart**
  - Restart postgres while health checks running
  - Expected: Pgbouncer detects connection lost, reconnects, health check recovers

- [ ] **Health check with network latency/jitter**
  - Add 3-5 second latency between containers, verify 10s timeout is sufficient
  - Expected: Health checks still pass with adjusted timeout

- [ ] **Multiple simultaneous health checks**
  - Deploy 10+ postgres replicas, verify health checks don't interfere
  - Expected: Each health check independent, no cascading failures

- [ ] **Health check under high memory pressure**
  - Deploy with tight memory limit (512MB), run health checks
  - Expected: Health checks still pass, database still responsive

---

### 5.5 Container Startup Under Various Conditions
**Commits:** 8ee2f84, 3654a4c

**Tests to Run:**
- [ ] **Fast container restart**
  - Kill postgres container, restart immediately (1-second interval)
  - Expected: Second start succeeds, database in consistent state

- [ ] **Startup with corrupted .pgpass**
  - Corrupt /tmp/.pgpass in running container, kill container, restart
  - Expected: New .pgpass created correctly, auth works

- [ ] **Startup with readonly /tmp**
  - Mount /tmp as readonly, attempt to create .pgpass
  - Expected: Script fails with clear error "Failed to set .pgpass permissions"

- [ ] **Startup with missing environment variables**
  - Don't set PGBOUNCER_AUTH_PASS
  - Expected: Fails with clear error message immediately

- [ ] **Startup with invalid environment variables**
  - Set POSTGRES_MEMORY=not_a_number
  - Expected: Auto-config script detects and fails with validation error

- [ ] **Startup with extreme resource limits**
  - 128MB RAM: Should work (minimum viable)
  - 512MB RAM: Should work fine
  - 256GB RAM: Should work (may need POSTGRES_MEMORY to cap)
  - Expected: All work or fail with clear error messages

---

## 6. INTEGRATION TESTS

### 6.1 Full Primary Stack Deploy
**Tests to Run:**
- [ ] **Deploy primary stack with all defaults**
  - Command: `docker compose -f stacks/primary/compose.yml up -d`
  - Verify: All 3 services start (postgres, pgbouncer, postgres_exporter)
  - Expected: All services healthy in <5 minutes

- [ ] **Verify all security fixes are applied**
  - Check: .pgpass permissions = 600
  - Check: No hardcoded credentials in running processes
  - Check: PgBouncer auth works with actual credentials
  - Expected: All checks pass

- [ ] **Verify all configuration options work**
  - Set all env vars: POSTGRES_MEMORY, PGBOUNCER_SERVER_SSLMODE, MAX_CLIENT_CONN, etc.
  - Expected: Config applies correctly, no errors

- [ ] **Verify documentation matches behavior**
  - Follow README sections step-by-step
  - Expected: All steps work as documented

---

### 6.2 Replica Stack Deploy
**Tests to Run:**
- [ ] **Deploy primary + replica stack**
  - Command: `docker compose -f stacks/primary/compose.yml -f stacks/replica/compose.yml up -d`
  - Expected: Both stacks start, replication establishes

- [ ] **Verify replication slots created**
  - Expected: pg_replication_slots has active slot

- [ ] **Test replica failover scenario**
  - Kill primary, promote replica
  - Expected: Replica becomes primary, connections work

---

## 7. REGRESSION TESTS

### 7.1 Backward Compatibility
**Tests to Run:**
- [ ] **Deployments with old .env files**
  - Use .env without new variables (POSTGRES_MEMORY, etc.)
  - Expected: Deployment still works with defaults

- [ ] **Deployments expecting sslmode=require**
  - Old deployments set PGBOUNCER_SERVER_SSLMODE explicitly in compose override
  - Expected: Still works (no breaking change in explicit setting)

- [ ] **Deployments with custom pool sizes**
  - Had hardcoded values in compose.yml, now using env vars
  - Expected: Can override via env vars, backward compatible

---

### 7.2 Security Regression
**Tests to Run:**
- [ ] **Verify no new secrets in logs**
  - Deploy and check all logs for plaintext passwords
  - Command: `docker compose logs 2>&1 | grep -i "password\|pgbouncer_auth" | grep -v "PGPASSWORD=" || echo "PASS"`
  - Expected: No passwords in logs except in env var references

- [ ] **Verify no security downgrade**
  - All SCRAM-SHA-256 auth still enforced
  - .pgpass still 600 permissions
  - pgsodium uses search_path hardening
  - Expected: All security controls still in place

---

## CHECKLIST SUMMARY

**Total Tests:** ~150 individual test items across 7 categories

**Priority Order for Testing:**
1. **CRITICAL** (Must pass before merge):
   - Security fixes: credentials removal, .pgpass perms, pgsodium search_path
   - Broken changes: sslmode default change documentation
   - Configuration: env vars applied correctly
   - Auto-config: CPU cores capping, listen_addresses fix

2. **HIGH** (Should pass before production):
   - All edge cases
   - Health check robustness
   - Full stack integration tests
   - Documentation accuracy

3. **MEDIUM** (Good to verify):
   - Backward compatibility
   - Size optimizations
   - Logging improvements

4. **LOW** (Nice to have):
   - Regression tests
   - Performance benchmarks

---

**Testing Duration:** ~4-6 hours for full comprehensive test run

**Recommended Approach:**
1. Run automated syntax checks (bash -n, yaml lint)
2. Deploy primary stack, run core security tests (1 hour)
3. Run configuration tests with env var overrides (1 hour)
4. Test edge cases and failure scenarios (1 hour)
5. Deploy replicas, test replication (1 hour)
6. Documentation verification walkthrough (30 min)
7. Regression tests and cleanup (30 min)

