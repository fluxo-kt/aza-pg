/**
 * pgflow Schema Installation Helper
 *
 * Provides utilities for installing the pgflow v0.8.1 schema into PostgreSQL databases.
 * Used for testing pgflow functionality without bundling it in the Docker image.
 *
 * NOTE: pgflow v0.8.1 integrates with Supabase Realtime. For non-Supabase deployments,
 * this helper creates a pg_notify-based replacement for `realtime.send()` that uses
 * PostgreSQL's native LISTEN/NOTIFY mechanism for event broadcasting.
 *
 * Clients can subscribe to events using:
 *   LISTEN pgflow_events;  -- All pgflow events
 *   LISTEN <topic>;        -- Specific workflow/topic events
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = join(__dirname, "schema-v0.8.1.sql");

/**
 * SQL to create a pg_notify-based replacement for Supabase Realtime.
 * pgflow v0.8.1 calls realtime.send() for event broadcasting.
 *
 * This implementation uses PostgreSQL's native LISTEN/NOTIFY mechanism
 * to provide real-time event broadcasting without Supabase dependencies.
 *
 * Usage (client-side):
 *   LISTEN pgflow_events;  -- Subscribe to all pgflow events
 *   LISTEN my_workflow;    -- Subscribe to a specific topic
 *
 * Events are delivered as JSON with structure:
 *   { "payload": {...}, "event": "step:completed", "topic": "..." }
 */
const REALTIME_STUB_SQL = `
-- Create realtime schema if not exists (pg_notify-based for non-Supabase deployments)
CREATE SCHEMA IF NOT EXISTS realtime;

-- Create pg_notify-based send function that matches Supabase Realtime signature
-- Uses PostgreSQL's native LISTEN/NOTIFY for pub/sub event broadcasting
CREATE OR REPLACE FUNCTION realtime.send(
  payload jsonb,
  event text,
  topic text,
  private boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- Broadcast event using PostgreSQL native NOTIFY
  -- Clients can subscribe using: LISTEN <topic>;
  -- Events are delivered as JSON payloads
  PERFORM pg_notify(
    topic,
    jsonb_build_object(
      'payload', payload,
      'event', event,
      'topic', topic,
      'timestamp', extract(epoch from now())
    )::text
  );

  -- Also broadcast to a global pgflow_events channel for centralized monitoring
  PERFORM pg_notify(
    'pgflow_events',
    jsonb_build_object(
      'payload', payload,
      'event', event,
      'topic', topic,
      'timestamp', extract(epoch from now())
    )::text
  );
END;
$$;

COMMENT ON FUNCTION realtime.send IS 'pg_notify-based event broadcaster for pgflow v0.8.1 (non-Supabase deployments)';
`;

export interface InstallResult {
  success: boolean;
  stdout: string;
  stderr: string;
  tablesCreated?: number;
  functionsCreated?: number;
}

/**
 * Install pgflow schema into a PostgreSQL database via Docker container.
 * Automatically creates a no-op realtime.send() stub for non-Supabase deployments.
 */
export async function installPgflowSchema(
  container: string,
  database: string = "postgres",
  user: string = "postgres"
): Promise<InstallResult> {
  try {
    // Step 1: Install realtime stub (required for pgflow v0.8.1)
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
export const PGFLOW_VERSION = "0.8.1";
