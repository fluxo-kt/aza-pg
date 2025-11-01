# Changelog

All notable changes to aza-pg will be documented in this file.

## [Unreleased]

### Added (Post-Audit Improvements - 2025-01-31)
- Single instance stack (`stacks/single/`) with minimal Postgres-only deployment
- Replica stack (`stacks/replica/`) with streaming replication and auto-setup
- Test scripts: `test-build.sh`, `test-auto-config.sh`, `wait-for-postgres.sh`
- Tool scripts: `backup-postgres.sh`, `restore-postgres.sh`
- Prometheus scrape config and alert rules (`examples/prometheus/`)
- Grafana dashboard guide (`examples/grafana/README.md`)
- .dockerignore to optimize Docker build context
- UPGRADING.md guide for major version upgrades
- Init script execution order documentation in CLAUDE.md

### Fixed (Post-Audit - 2025-01-31)
- Added pg_cron, pgaudit, pg_stat_statements to extension creation in init script
- Added build verification commands to README Quick Start
- Added prominent warning about `ghcr.io/your-org` placeholder

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
