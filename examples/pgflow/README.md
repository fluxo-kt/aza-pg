# pgflow Example

Reference for pgflow SQL schema and installation.

## Important: Per-Project Installation

As of v0.9.0, pgflow is **NOT bundled** in the aza-pg Docker image. You must install it per-project.

See the following documentation:

- **[PGFLOW.md](../../docs/PGFLOW.md)** - Complete guide (installation, usage, update procedures)

## Schema Location

The pgflow schema is maintained in test fixtures:

```text
tests/fixtures/pgflow/schema-v0.9.0.sql
```

## Quick Install

```bash
# Download and install in your database
psql -d your_project_db -f tests/fixtures/pgflow/schema-v0.9.0.sql
```

## Using npm Packages

For TypeScript projects, use the official packages:

```bash
bun add @pgflow/dsl @pgflow/client
```

See [@pgflow/dsl](https://www.npmjs.com/package/@pgflow/dsl) documentation for DSL usage.
