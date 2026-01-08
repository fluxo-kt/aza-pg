# Documentation Index

Quick navigation for aza-pg documentation.

## Core

| Document                                             | Description                           |
| ---------------------------------------------------- | ------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md)                   | System design, component overview     |
| [EXTENSIONS.md](EXTENSIONS.md)                       | Extension catalog, categories, counts |
| [ENVIRONMENT-VARIABLES.md](ENVIRONMENT-VARIABLES.md) | All env vars for configuration        |

## Development

| Document                                       | Description                          |
| ---------------------------------------------- | ------------------------------------ |
| [BUILD.md](BUILD.md)                           | Building images, CI/CD workflows     |
| [TESTING.md](TESTING.md)                       | Test patterns, session isolation     |
| [REGRESSION-TESTING.md](REGRESSION-TESTING.md) | Regression test framework (4 tiers)  |
| [TOOLING.md](TOOLING.md)                       | Tech decisions, Bun-first approach   |
| [VERSION-MANAGEMENT.md](VERSION-MANAGEMENT.md) | Version procedures, manifest updates |

## Deployment

| Document                                                   | Description                 |
| ---------------------------------------------------------- | --------------------------- |
| [PRODUCTION.md](PRODUCTION.md)                             | Production deployment guide |
| [COOLIFY.md](COOLIFY.md)                                   | Coolify platform deployment |
| [GITHUB_ENVIRONMENT_SETUP.md](GITHUB_ENVIRONMENT_SETUP.md) | GitHub env/secrets setup    |

## Operations

| Document                                       | Description                     |
| ---------------------------------------------- | ------------------------------- |
| [OPERATIONS.md](OPERATIONS.md)                 | Day-to-day operations           |
| [BACKUP-PGBACKREST.md](BACKUP-PGBACKREST.md)   | pgBackRest backup configuration |
| [MONITORING-GRAFANA.md](MONITORING-GRAFANA.md) | Grafana dashboards, metrics     |
| [UPGRADING.md](UPGRADING.md)                   | Upgrade procedures, migration   |

## Extension-Specific

| Document                                     | Description                                                         |
| -------------------------------------------- | ------------------------------------------------------------------- |
| [PGFLOW.md](PGFLOW.md)                       | pgflow v0.13.1 workflow orchestration, Supabase compatibility layer |
| [TIMESCALEDB-TSL.md](TIMESCALEDB-TSL.md)     | TimescaleDB TSL license features                                    |
| [EXTENSION-SOURCES.md](EXTENSION-SOURCES.md) | Extension source types, PGDG vs compiled                            |

## Generated

| Document                                               | Description                        |
| ------------------------------------------------------ | ---------------------------------- |
| [.generated/docs-data.json](.generated/docs-data.json) | Live counts (extensions, preloads) |

---

**Entry point**: Start with [ARCHITECTURE.md](ARCHITECTURE.md) for system overview.

**AI agents**: See [CLAUDE.md](../CLAUDE.md) for development context.
