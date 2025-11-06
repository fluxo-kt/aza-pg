# pgflow v0.7.2 - Integration Notes for Standalone PostgreSQL

## Overview

This document describes how to integrate pgflow v0.7.2 (workflow orchestration system) into a standalone PostgreSQL environment without Supabase dependencies.

## What pgflow Provides

### Core Components

**Schema**: `pgflow` (workflow orchestration) + `pgmq` (message queue)

**Tables**:
- `pgflow.flows` - Workflow definitions with retry/timeout configuration
- `pgflow.steps` - Individual workflow steps with dependencies
- `pgflow.deps` - Dependency relationships between steps
- `pgflow.runs` - Workflow execution instances
- `pgflow.step_states` - Per-run step state tracking
- `pgflow.step_tasks` - Individual task execution records
- `pgflow.workers` - Worker process registration (optional)

**Key Functions**:
- `pgflow.create_flow(slug, max_attempts, base_delay, timeout)` - Define a workflow
- `pgflow.add_step(flow_slug, step_slug, deps_slugs[], ...)` - Add step to workflow
- `pgflow.start_flow(flow_slug, input_jsonb)` - Execute a workflow
- `pgflow.start_tasks(flow_slug, msg_ids[], worker_id)` - Poll and start tasks (worker side)
- `pgflow.complete_task(run_id, step_slug, task_index, output_jsonb)` - Mark task complete
- `pgflow.fail_task(run_id, step_slug, task_index, error_message)` - Mark task failed

### Workflow Features

**Capabilities**:
- ✅ DAG-based workflow orchestration (directed acyclic graphs)
- ✅ Automatic dependency resolution
- ✅ Retry with exponential backoff
- ✅ Task timeout management
- ✅ Persistent message queue (pgmq)
- ✅ Atomic state transitions
- ✅ Parallel task execution
- ✅ Map step type (v0.7.2) - process arrays in parallel

**Execution Flow**:
1. Define flow and steps with dependencies
2. Start flow with input JSON
3. pgflow creates step_states and queues initial tasks
4. Worker polls for tasks via `start_tasks()`
5. Worker executes task logic and calls `complete_task()` or `fail_task()`
6. pgflow updates state, starts dependent steps, completes run when done

## Dependencies

### Required Extensions

1. **pgmq** (PostgreSQL Message Queue)
   - Provides message queue functionality
   - Must be installed BEFORE running pgflow schema
   - Installation: `CREATE EXTENSION pgmq;`
   - Repository: https://github.com/tembo-io/pgmq

### PostgreSQL Version

- **Minimum**: PostgreSQL 14+
- **Recommended**: PostgreSQL 15+
- **Tested**: PostgreSQL 18 (as per aza-pg)

**Required Features**:
- `gen_random_uuid()` (built-in since PG 13)
- JSONB support (built-in since PG 9.4)
- `make_interval()` (built-in since PG 9.4)

## Limitations Without Supabase

### Real-time Events (Stubbed)

**What Supabase Provides**:
- `realtime.send()` broadcasts workflow events to connected clients
- Events: `run:started`, `run:completed`, `run:failed`, `step:started`, `step:completed`, `step:failed`

**Standalone Workaround**:
- A no-op stub function is provided in the schema
- **Option 1**: Use PostgreSQL LISTEN/NOTIFY
  ```sql
  -- Modify realtime.send() stub:
  PERFORM pg_notify('pgflow_events', payload::text);
  ```
- **Option 2**: Log events to a separate `pgflow_events` table
- **Option 3**: Integrate with external message broker (Redis Pub/Sub, RabbitMQ, etc.)
- **Option 4**: Leave as no-op (current default)

### Authentication & Authorization

**What Supabase Provides**:
- Row Level Security (RLS) policies
- `auth.users` table integration
- JWT-based authentication
- Role-based access control

**Standalone Workaround**:
- **No built-in authentication** - you must implement your own
- Remove or adapt RLS policies based on your auth system
- Consider:
  - Application-level authorization (most common)
  - PostgreSQL roles and GRANT/REVOKE
  - Custom RLS policies integrated with your user table
  - Middleware/API layer enforcing access control

