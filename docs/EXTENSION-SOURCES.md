# PostgreSQL Extension Sources

Reference guide for PostgreSQL extension repository availability and sourcing decisions.

## Repository Overview

| Repository    | PG18 Support | Extensions               | Use Case                                   |
| ------------- | ------------ | ------------------------ | ------------------------------------------ |
| **PGDG**      | ✅ Full      | 11 (w/ exact versions)   | Primary source; stable, tested packages    |
| **Pigsty**    | ✅ Full      | 421+                     | Alternative when PGDG lacks extension      |
| **Timescale** | ✅ Full      | 3 (timescaledb, toolkit) | TSL-licensed TimescaleDB (not community)   |
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

**When to consider Pigsty:**

- Extension unavailable in PGDG
- Version 1-2 behind is acceptable
- Need rapid deployment without compilation

## PGDG Extensions (PG18)

Extensions with `pgdgVersion` in manifest have verified PGDG packages:

| Extension   | PGDG Version | Source Tag | Match |
| ----------- | ------------ | ---------- | ----- |
| pgvector    | 0.8.1        | v0.8.1     | ✅    |
| timescaledb | 2.23.1       | 2.23.1     | ✅    |
| pg_cron     | 1.6.5        | v1.6.5     | ✅    |
| pgaudit     | 18.0         | 18.0       | ✅    |
| hll         | 2.19         | v2.19      | ✅    |
| postgis     | 3.6.1        | 3.6.1      | ✅    |
| pgrouting   | 4.0.0        | v4.0.0     | ✅    |
| pg_partman  | 5.3.1        | v5.3.1     | ✅    |
| pg_repack   | 1.5.3        | ver_1.5.3  | ✅    |

## Source-Built Extensions

These extensions MUST be built from source (no PGDG packages):

### Rust/pgrx Extensions

| Extension               | Reason             | Version |
| ----------------------- | ------------------ | ------- |
| **wrappers**            | Rust FDW framework | v0.5.7  |
| **vectorscale**         | Rust pgrx          | 0.9.0   |
| **pg_jsonschema**       | Rust pgrx          | commit  |
| **timescaledb_toolkit** | Rust pgrx          | 1.22.0  |

### Other Source-Built

| Extension           | Reason                  | Notes             |
| ------------------- | ----------------------- | ----------------- |
| **pg_stat_monitor** | Percona repo lacks PG18 | Using commit SHA  |
| **pgsodium**        | Not in PGDG             | Built from source |
| **pgmq**            | Not in PGDG             | Rust-based        |

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
# Repository info: https://pigsty.io/docs/pgsql/ext/#extension-repo
```

- **Pros:** 421+ extensions, fast deployment
- **Cons:** Versions may lag (e.g., wrappers v0.5.0 vs v0.5.7)
- **Status:** Community-maintained, frequent updates

### Timescale (packagecloud.io/timescale)

```bash
# Add repository for TSL-licensed TimescaleDB
curl -s https://packagecloud.io/install/repositories/timescale/timescaledb/script.deb.sh | bash
```

- **Packages:** timescaledb-2-postgresql-18, timescaledb-toolkit-postgresql-18
- **License:** Timescale License (TSL) - not Apache 2.0
- **Note:** NO vectorscale PG18 packages available

### Percona (repo.percona.com)

```bash
# PG18 NOT YET AVAILABLE (as of Nov 2025)
# Future: wget https://repo.percona.com/apt/percona-release_latest.generic_all.deb
```

- **Status:** ppg-18 packages not yet released
- **Monitor:** Check for pg_stat_monitor PG18 packages

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
