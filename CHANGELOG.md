# Changelog

All notable changes to aza-pg will be documented in this file.

## [Unreleased]

### Fixed

- Fix hardcoded test passwords in 6 test scripts (Phase 7)
- Fix absolute paths in all TypeScript scripts for portability (Phase 6)
- Fix 37 vs 38 extension count inconsistency across codebase (Phase 6)
- Fix SQL identifier quoting in generated scripts (Phase 6)

### Changed

- Modernize tsconfig types to Bun 1.3+ convention (Phase 6)
- Standardize GitHub Actions to oven-sh/setup-bun@v2 (Phase 6)
- Make Dockerfile PGDG assertion dynamic based on manifest (Phase 7)

### Added

- Add Trivy vulnerability scanning to CI/CD pipeline (Phase 7)
- Add SARIF export for hadolint and shellcheck (Phase 7)
- Add OCI metadata labels to Dockerfile (Phase 7)
- Add Bun-not-in-final-image assertion (Phase 7)

### Removed

- Remove unused yaml-lint npm package (Phase 6)

---

## [2025-11-08] - Security & Documentation Audit

### ⚠️ BREAKING CHANGES

- **PGBOUNCER_SERVER_SSLMODE**: Changed from `require` to `prefer` (TLS now optional by default)
  - **Impact**: Existing deployments expecting enforced TLS must explicitly set `PGBOUNCER_SERVER_SSLMODE=require`
  - **Rationale**: PostgreSQL TLS disabled by default in image; `require` mode breaks all connections without certificates
  - **Migration**: Deploy TLS certificates first, then set `PGBOUNCER_SERVER_SSLMODE=require` in .env
- **POSTGRES_BIND_IP**: Now honors specific IP addresses instead of forcing 0.0.0.0
  - **Impact**: Setting `POSTGRES_BIND_IP=192.168.1.100` now binds to that specific IP only (not all interfaces)
  - **Migration**: Deployments expecting all-interface binding should explicitly set `POSTGRES_BIND_IP=0.0.0.0`
- **Test Credentials**: Removed hardcoded `dev_pgbouncer_auth_test_2025` password
  - **Impact**: All test scripts now generate unique passwords at runtime
  - **Migration**: Update any external test automation that relied on hardcoded credentials

### 🔒 Security Fixes

**Critical:**

- Remove hardcoded test credentials from all test scripts (generate unique passwords at runtime)
- Harden pgsodium init script with `SET search_path=pg_catalog` (prevents search_path injection attacks)
- Add explicit .pgpass permission verification (600) in pgbouncer-entrypoint.sh (fail fast with clear error if permissions cannot be set)
- Fixed PgBouncer healthcheck (tests actual connectivity via psql SELECT 1, not version output)
- Added git URL domain allowlist validation (github.com, gitlab.com only) in build-extensions.sh
- Fixed password validation in primary compose.yml (added :? operators for POSTGRES_PASSWORD, PG_REPLICATION_PASSWORD, PGBOUNCER_AUTH_PASS)
- Fixed PgBouncer sed injection vulnerability (changed to pipe delimiter)
- Fixed effective_cache_size calculation to cap at 75% RAM (prevents over-allocation)
- Added POSTGRES_MEMORY upper bound validation (rejects > 1TB)
- Added REPLICATION_SLOT_NAME validation (prevents SQL injection)

**High:**

- Add password complexity guidance to primary/.env.example (minimum 16 chars, avoid special chars that need escaping)
- Improved IP validation regex in pgbouncer-entrypoint.sh (proper 0-255 octet range validation, rejects 999.999.999)
- Fixed PgBouncer healthcheck .pgpass mismatch (added localhost:6432 and pgbouncer:6432 entries)
- Add defensive .gitignore patterns (certificates, backups, additional log patterns)

**Medium:**

- Added password escape error checking in pgbouncer-entrypoint.sh (validates sed success before continuing)
- Add security test comment to test-pgbouncer-failures.sh (clarify chmod 777 is intentional test behavior, not vulnerability)

### ⚡ Performance & Build Optimizations (Phase 1)

**Size Reductions (-60-95MB total):**

- Remove Python3 from runtime packages (-100MB, only needed at build time)
- Strip PGDG .so libraries post-install (-5-15MB debug symbols)
- Add `apt-get clean` to all Dockerfile RUN blocks (-60MB across 3 layers)

**Total Savings:** 60-95MB image size reduction (timescaledb_toolkit: 186MB→13MB from Phase 11 Rust optimization)

### 📚 Documentation Fixes

**Critical:**

- **TLS enablement guide** added to README.md Security section
- **Memory allocation table** fixed: 10 incorrect values across 8 rows (64GB: 54706MB→49152MB, aligned with 75% cap)
- **timescaledb_toolkit size** updated across 8 files (186MB→13MB, 52 references with historical context)
- Fixed postgres_exporter_queries.yaml path reference in AGENTS.md (line 277: @stacks/... → docker/postgres/...)
- Updated AGENTS.md init script execution order to include 03-pgsodium-init.sh
- Remove obsolete !override tag requirement from README.md and AGENTS.md

