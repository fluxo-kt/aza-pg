import { describe, expect, test } from "bun:test";

const SCHEMA_PATH = "tests/fixtures/pgflow/schema.sql";
const SECURITY_PATCHES_PATH = "docker/postgres/pgflow/security-patches.sql";

async function readSchema(): Promise<string> {
  return await Bun.file(SCHEMA_PATH).text();
}

function matches(pattern: RegExp, input: string): string[] {
  return [...input.matchAll(pattern)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
}

interface FunctionDefinition {
  /** Argument list and return type, lower-cased with whitespace collapsed. */
  signature: string;
  /** Every clause outside the signature and the body (LANGUAGE, SECURITY DEFINER, SET ...), normalised. */
  clauses: string;
  /** The dollar-quoted body, byte for byte. */
  body: string;
}

const normalise = (text: string): string =>
  text
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * Every `CREATE OR REPLACE FUNCTION pgflow.<name> (...) ... AS $$ body $$ ...;` in `sql`, keyed by name. Upstream
 * writes LANGUAGE/SECURITY DEFINER after the body and the patch file before it, so clauses from both sides are pooled.
 */
function functionDefinitions(sql: string): Map<string, FunctionDefinition[]> {
  const pattern =
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+pgflow\.([a-z_][a-z0-9_]*)\s*(\([^)]*\)\s*returns\s+\S+)([\s\S]*?)\bAS\s+\$\$([\s\S]*?)\$\$([^;]*);/gi;
  const definitions = new Map<string, FunctionDefinition[]>();
  for (const [, name, signature, before, body, after] of sql.matchAll(pattern)) {
    if (!name || signature === undefined || body === undefined) continue;
    const list = definitions.get(name) ?? [];
    list.push({
      signature: normalise(signature),
      clauses: normalise(`${before ?? ""} ${after ?? ""}`),
      body,
    });
    definitions.set(name, list);
  }
  return definitions;
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

  test("does not include volatile generation metadata", async () => {
    const schema = await readSchema();

    expect(schema).not.toContain("-- Generated at:");
  });

  // security-patches.sql re-creates upstream functions to add SET search_path. If a pgflow bump changes an upstream
  // body, the patch would silently install the old body over the new one; this fails instead.
  test("security patches equal upstream functions apart from the added search_path", async () => {
    const patches = await Bun.file(SECURITY_PATCHES_PATH).text();
    const patched = functionDefinitions(patches);
    // The parser must see every function the patch file creates, or the comparison below would skip it.
    const declared = patches.match(/CREATE\s+OR\s+REPLACE\s+FUNCTION/gi)?.length ?? 0;
    expect(declared).toBeGreaterThan(0);
    expect([...patched.values()].flat().length).toBe(declared);

    const upstream = functionDefinitions(await readSchema());
    for (const [name, [patch, ...extraPatches]] of patched) {
      expect(extraPatches, `${name} patched more than once`).toEqual([]);
      const [original, ...extraOriginals] = upstream.get(name) ?? [];
      expect(original, `${name} is not defined upstream`).toBeDefined();
      expect(extraOriginals, `${name} defined more than once upstream`).toEqual([]);
      if (!patch || !original) continue;

      expect(patch.body, `${name} body`).toBe(original.body);
      expect(patch.signature, `${name} signature`).toBe(original.signature);
      const added = /\bset search_path = ''/;
      expect(patch.clauses, `${name} must SET search_path = ''`).toMatch(added);
      const clauseSet = (clauses: string) =>
        clauses.replace(added, " ").split(" ").filter(Boolean).sort().join(" ");
      expect(clauseSet(patch.clauses), `${name} clauses besides search_path`).toBe(
        clauseSet(original.clauses)
      );
    }
  });
});
