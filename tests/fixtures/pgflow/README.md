# pgflow Test Fixtures

This directory contains the pgflow SQL schema for testing purposes.

## Contents

- `schema.sql` - Complete pgflow release schema (generated; do not edit)
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
`https://github.com/pgflow-dev/pgflow/tree/<pgflow tag>/pkgs/core/schemas/`, at the `pgflow` tag in
`scripts/extensions/manifest-data.ts`.

The generator discovers upstream `*.sql` files from the release tag and concatenates them in
lexicographic order.

## Updating Schema

To update to a newer pgflow version:

1. Check latest release: https://github.com/pgflow-dev/pgflow/releases
2. Set the `pgflow` tag in `scripts/extensions/manifest-data.ts` and the `@pgflow/client` / `@pgflow/dsl`
   versions in `package.json` (validate fails while they differ), then `bun run generate && bun install`
3. Run `bun scripts/pgflow/generate-schema.ts`; it fails loudly if a local schema patch no longer matches upstream
4. Review the generated schema, rebuild (`bun run build`: the image copies this directory) and run
   `bun scripts/test-all.ts --group features` (fresh-install and upgrade suites) before committing

## Supabase Realtime Compatibility

pgflow integrates with Supabase Realtime via `realtime.send()` for event broadcasting. For non-Supabase deployments, the image provides a **pg_notify-based replacement** (init script `04a-pgflow-realtime-stub.sh`, installed in `template1` and `POSTGRES_DB`), so every database created later inherits it; `install.ts` ships no copy and refuses a database without it.

### How It Works

The image's replacement:

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
