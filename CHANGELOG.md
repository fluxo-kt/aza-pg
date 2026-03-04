# Changelog

All notable changes to the aza-pg Docker image will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Focus**: This changelog tracks changes affecting the **release Docker image** only.
Development tooling, test infrastructure, and CI/CD changes are noted briefly if relevant.

## [Unreleased]

### Development

- GH Actions SHA pins updated (docker/login-action, docker/setup-qemu-action → Node.js 24; claude-code-action minor bumps)
- Size regression checker: fixed misleading "within expected range" message for tolerance zone; tri-state result signal; updated pg_jsonschema baseline
- Size regression checker: fixed false-negative signals (null/.so-not-found and below-min now emit warn, not success); removed dead postgis entry from size-baselines.json (disabled extension, wrong .so filename); fixed SIZE_BASELINES code-variable reference in failure message to actual file path
- Size regression checker: removed impossible second search path (`/usr/share/.../extension/*.so`); FHS mandates .so binaries in `/usr/lib/`; dead path caused a wasted `docker run` per missing extension
- /update skill: fixed 15 bare `grep` calls to `command grep` (RTK proxy guardrail 15); stale postgis ref in size-baselines example list removed; Phase 5.4 now mandates removing size-baselines.json entries when disabling extensions
- Size regression checker: major refactor — extracted `classifySize` as pure testable function; added `ResultCategory` discriminator (`ok/not-found/below-min/tolerance/exceeded`); fixed `toFixed(1)→toFixed(2)` precision bug (0.35 rendered as "0.3" via IEEE754); added `import.meta.main` guard for testability; added JSON schema validation in `loadSizeBaselines`; 13 unit tests added covering all branches, boundary conditions, and precision regression
- Unit test suite: registered 5 previously orphaned test files in validate.ts + package.json test:unit (config-generator, sql-generator, generate-dockerfile, generate-entrypoint, check-size-regression); fixed 3 pre-existing test failures (stale `18.1` hardcoded version regex in sql-generator; line-based comment filtering in two generate-dockerfile tests where regex match missed leading `#`); test count 198→353
- Unit test discovery: replaced explicit file list in validate.ts with `Bun.Glob` auto-discovery (new `.test.ts` files register themselves); Docker-dependent integration tests excluded via `DOCKER_INTEGRATION_TESTS` set; fixed `./`-prefix bug in glob path normalisation; improved secret scan regex to also exclude `*.test.ts` files; `loadSizeBaselines` now validates `description` field
- Found and fixed two more orphaned test issues: renamed `test-image-resolver-unit.ts` → `test-image-resolver-unit.test.ts` so 20 bun:test tests are auto-discovered (were completely invisible to CI); deleted `test-formatter.ts` (tested a duplicate copy of production code — zero confidence value — real code already covered by `test-utils.test.ts`); added missing `timescaledb` namespace test to `test-utils.test.ts` (5th `PG_EXTENSION_NAMESPACES` entry was untested); test count 353→374

---

## [v18.3-202603040417] - 2026-03-04

### Security

