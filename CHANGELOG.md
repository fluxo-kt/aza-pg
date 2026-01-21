# Changelog

All notable changes to the aza-pg Docker image will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Focus**: This changelog tracks changes affecting the **release Docker image** only.
Development tooling, test infrastructure, and CI/CD changes are noted briefly if relevant.

## [Unreleased]

### Changed

- **pgmq 1.8.1 → 1.9.0**: FIFO queue support with message groups, `read_grouped()` functions
  - New `read_grouped()`, `read_grouped_rr()`, `read_grouped_with_poll()`, `read_grouped_rr_with_poll()` functions
  - New `create_fifo_index()` / `create_fifo_indexes_all()` for GIN indexes on message headers
  - ⚠️ **Breaking**: `conditional` parameter removed from FIFO-grouped read functions (violated ordering guarantees)
- **pgbackrest 2.57.0 → 2.58.0**: Latest backup/restore tool from PGDG
  - ⚠️ **Breaking**: Minimum `repo-storage-upload-chunk-size` increased to vendor minimums
  - ⚠️ **Breaking**: TLS 1.2 now required (unless verification disabled)
  - New: HTTP support for S3/GCS/Azure, Azure managed identities

### Development (non-image)

- Updated oxlint to 1.41.0, squawk-cli to 2.37.0, @pgflow/client and @pgflow/dsl to 0.13.2
- Enhanced pgmq test suite with FIFO tests, error handling, batch operations

---

## [v18.1-202601171501] - 2026-01-17

### Added

- **pgflow v0.13.1 Supabase Compatibility Layer**: Full integration with Supabase-to-standalone PostgreSQL compatibility
  - `realtime.send()` stub replacing Supabase Realtime API (3-layer: pg_notify + pgmq + pg_net webhooks)
  - Template1 installation: ALL new databases inherit pgflow compatibility automatically
  - Custom installation marker (`app.aza_pg_custom`) for environment detection
  - Comprehensive documentation: `docs/PGFLOW.md`
  - Test suite: `test-pgflow-security.ts`, `test-pgflow-new-database.ts`
  - **Security**: SSRF protection (REVOKE EXECUTE FROM PUBLIC), role-based access control
  - Security patches: AZA-PGFLOW-001 (get_run_with_states), AZA-PGFLOW-002 (start_flow_with_states), COMPAT-AZA-PG-001 (is_local)

### Changed

- **Base image**: Updated `postgres:18.1-trixie` SHA from `bfe50b2b...` to `5773fe72...` (Debian Trixie 13.8.2→13.8.3, GnuPG CVE-2025-30258 fix)
- **pgflow**: 0.13.0 → 0.13.1
  - Fixed Supabase CLI local environment detection (now uses `SUPABASE_URL` check instead of API keys)
  - Includes v0.13.0 performance improvements (2.17× faster Map→Map chains via atomic step output storage)
- **pg_partman**: 5.3.1 → 5.4.0 (switched from PGDG to source build)
  - New `create_partition()` and `create_sub_partition()` functions (backward-compatible aliases for `create_parent()`/`create_sub_parent()`)
  - New `config_cleanup()` function to remove pg_partman configuration while preserving partition structure
  - Fixed critical bug in DESC order partitioning (`p_order := 'DESC'`) causing "relation does not exist" errors
  - Added infinity value handling via `p_ignore_infinity` parameter in `partition_data_time()`, `partition_data_proc()`, and `check_default()`
  - PostgreSQL 17 MAINTAIN privilege now properly inherited (automatically applied when using PG17+)
  - **Note**: PGDG repository only has v5.3.1 - building from source for latest features
- **pgbadger**: 13.1 → 13.2
  - **Critical fix for PostgreSQL 18**: Fixed checkpoint parsing regression
  - Updated embedded pgFormatter to v5.9
  - Fixed SQL normalization for escaped quotes handling
  - Fixed PgBouncer stats parsing
  - New `--ssh-sudo` command for remote log analysis with sudo authentication

### Fixed

