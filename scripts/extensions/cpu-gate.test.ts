/**
 * CPU gate for extensions with x86CpuFlags (scripts/extensions/cpu-gate.ts).
 *
 * The shell function is taken from the generated entrypoint, so these cases run the code the image
 * ships rather than a copy of it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateHealthcheckScript } from "../config-generator/healthcheck-generator";
import { generateExtensionsInitScript } from "../config-generator/sql-generator";
import { generateCpuGatedExtensions } from "../docker/generate-entrypoint";
import { cpuGatedShareDir, requiredX86Flags } from "./cpu-gate";
import { MANIFEST_ENTRIES, MANIFEST_METADATA, type ManifestEntry } from "./manifest-data";

const ENTRYPOINT = join(import.meta.dir, "../../docker/postgres/docker-auto-config-entrypoint.sh");
const entrypoint = await Bun.file(ENTRYPOINT).text();
const gateFunction = entrypoint.match(
  /^cpu_gated_extension_control_path\(\) \{\n[\s\S]*?\n\}\n/m
)?.[0];

const fixtures = mkdtempSync(join(tmpdir(), "aza-cpu-gate-"));
afterAll(() => rmSync(fixtures, { recursive: true, force: true }));

// Real /proc/cpuinfo layout: "flags<TAB><TAB>: ..." on x86, "Features<TAB>: ..." on aarch64.
async function cpuinfo(name: string, line: string): Promise<string> {
  const path = join(fixtures, name);
  await Bun.write(
    path,
    `processor\t: 0\nvendor_id\t: GenuineIntel\n${line}\nbogomips\t: 4800.00\n`
  );
  return path;
}

const GATED = [
  "vectorscale|avx2 fma|/share/cpu-gated/vectorscale",
  "other|sse4_2|/share/cpu-gated/other",
].join("\n");

function gate(cpuinfoPath: string, machine: string, gated = GATED) {
  if (!gateFunction)
    throw new Error(`cpu_gated_extension_control_path() not found in ${ENTRYPOINT}`);
  const proc = Bun.spawnSync(
    [
      "bash",
      "-c",
      `set -euo pipefail\n${gateFunction}\ncpu_gated_extension_control_path "$1" "$2"`,
      "gate",
      cpuinfoPath,
      machine,
    ],
    { stdin: new TextEncoder().encode(gated), stdout: "pipe", stderr: "pipe" }
  );
  return {
    exitCode: proc.exitCode,
    path: proc.stdout.toString().trim(),
    log: proc.stderr.toString(),
  };
}

describe("entrypoint cpu_gated_extension_control_path", () => {
  test("x86 CPU with every flag gets each gated directory", async () => {
    const result = gate(await cpuinfo("full", "flags\t\t: fpu sse4_2 avx avx2 fma bmi2"), "x86_64");
    expect(result).toEqual({
      exitCode: 0,
      path: "$system:/share/cpu-gated/vectorscale:/share/cpu-gated/other",
      log: "",
    });
  });

  test("x86 CPU missing one flag hides only that extension and names the flag", async () => {
    const result = gate(await cpuinfo("nofma", "flags\t\t: fpu sse4_2 avx avx2 bmi2"), "x86_64");
    expect(result.exitCode).toBe(0);
    expect(result.path).toBe("$system:/share/cpu-gated/other");
    expect(result.log).toBe(
      "[POSTGRES] [AUTO-CONFIG] vectorscale unavailable: this CPU lacks fma\n"
    );
  });

  test("a flag that merely contains the required name does not satisfy it", async () => {
    const result = gate(await cpuinfo("avx512", "flags\t\t: sse4_2 avx512f avx2x fma"), "x86_64");
    expect(result.path).toBe("$system:/share/cpu-gated/other");
    expect(result.log).toContain("lacks avx2");
  });

  test("x86 cpuinfo without a flags line hides every gated extension", async () => {
    const result = gate(await cpuinfo("noflags", "model name\t: unknown"), "x86_64");
    expect(result.exitCode).toBe(0);
    expect(result.path).toBe("$system");
    expect(result.log).toContain("vectorscale unavailable: this CPU lacks avx2 fma");
  });

  test("unreadable cpuinfo on x86 hides every gated extension instead of aborting", () => {
    const result = gate(join(fixtures, "missing"), "x86_64");
    expect(result.exitCode).toBe(0);
    expect(result.path).toBe("$system");
  });

  test("non-x86 machines skip the check: x86CpuFlags describe the amd64 binary only", async () => {
    const result = gate(await cpuinfo("arm", "Features\t: fp asimd aes crc32"), "aarch64");
    expect(result).toEqual({
      exitCode: 0,
      path: "$system:/share/cpu-gated/vectorscale:/share/cpu-gated/other",
      log: "",
    });
  });

  test("no gated extensions leaves only $system", async () => {
    const result = gate(await cpuinfo("none", "flags\t\t: fpu"), "x86_64", "");
    expect(result).toEqual({ exitCode: 0, path: "$system", log: "" });
  });

  test("the entrypoint passes the result to postgres", () => {
    expect(entrypoint).toContain('-c "extension_control_path=${EXTENSION_CONTROL_PATH}"');
  });
});

describe("manifest wiring", () => {
  const pgMajor = MANIFEST_METADATA.pgVersion.split(".")[0] ?? "";
  const gatedEntries = MANIFEST_ENTRIES.filter(
    (e) => e.enabled !== false && requiredX86Flags(e).length > 0
  );

  test("the generated entrypoint lists every enabled gated entry with its share directory", () => {
    const expected = gatedEntries.map(
      (e) => `${e.name}|${requiredX86Flags(e).join(" ")}|${cpuGatedShareDir(pgMajor, e.name)}`
    );
    expect(generateCpuGatedExtensions({ entries: MANIFEST_ENTRIES }, pgMajor).split("\n")).toEqual(
      expected
    );
    expect(entrypoint).toContain(`readonly CPU_GATED_EXTENSIONS="${expected.join("\n")}"`);
  });

  test("requiredX86Flags refuses anything that is not a cpuinfo flag name", () => {
    expect(() => requiredX86Flags({ name: "x", x86CpuFlags: ["avx2", "fma;rm -rf /"] })).toThrow(
      'x: x86CpuFlags entry "fma;rm -rf /"'
    );
    expect(() => requiredX86Flags({ name: "x", x86CpuFlags: ["avx2|fma"] })).toThrow();
  });
});

describe("initdb and healthcheck treat an unavailable gated extension as skipped", () => {
  const entry = (name: string, extra: Partial<ManifestEntry> = {}): ManifestEntry => ({
    name,
    kind: "extension",
    category: "test",
    description: name,
    source: { type: "builtin" },
    ...extra,
  });
  const entries = [entry("plain"), entry("gated", { x86CpuFlags: ["avx2", "fma"] })];

  test("SQL creates the gated extension only when pg_available_extensions lists it", async () => {
    const sql = await generateExtensionsInitScript(entries);
    const gatedBlock = sql.slice(
      sql.indexOf("IF NOT EXISTS (SELECT 1 FROM pg_available_extensions")
    );
    expect(gatedBlock).toStartWith(
      "IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'gated') THEN"
    );
    expect(gatedBlock.indexOf("array_remove(v_expected_exts, 'gated')")).toBeLessThan(
      gatedBlock.indexOf('CREATE EXTENSION IF NOT EXISTS "gated"')
    );
    // Only the gated entry is conditional; anything else missing must still fail initialisation.
    expect(sql.match(/pg_available_extensions/g)).toHaveLength(1);
    expect(sql).toContain("expected_extensions = v_expected_exts");
  });

  test("healthcheck lists only gated entries as CPU-dependent", () => {
    const script = generateHealthcheckScript(entries, "");
    expect(script).toContain('CPU_GATED_EXTENSIONS=("gated")');
    expect(script).toContain('EXPECTED_EXTENSIONS=("plain" "gated")');
  });
});