- **gosu → su-exec**: Replaced `gosu` (Go binary, `/usr/local/bin/gosu`) with [`su-exec v0.2`](https://github.com/ncopa/su-exec) — a functionally identical pure-C privilege-drop utility. gosu was compiled with Go 1.24.6 which carries CVE-2025-68121 (CRITICAL, CVSS 8.8) and five HIGH-severity Go stdlib CVEs with no upstream fix available. su-exec has zero Go stdlib dependency, permanently eliminating this CVE class. Drop-in compatible: placed at the same path, same CLI syntax.

### Fixed

- **Dockerfile generator silent failure bug**: `|| true` at end of `&&` chains in `generate-dockerfile.ts` caused `set -e` to be completely ineffective for all installation commands. A failing `apt-get install` would short-circuit its `&&` chain but `|| true` made the RUN step exit 0, silently committing a broken layer with missing `.so` files. Fixed by separating `find … strip … || true` with `;` from each install chain in all 5 affected generators (PGDG, Percona, Timescale, GitHub release, Regression mode). The `.so` verification `test -f` steps were also being silently bypassed — this fix restores them as effective guards.
- **pg_stat_monitor startup failure**: Percona removed v2.3.1 from the ppg-18 apt repository (only v2.3.2 available). Combined with the `|| true` build bug above, this caused `pg_stat_monitor.so` to be silently absent from the image, producing a PostgreSQL `FATAL: could not access file "pg_stat_monitor"` crash on startup. ⚠️ Images built while v2.3.1 was still in Percona's repo may be unaffected; images built after Percona purged it (before this release) will have the absent `.so` and must be rebuilt.
- **TimescaleDB loader version split**: The `timescaledb-2-loader-postgresql-18` package was unpinned and jumped to v2.25.2 while the main extension was pinned to v2.25.1, causing `ERROR: extension timescaledb has no installation script for version 2.25.2` at startup. Loader package is now explicitly pinned to match the main extension in the Dockerfile generator.
- **gosu → su-exec: self-contained compilation + trivyignore**: Six prior fix attempts failed — four due to GHA layer cache interference (`COPY --from=builder-base`, `RUN --mount=type=bind`, `apt-get install su-exec` — package absent, `COPY via builder-pgxs output dir` — COPY key matched stale GHA entry); the fifth added `apt-get purge gosu` (gosu is not an apt package in the postgres base image — it's a direct binary download, so purge is a no-op); the sixth realised Trivy scans ALL image layers including immutable base layers and finds gosu in the postgres:18.3-trixie base layer — the replacement in later layers cannot affect base layer content. Definitive fix: compile su-exec (v0.2, SHA-pinned) in the final stage, install at `/usr/local/bin/gosu` (shadows the base layer's gosu in the merged filesystem), add CVE-2025-68121 to `.trivyignore` with justification (the running binary is su-exec; gosu in base layers is unreachable). Also excludes gosu from builder-pgxs rsync to avoid adding another intermediate layer.

### Changed

- **PostgreSQL 18.1 → 18.3**: 5 CVEs fixed (including CVSS 8.8 intarray arbitrary code execution via bitset operations), plus emergency regression fixes from 18.2. ⚠️ If upgrading from pre-18.2: ltree column indexes may need `REINDEX`
- **pg_partman 5.4.0 → 5.4.2**: Security hardening against `search_path` injection in `run_maintenance()` and related functions (v5.4.1); regression fix for non-default schema partitioned tables (v5.4.2)
- **TimescaleDB 2.25.0 → 2.25.2**: Fixed continuous aggregate invalidation log cleanup and variable bucket batching (2.25.1); bugfix release (2.25.2). Loader package explicitly pinned to prevent future version split (see Fixed).
- **pgmq 1.10.0 → 1.11.0**: Full AMQP-style topic routing — bind queues to patterns and fan out via `send_topic()`. Uses `*` (one segment) and `#` (zero or more segments) wildcards. New SQL: `bind_topic()`, `unbind_topic()`, `send_topic()`, `send_batch_topic()`, `list_topic_bindings()`
- **wrappers 0.5.7 → 0.6.0**: New Infura (Ethereum/IPFS) and OpenAPI FDWs; ClickHouse FDW fixes; memory context improvements
- **pgvector 0.8.1 → 0.8.2**: Fixed buffer overflow in parallel HNSW builds; fixed Index Searches in EXPLAIN output for PG18
- **plpgsql_check 2.8.8 → 2.8.11**: Migrated from source build to PGDG apt (~2–3 min faster Docker builds); fixed false positives on composite constants and domain types
- **pg_stat_monitor 2.3.1 → 2.3.2**: Required version bump — see Fixed above

### Development

- Dev deps: Bun 1.3.10, oxlint 1.51.0, squawk-cli 2.43.0; Cosign v3.0.4; GH Actions pins updated
- Disabled extensions synced to PGDG: PostGIS 3.6.2, pgRouting 4.0.1
- Test coverage: pgvector HNSW/EXPLAIN, pgmq topic routing, plpgsql_check semantics; assertions hardened for patch-release robustness

---

## [v18.1-202602082259] - 2026-02-08

### Changed

- **TimescaleDB 2.24.0 → 2.25.0**: Major continuous aggregate performance improvements
  - Direct compress during refresh reduces I/O significantly
  - DELETE optimizations lower resource usage on columnstore
  - Default `buckets_per_batch` changed to 10 (reduced WAL holding)
  - ⚠️ **Breaking**: Old continuous aggregate format removed (deprecated since 2.10.0)
  - ⚠️ **Breaking**: `time_bucket_ng` function removed
  - ⚠️ **Breaking**: WAL-based invalidation removed
  - ⚠️ **Breaking**: `_timescaledb_debug` schema removed
- **pgmq 1.9.0 → 1.10.0**: Message read tracking and flexible visibility timeout
  - New `last_read_at` column tracks message read times
  - `set_vt()` now accepts `INTEGER` or `TIMESTAMPTZ` for absolute timeout
- **supautils 3.0.6 → 3.1.0**: PostgreSQL 18 introspection improvements
  - PG_MODULE_MAGIC_EXT support enables module visibility via `pg_get_loaded_modules()`
  - Fixed spurious `supautils.disable_program` GUC connection warnings
- **plpgsql_check 2.8.5 → 2.8.8**: Stability and debugging improvements (switched from PGDG to source build)
  - Fixed memory corruption crash
  - Rewritten pldbgapi debugging API
  - New warnings for expression volatility and reserved keyword labels
- **pgflow 0.13.2 → 0.13.3**: Edge worker authentication and connection improvements
  - Optional `PGFLOW_AUTH_SECRET` support for worker authentication
  - Fixed `maxPgConnections` parameter propagation

### Development (non-image)

- Updated Bun dev dependencies: @pgflow/client 0.13.3, @pgflow/dsl 0.13.3, @types/bun 1.3.8, oxlint 1.43.0, prettier 3.8.1, squawk-cli 2.40.0

---

## [v18.1-202601221905] - 2026-01-22

### Changed

- **pgflow 0.13.1 → 0.13.2**: Automatic stalled task recovery for worker crash resilience
  - New: Tasks stuck in 'started' status beyond `timeout + 30s` are automatically requeued (up to 3 attempts)
  - New: `requeued_count` and `last_requeued_at` columns in `step_tasks` table for monitoring
  - New: Cron job (`requeue_stalled_tasks`) runs every 15 seconds
  - Fixed: `maxPgConnections` parameter now respected in edge-worker (was ignored, default changed 10→4)
- **pgmq 1.8.1 → 1.9.0**: FIFO queue support with message groups, `read_grouped()` functions
  - New `read_grouped()`, `read_grouped_rr()` functions for FIFO message group ordering
  - New `create_fifo_index()` / `create_fifo_indexes_all()` for GIN indexes on message headers
  - ⚠️ **Breaking**: `conditional` parameter removed from FIFO-grouped read functions (violated ordering guarantees)
- **pgbackrest 2.57.0 → 2.58.0**: Latest backup/restore tool from PGDG
  - ⚠️ **Breaking**: Minimum `repo-storage-upload-chunk-size` increased to vendor minimums
  - ⚠️ **Breaking**: TLS 1.2 now required (unless verification disabled)
  - New: HTTP support for S3/GCS/Azure, Azure managed identities

### Development (non-image)

- Updated oxlint to 1.41.0, squawk-cli to 2.37.0, @pgflow/client and @pgflow/dsl to 0.13.2
- Enhanced pgmq test suite with FIFO tests, error handling, batch operations, `list_queues` metadata verification
- Added pgflow-pgmq contract tests: `pgmq.format_table_name()` and `pgflow.set_vt_batch()` internal API verification

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
