/**
 * pgflow Schema Installation Helper
 *
 * Installs the repository's pgflow schema fixture into a database of a running aza-pg container.
 *
 * pgflow broadcasts events through realtime.send(). The image creates its own implementation in template1 and in
 * POSTGRES_DB at initdb (docker-entrypoint-initdb.d/04a-pgflow-realtime-stub.sh), so every database created later
 * inherits it. This helper deliberately ships no copy of that function: a test copy would make every pgflow run
 * exercise the copy instead of the function the image ships. A target database without realtime.send() is refused.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = join(__dirname, "schema.sql");

export interface InstallResult {
  success: boolean;
  stdout: string;
  stderr: string;
  tablesCreated?: number;
  functionsCreated?: number;
}

/**
 * Get the configured cron.database_name setting from PostgreSQL.
 * pg_cron can only be created in the database matching this setting.
 */
async function getCronDatabaseName(
  container: string,
  user: string = "postgres"
): Promise<string | null> {
  const sql = `SELECT current_setting('cron.database_name', true)`;
  const result = await runSQL(container, "postgres", sql, user);
  if (!result.success || !result.stdout.trim()) {
    return null;
  }
  return result.stdout.trim();
}

/**
 * Check if a specific extension exists in a database.
 */
async function checkExtension(
  container: string,
  database: string,
  extname: string,
  user: string = "postgres"
): Promise<boolean> {
  const sql = `SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = '${extname}')`;
  const result = await runSQL(container, database, sql, user);
  return result.success && result.stdout.trim() === "t";
}

/**
 * Install pgflow schema into a PostgreSQL database via Docker container.
 * The database must already have the image's realtime.send() (see the module comment).
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

    // Step 1: pgflow calls realtime.send(); the image provides it (inherited from template1), this helper does not.
    const realtime = await runSQL(
      container,
      database,
      "SELECT to_regprocedure('realtime.send(jsonb,text,text,boolean)') IS NOT NULL",
      user
    );
    if (!realtime.success || realtime.stdout !== "t") {
      return {
        success: false,
        stdout: "",
        stderr: `realtime.send() is missing in database '${database}': create it from template1 of an aza-pg image (${realtime.stderr})`,
      };
    }

    // Step 2: Read and prepare pgflow schema
    let schemaContent = await Bun.file(SCHEMA_FILE).text();

    // Step 2a: Handle pg_cron database mismatch (defensive layer)
    // pg_cron can ONLY be created in database matching cron.database_name
    const cronDB = await getCronDatabaseName(container, user);

    if (cronDB && database !== cronDB) {
      // Target database differs from cron.database_name
      // Filter out pg_cron creation line to prevent error
      const originalContent = schemaContent;
      schemaContent = schemaContent.replace(
        /CREATE EXTENSION\s+if\s+NOT\s+EXISTS\s+pg_cron;?\s*/gi,
        `-- pg_cron exists in database '${cronDB}' (cron.database_name)\n`
      );

      // Verify pg_cron exists where expected
      const cronExists = await checkExtension(container, cronDB, "pg_cron", user);
      if (!cronExists) {
        return {
          success: false,
          stdout: "",
          stderr: `pgflow requires pg_cron extension, but it was not found in configured database '${cronDB}' (cron.database_name). Please ensure pg_cron is installed.`,
        };
      }

      // Log filtering for diagnostics
      if (originalContent !== schemaContent) {
        console.warn(
          `[pgflow] Filtered pg_cron from schema (target: ${database}, cron.database_name: ${cronDB})`
        );
      }
    }

    // Step 3: Install prepared schema
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

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

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
      { stdout: "pipe", stderr: "ignore" }
    );
    const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode === 0) {
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
    { stdout: "pipe", stderr: "ignore" }
  );
  const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) return false;

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
    { stdout: "ignore", stderr: "ignore" }
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
    { stdout: "ignore", stderr: "ignore" }
  );
  const exitCode = await proc.exited;
  return exitCode === 0;
}

/**
 * Run SQL (one or more statements, one session) in a database.
 * ON_ERROR_STOP makes psql exit non-zero on the first SQL error; without it psql exits 0 after a failed statement and
 * `success` could never report bad SQL. -q drops command tags (SET, CREATE ...) so stdout holds only query rows.
 */
export async function runSQL(
  container: string,
  database: string,
  sql: string,
  user: string = "postgres"
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    [
      "docker",
      "exec",
      "-i",
      "-u",
      user,
      container,
      "psql",
      "-X",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-d",
      database,
      "-t",
      "-A",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
  );

  proc.stdin.write(sql);
  proc.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {
    success: exitCode === 0,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

// Export schema file path for direct access if needed
export const PGFLOW_SCHEMA_PATH = SCHEMA_FILE;
export { PGFLOW_VERSION } from "../../../scripts/pgflow/version";
