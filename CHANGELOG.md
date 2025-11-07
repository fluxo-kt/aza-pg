# Changelog

All notable changes to aza-pg will be documented in this file.

## [Unreleased] - 2025-11-07

### 🔒 Security Fixes
- **Critical:** Fixed PgBouncer sed injection vulnerability (changed to pipe delimiter)
- **Critical:** Fixed effective_cache_size calculation to cap at 75% RAM (prevents over-allocation)
- **Critical:** Added POSTGRES_MEMORY upper bound validation (rejects > 1TB)
- **Critical:** Added REPLICATION_SLOT_NAME validation (prevents SQL injection)
- **Security:** Fixed PgBouncer healthcheck .pgpass mismatch (added localhost:6432 and pgbouncer:6432 entries)

### 🐛 Bug Fixes
- **Config:** Fixed Dockerfile ARG duplication (inherit from parent stage properly)
- **Config:** Fixed postgresql-base.conf precedence comment (command-line -c overrides file)
- **Config:** Added log_replication_commands to replica config
- **Compose:** Fixed primary compose.dev.yml network conflict (proper override behavior)
- **Manifest:** Fixed supautils defaultEnable (true→false, reflects actual behavior)
- **Tests:** Fixed test-extensions.ts extension name (safeupdate→pg_safeupdate)

### 📚 Documentation Corrections
- **EXTENSIONS.md:** Fixed default shared_preload_libraries (7→4 extensions: pg_stat_statements, auto_explain, pg_cron, pgaudit)
- **architecture.md:** Fixed "creates all extensions" claim (→"creates 5 baseline extensions")
- **PERFORMANCE-IMPACT.md:** Fixed extension counts (15+17→14+18, total 38)
- **CI workflow:** Fixed extension count summary (37→38)
- **AGENTS.md:** Fixed file path references to match actual structure
- **PRODUCTION.md:** Fixed listen_addresses docs (127.0.0.1 not *), AUTO-CONFIG grep instructions, synchronous replication guidance
- **README.md:** Added exporter ports for all stacks (primary:9187/9127, replica:9188, single:9189)
- **Archived stale reports:** Moved 4 audit reports to docs/archive/

### ✨ Features & Improvements
- **Build System:** Implemented build.patches support in manifest (mentioned in 3 audit reports)
  * Added patches?: string[] field to BuildSpec interface
  * Moved 3 hardcoded sed patches to manifest (pg_jsonschema, wrappers, supautils)
  * Updated build-extensions.sh for manifest-driven patch application
  * Intelligently finds target files (Cargo.toml, .c files) based on patch content
- **Testing:** Made test-extensions.ts fully manifest-driven (removed 46 lines of hardcoded arrays)
  * Now dynamically imports from manifest-data.ts
  * Single source of truth, auto-syncs with manifest changes
  * Reduced code by 36 lines (-76%)
- **Testing:** Created comprehensive manifest validator (290 lines, validates 38 extensions across 5 dimensions)
- **Testing:** Integrated manifest validator into build.sh (preflight check, fails fast)
- **Testing:** Created PgBouncer healthcheck test suite (254 lines, 8 test cases)
- **Testing:** Added AUTO-CONFIG log token assertion to test-auto-config.sh
- **Testing:** Added comprehensive extension tests to CI workflow (all 38 extensions)
- **Testing:** Increased CI timeout (15→25min for thorough extension testing)
- **Code Quality:** Extended scripts/lib/common.sh with 3 reusable functions (check_command, check_docker_daemon, wait_for_postgres)
- **Code Quality:** Refactored 6 scripts to use common library (eliminated duplication)
- **Code Quality:** Added shellcheck directives to all scripts
- **Docs:** Created comprehensive scripts/README.md (554 lines, all scripts documented)
- **Docs:** Created scripts/extensions/README.md (manifest validator documentation)
- **Docs:** Documented pgroonga compile-from-source rationale (NOT available in PGDG for PG18)

### 🔧 Configuration
- **Compose:** Fixed healthcheck retry inconsistency (primary 3→5 retries to match replica/single)
- **Compose:** Standardized postgres healthcheck to use ${POSTGRES_USER:-postgres} across all stacks
- **Compose:** Removed duplicate postgres_exporter_queries.yaml (single source of truth)
- **Compose:** Added env_file to single stack compose.yml
- **Compose:** Added POSTGRES_USER to primary/.env
- **Compose:** Standardized memory units (M→m) across all stacks
- **Dockerfile:** Converted PGDG version pins to ARGs (14 extensions, better maintainability)
- **Manifest:** Added runtime specs to pgbackrest and pgbadger tools
- **Entrypoint:** Added AUTO-CONFIG log token for reliable monitoring