### Supabase-Specific Features Removed

- ❌ `auth.users` references (from example migrations)
- ❌ `supabase_realtime` publication
- ❌ Row-level security policies for `authenticated` role
- ❌ Edge Functions runtime (Deno-based task execution)

## Installation Order

### 1. Install pgmq Extension

```sql
-- Create pgmq schema if not exists
CREATE SCHEMA IF NOT EXISTS pgmq;

-- Install pgmq extension
CREATE EXTENSION IF NOT EXISTS pgmq WITH SCHEMA pgmq;
```

**Note**: If pgmq is not available via `CREATE EXTENSION`, you must install it first:
- Follow instructions at: https://github.com/tembo-io/pgmq
- Or use Docker image: `tembo-io/pgmq` (includes PostgreSQL + pgmq)

### 2. Run pgflow Schema

```sql
-- Execute the consolidated schema file
\i /tmp/pgflow-schema-v0.7.2.sql
```

**What This Creates**:
- `pgflow` schema with all tables and functions
- `realtime` schema with stub function
- Indexes and constraints
- Default configuration (3 retries, 1s base delay, 60s timeout)

### 3. Test Installation

```sql
-- Verify tables exist
SELECT tablename FROM pg_tables WHERE schemaname = 'pgflow';

-- Verify pgmq is working
SELECT pgmq.create('test_queue');
SELECT pgmq.send('test_queue', '{"test": true}'::jsonb);
SELECT * FROM pgmq.read('test_queue', 30, 1);

-- Create a simple flow
SELECT pgflow.create_flow('test_flow');
SELECT pgflow.add_step('test_flow', 'step1');
SELECT pgflow.start_flow('test_flow', '{"input": "data"}'::jsonb);

-- Check run status
SELECT * FROM pgflow.runs;
```

## Integration Patterns

### Pattern 1: Application-Side Workers (Recommended)

Your application polls pgmq and executes tasks:

```python
# Python example with psycopg3
import psycopg
import json

conn = psycopg.connect("postgresql://user:pass@host/db")

while True:
    # Poll for tasks (up to 10 messages, 30s visibility timeout)
    with conn.cursor() as cur:
        cur.execute("""
            SELECT * FROM pgmq.read(%s, 30, 10)
        """, ("my_flow",))

        messages = cur.fetchall()

    for msg in messages:
        msg_id, read_ct, enqueued_at, vt, message = msg

        # Start the task (marks as 'started')
        with conn.cursor() as cur:
            cur.execute("""
                SELECT * FROM pgflow.start_tasks(%s, %s, %s)
            """, ("my_flow", [msg_id], "worker-uuid"))

            task = cur.fetchone()

        # Execute your business logic
        try:
            result = execute_step_logic(task.flow_slug, task.step_slug, task.input)

            # Mark complete
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT pgflow.complete_task(%s, %s, %s, %s)
                """, (task.run_id, task.step_slug, task.task_index, json.dumps(result)))

            conn.commit()
        except Exception as e:
            # Mark failed
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT pgflow.fail_task(%s, %s, %s, %s)
                """, (task.run_id, task.step_slug, task.task_index, str(e)))

            conn.commit()
```

### Pattern 2: PostgreSQL-Side Workers (Advanced)

Use PL/Python, PL/Perl, or background workers to execute tasks directly in PostgreSQL.

**Advantages**:
- Lower latency
- No external process management

**Disadvantages**:
- Limited to PostgreSQL-supported languages
- Resource contention with database
- Harder to scale horizontally

### Pattern 3: Hybrid (Microservices)

- API service exposes `start_flow()`
- Multiple worker services poll pgmq
- Each worker specializes in certain step types
- Use Kubernetes/Docker for orchestration

## Configuration & Tuning

### Flow-Level Defaults

```sql
-- Create flow with custom retry/timeout
SELECT pgflow.create_flow(
  'my_flow',
  max_attempts => 5,      -- Retry up to 5 times
  base_delay => 10,       -- Start with 10s backoff
  timeout => 300          -- 5 minute timeout
);
```

### Step-Level Overrides

