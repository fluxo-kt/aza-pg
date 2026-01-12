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
PG_NET_READY=$(psql -U postgres -d "$TARGET_DB" -t -c "SELECT count(*) FROM pg_available_extensions WHERE name = 'pg_net'" | tr -d ' ')
if [ "$PG_NET_READY" != "1" ]; then
    echo "[04a-realtime-stub] Skipping: pg_net not available (pgflow prerequisites not met)"
    exit 0
fi

echo "[04a-realtime-stub] Creating realtime.send() stub for pgflow..."

psql -U postgres -d "$TARGET_DB" <<'EOSQL'
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
      NULL;
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
EOSQL

echo "[04a-realtime-stub] ✅ realtime.send() stub created successfully"
