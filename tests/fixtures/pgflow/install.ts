/**
 * pgflow Schema Installation Helper
 *
 * Provides utilities for installing the pgflow schema into PostgreSQL databases.
 * Used for testing pgflow functionality without bundling it in the Docker image.
 *
 * NOTE: pgflow integrates with Supabase Realtime. For non-Supabase deployments,
 * this helper creates a multi-layer replacement for `realtime.send()` that provides:
 *
 * 1. **pg_notify** (immediate): Fire-and-forget notifications via LISTEN/NOTIFY
 *    - Best for: Same-database listeners, low-latency requirements
 *    - Clients subscribe using: LISTEN pgflow_events; or LISTEN <topic>;
 *
 * 2. **pgmq** (reliable): At-least-once delivery via message queue
 *    - Best for: Backend workers needing guaranteed delivery with retries
 *    - Enable: SET realtime.pgmq_enabled = 'true'; (auto-creates queue if needed)
 *    - Poll: SELECT * FROM pgmq.read('pgflow_events', 30, 10);
 *
 * 3. **pg_net** (external webhooks): Async HTTP POST to external services
 *    - Best for: External service integration, webhooks
 *    - Enable: SET realtime.webhook_url = 'https://api.example.com/webhook';
 *    - Requires: pg_net extension with shared_preload_libraries
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = join(__dirname, "schema-v0.11.0.sql");

/**
 * SQL to create a multi-layer replacement for Supabase Realtime.
 * pgflow calls realtime.send() for event broadcasting.
 *
 * This implementation provides three delivery mechanisms:
 *
 * 1. pg_notify (always): Immediate, at-most-once delivery via LISTEN/NOTIFY
 *    - LISTEN pgflow_events; or LISTEN <topic>;
 *
 * 2. pgmq (optional): Reliable, at-least-once delivery via message queue
 *    - Enable: SET realtime.pgmq_enabled = 'true';
 *    - Poll: SELECT * FROM pgmq.read('pgflow_events', 30, 10);
 *
 * 3. pg_net (optional): Async HTTP webhooks to external services
 *    - Enable: SET realtime.webhook_url = 'https://...';
 *
 * Events are delivered as JSON with structure:
 *   { "payload": {...}, "event": "step:completed", "topic": "...", "timestamp": ... }
 */