```sql
-- Add step with custom config (overrides flow defaults)
SELECT pgflow.add_step(
  'my_flow',
  'expensive_step',
  ARRAY[]::text[],        -- No dependencies
  max_attempts => 1,      -- Don't retry expensive operations
  base_delay => NULL,     -- Use flow default
  timeout => 600,         -- 10 minute timeout for this step
  start_delay => 60       -- Delay task start by 60 seconds
);
```

### pgmq Configuration

pgmq queues are created automatically per flow, but you can tune:

```sql
-- View all queues
SELECT * FROM pgmq.list_queues();

-- Drop old queue (deletes all messages!)
SELECT pgmq.drop_queue('my_flow');

-- Archive old messages (moves from active to archive table)
SELECT pgmq.archive('my_flow', msg_id);

-- Purge queue (deletes all active messages)
SELECT pgmq.purge_queue('my_flow');
```

## Performance Considerations

### Indexing

All necessary indexes are created by the schema. Key indexes:

- `pgflow.runs(status)` - Query active runs
- `pgflow.step_states(run_id, status, remaining_deps)` - Find ready steps
- `pgflow.step_tasks(message_id)` - Message lookup
- `pgflow.step_tasks(status)` - Query by status (queued/started/completed/failed)

### Connection Pooling

pgflow makes heavy use of database connections. Use a connection pooler:

- **aza-pg**: Includes PgBouncer (transaction mode)
- **External**: pgBouncer, pgPool-II, or application-level pooling

**Note**: pgflow uses complex transactions with advisory locks. Test with your pooler.

### Monitoring

Key metrics to track:

```sql
-- Active runs
SELECT count(*) FROM pgflow.runs WHERE status = 'started';

-- Failed runs
SELECT count(*) FROM pgflow.runs WHERE status = 'failed';

-- Task backlog per flow
SELECT flow_slug, count(*)
FROM pgflow.step_tasks
WHERE status = 'queued'
GROUP BY flow_slug;

-- Average run duration per flow
SELECT flow_slug,
       avg(extract(epoch from (completed_at - started_at))) as avg_duration_sec
FROM pgflow.runs
WHERE status = 'completed'
GROUP BY flow_slug;

-- pgmq queue depths
SELECT queue_name,
       (SELECT count(*) FROM pgmq.format_table_name(queue_name, 'q'))
FROM pgmq.list_queues();
```

## Troubleshooting

### Issue: Tasks stuck in 'queued' state

**Cause**: No workers polling the queue

**Solution**: Start workers or check worker connectivity

### Issue: Tasks stuck in 'started' state

**Cause**: Worker crashed before completing/failing task

**Solution**:
1. pgmq will automatically re-deliver after visibility timeout
2. Implement worker health checks and graceful shutdown

### Issue: "extension pgmq does not exist"

**Cause**: pgmq not installed

**Solution**: Install pgmq extension (see Dependencies section)

### Issue: Flows never complete

**Cause**: Circular dependencies or orphaned steps

**Solution**:
```sql
-- Check for circular dependencies
WITH RECURSIVE dep_chain AS (
  SELECT flow_slug, dep_slug, step_slug, 1 as depth,
         ARRAY[dep_slug, step_slug] as path
  FROM pgflow.deps
  UNION ALL
  SELECT dc.flow_slug, d.dep_slug, d.step_slug, dc.depth + 1,
         dc.path || d.step_slug
  FROM dep_chain dc
  JOIN pgflow.deps d ON dc.step_slug = d.dep_slug
                     AND dc.flow_slug = d.flow_slug
  WHERE NOT d.step_slug = ANY(dc.path)
    AND dc.depth < 100
)
SELECT * FROM dep_chain WHERE depth > 10;  -- Likely circular if depth > 10
```

### Issue: High memory usage

**Cause**: Large JSONB payloads or too many concurrent runs

**Solution**:
1. Limit JSONB payload size (use external storage for large data)
2. Archive completed runs periodically
3. Tune PostgreSQL `work_mem` and `shared_buffers`

## Security Best Practices

