/**
 * The generated healthcheck parses as bash and checks exactly the extensions and preload libraries it
 * was given. What each tier does is exercised against a running container by the image tests.
 *
 * Usage: bun test scripts/config-generator/config-generator.test.ts
 */

import { test, expect, describe } from "bun:test";
import { generateHealthcheckScript } from "./healthcheck-generator";
import type { ManifestEntry } from "../extensions/manifest-data";

const extensions: ManifestEntry[] = ["postgis", "pg_stat_statements", "timescaledb"].map(
  (name) => ({
    name,
    kind: "extension",
    category: "test",
    description: name,
    source: { type: "builtin" },
  })
);
const preload = "auto_explain,pg_cron,pg_stat_statements,timescaledb";

const assignments = (script: string) =>
  script
    .split("\n")
    .filter((line) => /^(EXPECTED_EXTENSIONS|EXPECTED_COUNT|EXPECTED_PRELOAD)=/.test(line));

describe("generateHealthcheckScript", () => {
  test("output parses as bash", () => {
    const script = generateHealthcheckScript(extensions, preload);
    expect(script).toStartWith("#!/bin/bash");
    expect(script).toContain("set -euo pipefail");
    // bash -n parses without executing, so it catches syntax errors and nothing else
    const parse = Bun.spawnSync(["bash", "-n"], {
      stdin: new TextEncoder().encode(script),
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(parse.stderr.toString()).toBe("");
    expect(parse.exitCode).toBe(0);
  });

  test("expects exactly the given extensions and preload list", () => {
    expect(assignments(generateHealthcheckScript(extensions, preload))).toEqual([
      'EXPECTED_EXTENSIONS=("postgis" "pg_stat_statements" "timescaledb")',
      "EXPECTED_COUNT=3",
      `EXPECTED_PRELOAD="${preload}"`,
    ]);
  });

  test("no extensions expects none", () => {
    expect(assignments(generateHealthcheckScript([], "auto_explain"))).toEqual([
      "EXPECTED_EXTENSIONS=()",
      "EXPECTED_COUNT=0",
      'EXPECTED_PRELOAD="auto_explain"',
    ]);
  });
});
