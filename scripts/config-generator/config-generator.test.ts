/**
 * The generated healthcheck parses as bash and checks each extension it was given, under the preload
 * library it needs. What each tier does is exercised against a running container by the image tests.
 *
 * Usage: bun test scripts/config-generator/config-generator.test.ts
 */

import { test, expect, describe } from "bun:test";
import { generateHealthcheckScript } from "./healthcheck-generator";
import type { ManifestEntry } from "../extensions/manifest-data";

const entry = (name: string, runtime?: ManifestEntry["runtime"]): ManifestEntry => ({
  name,
  kind: "extension",
  category: "test",
  description: name,
  source: { type: "builtin" },
  runtime,
});
const extensions = [
  entry("postgis"),
  entry("timescaledb", { sharedPreload: true, defaultEnable: true }),
  entry("pg_safeupdate", { sharedPreload: true, preloadLibraryName: "safeupdate" }),
];

const assignments = (script: string) =>
  script.split("\n").filter((line) => line.startsWith("EXPECTED_EXTENSIONS="));

describe("generateHealthcheckScript", () => {
  test("output parses as bash", () => {
    const script = generateHealthcheckScript(extensions);
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

  test("pairs each extension with the library it loads under, empty when it needs no preload", () => {
    // A wrong library name would skip the extension's check, or demand one the operator left out.
    expect(assignments(generateHealthcheckScript(extensions))).toEqual([
      'EXPECTED_EXTENSIONS=("postgis:" "timescaledb:timescaledb" "pg_safeupdate:safeupdate")',
    ]);
  });
});
