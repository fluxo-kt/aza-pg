#!/usr/bin/env bun
/**
 * What 01-extensions.sql (generateExtensionsInitScript) creates, in what order, and the script version
 * the healthcheck reads back. The SQL text itself is exercised against real PostgreSQL by the image tests.
 *
 * Usage: bun test scripts/config-generator/sql-generator.test.ts
 */

import { describe, test, expect } from "bun:test";
import { generateExtensionsInitScript } from "./sql-generator";
import type { ManifestEntry } from "../extensions/manifest-data";

function entry(name: string, fields: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    name,
    kind: "extension",
    category: "test",
    description: name,
    source: { type: "builtin" },
    ...fields,
  };
}

const created = (sql: string): string[] =>
  [...sql.matchAll(/CREATE EXTENSION IF NOT EXISTS "([^"]+)"/g)].map((m) => m[1] ?? "");

function expected(sql: string): string[] {
  const array = /v_expected_exts TEXT\[\] := ARRAY\[([^\]]*)\]/.exec(sql)?.[1];
  if (array === undefined) throw new Error("v_expected_exts declaration not found");
  return [...array.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? "");
}

function scriptVersion(sql: string): string {
  const version = /VALUES \('([^']+)'/.exec(sql)?.[1];
  if (version === undefined) throw new Error("script_version not found");
  return version;
}

describe("generateExtensionsInitScript", () => {
  test("every entry is created exactly once and expected by the healthcheck", async () => {
    const names = Array.from({ length: 50 }, (_, i) => `ext_${i}`);
    const sql = await generateExtensionsInitScript(names.map((n) => entry(n)));
    expect(created(sql)).toEqual(names);
    expect(expected(sql)).toEqual(names);
  });

  test("no entries creates nothing", async () => {
    const sql = await generateExtensionsInitScript([]);
    expect(created(sql)).toEqual([]);
    expect(expected(sql)).toEqual([]);
  });

  test("pg_cron is left to 01b-pg_cron.sh: neither created nor expected here", async () => {
    // pg_cron can only be created in cron.database_name (POSTGRES_DB), which this script does not target.
    const sql = await generateExtensionsInitScript([
      entry("pg_stat_statements"),
      entry("pg_cron"),
      entry("postgis"),
    ]);
    expect(created(sql)).toEqual(["pg_stat_statements", "postgis"]);
    expect(expected(sql)).toEqual(["pg_stat_statements", "postgis"]);
  });

  test("dependencies are created before their dependents, whatever the input order", async () => {
    const sql = await generateExtensionsInitScript([
      entry("vectorscale", { dependencies: ["vector"] }),
      entry("chain_top", { dependencies: ["chain_mid"] }),
      entry("vector"),
      entry("chain_mid", { dependencies: ["chain_base"] }),
      entry("chain_base"),
      entry("needs_absent", { dependencies: ["plpgsql"] }), // a dependency outside the list is not created
    ]);
    expect(created(sql)).toEqual([
      "vector",
      "vectorscale",
      "chain_base",
      "chain_mid",
      "chain_top",
      "needs_absent",
    ]);
  });

  test("a dependency cycle fails generation instead of emitting a broken order", async () => {
    await expect(
      generateExtensionsInitScript([
        entry("a", { dependencies: ["b"] }),
        entry("b", { dependencies: ["a"] }),
      ])
    ).rejects.toThrow("Circular dependency");
  });

  test("script version depends on the extension set only, not its order", async () => {
    const version = async (names: string[]) =>
      scriptVersion(await generateExtensionsInitScript(names.map((n) => entry(n))));
    const base = await version(["a", "b", "c"]);
    expect(await version(["c", "a", "b"])).toBe(base);
    expect(await version(["a", "b"])).not.toBe(base);
    expect(await version(["a", "b", "d"])).not.toBe(base);
  });
});
