# Changelog

All notable changes to aza-pg will be documented in this file.

## [Unreleased]

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
