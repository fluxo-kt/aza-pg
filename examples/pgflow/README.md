# pgflow (Built-in)

pgflow v0.7.2 is a PostgreSQL-native DAG-based workflow orchestration system that provides task queuing, retry logic, step dependencies, and worker tracking. **pgflow is now built into the aza-pg image by default.**

## What is pgflow?

- **SQL-only schema**: Installed automatically via initdb (not a traditional CREATE EXTENSION)
- **DAG workflows**: Define multi-step workflows with dependencies
- **Task queuing**: Built on pgmq (Postgres Message Queue)
- **Retry logic**: Automatic retry with exponential backoff
- **Worker tracking**: Register workers and monitor heartbeats
- **Dependency management**: Step execution based on completion of upstream steps

## Availability

pgflow is **pre-installed** in all aza-pg images and automatically initialized when a new database cluster is created. No installation steps required.

## Verification

After starting your aza-pg container, verify pgflow is installed:

```sql
-- Check schema exists
\dn pgflow

-- List all pgflow tables
SELECT tablename FROM pg_tables WHERE schemaname = 'pgflow' ORDER BY tablename;

-- List all pgflow functions
SELECT proname FROM pg_proc
WHERE pronamespace = 'pgflow'::regnamespace
ORDER BY proname;

-- Create a simple test flow
SELECT * FROM pgflow.create_flow('test_flow');

-- Add a step
SELECT * FROM pgflow.add_step('test_flow', 'step1');

-- Check flows
SELECT * FROM pgflow.flows;
```

## Quick Start Example

```sql
-- 1. Create a workflow
SELECT * FROM pgflow.create_flow('data_pipeline', 3, 5, 60);

-- 2. Add steps with dependencies
SELECT * FROM pgflow.add_step('data_pipeline', 'extract');
SELECT * FROM pgflow.add_step('data_pipeline', 'transform', ARRAY['extract']);
SELECT * FROM pgflow.add_step('data_pipeline', 'load', ARRAY['transform']);

-- 3. Start a workflow run
SELECT * FROM pgflow.start_flow('data_pipeline', '{"source": "database"}'::jsonb);

-- 4. View run status
SELECT run_id, status, remaining_steps, started_at
FROM pgflow.runs
ORDER BY started_at DESC
LIMIT 10;

-- 5. View step states
SELECT run_id, step_slug, status, created_at, started_at, completed_at
FROM pgflow.step_states
WHERE run_id = '<your-run-id>'
ORDER BY created_at;
```

## Comprehensive Documentation

For complete integration guide, API reference, examples, and troubleshooting:

**→ See [docs/pgflow/INTEGRATION.md](../../docs/pgflow/INTEGRATION.md)**

Topics covered:

- Architecture overview (schemas, tables, functions)
- Basic and advanced usage patterns
- Creating flows and managing dependencies
- Implementing workers
- Retry logic and error handling
- Performance considerations
- Troubleshooting guide
- Complete API reference

## Version and Limitations

**Current version: v0.7.2 (Phases 1-3)**

**Included features:**

- ✓ DAG workflow execution
- ✓ Step dependencies and ordering
- ✓ Task queuing via pgmq
- ✓ Retry logic with exponential backoff
- ✓ Worker registration and heartbeat tracking

**Not included (future phases):**

- ✗ Map steps for parallel array processing (Phases 9-11)
- ✗ `opt_start_delay` parameter (Phase 7)
- ✗ Real-time event broadcasting (Supabase Edge Functions - stubbed as no-op)

## Dependencies

- **pgmq extension**: Auto-enabled in aza-pg
- **PostgreSQL 14+**: For gen_random_uuid, jsonb functions

## Why Built-in?

pgflow is included by default because:

1. **Zero external dependencies**: Pure PostgreSQL solution
2. **Lightweight**: SQL-only schema with minimal overhead
3. **Supabase compatibility**: Many users migrating from Supabase expect pgflow
4. **Common use case**: Workflow orchestration is a frequent requirement

If you don't need pgflow, it won't impact your database - it's just a schema with tables and functions.

## Source and Upstream

- **Repository**: https://github.com/pgflow-dev/pgflow
- **NPM Package**: @pgflow/core@0.7.2
- **License**: MIT
- **Maintainer**: pgflow-dev organization

## Related Documentation

- [Extension Catalog](../../docs/EXTENSIONS.md) - All bundled extensions
- [pgmq Queue System](../../docs/EXTENSIONS.md#queueing) - Underlying message queue
- [ARCHITECTURE.md](../../docs/ARCHITECTURE.md) - aza-pg system design