**High:**

- **Extension counts**: Clarified 38 total (6 builtin + 14 PGDG + 18 source-compiled)
- **shared_preload_libraries**: Enhanced runtime config comments (default: pg_stat_statements,auto_explain,pg_cron,pgaudit)
- Fixed default shared_preload_libraries documentation (7→4 extensions)
- Fixed "creates all extensions" claim (→"creates 5 baseline extensions")
- Added exporter ports for all stacks (primary:9187/9127, replica:9188, single:9189)

**Medium:**

- Created docs/archive/README.md explaining historical documents contain outdated information
- Updated hook-based extensions section to enumerate all 6 tools (pgbackrest, pgbadger, pg_plan_filter, pg_safeupdate, supautils, wal2json)
- Fixed listen_addresses docs (127.0.0.1 not \*), AUTO-CONFIG grep instructions, synchronous replication guidance

### 🐛 Bug Fixes

**Critical:**

- **Healthcheck timeouts**: postgres start_period 60s → 120s (primary/replica/single stacks) - prevents failures on large database startup
- Fixed wait loop in run-extension-smoke.sh (replaced broken for loop with proper while loop + timeout)
- Fixed dev memory override in compose.dev.yml (hardcoded 512m → ${POSTGRES_DEV_MEMORY_RESERVATION:-512m})
- Added comprehensive error handling to config generator (wraps all writeFileSync in try-catch, exits on failure)
- Fixed Dockerfile ARG duplication (inherit from parent stage properly)
- Fixed postgresql-base.conf precedence comment (command-line -c overrides file)

**High:**

- Fix undefined `cleanup_test_container` function in test-auto-config.sh (use docker_cleanup from common.sh)
- Fix listen_addresses to honor specific IPs instead of forcing 0.0.0.0
- Add max_worker_processes cap at 64 (prevent exceeding PostgreSQL hard limits)
- Add CPU core sanity check (clamp 1-128 cores with warnings for out-of-range values)

**Medium:**

- Remove non-standard !override YAML tag from compose.dev.yml (Docker Compose v2.24.4+ handles merges correctly)
- Removed orphaned cleanup_test_container() function from common.sh (consolidated to docker_cleanup)
- Added log_replication_commands to replica config
- Fixed primary compose.dev.yml network conflict (proper override behavior)
- Fixed supautils defaultEnable (true→false, reflects actual behavior)
- Fixed test-extensions.ts extension name (safeupdate→pg_safeupdate)

### 🔧 Configuration Enhancements

**New Environment Variables:** 29 total added to .env.example files (11 PRIMARY, 9 REPLICA, 9 SINGLE)

- Key additions: `COMPOSE_PROJECT_NAME`, `POSTGRES_USER`, exporter images/bind IPs, `DISABLE_DATA_CHECKSUMS`, `ENABLE_PGSODIUM_INIT`, `POSTGRES_INITDB_ARGS`, network names

**Variables Made Configurable:**

- `PGBOUNCER_SERVER_SSLMODE`, `PGBOUNCER_MAX_CLIENT_CONN`, `PGBOUNCER_DEFAULT_POOL_SIZE`, `POSTGRES_MEMORY`, `POSTGRES_SHARED_PRELOAD_LIBRARIES`

### 🔍 Operational Improvements (Phase 3)

**Enhanced Logging:**

- Log exact computed worker values (max_worker_processes, max_parallel_workers, max_parallel_workers_per_gather)
- Enhanced auto-config logging for troubleshooting
- Warn when /proc/meminfo fallback is used (may reflect host RAM instead of container limit)
- Recommend setting POSTGRES_MEMORY for deterministic tuning in containerized environments
- Warn when nproc fallback is used for CPU detection (no cgroup quota set)

### 📊 Impact Summary

- **Security**: 6 vulnerabilities fixed (3 critical, 2 high, 1 medium) - eliminated hardcoded credentials, hardened pgsodium against injection
- **Performance**: 60-95MB image reduction, healthcheck timeouts optimized, worker process caps added
- **Configuration**: 29 new env vars, 5 made configurable, TLS defaults to optional
- **Documentation**: 52 size refs + 10 memory values corrected, TLS guide added, init script order clarified
- **Reliability**: 3 critical bugs fixed (healthcheck timeouts, listen_addresses, cleanup functions)

**Audit:** 4-phase audit 2025-11-08 - All critical/high-priority issues resolved (60+ findings).

---

## [Previous Releases] - 2025-11-05 and Earlier

For detailed changelog history before 2025-11-08, see [CHANGELOG.archive.md](CHANGELOG.archive.md).

**Recent highlights:**

- 2025-11-06: Added pgq extension, pgflow workflow orchestration, manifest-driven build system
- 2025-11-05: Extension classification fixes, documentation updates, manifest validator
- 2025-11: PGDG hybrid strategy (14 extensions migrated), image size optimization (1.41GB→1.14GB), extension enable/disable architecture
- 2025-05: Security hardening (SHA-pinned base image, TLS support), configuration improvements, comprehensive documentation
