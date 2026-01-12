#!/bin/bash
# pgflow Realtime Stub - Create before pgflow schema installation
# This must run BEFORE 05-pgflow-init.sh (alphabetical order: 04a < 05)
#
# Context: pgflow is designed for Supabase and uses realtime.send() for event broadcasting.
# Since aza-pg is a custom Postgres build (not Supabase), we provide a compatibility stub
# that uses PostgreSQL native features instead of Supabase Realtime.
#
# Our stub uses a multi-layer approach:
# - Layer 1: pg_notify() - immediate LISTEN/NOTIFY (always)
# - Layer 2: pgmq - reliable queue delivery (optional, if enabled)
# - Layer 3: pg_net - HTTP webhooks (optional, if webhook URL configured)

set -euo pipefail

TARGET_DB="${POSTGRES_DB:-postgres}"

# Only run if pgflow will be installed (check dependencies)
PG_NET_READY=$(psql -v ON_ERROR_STOP=1 -U postgres -d "$TARGET_DB" -t -c "SELECT count(*) FROM pg_available_extensions WHERE name = 'pg_net'" | tr -d ' ')
if [ "$PG_NET_READY" != "1" ]; then
    echo "[04a-realtime-stub] Skipping: pg_net not available (pgflow prerequisites not met)"
    exit 0
fi

echo "[04a-realtime-stub] Creating realtime.send() stub for pgflow..."

# Extract SQL to shared variable to avoid duplication
read -r -d '' REALTIME_STUB_SQL <<'EOSQL' || true
-- Create realtime schema if not exists
CREATE SCHEMA IF NOT EXISTS realtime;

-- Multi-layer event broadcaster for pgflow
-- Replaces Supabase Realtime with PostgreSQL native features
CREATE OR REPLACE FUNCTION realtime.send(
  payload jsonb,
  event text,
  topic text,
  private boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  message_json jsonb;
BEGIN
  -- Build event message
  message_json := jsonb_build_object(
    'payload', payload,
    'event', event,
    'topic', topic,
    'timestamp', extract(epoch from now()),
    'private', private
  );

  -- Layer 1: pg_notify (always) - immediate LISTEN/NOTIFY
  -- Clients can LISTEN to specific topics or 'pgflow_events' for all events
  PERFORM pg_notify(topic, message_json::text);
  PERFORM pg_notify('pgflow_events', message_json::text);

  -- Layer 2: pgmq (optional) - reliable queue delivery
  -- Enabled via: ALTER SYSTEM SET realtime.pgmq_enabled = 'true';
  IF COALESCE(current_setting('realtime.pgmq_enabled', true), 'false') = 'true'
     AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgmq') THEN
    -- Ensure queue exists (idempotent)
    BEGIN
      PERFORM pgmq.create('pgflow_events');
    EXCEPTION WHEN duplicate_object THEN
      RAISE NOTICE 'Queue "pgflow_events" already exists, skipping creation';
    END;
    PERFORM pgmq.send('pgflow_events', message_json);
  END IF;

  -- Layer 3: pg_net (optional) - HTTP webhooks
  -- Enabled via: ALTER SYSTEM SET realtime.webhook_url = 'https://your-webhook-url';
  IF COALESCE(current_setting('realtime.webhook_url', true), '') != ''
     AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    PERFORM net.http_post(
      url := current_setting('realtime.webhook_url'),
      body := message_json,
      headers := '{"Content-Type": "application/json"}'::jsonb
    );
  END IF;
END;
$$;

COMMENT ON FUNCTION realtime.send IS 'pgflow event broadcaster: pg_notify + optional pgmq/pg_net (aza-pg Supabase compatibility stub)';

-- SECURITY: Prevent SSRF attacks via webhook_url manipulation
-- Only trusted roles (postgres, application roles) should execute this function
REVOKE EXECUTE ON FUNCTION realtime.send(jsonb, text, text, boolean) FROM PUBLIC;
-- Grant to postgres superuser by default (other roles must be explicitly granted)
GRANT EXECUTE ON FUNCTION realtime.send(jsonb, text, text, boolean) TO postgres;
EOSQL

# Install in template1 first so all NEW databases inherit it
echo "[04a-realtime-stub] Installing realtime.send() in template1 (for new databases)..."
psql -v ON_ERROR_STOP=1 -U postgres -d template1 <<<"$REALTIME_STUB_SQL"

# Now install in the initial database as well
echo "[04a-realtime-stub] Installing realtime.send() in initial database ($TARGET_DB)..."
psql -v ON_ERROR_STOP=1 -U postgres -d "$TARGET_DB" <<<"$REALTIME_STUB_SQL"

echo "[04a-realtime-stub] ✅ realtime.send() stub created in template1 and $TARGET_DB (EXECUTE revoked from PUBLIC for security)"