### 📊 Code Metrics
- Duplicate prerequisite checks: 5 → 0 (-100%)
- Duplicate PostgreSQL readiness checks: 4 → 0 (-100%)
- Scripts with shellcheck directives: 3 → 8 (+167%)
- Documentation coverage: 0% → 100%
- Test coverage in CI: 13% → 100% (5→38 extensions tested)

### 🔍 Validation
- ✅ Manifest validator passes (38 extensions: 6 builtin + 14 PGDG + 18 compiled)
- ✅ All shellcheck validations pass
- ✅ Pre-commit hooks pass (no secrets, correct file permissions)

### 🙏 Acknowledgments
This release incorporates findings from 5 comprehensive audit reports analyzing security, configuration consistency, extension management, documentation accuracy, and code quality. All critical issues identified have been resolved.

---

## [Previous Release] - 2025-11-06

### Added
- **Extension:** pgq v3.5.1 (Generic high-performance lockless queue for PostgreSQL)
- **Extension:** pgq compiled from source (NOT available in PGDG for PostgreSQL 18)
- **Workflow:** pgflow v0.7.2 SQL schema for workflow orchestration
- **Dependency:** pgflow uses pgmq extension (already installed) for task queuing
- **Docs:** pgflow integration guide at `docs/pgflow/INTEGRATION.md`
- **Init Script:** `10-pgflow.sql` creates pgflow schema with 7 core tables and 15+ functions

### Changed
- **Extension count:** 37 → 38 total extensions
- **Compiled extensions:** 17 → 18 (added pgq)
- **Init scripts:** Added pgflow workflow orchestration schema (optional, auto-installed)

### Technical Details
- pgq: Pure PLpgSQL extension, no external dependencies, PostgreSQL 10-18 compatible
- pgflow: Workflow DAG engine with task scheduling, retry logic, step dependencies
- pgflow limitations: Real-time events stubbed (no Supabase integration), requires custom worker
- Installation: pgflow schema ~44KB SQL, creates pgflow/pgmq/realtime schemas
- Security: pgflow functions use SECURITY DEFINER where needed, search_path hardened

**References**: See `docs/pgflow/INTEGRATION.md` for pgflow architecture, worker patterns, and migration guide

---

## [Previous Release] - 2025-11-05

### Fixed
- **Extensions**: Corrected extension vs tool classifications (vector, pg_cron, pgaudit → extension; pg_safeupdate, supautils → tool)
- **Extensions**: Set timescaledb defaultEnable to false (not auto-created by init script)
- **Config**: Removed shared_preload_libraries duplication between base config and runtime entrypoint
- **Docs**: Fixed work_mem values for 2GB nodes (2MB → 4MB) in AGENTS.md, README.md, PRODUCTION.md
- **Docs**: Updated shared_buffers documentation (12.5%/8GB → 15-25%/32GB cap)
- **Docs**: Corrected preloaded extension count (4 → 7 extensions)
- **Docs**: Fixed "creates ALL extensions" claim to "creates 5 baseline extensions"
- **CI**: Removed unused build-args (PGVECTOR_VERSION, PG_CRON_VERSION, PGAUDIT_VERSION)
- **Docs**: Added minimum Docker Compose version requirement (v2.24.4+)

### Added
- **Config**: Documented POSTGRES_SHARED_PRELOAD_LIBRARIES override in AGENTS.md
- **Docs**: Network security hardening guidance in PRODUCTION.md
- **Docs**: Comprehensive extension testing strategy document (TESTING-STRATEGY.md)
- **Docs**: Build script workaround documentation for pgrx version fixes

### Changed
- Extension manifest regenerated with correct classifications
- PostgreSQL configs regenerated without hardcoded shared_preload_libraries
- CI workflow simplified to reference manifest.json for version management

### Technical Details
- Resolved 14 verified audit findings from VERIFICATION_REPORT.md
- 10 commits across 11 phases of remediation
- Files modified: 15+ configuration, documentation, and script files
- Bitcode cleanup verified present in Dockerfile (line 135)

**References**: See VERIFICATION_REPORT.md and TODO_PROGRESS.md for detailed breakdown

---

## [Previous Releases]