const REALTIME_STUB_SQL = `
-- Create realtime schema if not exists (multi-layer for non-Supabase deployments)
CREATE SCHEMA IF NOT EXISTS realtime;

-- Configuration settings for delivery mechanisms
-- These can be set per-session or globally via ALTER SYSTEM
DO $$
BEGIN
  -- pgmq_enabled: 'true' to enable reliable queue delivery (default: false)
  PERFORM set_config('realtime.pgmq_enabled', 'false', false);
  -- webhook_url: URL for pg_net HTTP webhook delivery (default: empty = disabled)
  PERFORM set_config('realtime.webhook_url', '', false);
EXCEPTION WHEN OTHERS THEN
  -- Ignore if settings already exist
  NULL;
END $$;

-- Helper function to ensure pgmq queue exists (idempotent)
CREATE OR REPLACE FUNCTION realtime._ensure_pgmq_queue(queue_name text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- Check if pgmq extension is available
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgmq') THEN
    -- Create queue if it doesn't exist (pgmq.create returns 1 if created, 0 if exists)
    BEGIN
      PERFORM pgmq.create(queue_name);
    EXCEPTION WHEN duplicate_object THEN
      -- Queue already exists, ignore
      NULL;
    END;
  END IF;
END;
$$;

-- Helper function to check if pg_net is available
CREATE OR REPLACE FUNCTION realtime._pg_net_available()
RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net');
END;
$$;

-- Multi-layer send function that matches Supabase Realtime signature
-- Provides pg_notify (immediate) + pgmq (reliable) + pg_net (webhooks)
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
  pgmq_enabled boolean;
  webhook_url text;
BEGIN
  -- Build the event message
  message_json := jsonb_build_object(
    'payload', payload,
    'event', event,
    'topic', topic,
    'timestamp', extract(epoch from now()),
    'private', private
  );

  ------------------------------------------------------------------
  -- Layer 1: pg_notify (always enabled) - immediate, at-most-once
  ------------------------------------------------------------------
  -- Broadcast to topic-specific channel
  PERFORM pg_notify(
    topic,
    message_json::text
  );

  -- Also broadcast to global pgflow_events channel for centralized monitoring
  PERFORM pg_notify(
    'pgflow_events',
    message_json::text
  );

  ------------------------------------------------------------------
  -- Layer 2: pgmq (optional) - reliable, at-least-once
  ------------------------------------------------------------------
  pgmq_enabled := COALESCE(current_setting('realtime.pgmq_enabled', true), 'false') = 'true';

  IF pgmq_enabled AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgmq') THEN
    -- Ensure queue exists
    PERFORM realtime._ensure_pgmq_queue('pgflow_events');

    -- Send message to queue for reliable delivery
    PERFORM pgmq.send('pgflow_events', message_json);
  END IF;

  ------------------------------------------------------------------
  -- Layer 3: pg_net (optional) - async HTTP webhooks
  ------------------------------------------------------------------
  webhook_url := COALESCE(current_setting('realtime.webhook_url', true), '');

  IF webhook_url != '' AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    -- Send async HTTP POST to webhook URL
    PERFORM net.http_post(
      url := webhook_url,
      body := message_json,
      headers := '{"Content-Type": "application/json"}'::jsonb
    );
  END IF;
END;
$$;

COMMENT ON FUNCTION realtime.send IS 'Multi-layer event broadcaster for pgflow: pg_notify (immediate) + pgmq (reliable) + pg_net (webhooks)';
COMMENT ON FUNCTION realtime._ensure_pgmq_queue IS 'Helper to idempotently create pgmq queue';
COMMENT ON FUNCTION realtime._pg_net_available IS 'Check if pg_net extension is available';
`;

/**
 * Install only the realtime stub (idempotent).
 * Use this to ensure realtime.send() exists even when pgflow schema is already installed.
 */
