# PostgreSQL Extension Sources

Reference guide for PostgreSQL extension repository availability and sourcing decisions.

## Repository Overview

| Repository    | PG18 Support | Extensions               | Use Case                                   |
| ------------- | ------------ | ------------------------ | ------------------------------------------ |
| **PGDG**      | ✅ Full      | 13 (w/ exact versions)   | Primary source; stable, tested packages    |
| **Pigsty**    | ✅ Full      | 421+                     | Alternative when PGDG lacks extension      |
| **Timescale** | ✅ Full      | 2 (timescaledb, toolkit) | TSL-licensed TimescaleDB (not community)   |
| **Percona**   | ❌ No PG18   | ~10                      | Future option when PG18 packages available |

## Decision Matrix

**When to use PGDG (default):**

- Extension available with exact version match
- Standard PostgreSQL contrib modules
- Well-tested, official packages

**When to build from source:**

- Rust extensions (pgrx-based) - PGDG excludes these
- Extension needs newer version than PGDG offers
- Custom patches or features required
- TimescaleDB with full TSL features (continuous aggregates, compression policies)

**When to consider Pigsty:**

- Extension unavailable in PGDG
- Version 1-2 behind is acceptable
- Need rapid deployment without compilation

**When to consider Timescale repo:**

- Need TSL-licensed TimescaleDB features (not just Apache 2.0 features)
- Want official Timescale packages instead of source builds
- Need timescaledb_toolkit with matching version

## PGDG Extensions (PG18)

Extensions with `pgdgVersion` in manifest have verified PGDG packages:

| Extension     | PGDG Version | Source Tag | Pigsty Alt     |
| ------------- | ------------ | ---------- | -------------- |
| pgvector      | 0.8.1        | v0.8.1     | v0.8.0         |
| pg_cron       | 1.6.7        | v1.6.7     | v1.6.7 (same)  |
| pgaudit       | 18.0         | 18.0       | v18.0 (same)   |
| hypopg        | 1.4.2        | 1.4.2      | v1.4.2 (same)  |
| plpgsql_check | 2.8.4        | v2.8.4     | v2.8.4 (same)  |
| http          | 1.7.0        | v1.7.0     | v1.7.0 (same)  |
| rum           | 1.3.15       | 1.3.15     | v1.3.15 (same) |
| hll           | 2.19         | v2.19      | v2.19 (same)   |
| postgis       | 3.6.1        | 3.6.1      | v3.6.1 (same)  |
| pgrouting     | 4.0.0        | v4.0.0     | v4.0.0 (same)  |
| pg_partman    | 5.3.1        | v5.3.1     | v5.3.1 (same)  |
| pg_repack     | 1.5.3        | ver_1.5.3  | v1.5.3 (same)  |
| set_user      | 4.2.0        | REL4_2_0   | v4.2.0 (same)  |

## Source-Built Extensions

These extensions MUST be built from source (no PGDG packages):

### Rust/pgrx Extensions

| Extension               | Version | Pigsty Alt | Timescale Alt | Notes                          |
| ----------------------- | ------- | ---------- | ------------- | ------------------------------ |
| **wrappers**            | v0.5.7  | v0.5.0     | ❌            | Pigsty 2 versions behind       |
| **vectorscale**         | 0.9.0   | v0.7.1     | ❌ (no PG18)  | Source required for latest     |
| **pg_jsonschema**       | commit  | v0.3.3     | ❌            | Source required for latest     |
| **timescaledb_toolkit** | 1.22.0  | v1.21.0    | v1.22.0       | Timescale repo has exact match |

### TimescaleDB (Special Case)

| Extension       | Version | Pigsty Alt            | Timescale Alt | Notes                |
| --------------- | ------- | --------------------- | ------------- | -------------------- |
| **timescaledb** | 2.23.1  | v2.20.0 (Apache only) | v2.23.1 (TSL) | Source build for TSL |

### Other Source-Built