1. **Least Privilege**: Grant only necessary permissions
   ```sql
   -- Example: App user can execute flows but not modify definitions
   GRANT USAGE ON SCHEMA pgflow TO app_user;
   GRANT SELECT, INSERT, UPDATE ON pgflow.runs TO app_user;
   GRANT SELECT ON pgflow.flows, pgflow.steps TO app_user;
   GRANT EXECUTE ON FUNCTION pgflow.start_flow TO app_user;
   ```

2. **Input Validation**: Sanitize user inputs before `start_flow()`

3. **Rate Limiting**: Limit flow creation/start calls per user

4. **Audit Logging**: Track who starts flows and when
   ```sql
   -- Add audit columns to pgflow.runs
   ALTER TABLE pgflow.runs ADD COLUMN created_by text;
   ALTER TABLE pgflow.runs ADD COLUMN client_ip inet;
   ```

5. **Secrets Management**: Never pass secrets in JSONB inputs
   - Use separate secure storage (Vault, AWS Secrets Manager, etc.)
   - Pass references/IDs only

## Migration Path from Supabase

If migrating from Supabase to standalone PostgreSQL:

1. **Export Data**: Use `pg_dump` to export pgflow tables
   ```bash
   pg_dump -h supabase-host -U user -t 'pgflow.*' -t 'pgmq.*' > pgflow_data.sql
   ```

2. **Install Clean Schema**: Run consolidated schema on new PostgreSQL

3. **Import Data**:
   ```bash
   psql -h new-host -U user -d database < pgflow_data.sql
   ```

4. **Update Application**:
   - Remove Supabase client library
   - Use direct PostgreSQL connections
   - Implement authentication layer

5. **Replace Realtime**: Choose event notification strategy (see Limitations section)

6. **Test Thoroughly**: Run full workflow test suite

## Advanced Topics

### Map Steps (v0.7.2)

Process arrays in parallel:

```sql
-- Create flow with map step
SELECT pgflow.create_flow('parallel_flow');

-- Root map: processes run input array
SELECT pgflow.add_step(
  'parallel_flow',
  'process_items',
  ARRAY[]::text[],     -- No dependencies (root step)
  step_type => 'map'   -- Map step type
);

-- Start with array input
SELECT pgflow.start_flow(
  'parallel_flow',
  '[{"id": 1}, {"id": 2}, {"id": 3}]'::jsonb
);

-- pgflow creates 3 parallel tasks (one per array element)
-- Worker receives individual elements: {"id": 1}, {"id": 2}, {"id": 3}
```

### Conditional Execution

Use step dependencies and output values:

```sql
SELECT pgflow.add_step('my_flow', 'check_condition');
SELECT pgflow.add_step('my_flow', 'on_success', ARRAY['check_condition']);
SELECT pgflow.add_step('my_flow', 'on_failure', ARRAY['check_condition']);

-- Worker logic determines which path to take based on check_condition output
```

### Scheduled Flows

Use PostgreSQL cron (pg_cron extension):

```sql
-- Schedule daily flow at 2am
SELECT cron.schedule(
  'daily-report',
  '0 2 * * *',
  $$SELECT pgflow.start_flow('report_flow', '{"date": "today"}'::jsonb)$$
);
```

## Additional Resources

- **pgflow GitHub**: https://github.com/pgflow/pgflow
- **pgmq GitHub**: https://github.com/tembo-io/pgmq
- **PostgreSQL Documentation**: https://www.postgresql.org/docs/
- **aza-pg Project**: /opt/apps/art/infra/aza-pg (your PostgreSQL stack)

## Support & Maintenance

### Schema Version

This schema is based on **pgflow v0.7.2** (`@pgflow/core@0.7.2`).

### Upgrade Path

Future pgflow versions may require schema migrations. Monitor:
- pgflow releases on GitHub
- CHANGELOG for breaking changes
- Run migration scripts in order

### Backup Strategy

1. **Regular Backups**: Include pgflow and pgmq schemas in pg_dump
2. **PITR**: Configure WAL archiving for point-in-time recovery
3. **Test Restores**: Regularly test backup restoration

---

**Last Updated**: 2025-11-06
**pgflow Version**: v0.7.2
**PostgreSQL Version**: 18 (compatible with 14+)
**Status**: Production-ready with noted limitations
