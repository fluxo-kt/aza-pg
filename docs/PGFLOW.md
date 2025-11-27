# pgflow Documentation

Comprehensive guide to pgflow v0.8.1, a PostgreSQL-native DAG workflow orchestration engine with task queuing, dependencies, and retry logic.

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Core Concepts](#core-concepts)
- [Basic Usage](#basic-usage)
- [Architecture](#architecture)
- [API Reference](#api-reference)
- [Advanced Topics](#advanced-topics)
- [Worker Implementation](#worker-implementation)
- [Real-Time Event Notifications](#real-time-event-notifications)
- [Performance Considerations](#performance-considerations)
- [Monitoring](#monitoring)
- [Troubleshooting](#troubleshooting)
- [Examples](#examples)
- [Limitations](#limitations)
- [Schema Update Process](#schema-update-process)
- [Resources](#resources)

---

## Overview

### What is pgflow?

pgflow is a PostgreSQL-native workflow orchestration system that runs entirely inside PostgreSQL using the pgmq extension. It enables you to:

- **Define DAG workflows**: Create directed acyclic graphs of tasks with dependencies
- **Queue and execute tasks**: Leverage pgmq for reliable task queuing
- **Handle failures gracefully**: Automatic retry with exponential backoff
- **Track execution**: Monitor workflow runs, step states, and task completion
- **Scale workers**: Register multiple workers and track their health

### Key Features

- ✅ **Pure SQL**: No external services or languages required
- ✅ **ACID guarantees**: All state changes are transactional
- ✅ **Dependency management**: Steps wait for dependencies before executing
- ✅ **Retry logic**: Configurable max attempts and exponential backoff
- ✅ **Worker tracking**: Register workers, track heartbeats, monitor health
- ✅ **Task queuing**: Built on pgmq for reliable message delivery

### When to Use pgflow

**Good fit:**

- Database-centric applications already using PostgreSQL
- Workflows with complex dependencies between steps
- Systems requiring ACID guarantees for workflow state
- Supabase migrations (pgflow compatibility layer)
- Background job processing with retry logic

**Consider alternatives:**

- High-throughput event processing (use dedicated stream processors)
- Cross-service orchestration (use Temporal, Airflow, or similar)
- Simple scheduled tasks (use pg_cron instead)

### Important: Per-Project Installation

**pgflow is NOT bundled in the aza-pg Docker image.** It must be installed per-project into each database that needs workflow capabilities. This ensures true isolation between different projects/databases.

---

## Quick Start

### Prerequisites

- aza-pg container running (provides pgmq extension)
- Database created for your project
- PostgreSQL 17+ (pgflow 0.8.x requirement)
- pgmq 1.5.0+ (included in aza-pg image)

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

---

## Installation

### Multi-Project Setup

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

### Version Compatibility

| pgflow | pgmq Required | PostgreSQL Required |
| ------ | ------------- | ------------------- |
| 0.8.1  | 1.5.0+        | 17+                 |
| 0.7.2  | 1.4.x         | 14+                 |

### Schema Files

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

---

## Core Concepts

### 1. Flows

A **flow** is a named workflow definition with default retry and timeout settings. Identified by `flow_slug`.

```sql
SELECT * FROM pgflow.create_flow(
  flow_slug := 'etl_pipeline',
  max_attempts := 3,      -- Retry up to 3 times
  base_delay := 5,        -- Initial retry delay: 5 seconds
  timeout := 120          -- Step timeout: 120 seconds
);
```

### 2. Steps

A **step** is a unit of work within a flow. Steps can have dependencies on other steps.

```sql
-- Add independent step
SELECT * FROM pgflow.add_step('etl_pipeline', 'extract');

-- Add step with dependency
SELECT * FROM pgflow.add_step(
  flow_slug := 'etl_pipeline',
  step_slug := 'transform',
  deps_slugs := ARRAY['extract']  -- Waits for 'extract' to complete
);
```

### 3. Dependencies

Dependencies create a DAG structure. A step only executes after all its dependencies complete.

```sql
-- Linear pipeline: extract → transform → load
SELECT * FROM pgflow.add_step('pipeline', 'extract');
SELECT * FROM pgflow.add_step('pipeline', 'transform', ARRAY['extract']);
SELECT * FROM pgflow.add_step('pipeline', 'load', ARRAY['transform']);

-- Parallel branches: extract → [transform_a, transform_b] → merge
SELECT * FROM pgflow.add_step('pipeline', 'extract');
SELECT * FROM pgflow.add_step('pipeline', 'transform_a', ARRAY['extract']);
SELECT * FROM pgflow.add_step('pipeline', 'transform_b', ARRAY['extract']);
SELECT * FROM pgflow.add_step('pipeline', 'merge', ARRAY['transform_a', 'transform_b']);
```

### 4. Runs

A **run** is a workflow execution instance with input data.

```sql
SELECT * FROM pgflow.start_flow(
  flow_slug := 'etl_pipeline',
  input := '{"source": "s3://bucket/data.csv", "format": "csv"}'::jsonb
);
```

**Returns**: Run record with `run_id` for tracking.

### 5. Tasks

A **task** is the actual work unit queued for execution. In v0.8.1, each step creates exactly 1 task. Actual work items created when steps become ready. Processed by workers.

### 6. Workers

Workers are processes that poll queues, execute tasks, and update state.

```sql
-- Register worker (typically done by worker process)
INSERT INTO pgflow.workers (worker_id, queue_name, function_name)
VALUES (gen_random_uuid(), 'etl_pipeline', 'worker_main')
RETURNING *;
```

---

## Basic Usage

### Creating a Workflow

```sql
-- 1. Define the flow
SELECT * FROM pgflow.create_flow(
  flow_slug := 'data_sync',
  max_attempts := 3,
  base_delay := 2,
  timeout := 60
);

-- 2. Add steps with dependencies
SELECT * FROM pgflow.add_step('data_sync', 'fetch_data');
SELECT * FROM pgflow.add_step('data_sync', 'validate', ARRAY['fetch_data']);
SELECT * FROM pgflow.add_step('data_sync', 'process', ARRAY['validate']);
SELECT * FROM pgflow.add_step('data_sync', 'store', ARRAY['process']);

-- 3. View the workflow definition
SELECT s.step_slug, s.step_index, s.deps_count,
       array_agg(d.dep_slug ORDER BY d.dep_slug) AS dependencies
FROM pgflow.steps s
LEFT JOIN pgflow.deps d ON d.flow_slug = s.flow_slug AND d.step_slug = s.step_slug
WHERE s.flow_slug = 'data_sync'
GROUP BY s.step_slug, s.step_index, s.deps_count
ORDER BY s.step_index;
```

### Starting a Workflow

```sql
-- Start a new run
SELECT * FROM pgflow.start_flow(
  'data_sync',
  '{"api_endpoint": "https://api.example.com/data", "limit": 1000}'::jsonb
);

-- Returns run record with run_id
-- Example: run_id = '550e8400-e29b-41d4-a716-446655440000'
```

### Monitoring Workflow Status

```sql
-- Check run status
SELECT run_id, status, remaining_steps, started_at, completed_at, failed_at
FROM pgflow.runs
WHERE flow_slug = 'data_sync'
ORDER BY started_at DESC
LIMIT 10;

-- Check step states for a specific run
SELECT step_slug, status, remaining_deps, started_at, completed_at, failed_at
FROM pgflow.step_states
WHERE run_id = '550e8400-e29b-41d4-a716-446655440000'
ORDER BY created_at;

-- Check task details
SELECT step_slug, status, attempts_count, error_message, started_at, completed_at
FROM pgflow.step_tasks
WHERE run_id = '550e8400-e29b-41d4-a716-446655440000'
ORDER BY queued_at;
```

### Processing Tasks (Worker Side)

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

---

## Architecture

### Schema Components

pgflow creates three schemas:

1. **`pgflow`**: Core workflow tables and functions
2. **`pgmq`**: Message queue (created if not exists)
3. **`realtime`**: Event broadcasting via pg_notify (LISTEN/NOTIFY)

### Core Tables

#### 1. `pgflow.flows`

Defines workflows with retry and timeout defaults.

| Column           | Type        | Description                         |
| ---------------- | ----------- | ----------------------------------- |
| flow_slug        | text        | Unique workflow identifier (PK)     |
| opt_max_attempts | integer     | Default max retry attempts (3)      |
| opt_base_delay   | integer     | Default retry base delay in sec (1) |
| opt_timeout      | integer     | Default step timeout in sec (60)    |
| created_at       | timestamptz | Flow creation timestamp             |

#### 2. `pgflow.steps`

Defines workflow steps with dependencies.

| Column           | Type        | Description                             |
| ---------------- | ----------- | --------------------------------------- |
| flow_slug        | text        | Parent flow (FK)                        |
| step_slug        | text        | Unique step identifier within flow (PK) |
| step_type        | text        | Step type (always 'single' in v0.8.1)   |
| step_index       | integer     | Execution order hint                    |
| deps_count       | integer     | Number of dependencies                  |
| opt_max_attempts | integer     | Override max attempts (nullable)        |
| opt_base_delay   | integer     | Override base delay (nullable)          |
| opt_timeout      | integer     | Override timeout (nullable)             |
| created_at       | timestamptz | Step creation timestamp                 |

#### 3. `pgflow.deps`

Defines step dependencies (edges in DAG).

| Column     | Type        | Description                   |
| ---------- | ----------- | ----------------------------- |
| flow_slug  | text        | Parent flow (FK)              |
| dep_slug   | text        | Dependency step slug (FK)     |
| step_slug  | text        | Dependent step slug (FK)      |
| created_at | timestamptz | Dependency creation timestamp |

**Constraint**: `dep_slug` ≠ `step_slug` (no self-dependencies)

#### 4. `pgflow.runs`

Tracks workflow execution instances.

| Column          | Type        | Description                         |
| --------------- | ----------- | ----------------------------------- |
| run_id          | uuid        | Unique run identifier (PK)          |
| flow_slug       | text        | Parent flow (FK)                    |
| status          | text        | started/completed/failed            |
| input           | jsonb       | Workflow input data                 |
| output          | jsonb       | Aggregated output from leaf steps   |
| remaining_steps | integer     | Steps not yet completed             |
| started_at      | timestamptz | Run start timestamp                 |
| completed_at    | timestamptz | Run completion timestamp (nullable) |
| failed_at       | timestamptz | Run failure timestamp (nullable)    |

**Constraints**:

- `completed_at` XOR `failed_at` (mutually exclusive)
- Timestamps must be chronologically ordered

#### 5. `pgflow.step_states`

Tracks step execution within a run.

| Column          | Type        | Description                           |
| --------------- | ----------- | ------------------------------------- |
| flow_slug       | text        | Parent flow (FK)                      |
| run_id          | uuid        | Parent run (FK)                       |
| step_slug       | text        | Step identifier (FK) (PK with run_id) |
| status          | text        | created/started/completed/failed      |
| remaining_tasks | integer     | Tasks not yet completed (always 1)    |
| remaining_deps  | integer     | Dependencies not yet satisfied        |
| created_at      | timestamptz | State creation timestamp              |
| started_at      | timestamptz | Step start timestamp (nullable)       |
| completed_at    | timestamptz | Step completion timestamp (nullable)  |
| failed_at       | timestamptz | Step failure timestamp (nullable)     |

**Key insight**: `remaining_deps` decrements as upstream steps complete. When it reaches 0, the step becomes ready to execute.

#### 6. `pgflow.step_tasks`

Tracks individual task executions (1 task per step in v0.8.1).

| Column         | Type        | Description                          |
| -------------- | ----------- | ------------------------------------ |
| flow_slug      | text        | Parent flow (FK)                     |
| run_id         | uuid        | Parent run (FK)                      |
| step_slug      | text        | Parent step (FK)                     |
| message_id     | bigint      | pgmq message ID (nullable)           |
| task_index     | integer     | Task index (always 0 in v0.8.1)      |
| status         | text        | queued/started/completed/failed      |
| attempts_count | integer     | Number of execution attempts         |
| error_message  | text        | Last error message (nullable)        |
| output         | jsonb       | Task output data (nullable)          |
| queued_at      | timestamptz | Task creation timestamp              |
| started_at     | timestamptz | Task start timestamp (nullable)      |
| completed_at   | timestamptz | Task completion timestamp (nullable) |
| failed_at      | timestamptz | Task failure timestamp (nullable)    |
| last_worker_id | uuid        | Last worker that processed task (FK) |

#### 7. `pgflow.workers`

Tracks worker registration and heartbeats.

| Column            | Type        | Description                      |
| ----------------- | ----------- | -------------------------------- |
| worker_id         | uuid        | Unique worker identifier (PK)    |
| queue_name        | text        | Queue being monitored            |
| function_name     | text        | Worker function/handler name     |
| started_at        | timestamptz | Worker registration timestamp    |
| stopped_at        | timestamptz | Worker stop timestamp (nullable) |
| last_heartbeat_at | timestamptz | Last heartbeat timestamp         |

---

## API Reference

### Flow Management

#### `pgflow.create_flow()`

Creates or updates a flow definition.

```sql
FUNCTION pgflow.create_flow(
  flow_slug text,
  max_attempts integer DEFAULT 3,
  base_delay integer DEFAULT 5,
  timeout integer DEFAULT 60
) RETURNS pgflow.flows
```

**Parameters**:

- `flow_slug`: Unique workflow identifier (must be valid slug: `^[a-zA-Z_][a-zA-Z0-9_]*$`)
- `max_attempts`: Max retry attempts (≥ 0)
- `base_delay`: Base retry delay in seconds (≥ 0)
- `timeout`: Step timeout in seconds (> 0)

**Returns**: Flow record

**Side effects**:

- Creates pgmq queue with name `flow_slug`
- Upserts flow record (idempotent)

**Example**:

```sql
SELECT * FROM pgflow.create_flow('email_campaign', 5, 10, 300);
```

### Step Management

#### `pgflow.add_step()` (with dependencies)

Adds a step with dependencies to a flow.

```sql
FUNCTION pgflow.add_step(
  flow_slug text,
  step_slug text,
  deps_slugs text[],
  max_attempts integer DEFAULT NULL,
  base_delay integer DEFAULT NULL,
  timeout integer DEFAULT NULL
) RETURNS pgflow.steps
```

**Parameters**:

- `flow_slug`: Parent flow identifier
- `step_slug`: Unique step identifier within flow
- `deps_slugs`: Array of dependency step slugs (must already exist)
- `max_attempts`: Override flow's max_attempts (nullable)
- `base_delay`: Override flow's base_delay (nullable)
- `timeout`: Override flow's timeout (nullable)

**Returns**: Step record

**Example**:

```sql
SELECT * FROM pgflow.add_step(
  'email_campaign',
  'send_emails',
  ARRAY['load_recipients', 'validate_content'],
  max_attempts := 5  -- Override default
);
```

#### `pgflow.add_step()` (no dependencies)

Overload for steps without dependencies.

```sql
FUNCTION pgflow.add_step(
  flow_slug text,
  step_slug text,
  max_attempts integer DEFAULT NULL,
  base_delay integer DEFAULT NULL,
  timeout integer DEFAULT NULL
) RETURNS pgflow.steps
```

**Example**:

```sql
SELECT * FROM pgflow.add_step('email_campaign', 'load_recipients');
```

### Workflow Execution

#### `pgflow.start_flow()`

Starts a new workflow run.

```sql
FUNCTION pgflow.start_flow(
  flow_slug text,
  input jsonb
) RETURNS SETOF pgflow.runs
```

**Parameters**:

- `flow_slug`: Flow to execute
- `input`: Input data passed to all steps (available as `input.run`)

**Returns**: Run record with `run_id`

**Side effects**:

- Creates run record
- Creates step_states for all steps
- Queues tasks for steps with no dependencies (via pgmq)
- Initializes `remaining_deps` counters

**Example**:

```sql
SELECT * FROM pgflow.start_flow(
  'email_campaign',
  '{"campaign_id": 42, "send_time": "2025-01-15T10:00:00Z"}'::jsonb
);
```

### Task Processing (Worker Side)

#### `pgflow.start_tasks()` (v0.8.1 recommended)

Marks tasks as started and returns task details.

```sql
FUNCTION pgflow.start_tasks(
  flow_slug text,
  msg_ids bigint[],
  worker_id uuid
) RETURNS SETOF pgflow.step_task_record
```

**Parameters**:

- `flow_slug`: Flow name (queue name)
- `msg_ids`: Array of message IDs from pgmq.read()
- `worker_id`: Worker UUID

**Returns**: Set of task records with:

- `flow_slug`: Flow identifier
- `run_id`: Run UUID
- `step_slug`: Step identifier
- `input`: Merged input (run input + dependency outputs)
- `msg_id`: Message ID

**Side effects**:

- Increments `attempts_count`
- Sets status = 'started'
- Records `started_at` timestamp
- Associates task with `worker_id`
- Sets message visibility timeout based on step timeout

**Typical usage**:

```sql
-- 1. Poll queue
SELECT msg_id FROM pgmq.read('my_flow', 60, 10);  -- Returns message IDs

-- 2. Start tasks
SELECT * FROM pgflow.start_tasks(
  'my_flow',
  ARRAY[123, 124, 125],  -- msg_ids from step 1
  '550e8400-e29b-41d4-a716-446655440000'::uuid  -- worker_id
);
```

#### `pgflow.complete_task()`

Marks a task as successfully completed.

```sql
FUNCTION pgflow.complete_task(
  run_id uuid,
  step_slug text,
  task_index integer,
  output jsonb
) RETURNS SETOF pgflow.step_tasks
```

**Parameters**:

- `run_id`: Run identifier
- `step_slug`: Step identifier
- `task_index`: Task index (always 0 in v0.8.1)
- `output`: Task output data (available to dependent steps)

**Returns**: Updated task record

**Side effects**:

- Sets task status = 'completed'
- Records `completed_at` timestamp
- Archives message in pgmq
- Decrements `remaining_tasks` on step_state
- Marks step as completed if all tasks done
- Decrements `remaining_deps` on dependent steps
- Queues dependent steps if they become ready
- Decrements `remaining_steps` on run
- Marks run as completed if all steps done
- Aggregates outputs from leaf steps into run.output

**Example**:

```sql
SELECT * FROM pgflow.complete_task(
  run_id := '550e8400-e29b-41d4-a716-446655440000',
  step_slug := 'fetch_data',
  task_index := 0,
  output := '{"record_count": 1500, "checksum": "abc123"}'::jsonb
);
```

#### `pgflow.fail_task()`

Marks a task as failed (retries if attempts remain).

```sql
FUNCTION pgflow.fail_task(
  run_id uuid,
  step_slug text,
  task_index integer,
  error_message text
) RETURNS SETOF pgflow.step_tasks
```

**Parameters**:

- `run_id`: Run identifier
- `step_slug`: Step identifier
- `task_index`: Task index (always 0)
- `error_message`: Error description

**Returns**: Updated task record

**Side effects**:

- If `attempts_count` < `max_attempts`:
  - Sets status = 'queued' (retry)
  - Delays message with exponential backoff: `base_delay * 2^attempts_count`
  - Clears `started_at` timestamp
- If `attempts_count` ≥ `max_attempts`:
  - Sets status = 'failed'
  - Records `failed_at` timestamp
  - Archives message in pgmq
  - Marks step as failed
  - Marks run as failed
- Always records `error_message`

**Example**:

```sql
SELECT * FROM pgflow.fail_task(
  run_id := '550e8400-e29b-41d4-a716-446655440000',
  step_slug := 'fetch_data',
  task_index := 0,
  error_message := 'Connection timeout after 30s'
);
```

### Utility Functions

#### `pgflow.is_valid_slug()`

Validates slug format.

```sql
FUNCTION pgflow.is_valid_slug(slug text) RETURNS boolean
```

**Rules**:

- Not null or empty
- Length ≤ 128 characters
- Matches regex: `^[a-zA-Z_][a-zA-Z0-9_]*$`
- Not a reserved word ('run')

#### `pgflow.calculate_retry_delay()`

Calculates exponential backoff delay.

```sql
FUNCTION pgflow.calculate_retry_delay(
  base_delay numeric,
  attempts_count integer
) RETURNS integer
```

**Formula**: `floor(base_delay * 2^attempts_count)`

**Example**:

- Base delay: 5s
- Attempt 0: 5s
- Attempt 1: 10s
- Attempt 2: 20s
- Attempt 3: 40s

---

## Advanced Topics

### Input and Output Flow

#### Run Input

The `input` parameter to `start_flow()` is available to all steps:

```sql
SELECT * FROM pgflow.start_flow('my_flow', '{"user_id": 123}'::jsonb);
```

In task processing, access via `input.run`:

```json
{
  "run": { "user_id": 123 }
}
```

#### Dependency Outputs

Completed upstream steps contribute their outputs:

```sql
-- Step A completes
SELECT * FROM pgflow.complete_task(
  run_id := '...',
  step_slug := 'step_a',
  task_index := 0,
  output := '{"result": "success", "data": [1, 2, 3]}'::jsonb
);

-- Step B (depends on A) receives merged input
{
  "run": {"user_id": 123},
  "step_a": {"result": "success", "data": [1, 2, 3]}
}
```

#### Run Output

When all steps complete, `run.output` aggregates outputs from **leaf steps** (steps with no dependents):

```sql
SELECT output FROM pgflow.runs WHERE run_id = '...';
-- {"step_c": {...}, "step_d": {...}}  -- Only leaf steps
```

### Retry Logic

#### Exponential Backoff

Failed tasks retry with exponentially increasing delays:

```sql
-- Flow defaults
SELECT * FROM pgflow.create_flow('my_flow', max_attempts := 5, base_delay := 2);

-- Retry schedule:
-- Attempt 1: immediate
-- Attempt 2: 2s delay   (2 * 2^0)
-- Attempt 3: 4s delay   (2 * 2^1)
-- Attempt 4: 8s delay   (2 * 2^2)
-- Attempt 5: 16s delay  (2 * 2^3)
```

#### Per-Step Overrides

Override retry settings for specific steps:

```sql
SELECT * FROM pgflow.add_step(
  'my_flow',
  'flaky_api_call',
  max_attempts := 10,      -- Retry more
  base_delay := 1          -- Shorter initial delay
);
```

### Timeouts

#### Step Timeout

Each step has a timeout (default 60s):

```sql
-- Set timeout at flow level
SELECT * FROM pgflow.create_flow('my_flow', timeout := 120);

-- Override at step level
SELECT * FROM pgflow.add_step('my_flow', 'long_step', timeout := 600);
```

**Mechanism**:

- When a task is started, its message visibility timeout is set to `timeout + 2` seconds
- If the worker doesn't complete/fail the task within this window, the message becomes visible again
- Another worker can pick it up (counts as a new attempt)

**Important**: Timeouts don't kill running workers. They only affect message visibility. Implement application-level timeouts in workers.

### Workflow Patterns

#### Linear Pipeline

```sql
SELECT * FROM pgflow.add_step('pipeline', 'step1');
SELECT * FROM pgflow.add_step('pipeline', 'step2', ARRAY['step1']);
SELECT * FROM pgflow.add_step('pipeline', 'step3', ARRAY['step2']);
```

```
step1 → step2 → step3
```

#### Fan-Out / Fan-In

```sql
SELECT * FROM pgflow.add_step('pipeline', 'split');
SELECT * FROM pgflow.add_step('pipeline', 'process_a', ARRAY['split']);
SELECT * FROM pgflow.add_step('pipeline', 'process_b', ARRAY['split']);
SELECT * FROM pgflow.add_step('pipeline', 'process_c', ARRAY['split']);
SELECT * FROM pgflow.add_step('pipeline', 'merge', ARRAY['process_a', 'process_b', 'process_c']);
```

```
        ┌─→ process_a ─┐
split ──┼─→ process_b ─┼─→ merge
        └─→ process_c ─┘
```

#### Diamond Pattern

```sql
SELECT * FROM pgflow.add_step('pipeline', 'start');
SELECT * FROM pgflow.add_step('pipeline', 'branch_a', ARRAY['start']);
SELECT * FROM pgflow.add_step('pipeline', 'branch_b', ARRAY['start']);
SELECT * FROM pgflow.add_step('pipeline', 'join', ARRAY['branch_a', 'branch_b']);
```

```
        ┌─→ branch_a ─┐
start ──┤             ├─→ join
        └─→ branch_b ─┘
```

---

## Worker Implementation

### Worker Lifecycle

1. **Register**: Insert into `pgflow.workers`
2. **Poll**: Read messages from queue
3. **Start**: Call `start_tasks()` to mark as started
4. **Execute**: Run business logic
5. **Complete/Fail**: Call `complete_task()` or `fail_task()`
6. **Heartbeat**: Update `last_heartbeat_at` periodically
7. **Shutdown**: Update `stopped_at`

### Example Worker (Pseudocode)

```sql
-- Worker setup
DO $$
DECLARE
  v_worker_id uuid := gen_random_uuid();
  v_queue_name text := 'my_flow';
  v_messages pgmq.message_record[];
  v_task pgflow.step_task_record;
BEGIN
  -- Register worker
  INSERT INTO pgflow.workers (worker_id, queue_name, function_name, started_at, last_heartbeat_at)
  VALUES (v_worker_id, v_queue_name, 'example_worker', now(), now());

  -- Main loop
  LOOP
    -- Poll for messages
    SELECT array_agg(msg_id) INTO v_messages
    FROM pgmq.read(v_queue_name, 60, 10);  -- Read up to 10 messages, 60s visibility

    EXIT WHEN v_messages IS NULL OR array_length(v_messages, 1) = 0;

    -- Start tasks
    FOR v_task IN
      SELECT * FROM pgflow.start_tasks(v_queue_name, v_messages, v_worker_id)
    LOOP
      BEGIN
        -- Execute business logic
        -- (Access inputs via v_task.input)
        DECLARE
          v_output jsonb;
        BEGIN
          -- Example: Call a function
          v_output := my_step_handler(v_task.input);

          -- Mark as completed
          PERFORM pgflow.complete_task(
            v_task.run_id,
            v_task.step_slug,
            0,  -- task_index always 0 in v0.8.1
            v_output
          );
        END;
      EXCEPTION WHEN OTHERS THEN
        -- Mark as failed
        PERFORM pgflow.fail_task(
          v_task.run_id,
          v_task.step_slug,
          0,
          SQLERRM
        );
      END;
    END LOOP;

    -- Update heartbeat
    UPDATE pgflow.workers
    SET last_heartbeat_at = now()
    WHERE worker_id = v_worker_id;

    -- Small delay before next poll
    PERFORM pg_sleep(1);
  END LOOP;

  -- Cleanup
  UPDATE pgflow.workers SET stopped_at = now() WHERE worker_id = v_worker_id;
END;
$$;
```

### Worker Best Practices

1. **Idempotency**: Steps should be idempotent (safe to retry)
2. **Heartbeats**: Update `last_heartbeat_at` every 10-30 seconds
3. **Graceful shutdown**: Set `stopped_at` before exiting
4. **Error handling**: Always call `fail_task()` on errors (never leave tasks hanging)
5. **Visibility timeout**: Match to expected execution time + buffer
6. **Batch polling**: Poll for multiple messages to reduce round-trips

---

## Real-Time Event Notifications

pgflow v0.8.1 broadcasts events for workflow state changes. In Supabase environments, this uses Supabase Realtime. For non-Supabase deployments (like aza-pg), we provide a **pg_notify-based implementation** using PostgreSQL's native LISTEN/NOTIFY mechanism.

### Subscribing to Events

```sql
-- Subscribe to ALL pgflow events (global channel)
LISTEN pgflow_events;

-- Subscribe to a specific workflow topic
LISTEN order_processing;
```

### Event Payload Structure

Events are delivered as JSON:

```json
{
  "payload": {
    "event_type": "step:completed",
    "run_id": "uuid",
    "step_slug": "validate",
    "status": "completed"
  },
  "event": "step:completed",
  "topic": "order_processing",
  "timestamp": 1700000000.123
}
```

### Event Types

| Event            | Description                      |
| ---------------- | -------------------------------- |
| `step:completed` | A step has finished successfully |
| `run:failed`     | A workflow run has failed        |
| `run:completed`  | A workflow run completed         |

### Client-Side Example (Node.js)

```typescript
import { Client } from "pg";

const client = new Client(connectionString);
await client.connect();

// Subscribe to events
await client.query("LISTEN pgflow_events");

// Handle notifications
client.on("notification", (msg) => {
  const event = JSON.parse(msg.payload);
  console.log("Event:", event.event, event.payload);
});
```

### Client-Side Example (Python)

```python
import psycopg2
import select

conn = psycopg2.connect(dsn)
conn.set_isolation_level(psycopg2.extensions.ISOLATION_LEVEL_AUTOCOMMIT)
curs = conn.cursor()
curs.execute("LISTEN pgflow_events;")

while True:
    if select.select([conn], [], [], 5) != ([], [], []):
        conn.poll()
        while conn.notifies:
            notify = conn.notifies.pop(0)
            print(f"Got: {notify.payload}")
```

---

## Performance Considerations

### Indexing

pgflow creates indexes on:

- `runs.flow_slug`, `runs.status`
- `step_states.flow_slug`, `step_states.(run_id, status, remaining_deps)`
- `step_tasks.flow_slug`, `step_tasks.message_id`, `step_tasks.(run_id, step_slug)`
- `workers.queue_name`, `workers.last_heartbeat_at`

**Custom indexes**: Add as needed for your query patterns.

### Queue Performance

- **pgmq message archival**: Completed/failed tasks are archived (moved to archive table)
- **Vacuum**: Regularly vacuum pgmq tables to reclaim space
- **Partitioning**: For high-throughput, consider partitioning `step_tasks` by `queued_at`

### Scalability

- **Horizontal scaling**: Run multiple workers polling the same queue
- **Vertical scaling**: Increase worker batch size (`qty` parameter)
- **Queue separation**: Use separate flows for different workload priorities

---

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

-- Active runs by status
SELECT status, count(*) FROM pgflow.runs GROUP BY status;

-- Failed steps in last hour
SELECT flow_slug, step_slug, count(*) AS failures
FROM pgflow.step_states
WHERE status = 'failed' AND failed_at > now() - interval '1 hour'
GROUP BY flow_slug, step_slug
ORDER BY failures DESC;

-- Worker health (stale heartbeats)
SELECT worker_id, queue_name, last_heartbeat_at,
       now() - last_heartbeat_at AS staleness
FROM pgflow.workers
WHERE stopped_at IS NULL
  AND last_heartbeat_at < now() - interval '5 minutes'
ORDER BY staleness DESC;

-- Queue depth per flow
SELECT queue_name, count(*) AS pending_tasks
FROM pgmq.q_*  -- Adjust based on your queue names
GROUP BY queue_name;
```

---

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

### Tasks Stuck in 'queued' Status

**Symptoms**: Tasks remain queued, never transition to 'started'

**Causes**:

1. No workers polling the queue
2. Workers crashed/stopped
3. Message visibility timeout too short

**Diagnosis**:

```sql
-- Check for active workers
SELECT * FROM pgflow.workers WHERE queue_name = 'my_flow' AND stopped_at IS NULL;

-- Check stale heartbeats
SELECT worker_id, last_heartbeat_at, now() - last_heartbeat_at AS staleness
FROM pgflow.workers
WHERE queue_name = 'my_flow' AND stopped_at IS NULL;

-- Check message visibility in pgmq
SELECT msg_id, vt, read_ct FROM pgmq.q_my_flow ORDER BY msg_id;
```

**Solutions**:

- Start workers
- Restart crashed workers
- Increase visibility timeout if workers are slow

### Tasks Stuck in 'started' Status

**Symptoms**: Tasks transition to 'started' but never complete/fail

**Causes**:

1. Worker crashed mid-execution
2. Worker hung (infinite loop, deadlock)
3. Worker never called `complete_task()` or `fail_task()`

**Diagnosis**:

```sql
-- Check started tasks without recent progress
SELECT run_id, step_slug, started_at, last_worker_id,
       now() - started_at AS running_time
FROM pgflow.step_tasks
WHERE status = 'started'
  AND started_at < now() - interval '10 minutes'
ORDER BY started_at;

-- Check associated workers
SELECT w.*
FROM pgflow.step_tasks t
JOIN pgflow.workers w ON w.worker_id = t.last_worker_id
WHERE t.status = 'started';
```

**Solutions**:

- Investigate worker logs for crashes/hangs
- Kill hung workers, restart
- Manually fail tasks: `SELECT pgflow.fail_task(run_id, step_slug, 0, 'Worker timeout')`

### Deadlocks

**Symptoms**: Transactions abort with deadlock errors

**Causes**:

- Multiple workers processing same run (row locks on `runs`, `step_states`)
- Circular lock dependencies

**Solutions**:

- Ensure `start_tasks()` is called before any long-running work
- Minimize transaction duration
- Retry on deadlock (workers should handle transient errors)

### Exponential Backoff Not Working

**Symptoms**: Retries happen immediately

**Diagnosis**:

```sql
SELECT step_slug, attempts_count, error_message,
       queued_at, started_at
FROM pgflow.step_tasks
WHERE run_id = '...'
ORDER BY queued_at;
```

**Check**: Are `attempts_count` incrementing? Is there delay between `queued_at` and `started_at`?

**Cause**: Usually worker polling too frequently or message visibility not being set correctly

### Failed Run Not Failing

**Symptoms**: Run status remains 'started' despite failed steps

**Cause**: pgflow marks run as 'failed' only when a task exhausts retries (status = 'failed')

**Check**:

```sql
SELECT run_id, status, remaining_steps FROM pgflow.runs WHERE run_id = '...';
SELECT step_slug, status FROM pgflow.step_states WHERE run_id = '...';
SELECT step_slug, status, attempts_count FROM pgflow.step_tasks WHERE run_id = '...';
```

**Solution**: Ensure `fail_task()` is called and `attempts_count` reaches `max_attempts`

---

## Examples

### Example 1: Simple Linear Workflow

```sql
-- Define workflow
SELECT * FROM pgflow.create_flow('email_report', 3, 5, 120);
SELECT * FROM pgflow.add_step('email_report', 'generate_report');
SELECT * FROM pgflow.add_step('email_report', 'send_email', ARRAY['generate_report']);

-- Start run
SELECT * FROM pgflow.start_flow('email_report', '{"recipient": "user@example.com"}'::jsonb);

-- Worker processes 'generate_report'
-- (Polls queue, starts task, executes, completes)
SELECT * FROM pgflow.complete_task(
  run_id := '...',
  step_slug := 'generate_report',
  task_index := 0,
  output := '{"report_url": "https://example.com/report.pdf"}'::jsonb
);

-- Worker processes 'send_email'
-- (Receives input with report_url from generate_report)
SELECT * FROM pgflow.complete_task(
  run_id := '...',
  step_slug := 'send_email',
  task_index := 0,
  output := '{"email_sent": true, "message_id": "abc123"}'::jsonb
);

-- Check final status
SELECT status, output FROM pgflow.runs WHERE run_id = '...';
-- status: 'completed'
-- output: {"send_email": {"email_sent": true, "message_id": "abc123"}}
```

### Example 2: Workflow with Parallel Steps

```sql
-- Define workflow with parallel processing
SELECT * FROM pgflow.create_flow('image_processing', 3, 2, 300);
SELECT * FROM pgflow.add_step('image_processing', 'upload_image');
SELECT * FROM pgflow.add_step('image_processing', 'create_thumbnail', ARRAY['upload_image']);
SELECT * FROM pgflow.add_step('image_processing', 'extract_metadata', ARRAY['upload_image']);
SELECT * FROM pgflow.add_step('image_processing', 'classify_image', ARRAY['upload_image']);
SELECT * FROM pgflow.add_step('image_processing', 'store_results',
  ARRAY['create_thumbnail', 'extract_metadata', 'classify_image']);

-- Start run
SELECT * FROM pgflow.start_flow('image_processing',
  '{"image_url": "https://example.com/photo.jpg"}'::jsonb);

-- Worker 1 completes upload
SELECT * FROM pgflow.complete_task(..., 'upload_image', 0,
  '{"stored_path": "/images/photo.jpg", "size": 2048576}'::jsonb);

-- Workers 2, 3, 4 process in parallel
-- (create_thumbnail, extract_metadata, classify_image all start immediately)

-- All parallel steps complete
SELECT * FROM pgflow.complete_task(..., 'create_thumbnail', 0,
  '{"thumbnail_url": "/thumbs/photo.jpg"}'::jsonb);
SELECT * FROM pgflow.complete_task(..., 'extract_metadata', 0,
  '{"width": 1920, "height": 1080, "exif": {...}}'::jsonb);
SELECT * FROM pgflow.complete_task(..., 'classify_image', 0,
  '{"labels": ["outdoor", "sunset", "beach"]}'::jsonb);

-- store_results receives all outputs
-- Input: {
--   "run": {"image_url": "..."},
--   "upload_image": {"stored_path": "...", "size": ...},
--   "create_thumbnail": {"thumbnail_url": "..."},
--   "extract_metadata": {"width": ..., "height": ..., "exif": ...},
--   "classify_image": {"labels": [...]}
-- }
SELECT * FROM pgflow.complete_task(..., 'store_results', 0,
  '{"record_id": 42, "indexed": true}'::jsonb);
```

### Example 3: Error Handling with Retry

```sql
-- Create flow with generous retry settings
SELECT * FROM pgflow.create_flow('api_sync', 5, 1, 30);
SELECT * FROM pgflow.add_step('api_sync', 'fetch_data');

-- Start run
SELECT * FROM pgflow.start_flow('api_sync', '{"endpoint": "/api/users"}'::jsonb);

-- Worker attempts 1: Network timeout
SELECT * FROM pgflow.fail_task(..., 'fetch_data', 0, 'Connection timeout');
-- Task status: 'queued', attempts_count: 1, retry in 1s

-- Worker attempts 2: Rate limit
SELECT * FROM pgflow.fail_task(..., 'fetch_data', 0, 'HTTP 429 Too Many Requests');
-- Task status: 'queued', attempts_count: 2, retry in 2s

-- Worker attempts 3: Success!
SELECT * FROM pgflow.complete_task(..., 'fetch_data', 0,
  '{"users": [...], "count": 150}'::jsonb);
-- Task status: 'completed', attempts_count: 3
```

---

## Limitations

### Current Version (v0.8.1)

The following features have limited support or workarounds:

#### Missing Features

1. **Map Steps (Phases 9-11)**
   - Parallel processing of array elements
   - Dynamic task count based on input array length
   - Use case: Process 1000 records in parallel

2. **opt_start_delay (Phase 7)**
   - Delay step execution after dependencies complete
   - Use case: Rate limiting, scheduled execution

3. **Optimized Batch Operations (Phase 4)**
   - `set_vt_batch()` for bulk visibility timeout updates
   - Minor performance optimization

4. **Realtime Events (Phase 5)**
   - Supabase Edge Function integration
   - Live event broadcasting to clients
   - **Status**: Implemented via PostgreSQL pg_notify (LISTEN/NOTIFY)

5. **Worker Deprecation Field (Phase 8)**
   - `deprecated_at` column in workers table
   - Minor schema change

#### Workarounds

**Map steps**: Implement at application level:

```sql
-- Instead of map step, create dynamic steps programmatically
DO $$
DECLARE
  item jsonb;
BEGIN
  FOR item IN SELECT * FROM jsonb_array_elements('[...]'::jsonb)
  LOOP
    PERFORM pgflow.add_step('my_flow', 'process_' || (item->>'id'), ...);
  END LOOP;
END $$;
```

**opt_start_delay**: Use pg_cron or application-level scheduling

**Realtime events**: Use `LISTEN pgflow_events` or `LISTEN <topic>` for pg_notify events

### General Limitations

1. **Single task per step**: v0.8.1 only supports `task_index = 0`
2. **No cancellation**: No built-in workflow cancellation (must implement manually)
3. **No pause/resume**: Workflows cannot be paused
4. **No workflow versioning**: Schema changes affect all runs
5. **No distributed locking**: Use advisory locks if needed

---

## Schema Update Process

This section documents how to update the pgflow test schema and verify compatibility with aza-pg.

### Architecture Change (v0.8.1)

**Important**: As of v0.8.1, pgflow is NO LONGER bundled in the Docker image.

| Before               | After                    |
| -------------------- | ------------------------ |
| Bundled in initdb.d  | Per-project installation |
| Auto-installed       | Manual installation      |
| Single shared schema | Isolated per database    |

### Test Schema Location

The pgflow schema is maintained in test fixtures for validation:

```
tests/fixtures/pgflow/
├── schema-v0.8.1.sql   # Combined schema for testing
├── install.ts          # Installation helper
└── README.md           # Update instructions
```

### Update Workflow

#### 1. Check for New pgflow Version

```bash
# Check npm for latest version
npm view @pgflow/dsl version
npm view @pgflow/client version

# Or check GitHub releases
open https://github.com/pgflow-dev/pgflow/releases
```

#### 2. Download Schema Files

pgflow uses 21 numbered SQL files in `pkgs/core/schemas/`:

```bash
VERSION="0.9.0"  # Update to target version
BASE_URL="https://raw.githubusercontent.com/pgflow-dev/pgflow/pgflow%40${VERSION}/pkgs/core/schemas"

# Create combined schema
echo "-- pgflow v${VERSION} Schema" > tests/fixtures/pgflow/schema-v${VERSION}.sql
echo "-- Source: https://github.com/pgflow-dev/pgflow/tree/pgflow@${VERSION}/pkgs/core/schemas/" >> tests/fixtures/pgflow/schema-v${VERSION}.sql

FILES=(
  0010_extensions.sql
  0020_schemas.sql
  0030_utilities.sql
  0040_types.sql
  0050_tables_definitions.sql
  0055_tables_workers.sql
  0060_tables_runtime.sql
  0090_function_poll_for_tasks.sql
  0100_function_add_step.sql
  0100_function_cascade_complete_taskless_steps.sql
  0100_function_complete_task.sql
  0100_function_create_flow.sql
  0100_function_fail_task.sql
  0100_function_maybe_complete_run.sql
  0100_function_start_flow.sql
  0100_function_start_ready_steps.sql
  0105_function_get_run_with_states.sql
  0110_function_set_vt_batch.sql
  0110_function_start_flow_with_states.sql
  0120_function_start_tasks.sql
  0200_grants_and_revokes.sql
)

for file in "${FILES[@]}"; do
  echo -e "\n-- ============================================================================" >> tests/fixtures/pgflow/schema-v${VERSION}.sql
  echo "-- Source: ${file}" >> tests/fixtures/pgflow/schema-v${VERSION}.sql
  echo -e "-- ============================================================================\n" >> tests/fixtures/pgflow/schema-v${VERSION}.sql
  curl -sS "${BASE_URL}/${file}" >> tests/fixtures/pgflow/schema-v${VERSION}.sql
done
```

#### 3. Update References

Update these files:

1. **`tests/fixtures/pgflow/install.ts`**:
   - Update `PGFLOW_VERSION` constant
   - Update schema file path if version changed

2. **`scripts/extensions/manifest-data.ts`**:
   - Update `tag: "pgflow@X.Y.Z"`

3. **`examples/pgflow/10-pgflow.sql`**:
   - Copy new schema for documentation

4. **npm packages** (if using):
   ```bash
   bun add -d @pgflow/dsl@X.Y.Z @pgflow/client@X.Y.Z
   ```

#### 4. Run Tests

```bash
# Validate schema completeness
bun scripts/test/test-pgflow-schema.ts --image=aza-pg:latest

# Full functional tests
bun scripts/test/test-pgflow-v081.ts --image=aza-pg:latest

# Multi-project isolation
bun scripts/test/test-pgflow-multiproject.ts --image=aza-pg:latest
```

#### 5. Update Documentation

- `docs/PGFLOW.md` - Version compatibility table
- `tests/fixtures/pgflow/README.md` - Schema file list

#### 6. Commit Changes

```bash
git add tests/fixtures/pgflow/ scripts/extensions/manifest-data.ts examples/pgflow/
git commit -m "feat(pgflow): update test schema to v${VERSION}

Update pgflow test fixtures to v${VERSION}.

Changes:
- Download and combine 21 schema files from pgflow@${VERSION}
- Update manifest version reference
- Verify all tests pass

Source: https://github.com/pgflow-dev/pgflow/releases/tag/pgflow@${VERSION}

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Breaking Changes Log

#### v0.8.0 → v0.8.1

- Fixed Supabase CLI version requirement (2.50.3+)
- No schema changes

#### v0.7.x → v0.8.0

- **BREAKING**: Requires pgmq 1.5.0+ (was 1.4.x)
- **BREAKING**: Requires PostgreSQL 17+ (was 14+)
- Added `step_type` column for map steps
- Added `task_index` for parallel processing
- Removed deprecated `read_with_poll()` function

### Maintenance Notes

**Last Updated**: 2025-11-26
**Current Version**: v0.8.1
**Schema Location**: `tests/fixtures/pgflow/schema-v0.8.1.sql`

---

## Resources

- [pgflow Documentation](https://pgflow.dev)
- [pgflow GitHub](https://github.com/pgflow-dev/pgflow)
- [pgflow Schemas](https://github.com/pgflow-dev/pgflow/tree/main/pkgs/core/schemas)
- [@pgflow/dsl on npm](https://www.npmjs.com/package/@pgflow/dsl)
- [@pgflow/client on npm](https://www.npmjs.com/package/@pgflow/client)
- [pgmq Documentation](https://github.com/pgmq/pgmq#readme)
- [PostgreSQL LISTEN/NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)
- [Extension Catalog](EXTENSIONS.md)
- [aza-pg Architecture](ARCHITECTURE.md)
