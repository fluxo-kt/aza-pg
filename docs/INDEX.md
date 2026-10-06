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
| [REGRESSION-TESTING.md](REGRESSION-TESTING.md) | Regression test framework (2 tiers)  |
| [TOOLING.md](TOOLING.md)                       | Tech decisions, Bun-first approach   |
| [VERSION-MANAGEMENT.md](VERSION-MANAGEMENT.md) | Version procedures, manifest updates |

## Deployment

| Document                                                   | Description                                          |
| ---------------------------------------------------------- | ---------------------------------------------------- |
| [PRODUCTION.md](PRODUCTION.md)                             | Production deployment guide                          |
| [COOLIFY.md](COOLIFY.md)                                   | Coolify platform deployment                          |
| [DEPLOYMENT.md](DEPLOYMENT.md)                             | Hetzner VPS deployment (Coolify or bare), phases 1-2 |
| [DOCKER-HARDENED-IMAGES.md](DOCKER-HARDENED-IMAGES.md)     | Docker Hardened Images evaluation                    |
| [GITHUB_ENVIRONMENT_SETUP.md](GITHUB_ENVIRONMENT_SETUP.md) | GitHub env/secrets setup                             |

## Operations

| Document                                       | Description                                        |
| ---------------------------------------------- | -------------------------------------------------- |
| [OPERATIONS.md](OPERATIONS.md)                 | Day-to-day operations                              |
| [RUNBOOKS.md](RUNBOOKS.md)                     | Health checks, backup/restore, failover procedures |
| [PGSODIUM-SETUP.md](PGSODIUM-SETUP.md)         | pgsodium root key: where it lives, backing it up   |
| [BACKUP-PGBACKREST.md](BACKUP-PGBACKREST.md)   | pgBackRest backup configuration                    |
| [MONITORING-GRAFANA.md](MONITORING-GRAFANA.md) | Grafana dashboards, metrics                        |
| [UPGRADING.md](UPGRADING.md)                   | Upgrade procedures, migration                      |

## Extension-Specific

| Document                                     | Description                                                 |
| -------------------------------------------- | ----------------------------------------------------------- |
| [PGFLOW.md](PGFLOW.md)                       | pgflow workflow orchestration, Supabase compatibility layer |
| [TIMESCALEDB-TSL.md](TIMESCALEDB-TSL.md)     | TimescaleDB TSL license features                            |
| [EXTENSION-SOURCES.md](EXTENSION-SOURCES.md) | Extension source types, PGDG vs compiled                    |

## Generated

| Document                                               | Description                        |
| ------------------------------------------------------ | ---------------------------------- |
| [.generated/docs-data.json](.generated/docs-data.json) | Live counts (extensions, preloads) |

---

**Entry point**: Start with [ARCHITECTURE.md](ARCHITECTURE.md) for system overview.

**AI agents**: See [AGENTS.md](../AGENTS.md) for development context.
