# pgflow Example

This directory contains the pgflow SQL schema for reference and documentation.

## Important: Per-Project Installation

As of v0.9.0, pgflow is **NOT bundled** in the aza-pg Docker image. You must install it per-project.

See the following documentation:

- **[PGFLOW.md](../../docs/PGFLOW.md)** - Complete guide (installation, usage, update procedures)

## Files

- `10-pgflow.sql` - Complete pgflow v0.9.0 schema (for reference)

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