### Optimized (PGDG Hybrid Extension Strategy - 2025-11)
- **Build:** Migrated 14 extensions to PGDG pre-compiled packages (pg_cron, pgaudit, pgvector, timescaledb, postgis, pg_partman, pg_repack, plpgsql_check, hll, http, hypopg, pgrouting, rum, set_user)
- **Build:** Reduced extension compilation from 31→17 extensions (45% reduction)
- **Build:** Added `install_via: "pgdg"` manifest field to flag PGDG extensions
- **Build:** Updated `build-extensions.sh` to skip PGDG-flagged extensions during compilation
- **Build:** Added missing implicit dependencies (`zlib1g-dev`, `libicu-dev`) to build-packages.txt
- **Build:** Build time optimized to ~12min (14 PGDG packages install in ~10s, 17 extensions compile in ~12min)
- **Security:** Hybrid security model - PGDG packages use GPG-signed APT repository, compiled extensions use SHA256-pinned Git commits
- **Docs:** Updated CLAUDE.md/AGENTS.md with hybrid strategy explanation, upgrade procedures, and security trade-offs
- **Test:** Created comprehensive Bun TypeScript test suite (`scripts/test/test-extensions.ts`) validating 37 extensions

### Fixed (Phase 1 - Extension Verification & Corrections - 2025-11)
- **Build:** Reverted wal2json from PGDG to compiled (PGDG package incomplete - missing .control file for logical decoding plugin)
- **Manifest:** Corrected pg_safeupdate kind from "extension" to "tool" (hook-based, no CREATE EXTENSION)
- **Test:** Fixed test suite error reporting - replaced `.quiet()` with `.nothrow()` for proper error messages
- **Test:** Categorized hook-based extensions correctly (pg_plan_filter, pg_safeupdate) - no .control files, load via shared libraries
- **Test:** Categorized logical decoding plugins correctly (wal2json) - output plugin for replication, not CREATE EXTENSION
- **Test:** Test results improved to 29/37 passing (78% success rate)

### Fixed (Phase 2 - Test Suite Completion - 2025-11)
- **Test:** Added retry logic with exponential backoff (2s, 4s, 6s) for transient database restart errors
- **Test:** Fixed pg_partman query: `partman.part_config` → `part_config` (schema qualification issue)
- **Test:** Fixed hypopg query: `hypopg_list_indexes()` → check `pg_available_extensions` (function availability)
- **Test:** Fixed pg_stat_monitor query: `pg_stat_monitor_settings` → `pg_stat_monitor` (table vs view)
- **Test:** Fixed pgmq query: `pgmq.pgmq_create()` → `pgmq.create()` (correct function name)
- **Test:** Reclassified supautils: `compiled` → `compiled-hook` (no CREATE EXTENSION, GUC-based)
- **Test:** Fixed supautils GUC: `https_protocol_version` → `superuser` (correct parameter name)
- **Test:** All 37 extensions now passing (100% success rate) - 8 false negatives eliminated

### Optimized (Phase 3 - Image Size Reduction - 2025-11)
- **Build:** Added `strip --strip-debug` for all `.so` files in both builder stages
- **Build:** Removed LLVM bitcode directory (36MB savings)
- **Build:** Removed static libraries (`.a` files, 1.5MB savings)
- **Build:** Image size reduced: 1.41GB → 1.17GB (240MB savings / 17% reduction)
- **Build:** timescaledb_toolkit optimized: 186MB → ~20MB (debug symbols removed)
- **Build:** Total extension binaries: ~930MB → ~690MB
- **Test:** All 37 extensions verified functional after optimization
- **Perf:** No build time impact (strip operations add ~5 seconds total)

### Fixed (Phase 4 - Manifest Corrections - 2025-11)
- **Manifest:** Corrected supautils kind from "extension" to "tool" (hook-based library with no CREATE EXTENSION support)
- **Manifest:** Added clarifying note to supautils: "Hook-based library with no CREATE EXTENSION support. Provides GUC parameters and event trigger hooks only."
- **Docs:** Verified pg_plan_filter and pg_safeupdate already correctly classified as "tool" in manifest

### Fixed (Phase 5 - Remove Broken Auto-Config Override - 2025-11)
- **Config:** Removed POSTGRES_SKIP_AUTOCONFIG feature (broken - missing shared_preload_libraries initialization)
- **Entrypoint:** Removed POSTGRES_SKIP_AUTOCONFIG check from docker-auto-config-entrypoint.sh (lines 30-33)
- **Docs:** Removed all POSTGRES_SKIP_AUTOCONFIG references from documentation (AGENTS.md, README.md, architecture.md, PRODUCTION.md)
- **Stack:** Removed POSTGRES_SKIP_AUTOCONFIG env var from all stack configs (.env, .env.example, compose.yml files)
- **Generator:** Updated scripts/config-generator/generator.ts to reflect auto-config always enabled
- **Test:** Removed POSTGRES_SKIP_AUTOCONFIG from test-build.sh
- **Simplification:** Auto-config now always enabled, cannot be disabled (eliminates broken code path)

