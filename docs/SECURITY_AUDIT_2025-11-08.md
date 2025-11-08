COMPREHENSIVE SECURITY AND BEST PRACTICES AUDIT
================================================

PROJECT: aza-pg (Production PostgreSQL 18 Stack)
AUDIT DATE: 2025-11-08

================================================================================
CRITICAL FINDINGS (MUST FIX)
================================================================================

1. HARDCODED TEST CREDENTIALS IN COMMITTED CODE
   Severity: CRITICAL
   Location: Multiple test scripts
   Issue: Test password "dev_pgbouncer_auth_test_2025" is hardcoded in:
   - stacks/primary/scripts/pgbouncer-entrypoint.sh (lines 198, 239)
   - scripts/test/test-pgbouncer-healthcheck.sh (lines 82, 198, 239)
   - scripts/test/test-replica-stack.sh (referenced)
   
   Impact: Although documented as "safe for local testing only" in AGENTS.md,
   this password appears in version control and could be used to compromise
   any deployment using this code as a base.
   
   Risk: An attacker who clones this repo can use this hardcoded password
   to authenticate to PgBouncer if the test script logic is replicated.
   
   Recommendation: 
   - Remove all hardcoded test passwords from production code paths
   - Generate random test credentials at runtime or via environment variables
   - Add git hook to prevent password-like patterns in shell scripts

2. INSECURE TEMP FILE PERMISSIONS IN FAILURE TEST
   Severity: HIGH
   Location: scripts/test/test-pgbouncer-failures.sh
   Issue: Test intentionally sets insecure permissions:
   - "chmod 777 /tmp/.pgpass" (line contains test that checks this)
   
   Impact: If test code is accidentally executed in production or copied
   elsewhere, it would compromise the .pgpass file security model.
   
   Recommendation:
   - Isolate test failure scenarios in a dedicated test-only file
   - Never commit code that intentionally weakens security, even for testing
   - Use docker containers with temporary mounts for permission tests

3. .PGPASS FILE SECURITY NOT ENFORCED IN CONFIG
   Severity: MEDIUM
   Location: stacks/primary/scripts/pgbouncer-entrypoint.sh
   Issue: While the script correctly sets umask 077 and chmod 600, there's
   no verification that the permissions are actually applied correctly.
   Missing: Post-creation permission verification
   
   Recommendation:
   - Add assertion to verify file perms are exactly 0600 after creation
   - Fail container startup if permissions are wrong
   - Log warning if any other .pgpass* files exist

================================================================================
HIGH PRIORITY FINDINGS
================================================================================

