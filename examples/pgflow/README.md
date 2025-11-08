# pgflow - Optional Workflow Orchestration

pgflow v0.7.2 is a DAG-based workflow orchestration system for PostgreSQL that provides task queues, retry logic, step dependencies, and parallel processing.

## What is pgflow?

- **Schema-based installation**: SQL-only (not a traditional extension)
- **DAG workflows**: Define multi-step workflows with dependencies
- **Task queues**: Built on pgmq (Postgres Message Queue)
- **Retry logic**: Automatic retry with exponential backoff
- **Map steps**: Parallel array processing
- **Dependencies**: Requires pgmq extension

## Installation

pgflow is **optional** and not installed by default. To enable it:

### Option 1: Stack-specific installation

Copy the init script to your stack's initdb directory:

```bash
# For primary stack
cp examples/pgflow/10-pgflow.sql stacks/primary/configs/initdb/

# Rebuild and restart
docker compose down
docker compose up -d
```

### Option 2: Custom image

Add the init script to your custom Dockerfile:

```dockerfile
FROM ghcr.io/fluxo-kt/aza-pg:latest
COPY examples/pgflow/10-pgflow.sql /docker-entrypoint-initdb.d/
```

### Verification

```sql
-- Check schema exists
\dn pgflow

-- Verify functions
SELECT proname FROM pg_proc
WHERE pronamespace = 'pgflow'::regnamespace
ORDER BY proname;
```

## Usage

See `docs/pgflow/INTEGRATION.md` for comprehensive integration guide covering:

- Creating flows and steps
- Starting workflows
- Handling task completion
- Implementing workers
- Best practices

## Limitations

- **Real-time events stubbed**: No Supabase Edge Functions support
- **Worker implementation required**: pgflow provides state management only
- **Read-heavy**: Workflow queries add database load

## Why Optional?

pgflow adds complexity and workflow-specific database load. Most deployments don't need DAG orchestration and can use simpler approaches:

- `pg_cron` for scheduled jobs
- Application-level workflow engines (Temporal, Airflow)
- Event-driven architectures (message queues)

Only enable pgflow if you specifically need PostgreSQL-native workflow orchestration.