### Skipped (Phase 6 - wal2json PGDG Migration - 2025-11)
- **Analysis:** wal2json PGDG migration not viable - package incomplete (missing .control file for logical decoding plugin)
- **Status:** Already reverted from PGDG to compiled in Phase 1, remains compiled from source
- **Manifest:** wal2json correctly classified as "tool" with build.type "pgxs" and install_via null

### Added (Phase 7-8 - Documentation Enhancements - 2025-11)
- **Docs:** Added "Hook-Based Extensions & Tools" section to AGENTS.md explaining pg_plan_filter, pg_safeupdate, supautils, wal2json
- **Docs:** Added comprehensive memory allocation table to AGENTS.md (8 RAM tiers from 512MB to 64GB)
- **Docs:** Added extension memory overhead estimates (base: 50-100MB, pgvector: 10-50MB/conn, timescaledb: 20-100MB, pg_cron: 5-10MB)
- **Docs:** Added "Why These Numbers Matter" section explaining 512MB vs 16GB+ deployment characteristics
- **Docs:** Clarified manifest field usage for hook-based extensions (kind: "tool", sharedPreload: true)

### Optimized (Phase 9 - Per-Extension Impact Analysis - 2025-11)
- **Build:** Fixed LLVM bitcode cleanup in final image (34MB savings - was only removed from builder stages)
- **Build:** Image size: 1.17GB → 1.14GB (-34MB / -3%)
- **Docs:** Created SIZE-ANALYSIS.md with per-extension size breakdown (timescaledb_toolkit: 186MB outlier identified)
- **Docs:** Created PREBUILT-BINARIES-ANALYSIS.md with GitHub release research for 18 compiled extensions
- **Docs:** Identified 3 viable pre-built binary candidates: pgroonga (2-3min build savings), supautils (30sec), pgbadger (refactor needed)
- **Docs:** Created PERFORMANCE-IMPACT.md with comprehensive analysis of all 37 extensions (size, memory, performance, build time)
- **Test:** Created test-extension-performance.ts benchmarking suite (pgvector, timescaledb, postgis, pg_jsonschema, pgroonga, pg_cron)
- **Test:** Performance benchmarks include: execution time, throughput (ops/sec), memory overhead, index performance

### Verified (Phase 10 - PGDG Availability Analysis - 2025-11)
- **Research:** Attempted pgroonga PGDG migration based on initial documentation research
- **Build:** Build tests revealed pgroonga NOT available in PGDG repository for PostgreSQL 18 / Debian Trixie
- **Build:** Tested package names: `postgresql-18-pgdg-pgroonga` and `postgresql-18-pgroonga` (both failed with "Unable to locate package")
- **Root Cause:** PGroonga maintains separate APT repository, not included in PGDG (apt.postgresql.org)
- **Docs:** Updated PGDG-AVAILABILITY.md with corrected findings: pgroonga must remain source-compiled
- **Docs:** Documented "Must Remain Compiled" list updated to 17 extensions (added pgroonga)
- **Lesson:** Always verify package availability via actual build tests, not just documentation
- **Status:** No additional PGDG migrations possible from current 37-extension set (14 PGDG, 18 compiled)

### Optimized (Phase 11 - Rust Extension Size Optimization - 2025-11)
- **Build:** Added CARGO_PROFILE_RELEASE_* optimization flags for Rust extensions (opt-level=s, lto=thin, strip=symbols)
- **Build:** Modified build-extensions.sh to unset RUSTFLAGS during cargo-pgrx installation (prevents tool build conflicts)
- **Binary Sizes:** Rust extension reductions (4 extensions optimized):
  - pg_jsonschema: 4.3MB → 2.9MB (-1.4MB, **-32.6%**)
  - timescaledb_toolkit: 17MB → 13MB (-4MB, **-23.5%**)
  - vectorscale: 1.5MB → 901KB (-599KB, **-39.9%**)
  - wrappers: 580KB → 325KB (-255KB, **-44.0%**)
- **Build:** Total Rust binary savings: 6.25MB (-26.7% across all Rust extensions)
- **Test:** All 37 extensions verified functional after optimization
- **Notes:** Used CARGO_PROFILE variables instead of RUSTFLAGS to avoid breaking dependency builds
- **Performance:** Size optimization only (opt-level=s), no runtime performance degradation expected

