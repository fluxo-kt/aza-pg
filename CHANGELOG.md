# Changelog

## [Unreleased]

## [2025-11-09]

### Added

- `/etc/postgresql/version-info.txt` for self-documenting images (PostgreSQL version, extensions, tools)
- GitHub Actions workflows: `ci.yml` (fast validation ~5-10min), `publish.yml` (release to ghcr.io, multi-platform)
- Image versioning: `MM.mm-TS-TYPE` (e.g., `18.1-202511142330-single-node`)
- Development standards documentation (Bun-first, linting, git hooks)

### Fixed

- auto_explain classification (module, not extension - no CREATE EXTENSION needed)
- wrappers pgrx version conflict (0.16.0 → 0.16.1)
- PgBouncer POSIX sh compatibility (removed bash-isms)
- Extension classification: 6 tools, 1 module, 31 extensions, 4 preloaded
- Auto-config validated across 512MB/2GB/4GB memory tiers

### Changed

- Multi-stage build with Bun (build-time only, not in final image)
- Final image: ~900MB uncompressed (~250MB compressed wire)

### Security

- PgBouncer SHA update (CVE-2025-2291 password expiry bypass)
- PostgreSQL base image updated to postgres:18-trixie (ARM64 compatibility)

## [2025-11-08]

### Breaking Changes

- `PGBOUNCER_SERVER_SSLMODE`: `require` → `prefer` (TLS optional by default)
- `POSTGRES_BIND_IP`: Now honors specific IPs (not forced to 0.0.0.0)
- Test credentials: Removed hardcoded passwords (runtime generation)

### Security Fixes

- Removed hardcoded test credentials
- Hardened pgsodium init (search_path injection prevention)
- .pgpass permission verification (600)
- PgBouncer healthcheck (actual connectivity test)
- Git URL allowlist (github.com, gitlab.com)
- Password validation in compose.yml
- PgBouncer sed injection fix
- effective_cache_size cap (75% RAM)
- POSTGRES_MEMORY upper bound (≤1TB)
- REPLICATION_SLOT_NAME validation

### Performance

- Image size: -60-95MB (removed Python3 runtime, stripped .so libraries, apt-get clean)

### Bug Fixes

- Healthcheck timeout: 60s → 120s (large database startup)
- Fixed wait loop in run-extension-smoke.sh
- listen_addresses honors specific IPs
- max_worker_processes cap (64)
- CPU core sanity check (1-128)

### Configuration

- 29 new environment variables
- 5 variables made configurable: `PGBOUNCER_SERVER_SSLMODE`, `PGBOUNCER_MAX_CLIENT_CONN`, `PGBOUNCER_DEFAULT_POOL_SIZE`, `POSTGRES_MEMORY`, `POSTGRES_SHARED_PRELOAD_LIBRARIES`

---

## [2025-11-06]

- pgq extension, pgflow workflow orchestration, manifest-driven build system

## [2025-11-05]

- Extension classification fixes, documentation updates, manifest validator

## [2025-11 - Earlier]

- PGDG hybrid strategy (14 extensions), image optimization (progressive size reduction to current ~900MB), enable/disable architecture
- Security hardening (SHA-pinned, TLS support), configuration improvements