export async function installRealtimeStub(
  container: string,
  database: string = "postgres",
  user: string = "postgres"
): Promise<{ success: boolean; stderr: string }> {
  const proc = Bun.spawn(
    [
      "docker",
      "exec",
      "-i",
      "-u",
      user,
      container,
      "psql",
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
  );
  proc.stdin.write(REALTIME_STUB_SQL);
  proc.stdin.end();

  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  return {
    success: exitCode === 0,
    stderr: stderr.trim(),
  };
}

export interface InstallResult {
  success: boolean;
  stdout: string;
  stderr: string;
  tablesCreated?: number;
  functionsCreated?: number;
}

/**
 * Install pgflow schema into a PostgreSQL database via Docker container.
 * Automatically creates a pg_notify-based realtime.send() for non-Supabase deployments.
 */
export async function installPgflowSchema(
  container: string,
  database: string = "postgres",
  user: string = "postgres"
): Promise<InstallResult> {
  try {
    // CHECK FIRST: If already installed, return early with existing counts
    if (await isPgflowInstalled(container, database, user)) {
      const verification = await verifyInstallation(container, database, user);
      return {
        success: true,
        stdout: "",
        stderr: "",
        tablesCreated: verification.tables,
        functionsCreated: verification.functions,
      };
    }

    // Step 1: Install realtime stub (required for pgflow)
    const stubProc = Bun.spawn(
      [
        "docker",
        "exec",
        "-i",
        "-u",
        user,
        container,
        "psql",
        "-d",
        database,
        "-v",
        "ON_ERROR_STOP=1",
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
    );
    stubProc.stdin.write(REALTIME_STUB_SQL);
    stubProc.stdin.end();

    const stubExitCode = await stubProc.exited;
    if (stubExitCode !== 0) {
      const stubStderr = await new Response(stubProc.stderr).text();
      return {
        success: false,
        stdout: "",
        stderr: `Failed to install realtime stub: ${stubStderr.trim()}`,
      };
    }

    // Step 2: Read and install pgflow schema
    const schemaContent = await Bun.file(SCHEMA_FILE).text();

    const proc = Bun.spawn(
      [
        "docker",
        "exec",
        "-i",
        "-u",
        user,
        container,
        "psql",
        "-d",
        database,
        "-v",
        "ON_ERROR_STOP=1",
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
    );

    proc.stdin.write(schemaContent);
    proc.stdin.end();

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      return {
        success: false,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      };
    }

    // Verify installation
    const verification = await verifyInstallation(container, database, user);

    return {
      success: true,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      tablesCreated: verification.tables,
      functionsCreated: verification.functions,
    };
  } catch (error) {
    return {
      success: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Verify pgflow schema installation
 */
export async function verifyInstallation(
  container: string,
  database: string = "postgres",
  user: string = "postgres"
): Promise<{ tables: number; functions: number; types: number }> {
  const queries = {
    tables: `SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'pgflow'`,
    functions: `SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'pgflow'`,
    types: `SELECT COUNT(*) FROM pg_type t JOIN pg_namespace n ON t.typnamespace = n.oid WHERE n.nspname = 'pgflow' AND t.typtype = 'c'`,
  };

  const results: { tables: number; functions: number; types: number } = {
    tables: 0,
    functions: 0,
    types: 0,
  };

  for (const [key, sql] of Object.entries(queries)) {
    const proc = Bun.spawn(
      [
        "docker",
        "exec",
        "-i",
        "-u",
        user,
        container,
        "psql",
        "-d",
        database,
        "-t",
        "-A",
        "-c",
        sql,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      const output = await new Response(proc.stdout).text();
      results[key as keyof typeof results] = parseInt(output.trim(), 10) || 0;
    }
  }

  return results;
}

/**
 * Check if pgflow schema exists in database
 */
export async function isPgflowInstalled(
  container: string,
  database: string = "postgres",
  user: string = "postgres"
): Promise<boolean> {
  const sql = `SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = 'pgflow')`;
  const proc = Bun.spawn(
    ["docker", "exec", "-i", "-u", user, container, "psql", "-d", database, "-t", "-A", "-c", sql],
    { stdout: "pipe", stderr: "pipe" }
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) return false;

  const output = await new Response(proc.stdout).text();
  return output.trim() === "t";
}

/**
 * Create a new database in the container
 */
export async function createDatabase(
  container: string,
  database: string,
  user: string = "postgres"
): Promise<boolean> {
  const sql = `CREATE DATABASE "${database}"`;
  const proc = Bun.spawn(
    ["docker", "exec", "-i", "-u", user, container, "psql", "-d", "postgres", "-c", sql],
    { stdout: "pipe", stderr: "pipe" }
  );
  const exitCode = await proc.exited;
  return exitCode === 0;
}

/**
 * Drop a database in the container
 */
export async function dropDatabase(
  container: string,
  database: string,
  user: string = "postgres"
): Promise<boolean> {
  const sql = `DROP DATABASE IF EXISTS "${database}"`;
  const proc = Bun.spawn(
    ["docker", "exec", "-i", "-u", user, container, "psql", "-d", "postgres", "-c", sql],
    { stdout: "pipe", stderr: "pipe" }
  );
  const exitCode = await proc.exited;
  return exitCode === 0;
}

/**
 * Run arbitrary SQL in a database
 */
export async function runSQL(
  container: string,
  database: string,
  sql: string,
  user: string = "postgres"
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    ["docker", "exec", "-i", "-u", user, container, "psql", "-d", database, "-t", "-A"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
  );

  proc.stdin.write(sql);
  proc.stdin.end();

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  return {
    success: exitCode === 0,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

// Export schema file path for direct access if needed
export const PGFLOW_SCHEMA_PATH = SCHEMA_FILE;
export const PGFLOW_VERSION = "0.11.0";