4. INSUFFICIENT .ENV FILE COMPLETENESS
   Severity: HIGH
   Location: stacks/*/,.env.example files
   Issue: Missing environment variables in .env.example files:
   - PGBOUNCER_LISTEN_ADDR not documented (used in pgbouncer-entrypoint.sh)
   - PGBOUNCER_BIND_IP appears in compose.yml but not in .env.example
   - POSTGRES_EXPORTER_BIND_IP appears in compose.yml but not documented
   - PGBOUNCER_EXPORTER_BIND_IP appears in compose.yml but not documented
   
   Impact: Users may miss optional security configurations when deploying.
   The listen address controls network exposure (127.0.0.1 vs 0.0.0.0).
   
   Recommendation:
   - Add all network binding variables to .env.example with comments
   - Document that default 127.0.0.1 is secure for development
   - Add warning about changing to 0.0.0.0 for production networks

5. PLAINTEXT PASSWORD EXPOSURE IN DOCKER INSPECT
   Severity: HIGH
   Location: stacks/primary/compose.yml (lines 92, 130)
   Issue: PGPASSWORD and database passwords in environment variables:
   - Line 92: PGPASSWORD in postgres_exporter environment
   - Line 130: PGPASSWORD in pgbouncer_exporter environment
   - These are visible via "docker inspect" or "docker compose config"
   
   Impact: Any user with docker access can see plaintext passwords.
   The compose.yml does document this is acceptable for private networks,
   but doesn't provide alternatives.
   
   Recommendation:
   - Document the limitation clearly (already done)
   - Suggest Docker secrets for production (commented out example)
   - Note that on Kubernetes, use native secrets instead

6. MISSING SSL/TLS CONFIGURATION
   Severity: HIGH
   Location: docker/postgres/configs/postgresql-base.conf
   Issue: No SSL/TLS settings configured:
   - ssl = off (default, not explicit in config)
   - No comment explaining how to enable TLS
   - PgBouncer config has "sslmode=require" for backend but no client TLS
   
   Impact: Network traffic between clients and PgBouncer is unencrypted.
   This is acceptable for Docker internal networks but risky for remote
   replicas or network access.
   
   Recommendation:
   - Add commented-out SSL configuration block
   - Provide guide for certificate generation (ssl_cert_file, ssl_key_file)
   - Warn that "listen_addr = 0.0.0.0" should only be used with TLS

================================================================================
MEDIUM PRIORITY FINDINGS
================================================================================

7. SQL INJECTION RISK IN REPLICA SETUP (MITIGATED)
   Severity: MEDIUM (WELL-MITIGATED)
   Location: stacks/replica/scripts/00-setup-replica.sh
   Issue: Replication slot name parameter used in SQL:
   - Line 43: SELECT query uses :'slot_name' parameter
   - Line 23-26: Validation regex allows only [a-zA-Z0-9_]
   
   Status: CORRECTLY MITIGATED - psql -v parameter substitution with
   regex validation prevents injection. The slot name validation is strict
   and proper parameterized queries are used.
   
   Recommendation: Keep current approach, add comment explaining the protection

8. MISSING INPUT VALIDATION FOR PGBOUNCER_LISTEN_ADDR
   Severity: MEDIUM
   Location: stacks/primary/scripts/pgbouncer-entrypoint.sh (lines 43-58)
   Issue: IP address validation is present and good:
   - Lines 43: Regex checks format
   - Lines 50-57: Octet range validation (0-255)
   - But no validation for reserved IPs (0.0.0.0 is allowed, which is fine)
   
   Status: GOOD - Validation is thorough. Could add warning comment about
   0.0.0.0 being accessible to all interfaces.
   
   Recommendation: Add inline comment about implications of each setting

9. PASSWORD ESCAPE SEQUENCE HANDLING IN PGBOUNCER
   Severity: MEDIUM
   Location: stacks/primary/scripts/pgbouncer-entrypoint.sh (lines 14-25)
   Issue: Password escaping for .pgpass:
   - Only escapes backslash and colon
   - .pgpass format requires these escapes but other characters are OK
   - Documentation states "@", "&", etc. are supported
   
   Status: CORRECT - .pgpass format (RFC-compliant) only requires
   escaping backslash and colon. Other special chars (@, &, #) don't
   need escaping in .pgpass format.
   
   Recommendation: Add comment referencing .pgpass format specification

10. MEMORY AUTO-CONFIG VALIDATION
    Severity: MEDIUM
    Location: docker/postgres/docker-auto-config-entrypoint.sh
    Issue: 
    - Line 50: Max memory check uses 1TB limit, reasonable but arbitrary
    - No warning if detected RAM equals physical limit (may indicate container)
    - Falls back to /proc/meminfo which reflects host, not container
    
    Status: ACCEPTABLE - The logic is sound:
    1. POSTGRES_MEMORY env var (highest priority, user override)
    2. cgroup v2 limit (Docker limit if set)
    3. /proc/meminfo (fallback, reflects host)
    The documentation clearly explains this behavior.
    
    Recommendation: Add log message when fallback to meminfo is used

11. PG_HBA.conf ALLOWS PRIVATE NETWORK ACCESS
    Severity: MEDIUM
    Location: stacks/primary/configs/pg_hba.conf (lines 16-28)
    Issue: Allows SCRAM-SHA-256 from entire private subnets:
    - 10.0.0.0/8 (Class A private)
    - 172.16.0.0/12 (Class B private)
    - 192.168.0.0/16 (Class C private)
    
    Status: REASONABLE - These are RFC 1918 private ranges, common in
    Docker and enterprise networks. However, very broad (millions of IPs
    in 10.0.0.0/8).
    
    Recommendation: Document the assumption that network boundary is
    secured by firewall/security groups. Consider more specific ranges
    if deploying across multiple subnets.

12. PGPASSWORD ENVIRONMENT VARIABLE USAGE
    Severity: LOW-MEDIUM
    Location: Multiple scripts using PGPASSWORD:
    - stacks/replica/scripts/00-setup-replica.sh (lines 31, 43, 66)
    
    Status: ACCEPTABLE - PGPASSWORD is standard PostgreSQL approach for
    non-interactive scripts. It's specifically designed for this purpose.
    psql and pg_basebackup commands properly support it.
    
    Note: The password is passed via environment variable which is visible
    in /proc/*/environ briefly, but this is the standard practice.
    
    Recommendation: Document that this is standard PostgreSQL pattern

