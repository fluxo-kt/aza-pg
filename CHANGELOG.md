# Changelog

All notable changes to the aza-pg Docker image will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Focus**: This changelog tracks changes affecting the **release Docker image** only.
Development tooling, test infrastructure, and CI/CD changes are noted briefly if relevant.

## [Unreleased]

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

### Development (non-image)

- Updated `@pgflow/client` and `@pgflow/dsl` devDependencies to 0.13.0
- Added tests for pgflow v0.13.0 atomic outputs
- Added tests for pgmq v1.8.1 archive partitioning

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
