# pgflow Setup Guide

pgflow is a PostgreSQL-native DAG workflow orchestration engine with task queuing, dependencies, and retry logic. It runs entirely inside PostgreSQL using the pgmq extension.

**Important**: pgflow is NOT bundled in the aza-pg Docker image. It must be installed per-project into each database that needs workflow capabilities.

## Prerequisites

- aza-pg container running (provides pgmq extension)
- Database created for your project
- PostgreSQL 17+ (pgflow 0.8.x requirement)
- pgmq 1.5.0+ (included in aza-pg image)

## Quick Start

### Option 1: Using npm Packages (Recommended)

The official pgflow packages provide TypeScript DSL for defining workflows:

```bash
# Install in your project
bun add @pgflow/dsl @pgflow/client
```

```typescript
import { Flow } from "@pgflow/dsl";

// Define workflow with full type safety
const MyWorkflow = new Flow<{ url: string }>({
  slug: "my_workflow",
  maxAttempts: 3,
  baseDelay: 5,
  timeout: 60,
})
  .step({ slug: "fetch" }, async (input) => {
    // Step implementation
    return { data: "fetched" };
  })
  .step({ slug: "process", dependsOn: ["fetch"] }, async (input) => {
    return { result: input.fetch.data };
  });
```

### Option 2: Direct SQL Installation

1. Get the schema from the pgflow repository:

```bash
# Download combined schema
VERSION="0.8.1"
curl -sL "https://raw.githubusercontent.com/pgflow-dev/pgflow/pgflow%40${VERSION}/pkgs/core/schemas/combined.sql" \
  -o pgflow-${VERSION}.sql

# Or combine individual files (if combined.sql not available)
# See "Schema Files" section below
```

2. Install in your database:

```bash
# Connect to your project database
psql -d your_project_db -f pgflow-0.8.1.sql
```

3. Verify installation:

```sql
-- Check tables (should be 7)
SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'pgflow';

-- Check functions (should be 14+)
SELECT COUNT(*) FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'pgflow';
```

## Multi-Project Setup

For true isolation, each project should have its own database with independent pgflow schema:

```sql
-- Create project databases
CREATE DATABASE project_alpha;
CREATE DATABASE project_beta;

-- Connect and install pgflow in each
\c project_alpha
\i pgflow-0.8.1.sql

\c project_beta
\i pgflow-0.8.1.sql
```

Each database has completely independent:

- Workflow definitions (`pgflow.flows`, `pgflow.steps`)
- Execution state (`pgflow.runs`, `pgflow.step_states`)
- Task queues (via pgmq)

## Using pgflow

### Define a Workflow

```sql
-- Create workflow with retry settings
SELECT pgflow.create_flow(
  'order_processing',  -- flow_slug (unique identifier)
  3,                   -- max_attempts
  5,                   -- base_delay (seconds)
  60                   -- timeout (seconds)
);

-- Add steps with dependencies
SELECT pgflow.add_step('order_processing', 'validate', ARRAY[]::text[], 3, 5, 30);
SELECT pgflow.add_step('order_processing', 'charge', ARRAY['validate']::text[], 3, 5, 30);
SELECT pgflow.add_step('order_processing', 'fulfill', ARRAY['charge']::text[], 3, 5, 30);
```

### Execute a Workflow

```sql
-- Start workflow with input data
SELECT run_id FROM pgflow.start_flow(
  'order_processing',
  '{"order_id": 12345, "amount": 99.99}'::jsonb
);
```

### Process Tasks (Worker Side)

```sql
-- Poll for ready tasks
SELECT * FROM pgflow.start_tasks(
  'order_processing',
  ARRAY[msg_id]::bigint[],
  worker_uuid
);

-- Complete task with output
SELECT pgflow.complete_task(
  run_id,
  'validate',
  0,  -- task_index
  '{"valid": true}'::jsonb
);

-- Or fail task (will retry if attempts remaining)
SELECT pgflow.fail_task(
  run_id,
  'validate',
  0,
  'Validation failed: invalid order'
);
```

## Version Compatibility

| pgflow | pgmq Required | PostgreSQL Required |
| ------ | ------------- | ------------------- |
| 0.8.1  | 1.5.0+        | 17+                 |
| 0.7.2  | 1.4.x         | 14+                 |

## Schema Files

The pgflow schema consists of 21 SQL files that must be combined in order:

1. `0010_extensions.sql` - pgmq extension
2. `0020_schemas.sql` - pgflow schema creation
3. `0030_utilities.sql` - Utility functions
4. `0040_types.sql` - Custom composite types
5. `0050_tables_definitions.sql` - Flow/step definition tables
6. `0055_tables_workers.sql` - Worker tracking tables
7. `0060_tables_runtime.sql` - Runtime execution tables
8. `0090_function_poll_for_tasks.sql` - Task polling (deprecated)
9. `0100_function_*.sql` - Core workflow functions (8 files)
10. `0105_function_get_run_with_states.sql` - State queries
11. `0110_function_*.sql` - Batch operations (2 files)
12. `0120_function_start_tasks.sql` - Task initialization
13. `0200_grants_and_revokes.sql` - Security settings

Source: https://github.com/pgflow-dev/pgflow/tree/main/pkgs/core/schemas

## Key Concepts

### Flows

Workflow definitions with default retry settings. Identified by `flow_slug`.

### Steps

Individual units of work within a flow. Can have dependencies on other steps.

### Runs

Instances of workflow execution. Each run has its own state and can be tracked.

### Tasks

Actual work items created when steps become ready. Processed by workers.

### Dependencies

Steps can depend on other steps. A step only starts when all dependencies complete.

## Monitoring

```sql
-- Active runs
SELECT flow_slug, status, COUNT(*)
FROM pgflow.runs
WHERE status = 'started'
GROUP BY flow_slug, status;

-- Failed tasks
SELECT r.flow_slug, ss.step_slug, st.error_message
FROM pgflow.step_tasks st
JOIN pgflow.runs r ON st.run_id = r.run_id
JOIN pgflow.step_states ss ON st.run_id = ss.run_id AND st.step_slug = ss.step_slug
WHERE st.status = 'failed';

-- Workflow completion times
SELECT flow_slug,
       AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) as avg_seconds
FROM pgflow.runs
WHERE status = 'completed'
GROUP BY flow_slug;
```

## Troubleshooting

### Schema Not Found

```
ERROR: schema "pgflow" does not exist
```

→ Run the installation SQL in your database

### pgmq Extension Missing

```
ERROR: extension "pgmq" is not available
```

→ Ensure you're using the aza-pg image which includes pgmq

### Version Mismatch

```
ERROR: function pgflow.xxx does not exist
```

→ Your schema version may not match your client. Reinstall the schema.

## Resources

- [pgflow Documentation](https://pgflow.dev)
- [pgflow GitHub](https://github.com/pgflow-dev/pgflow)
- [@pgflow/dsl on npm](https://www.npmjs.com/package/@pgflow/dsl)
- [@pgflow/client on npm](https://www.npmjs.com/package/@pgflow/client)
