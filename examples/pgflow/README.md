# pgflow v0.14.1 - Quick Reference

> **📖 Complete Documentation**: See **[docs/PGFLOW.md](../../docs/PGFLOW.md)** for the full guide

## Status in aza-pg

**pgflow v0.14.1 is bundled** and automatically installed in:

- Initial database (`POSTGRES_DB`) via initdb.

New databases inherit only the `realtime.send()` compatibility stub from `template1`; install
the pgflow schema into each additional database explicitly.

## Quick Verification

```sql
-- Verify installation
SELECT pgflow.is_local();  -- Returns: t (true)

-- List tables
\dt pgflow.*
```

## Usage

pgflow uses a TypeScript DSL for workflow definition:

```bash
bun add @pgflow/dsl @pgflow/client
```

See:

- **[docs/PGFLOW.md](../../docs/PGFLOW.md)** - Complete aza-pg integration guide
- **[pgflow.dev](https://pgflow.dev)** - Official pgflow documentation
- **[@pgflow/dsl](https://www.npmjs.com/package/@pgflow/dsl)** - TypeScript DSL package

## Schema Files

Located in `tests/fixtures/pgflow/`:

- `schema-v0.14.1.sql` - pgflow schema
- `README.md` - Schema usage notes

## Compatibility Layer

aza-pg provides Supabase-to-PostgreSQL compatibility:

- `realtime.send()` stub (3-layer event broadcasting)
- Security patches (search_path fixes)
- Custom installation detection

Details in [docs/PGFLOW.md](../../docs/PGFLOW.md).