================================================================================
LOW PRIORITY / BEST PRACTICE FINDINGS
================================================================================

13. .GITIGNORE COMPLETENESS
    Severity: LOW
    Location: .gitignore
    Issue: Missing patterns:
    - .env.local (common for local overrides)
    - .env.*.local (stack-specific locals)
    - *.key (SSL/TLS private keys)
    - *.crt (SSL certificates, though usually OK to commit test certs)
    - .pgpass* (unlikely but defensive)
    
    Status: GOOD - Current .gitignore catches .env and .env.*, which are
    the critical files. Test certificates might intentionally be committed.
    
    Recommendation: Add comment explaining why .env files are excluded
    and emphasize chmod 600 requirement

14. DOCKER COMPOSE FILE CLEANUP ON EXIT
    Severity: LOW
    Location: scripts/test/test-pgbouncer-failures.sh
    Issue: Cleanup function removes files but doesn't verify success
    - Line 76: docker compose down -v could fail silently
    
    Status: ACCEPTABLE - Test cleanup with || true pattern is appropriate
    
    Recommendation: Keep current approach (test cleanup doesn't break if
    resources are already gone)

15. POSTGRES EXPORTER CONFIGURATION
    Severity: LOW
    Location: docker/postgres/configs/postgres_exporter_queries.yaml
    Issue: Custom queries execute sensitive queries:
    - pg_settings (includes configuration paths and sources)
    - pg_ls_waldir() (WAL file information)
    
    Status: ACCEPTABLE - These metrics are intended to be exposed on
    monitoring network. Assume monitoring network is internal.
    
    Recommendation: Document assumption that monitoring network is
    isolated and not internet-facing

16. PG_CRON AND PGAUDIT ENABLED BY DEFAULT
    Severity: LOW
    Location: docker/postgres/docker-auto-config-entrypoint.sh (line 15)
    Issue: pgaudit logs all DDL, WRITE, ROLE changes by default
    - Could generate high log volume in active systems
    - pg_cron has minimal overhead
    
    Status: APPROPRIATE - pgaudit is critical for production audit trails
    
    Recommendation: Document log volume expectations and rotation strategy

================================================================================
POSITIVE SECURITY FINDINGS (Well Implemented)
================================================================================

✓ SCRAM-SHA-256 Authentication
  - No MD5 password hashes used
  - Proper authentication method throughout

✓ PGBOUNCER AUTH FUNCTION (SECURITY DEFINER)
  - Reads pg_shadow via secure function
  - Proper privilege separation with pgbouncer_auth user
  - No plaintext userlist.txt

✓ CONNECTION LIMITS PER ROLE
  - postgres: 50 connections (line 48 in 02-replication.sh)
  - replicator: 5 connections (line 49)
  - pgbouncer_auth: 10 connections (line 32 in 03-pgbouncer-auth.sh)

✓ PGDATA PATH VALIDATION
  - Replica setup validates PGDATA starts with /var/lib/postgresql (line 56)
  - Prevents rm -rf on arbitrary paths

✓ REPLICATION SLOT NAME VALIDATION
  - Regex enforces [a-zA-Z0-9_] only (line 17, 24)
  - Prevents SQL injection via slot names

✓ UMASK ENFORCEMENT
  - pgbouncer-entrypoint.sh sets umask 077 before creating .pgpass
  - Files created with 0600 permissions by default

✓ SHA-PINNED EXTENSION BUILDS
  - All compiled extensions use Git commit SHAs
  - Prevents tag poisoning attacks
  - Immutable references

✓ PGDG GPG-SIGNED PACKAGES
  - Extensions from apt.postgresql.org are GPG verified
  - Proper supply chain verification for PGDG packages

✓ MINIMAL DEFAULT PRELOAD
  - Only pg_stat_statements, auto_explain, pg_cron, pgaudit by default
  - Users can override via POSTGRES_SHARED_PRELOAD_LIBRARIES
  - Optional extensions can be explicitly added

