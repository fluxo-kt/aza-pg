# PostgreSQL Extension Sources

Each extension's source is its `install_via` in `scripts/extensions/manifest-data.ts`; its shipped version is in the generated [EXTENSIONS.md](EXTENSIONS.md). This page says which source to choose and why.

## Choosing a Source

| `install_via`      | Repository                                                                             | Use it when                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `pgdg`             | apt.postgresql.org                                                                     | PGDG packages the extension for the current PostgreSQL major and Debian release. Default: official, tested, no compile time. |
| `percona`          | repo.percona.com (`ppg-<major>`)                                                       | Percona is the upstream (pg_stat_monitor), or its repo is already required and packages the extension too (wal2json).        |
| `timescale`        | packagecloud.io/timescale                                                              | TimescaleDB and its toolkit: only Timescale's packages carry the TSL features (compression policies, continuous aggregates). |
| `source`, or unset | upstream git, commit-locked (built-in modules also leave it unset and install nothing) | PGDG has no package (most Rust/pgrx extensions), lags a needed fix, or the build needs a patch (`build.patches`).            |

Prefer the first row that fits. Moving an extension between sources is a one-entry manifest edit (`install_via` plus its package or build fields); `bun run validate` checks PGDG pins against the live repository.

**Check PGDG before building from source**: `docker run --rm postgres:18-trixie bash -c "apt-get update -qq && apt-cache madison postgresql-18-EXTNAME"`. For `pgdg`, `pgdgVersion` is authoritative: set `source.tag` to the version PGDG ships, not the newest upstream tag.

**Timescale ships two packages per release** (`timescaledb-2-postgresql-18` and `timescaledb-2-loader-postgresql-18`); the generator pins both to the same version, so the loader cannot run ahead of the extension.

## Rejected: Pigsty

Pigsty (ext.pigsty.io) packages hundreds of extensions, but aza-pg does not use it: it published no Debian 13 (Trixie) packages and lacked PostgreSQL 18 builds of extensions the image ships (checked 2025-11). Re-check both before proposing it.

## Related Documentation

- [VERSION-MANAGEMENT.md](VERSION-MANAGEMENT.md) — version update procedures
- [BUILD.md](BUILD.md) — build system details
- [EXTENSIONS.md](EXTENSIONS.md) — extension inventory with versions (generated)
