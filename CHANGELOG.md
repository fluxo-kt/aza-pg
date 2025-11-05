# Changelog

All notable changes to aza-pg will be documented in this file.

## [Unreleased]

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
