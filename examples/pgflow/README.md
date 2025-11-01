# pgflow Example

This directory contains the pgflow v0.8.1 SQL schema for reference and documentation.

## Important: Per-Project Installation

As of v0.8.1, pgflow is **NOT bundled** in the aza-pg Docker image. You must install it per-project.

See the following documentation:

- **[PGFLOW-SETUP.md](../../docs/PGFLOW-SETUP.md)** - Installation instructions
- **[PGFLOW_INTEGRATION_GUIDE.md](../../docs/PGFLOW_INTEGRATION_GUIDE.md)** - Complete usage guide
- **[PGFLOW-UPDATE-PROCESS.md](../../docs/PGFLOW-UPDATE-PROCESS.md)** - Schema update procedures

## Files

- `10-pgflow.sql` - Complete pgflow v0.8.1 schema (for reference)

## Quick Install

```bash
# Download and install in your database
psql -d your_project_db -f examples/pgflow/10-pgflow.sql
```

## Using npm Packages

For TypeScript projects, use the official packages:

```bash
bun add @pgflow/dsl @pgflow/client
```

See [@pgflow/dsl](https://www.npmjs.com/package/@pgflow/dsl) documentation for DSL usage.
