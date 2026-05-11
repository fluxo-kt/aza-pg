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
});