- **CRITICAL**: Fixed hll PGDG version causing all PGDG extensions to silently fail installation
  - **Root cause**: Docker BuildKit cached successful apt-get layer while actual package version didn't exist (2.19-1.pgdg13+1 vs 2.19-2.pgdg13+2)
  - **Symptom**: Image built successfully but extensions missing at runtime ("No such file or directory" errors)
  - **Impact**: Affected all 12 PGDG extensions (pg_cron, pgaudit, pgvector, postgis, pgrouting, pg_repack, hll, http, hypopg, rum, plpgsql_check, set_user)
  - **Fix**: Updated hll pgdgVersion to correct value (2.19-2.pgdg13+2)
  - **Prevention**: Created PGDG version validation script to catch mismatches before build

### Development (non-image)

- **Build system**: Removed pg_partman from PGDG package installation (now built from source)
- **Validation**: Added PGDG version validation against actual repository (prevents silent apt-get failures)
- **Testing**: Updated pgflow schema to v0.13.1 (test fixtures regenerated)
- **Stacks**: Updated PgBouncer to v1.25.1-p0 in primary stack (CVE-2025-12819 fix, LDAP auth, transaction_timeout)
- **Dependencies**: Updated dev dependencies (bun 1.3.5→1.3.6, oxlint 1.38.0→1.39.0, prettier 3.7.4→3.8.0, sql-formatter 15.6.12→15.7.0)

---

## [18.1-202601081823-single-node] - 2026-01-08

### Changed

- **Base image**: Updated `postgres:18.1-trixie` SHA from `38d5c9d5...` to `bfe50b2b...` (security patches)
- **pgflow**: 0.11.0 → 0.13.0
  - 2.17× faster Map→Map chains via atomic step output storage
  - **BREAKING**: v0.12.0 changed handler signatures (root: flowInput, dependent: deps + ctx.flowInput)
- **pgmq**: 1.8.0 → 1.8.1
  - Fixed time-based archive partitioning
  - SQL typo fixes

### Added

- CHANGELOG.md following Keep a Changelog format

### Security

- **CVE-2025-13836**: Accepted Python http.client memory exhaustion vulnerability
  - Does not affect PostgreSQL (core is C, no extensions use http.client)
  - Debian classified as minor issue, awaiting upstream fix
  - Added to .trivyignore and documented in SECURITY.md

### Development (non-image)

- **CI Reliability**: Added Cosign retry logic with exponential backoff for image signing
- **CI Reliability**: Made git tag creation atomic with verification to prevent race conditions
- **CI Reliability**: Fixed Bun cache monitoring (exit 127) by adding setup-bun to build jobs
- **CI Reliability**: Improved cleanup script resilience for GitHub API eventual consistency
- **Testing**: Updated `@pgflow/client` and `@pgflow/dsl` devDependencies to 0.13.0
- **Testing**: Added tests for pgflow v0.13.0 atomic outputs
- **Testing**: Added tests for pgmq v1.8.1 archive partitioning
- **Testing**: Fixed test pre-cleanup to safely handle stale volumes without affecting production containers
- **Dependencies**: Bumped GitHub Actions: checkout (4→6), upload-artifact (4→6), download-artifact (6→7), cache (4→5), attest-build-provenance (3.0.0→3.1.0)

---

## [18.1-202512241648-single-node]

### Changed

- Production artifacts with updated dependencies
- Documentation improvements

---

## [18.1-202512192240-single-node]

### Added

- **pg_net**: Added to default `shared_preload_libraries`
- **pgsodium**: Added to default `shared_preload_libraries`

### Development (non-image)

- Enhanced nightly CI workflow

---

## [18.1-202512190839-single-node]

### Fixed

- **Docker security**: Fixed apt cleanup for Dockle DKL-DI-0005 compliance

---

## Version Format

Image tags follow: `MM.mm-YYYYMMDDHHMM-TYPE`

- `MM.mm`: PostgreSQL version (e.g., 18.1)
- `YYYYMMDDHHMM`: Build timestamp
- `TYPE`: `single-node` or `replica-set`

Example: `18.1-202501071430-single-node`
