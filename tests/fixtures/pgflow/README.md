# pgflow Test Fixtures

This directory contains the pgflow SQL schema for testing purposes.

## Contents

- `schema-v0.9.0.sql` - Complete pgflow schema (21 combined SQL files)
- `install.ts` - TypeScript helper for installing schema into containers

## Usage

### Install Schema in Test Container

```typescript
import { installPgflowSchema, verifyInstallation } from "./install";

// Install in default postgres database
const result = await installPgflowSchema("my-container");
if (result.success) {
  console.log(
    `Tables: ${result.tablesCreated}, Functions: ${result.functionsCreated}`
  );
}

// Install in specific database
await installPgflowSchema("my-container", "project_db");
```

### Verify Installation

```typescript
import { verifyInstallation, isPgflowInstalled } from "./install";

// Quick check
const installed = await isPgflowInstalled("my-container", "postgres");

// Detailed verification
const stats = await verifyInstallation("my-container", "postgres");
console.log(
  `Tables: ${stats.tables}, Functions: ${stats.functions}, Types: ${stats.types}`
);
```

### Run SQL Queries

```typescript
import { runSQL } from "./install";

const result = await runSQL(
  "my-container",
  "postgres",
  `
  SELECT flow_slug FROM pgflow.flows WHERE flow_slug = 'my_workflow'
`
);
if (result.success) {
  console.log(result.stdout);
}
```

## Schema Source

The schema is combined from 21 individual files in the pgflow repository:
https://github.com/pgflow-dev/pgflow/tree/pgflow@0.9.0/pkgs/core/schemas/

### Files (in order)

1. `0010_extensions.sql` - pgmq extension
2. `0020_schemas.sql` - pgflow schema
3. `0030_utilities.sql` - Utility functions
4. `0040_types.sql` - Custom types
5. `0050_tables_definitions.sql` - Definition tables
6. `0055_tables_workers.sql` - Worker tables
7. `0060_tables_runtime.sql` - Runtime tables
8. `0090_function_poll_for_tasks.sql` - Deprecated poll function
9. `0100_function_*.sql` - Core functions (8 files)
10. `0105_function_get_run_with_states.sql`
11. `0110_function_*.sql` - Batch functions (2 files)
12. `0120_function_start_tasks.sql`
13. `0200_grants_and_revokes.sql` - Security

## Updating Schema

To update to a newer pgflow version:

1. Check latest release: https://github.com/pgflow-dev/pgflow/releases
2. Download schema files from `pkgs/core/schemas/`
3. Combine in lexicographic order with separator comments
4. Update `PGFLOW_VERSION` in `install.ts`
5. Update this README

```bash
# Example download script
VERSION="0.9.0"
BASE_URL="https://raw.githubusercontent.com/pgflow-dev/pgflow/pgflow%40${VERSION}/pkgs/core/schemas"
FILES=(
  0010_extensions.sql
  0020_schemas.sql
  0030_utilities.sql
  0040_types.sql
  0050_tables_definitions.sql
  0055_tables_workers.sql
  0060_tables_runtime.sql
  0090_function_poll_for_tasks.sql
  # ... add all files
  0200_grants_and_revokes.sql
)

echo "-- pgflow v${VERSION} Schema" > schema-v${VERSION}.sql
for file in "${FILES[@]}"; do
  echo -e "\n-- ============================================================================" >> schema-v${VERSION}.sql
  echo "-- Source: ${file}" >> schema-v${VERSION}.sql
  echo -e "-- ============================================================================\n" >> schema-v${VERSION}.sql
  curl -sS "${BASE_URL}/${file}" >> schema-v${VERSION}.sql
done
```

## Expected Counts (v0.9.0)

| Component | Count |
| --------- | ----- |
| Tables    | 7     |
| Functions | 15+   |
| Types     | 1     |

## Supabase Realtime Compatibility

pgflow integrates with Supabase Realtime via `realtime.send()` for event broadcasting. For non-Supabase deployments, the `install.ts` helper automatically creates a **pg_notify-based replacement** that uses PostgreSQL's native LISTEN/NOTIFY mechanism.

### How It Works

Before installing the pgflow schema, the helper creates:

```sql
-- Function signature matches Supabase Realtime
CREATE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean)

-- Implementation uses PostgreSQL native NOTIFY:
PERFORM pg_notify(topic, json_payload);
PERFORM pg_notify('pgflow_events', json_payload);
```

### Subscribing to Events

```sql
-- Subscribe to all pgflow events
LISTEN pgflow_events;

-- Subscribe to specific topic
LISTEN my_workflow;
```

### Event Payload

```json
{
  "payload": { "event_type": "step:completed", "run_id": "...", ... },
  "event": "step:completed",
  "topic": "my_workflow",
  "timestamp": 1700000000.123
}
```

## Dependencies

pgflow requires the `pgmq` extension, which is included in the aza-pg image.
The schema automatically creates the extension if missing.
