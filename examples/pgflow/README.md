# pgflow Example

Reference for pgflow SQL schema and usage in aza-pg.

## Automatic Installation

**pgflow v0.13.1 is bundled** in the aza-pg Docker image and automatically installed in:

- **Initial database** (created via `POSTGRES_DB`)
- **All new databases** (via template1 inheritance)

No manual installation required!

## Documentation

See **[PGFLOW.md](../../docs/PGFLOW.md)** for complete guide:

- Architecture and compatibility layer
- Event broadcasting (pg_notify + pgmq + pg_net)
- Security model (SSRF protection, search_path patches)
- Usage examples and testing

## Schema Location

The pgflow v0.13.1 schema is maintained in test fixtures:

```text
tests/fixtures/pgflow/schema-v0.13.1.sql
```

Automatically installed at container initialization via:

```text
docker/postgres/docker-entrypoint-initdb.d/05-pgflow-init.sh
```

## Manual Installation (New Databases)

If you create a new database **without** using `template1`:

```bash
# Database created outside template1
psql -d your_project_db -f /opt/pgflow/schema.sql
psql -d your_project_db -f /opt/pgflow/security-patches.sql
```

**Note**: Using `CREATE DATABASE template1` automatically inherits pgflow support.

## Verification

Check pgflow is installed:

```sql
-- Should return: t (true)
SELECT pgflow.is_local();

-- List pgflow tables
SELECT tablename FROM pg_tables WHERE schemaname = 'pgflow';
```

## Using npm Packages

For TypeScript projects, use the official packages:

```bash
bun add @pgflow/dsl @pgflow/client
```

See [@pgflow/dsl](https://www.npmjs.com/package/@pgflow/dsl) documentation for DSL usage.
