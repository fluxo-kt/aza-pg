# pgflow Test Fixtures

This directory contains the pgflow SQL schema for testing purposes.

## Contents

- `schema-v0.14.1.sql` - Complete pgflow release schema
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

The schema is combined from the release-tagged SQL files in the pgflow repository:
https://github.com/pgflow-dev/pgflow/tree/pgflow@0.14.1/pkgs/core/schemas/

The generator discovers upstream `*.sql` files from the release tag and concatenates them in
lexicographic order.

## Updating Schema

To update to a newer pgflow version:

1. Check latest release: https://github.com/pgflow-dev/pgflow/releases
2. Run `bun scripts/pgflow/generate-schema.ts <version> --update-install`
3. Review the generated schema and delete the old schema fixture
4. Run pgflow tests before committing
5. Update this README if the fixture workflow changes

```bash
bun scripts/pgflow/generate-schema.ts 0.14.1 --update-install
```

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
