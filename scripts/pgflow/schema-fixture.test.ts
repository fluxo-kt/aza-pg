import { describe, expect, test } from "bun:test";

const SCHEMA_PATH = "tests/fixtures/pgflow/schema-v0.14.1.sql";

async function readSchema(): Promise<string> {
  return await Bun.file(SCHEMA_PATH).text();
}

function matches(pattern: RegExp, input: string): string[] {
  return [...input.matchAll(pattern)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
}

function schemaSection(schema: string, startMarker: string, endMarker: string): string {
  const start = schema.indexOf(startMarker);
  const end = schema.indexOf(endMarker, start);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return schema.slice(start, end);
}

describe("pgflow schema fixture", () => {
  test("defines every pgflow function it calls", async () => {
    const schema = await readSchema();
    const definitions = new Set(
      matches(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+pgflow\.([a-z_][a-z0-9_]*)\s*\(/gi, schema)
    );
    const relationNames = new Set(
      matches(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+pgflow\.([a-z_][a-z0-9_]*)\s*\(/gi, schema)
    );
    const calls = new Set(matches(/\bpgflow\.([a-z_][a-z0-9_]*)\s*\(/gi, schema));
    const missing = [...calls]
      .filter((name) => !definitions.has(name) && !relationNames.has(name))
      .sort();

    expect(missing).toEqual([]);
  });

  test("includes 0.14 condition and worker schema files", async () => {
    const schema = await readSchema();
    const requiredSources = [
      "0056_table_worker_functions.sql",
      "0100_function__cascade_force_skip_steps.sql",
      "0100_function_archive_task_message.sql",
      "0100_function_cascade_resolve_conditions.sql",
      "0100_function_ensure_flow_compiled.sql",
    ];

    for (const source of requiredSources) {
      expect(schema).toContain(`-- Source: ${source}`);
    }
  });

  test("ensure_workers installs without binding to Supabase Vault tables", async () => {
    const schema = await readSchema();
    const ensureWorkersSource = schemaSection(
      schema,
      "-- Source: 0059_function_ensure_workers.sql",
      "-- Source: 0060_function_cleanup_ensure_workers_logs.sql"
    );
    const ensureWorkersFunction = schemaSection(
      schema,
      "CREATE OR REPLACE FUNCTION pgflow.ensure_workers",
      "-- Source: 0060_function_cleanup_ensure_workers_logs.sql"
    );

    expect(ensureWorkersSource).toContain("CREATE OR REPLACE FUNCTION pgflow.aza_vault_secret");
    expect(ensureWorkersSource).toContain("to_regclass('vault.decrypted_secrets') IS NULL");
    expect(ensureWorkersFunction).toContain("pgflow.aza_vault_secret('pgflow_auth_secret')");
    expect(ensureWorkersFunction).toContain("pgflow.aza_vault_secret('supabase_project_id')");
    expect(ensureWorkersFunction).not.toContain("vault.decrypted_secrets");
  });

  test("cleanup log function installs when pg_cron lives in another database", async () => {
    const schema = await readSchema();
    const cleanupSection = schemaSection(
      schema,
      "-- Source: 0060_function_cleanup_ensure_workers_logs.sql",
      "-- Source: 0060_tables_runtime.sql"
    );

    expect(cleanupSection).toContain("language plpgsql security definer");
    expect(cleanupSection).toContain("to_regclass('cron.job_run_details') IS NULL");
    expect(cleanupSection).toContain("RETURN QUERY SELECT 0::BIGINT");
    expect(cleanupSection).toContain("make_interval(hours => $1)");
    expect(cleanupSection).not.toContain("search_path = pgflow,\n  cron,\n  pg_temp");
  });

  test("cron setup functions skip scheduling without local pg_cron", async () => {
    const schema = await readSchema();
    const ensureWorkersSection = schemaSection(
      schema,
      "-- Source: 0061_function_setup_ensure_workers_cron.sql",
      "-- Source: 0062_function_requeue_stalled_tasks.sql"
    );
    const requeueSection = schemaSection(
      schema,
      "-- Source: 0063_function_setup_requeue_stalled_tasks_cron.sql",
      "-- Source: 0090_function_poll_for_tasks.sql"
    );

    for (const section of [ensureWorkersSection, requeueSection]) {
      expect(section).toContain("to_regprocedure('cron.schedule(text,text,text)') IS NULL");
      expect(section).toContain("pg_cron is not available in this database; skipped pgflow");
      expect(section).not.toContain("search_path = pgflow,\n  cron,\n  pg_temp");
    }
  });
});
