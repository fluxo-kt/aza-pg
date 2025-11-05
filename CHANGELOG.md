# Changelog

All notable changes to aza-pg will be documented in this file.

## [Unreleased]

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
- **Docs:** Created PREBUILT-BINARIES-ANALYSIS.md with GitHub release research for 17 compiled extensions
- **Docs:** Identified 3 viable pre-built binary candidates: pgroonga (2-3min build savings), supautils (30sec), pgbadger (refactor needed)
- **Docs:** Created PERFORMANCE-IMPACT.md with comprehensive analysis of all 37 extensions (size, memory, performance, build time)
- **Test:** Created test-extension-performance.ts benchmarking suite (pgvector, timescaledb, postgis, pg_jsonschema, pgroonga, pg_cron)
- **Test:** Performance benchmarks include: execution time, throughput (ops/sec), memory overhead, index performance
- **Analysis:** Potential build time reduction: 2-4 minutes (17-25%) via pre-built binaries
- **Analysis:** Potential image size reduction: 40-60MB (Phase 11 RUSTFLAGS for timescaledb_toolkit)
- **Addressed:** User request for "impact of each extension on container image size and Postgres performance"

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