| Extension           | Version | Pigsty Alt | Percona Alt  | Notes                      |
| ------------------- | ------- | ---------- | ------------ | -------------------------- |
| **pg_stat_monitor** | git-ref | v2.1       | ❌ (no PG18) | Pinned commit for PG18     |
| **pgsodium**        | v3.1.9  | v3.1.9     | ❌           | Pigsty has exact match     |
| **pgmq**            | v1.7.0  | v1.6       | ❌           | Source for latest features |
| **pg_hashids**      | v1.2.1  | v1.2.1     | ❌           | Pigsty has exact match     |
| **wal2json**        | 2.6     | v2.6       | ❌           | Pigsty has exact match     |
| **pg_safeupdate**   | 1.5     | v1.5       | ❌           | Pigsty has exact match     |
| **pgq**             | v3.5.1  | v3.5.1     | ❌           | Pigsty has exact match     |
| **vault**           | v0.3.1  | v0.3.1     | ❌           | Supabase-specific          |
| **index_advisor**   | v0.2.0  | ❌         | ❌           | Supabase-specific          |
| **pgroonga**        | 4.0.4   | PG13-17    | ❌           | Pigsty lacks PG18          |

## Repository Details

### PGDG (apt.postgresql.org)

```bash
# Add repository
echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/pgdg.gpg
```

- **Pros:** Official, stable, well-tested
- **Cons:** No Rust extensions, may lag latest versions

### Pigsty (pigsty.io)

```bash
# Install pig CLI tool
curl -fsSL https://repo.pigsty.io/pig | bash

# Setup repository
pig repo set

# Install PostgreSQL 18 kernel
pig install pg18

# Install extension for PG18
pig install pg_duckdb -v 18
```

- **Catalog:** https://ext.pigsty.io/
- **Pros:** 421+ extensions, fast deployment, no compilation needed
- **Cons:** Versions may lag 1-2 behind (e.g., wrappers v0.5.0 vs v0.5.7)
- **Status:** Community-maintained, frequent updates

### Timescale (packagecloud.io/timescale)

```bash
# Add Timescale repository (Debian/Ubuntu)
curl -s https://packagecloud.io/install/repositories/timescale/timescaledb/script.deb.sh | sudo bash

# Update package cache
apt-get update

# Install packages
apt-get install -y timescaledb-2-postgresql-18
apt-get install -y timescaledb-toolkit-postgresql-18
```

**Available packages for PG18:**

| Package                           | Version | License |
| --------------------------------- | ------- | ------- |
| timescaledb-2-postgresql-18       | 2.23.1  | TSL     |
| timescaledb-2-oss-postgresql-18   | 2.23.1  | Apache  |
| timescaledb-toolkit-postgresql-18 | 1.22.0  | TSL     |

- **License:** Timescale License (TSL) - not Apache 2.0
- **Note:** NO vectorscale PG18 packages available in Timescale repo
- **Loader:** timescaledb-2-loader-postgresql-18 also available

### Percona (repo.percona.com)

```bash
# PG18 NOT YET AVAILABLE (as of Nov 2025)

# Future setup when PG18 releases:
# wget https://repo.percona.com/apt/percona-release_latest.generic_all.deb
# dpkg -i percona-release_latest.generic_all.deb
# percona-release enable ppg-18 release
# apt-get update

# Expected packages (when available):
# apt-get install percona-postgresql-18
# apt-get install percona-pg_stat_monitor18
```

**Status as of Nov 2025:**

- `ppg-18` packages NOT released yet
- PG18 support tracked in: https://github.com/percona/pg_stat_monitor/issues/566
- Current Percona packages only support up to PG17

**Why we care:**

- pg_stat_monitor official repo is Percona
- Currently using git-ref (commit SHA) for PG18 pre-release support
- When ppg-18 releases, consider switching to official package

## Version Management

When updating extension versions:

1. **Check PGDG first:**

   ```bash
   apt-cache madison postgresql-18-{extension-name}
   ```

2. **Update manifest-data.ts:**
   - Set `pgdgVersion` if PGDG has exact match
   - Use source build otherwise

3. **Regenerate and validate:**
   ```bash
   bun run generate
   bun run validate
   ```

## Related Documentation

- [VERSION-MANAGEMENT.md](VERSION-MANAGEMENT.md) - Version update procedures
- [BUILD.md](BUILD.md) - Build system details
- [EXTENSIONS.md](EXTENSIONS.md) - Extension inventory (auto-generated)