### Fixed (Sprint 1-4 Code Review Improvements - 2025-05)
- **Config:** Removed broken extensions from `shared_preload_libraries` (supautils, timescaledb, pg_stat_monitor not compiled)
- **Config:** Added SSD optimizations (random_page_cost=1.1, effective_io_concurrency=200) for cloud deployments
- **Config:** Added WAL checkpoint tuning (max_wal_size='2GB', min_wal_size='1GB')
- **Config:** Added TLS/SSL configuration template (commented) to `postgresql-base.conf`
- **Config:** Disabled pg_cron on replica (set `cron.database_name=''` to prevent cron execution on read-only replica)
- **Security:** Added `sslmode=prefer` to PgBouncer→Postgres connection string for opportunistic SSL
- **Security:** Added SQL injection validation to replica setup script (replication slot name validation)
- **Security:** Added `.env` security warnings (chmod 600 instruction) to all .env.example files
- **Bug:** Fixed Dockerfile COPY paths to be relative to `docker/postgres` build context (was using absolute paths)

### Security (Sprint 2 - 2025-05)
- **Hardening:** Removed insecure APT flags (`--allow-unauthenticated`, `-o Acquire::AllowInsecureRepositories=true`)
- **Hardening:** Pinned base image to SHA256 digest (`postgres:18-trixie@sha256:41fc5342...`) prevents tag poisoning
- **Hardening:** Migrated PgBouncer healthcheck from `PGPASSWORD` env var to `.pgpass` file authentication (no password in process list)

### Changed (Sprint 3-4 - 2025-05)
- **CI:** Removed `|| true` from PgBouncer and postgres_exporter tests (now fails CI on test failure)
- **CI:** Added grep assertions to extension functional tests (validates pg_trgm, vector actually work)
- **Docs:** Clarified extension inventory in README (4 preloaded, 7 installed by default, 37 total available)
- **Docs:** Added Troubleshooting section to README (build failures, connection issues, performance tuning)
- **Docs:** Added Security section to README (hardening checklist, threat model)
- **Docs:** Added FAQ section to README (extension preloading, K8s compatibility, PgBouncer mode, config overrides)

### Added (Pre-Release Improvements)
- Single instance stack (`stacks/single/`) with minimal Postgres-only deployment
- Replica stack (`stacks/replica/`) with streaming replication and auto-setup
- Test scripts: `test-build.sh`, `test-auto-config.sh`, `wait-for-postgres.sh`
- Backup examples directory (`examples/backup/`) with pgBackRest setup
- Prometheus scrape config and alert rules (`examples/prometheus/`)
- Grafana dashboard guide (`examples/grafana/README.md`)
- .dockerignore to optimize Docker build context
- Init script execution order documentation in CLAUDE.md/AGENTS.md
- Architecture diagram in `docs/architecture.md`
- PgBouncer bootstrap script that renders `.pgpass` safely (`stacks/primary/scripts/pgbouncer-entrypoint.sh`)

### Fixed (Pre-Release)
- Auto-config documentation: Clarified 1GB default when no memory limit detected
- Added `POSTGRES_MEMORY` env var override documentation
- Updated init script references: `03-pgbouncer-auth.sh` is stack-specific
- Added TLS security warning to README (not enabled by default)
- Added localhost binding documentation (127.0.0.1 default, not 0.0.0.0)
- Replaced "zero config" claims with "minimal config"
- Added explicit "build image first" step to Quick Start
- Added pg_cron, pgaudit, pg_stat_statements to extension creation in init script
- Auto-config tuning now supports manual overrides, `/proc/meminfo` fallback, and large (>32GB) shared buffers with updated docs/tests
- Compose files use `mem_limit`/`mem_reservation` so Docker enforces memory caps
- PgBouncer configuration no longer inlines passwords; exporter and templates updated to avoid quoting pitfalls
- Prometheus/Grafana examples align with exported metric names
- Production guide backup instructions point to pgBackRest example stack

### Initial Release (Extracted from Wordian)
- Multi-stage Docker build for PostgreSQL 18
- Auto-configuration based on RAM and CPU detection at runtime
- Extensions: pgvector 0.8.1, pg_cron 1.6.7, pgAudit 18.0, pg_stat_statements, auto_explain, pg_trgm
- Primary deployment stack with PgBouncer and postgres_exporter
- GitHub Actions workflow for multi-platform builds (amd64/arm64)
- SHA-pinned extension sources for supply chain security
- Connection pooling with PgBouncer auth_query (SCRAM-SHA-256)
- Custom prometheus queries for monitoring
- .env.example files with detailed configuration options
- MIT License
- Quick start guide in README.md
- Agent operations guide in CLAUDE.md