✓ DATA CHECKSUMS ENABLED
  - Enabled by default via Debian PostgreSQL initdb
  - Can be disabled explicitly with DISABLE_DATA_CHECKSUMS=true
  - Good corruption detection

✓ PROPER LOGGING CONFIGURATION
  - Logs go to stderr (no file confusion)
  - Includes user, database, app name, client IP in prefix
  - Connection/disconnection logging enabled
  - Autovacuum logging enabled

================================================================================
ENVIRONMENT VARIABLE DOCUMENTATION
================================================================================

REVIEWED: .env.example files for completeness

DOCUMENTED IN .env.example:
✓ POSTGRES_IMAGE
✓ POSTGRES_CONTAINER_NAME
✓ POSTGRES_BIND_IP
✓ POSTGRES_PORT
✓ POSTGRES_DB
✓ POSTGRES_PASSWORD
✓ PG_REPLICATION_PASSWORD
✓ PGBOUNCER_AUTH_PASS
✓ Memory limits (POSTGRES_MEMORY_LIMIT, etc.)
✓ Volume names
✓ Network names

MISSING OR UNDER-DOCUMENTED:
✗ PGBOUNCER_LISTEN_ADDR (used in pgbouncer-entrypoint.sh, not in .env.example)
✗ PGBOUNCER_BIND_IP (used in compose.yml, not clearly documented)
✗ POSTGRES_EXPORTER_BIND_IP (used in compose.yml, not in .env.example)
✗ PGBOUNCER_EXPORTER_BIND_IP (used in compose.yml, not in .env.example)
✗ POSTGRES_MEMORY (mentioned in AGENTS.md as env override, not in .env.example)
✗ POSTGRES_SHARED_PRELOAD_LIBRARIES (documented in AGENTS.md, not in .env.example)
✗ DISABLE_DATA_CHECKSUMS (boolean override, not documented)

RECOMMENDATIONS:
- Add all *_BIND_IP variables with defaults and security notes
- Document POSTGRES_MEMORY override pattern
- Add POSTGRES_SHARED_PRELOAD_LIBRARIES with safe examples
- Add DISABLE_DATA_CHECKSUMS with warnings against disabling

================================================================================
SECURITY WARNINGS IN CODE
================================================================================

Found good inline security documentation:
✓ Password escaping rules documented in pgbouncer-entrypoint.sh
✓ PGPASSWORD visible in docker inspect noted in compose.yml (lines 91, 129)
✓ Private network assumption documented in docker/postgres/configs/postgresql-base.conf (line 10)
✓ chmod 600 requirement documented in .env.example files

Missing documentation:
- Risk of 0.0.0.0 listen address without TLS
- Assumption about Docker network isolation
- Monitoring network isolation requirement

================================================================================
SUMMARY OF RECOMMENDED FIXES
================================================================================

CRITICAL (Must Fix):
1. Remove or parameterize hardcoded "dev_pgbouncer_auth_test_2025" password
2. Isolate test failure scenarios that intentionally break security

HIGH (Should Fix):
3. Add missing env vars to .env.example files
4. Add SSL/TLS configuration guide and commented examples
5. Add permission verification in pgbouncer-entrypoint.sh

MEDIUM (Should Consider):
6. Document memory auto-config fallback behavior
7. Document pg_hba.conf subnet assumptions
8. Add explicit comments about when 0.0.0.0 is unsafe without TLS

LOW (Nice to Have):
9. Extend .gitignore for defense-in-depth
10. Document monitoring network isolation requirement
11. Document log volume expectations for pgaudit

================================================================================
CONCLUSION
================================================================================

OVERALL SECURITY POSTURE: GOOD with some improvements needed

The codebase demonstrates strong security foundations:
- Proper authentication (SCRAM-SHA-256)
- Good permission handling (umask, chmod)
- Input validation where needed
- SHA-pinned external dependencies
- Minimal attack surface by default

Key Issues to Address:
1. Remove hardcoded test credentials from committed code
2. Complete .env.example documentation
3. Add SSL/TLS configuration guides

The architecture itself is secure for private Docker networks and properly
documented. The issues found are primarily about documentation completeness
and test code hygiene rather than fundamental security flaws.

Most security risks are mitigated by the assumption of deployment on
private networks (Docker, firewalled cloud VPCs). For internet-facing
deployments, TLS must be enabled and firewall rules enforced.

================================================================================
