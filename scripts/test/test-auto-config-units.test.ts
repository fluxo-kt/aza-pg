/**
 * Auto-config formulas, run as the shipped bash: functions and the worker-count block are cut out of the generated
 * entrypoint and executed, so a changed formula there fails here — a TypeScript copy of the formulas would not.
 *
 * Covers what the Docker suite (test-auto-config.ts) does not reach cheaply: tier edges, caps, and the
 * POSTGRES_MEMORY / POSTGRES_MAX_WORKER_PROCESSES limits. Only code that runs in bash 3.2 is cut out, because macOS
 * ships bash 3.2 and these run in `bun run validate` there; max_connections and the workload/storage tables need
 * bash 4 associative arrays and are covered by the Docker suite's dry-run rows instead.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ENTRYPOINT = join(import.meta.dir, "../../docker/postgres/docker-auto-config-entrypoint.sh");
const source = await Bun.file(ENTRYPOINT).text();

function cut(pattern: RegExp, what: string): string {
  const found = source.match(pattern)?.[0];
  if (!found) throw new Error(`${what} not found in ${ENTRYPOINT}`);
  return found;
}

const fn = (name: string) =>
  cut(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, "m"), `${name}()`);

// Numeric constants the functions read (SHARED_BUFFERS_CAP_MB, OS_RESERVE_MB, ...).
const constants = (source.match(/^readonly [A-Z_]+=("?)[0-9.]+\1$/gm) ?? []).join("\n");

// The top-level block deriving worker and parallel-worker counts from CPU_CORES.
const workerBlockStart = source.search(/^if \[ "\$CPU_CORES" -le 4 \]; then$/m);
const workerBlockEnd = source.indexOf(
  "\nfi\n",
  source.indexOf("MAX_PARALLEL_MAINTENANCE_WORKERS=1")
);
if (workerBlockStart < 0 || workerBlockEnd < workerBlockStart) {
  throw new Error(`worker-count block not found in ${ENTRYPOINT}`);
}
const workerBlock = source.slice(workerBlockStart, workerBlockEnd + 4);

const shipped = [
  constants,
  fn("detect_ram"),
  fn("get_workload_type"),
  fn("calculate_shared_buffers"),
  fn("calculate_maintenance_work_mem"),
  fn("calculate_work_mem"),
  fn("calculate_wal_buffers"),
  fn("calculate_io_workers"),
  fn("conf_quote"),
].join("\n");

/** Runs `snippet` after the shipped code with only `env` set; returns stdout, stderr and the exit code. */
function bash(snippet: string, env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(["bash", "-c", `set -euo pipefail\n${shipped}\n${snippet}`], {
    env: { PATH: Bun.env.PATH ?? "/usr/bin:/bin", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    out: proc.stdout.toString().trim(),
    err: proc.stderr.toString().trim(),
    code: proc.exitCode,
  };
}

function value(fnName: string, env: Record<string, string>): string {
  const result = bash(fnName, env);
  if (result.code !== 0) throw new Error(`${fnName} exited ${result.code}: ${result.err}`);
  return result.out;
}

describe("shared_buffers tiers: 25% up to 8 GB, 20% up to 32 GB, 15% above, capped at 32 GB", () => {
  test.each([
    [8192, "2048"],
    [8193, "1638"],
    [32768, "6553"],
    [32769, "4915"],
    [262144, "32768"],
  ])("%d MB RAM → %s MB", (ram, expected) => {
    expect(value("calculate_shared_buffers", { TOTAL_RAM_MB: String(ram) })).toBe(expected);
  });
});

describe("maintenance_work_mem: 1/16 of RAM (dw 1/8), floor 32 MB, cap 2048 MB", () => {
  test.each([
    [512, "mixed", "32"],
    [4096, "dw", "512"],
    [4096, "web", "256"],
    [32768, "oltp", "2048"],
    [65536, "dw", "2048"],
  ])("%d MB %s → %s MB", (ram, workload, expected) => {
    expect(
      value("calculate_maintenance_work_mem", {
        TOTAL_RAM_MB: String(ram),
        POSTGRES_WORKLOAD_TYPE: workload,
      })
    ).toBe(expected);
  });
});

describe("work_mem caps at the sizes where they bind (inputs are the shipped tier values)", () => {
  // [RAM, shared_buffers, max_connections, workload, expected]
  test.each([
    [196608, 29491, 120, "mixed", "256"], // (196608−29491−1200−512)/480 = 344 → 256 cap at ≥32 GB
    [196608, 29491, 100, "dw", "256"],
    [196608, 29491, 200, "web", "32"], // 205 → web/oltp cap 32
    [196608, 29491, 300, "oltp", "32"],
    [512, 128, 60, "mixed", "1"], // pool floor 256 / 240 = 1
  ])("%d MB, sb %d, %d conns, %s → %s MB", (ram, sb, conns, workload, expected) => {
    expect(
      value("calculate_work_mem", {
        TOTAL_RAM_MB: String(ram),
        SHARED_BUFFERS_MB: String(sb),
        MAX_CONNECTIONS: String(conns),
        POSTGRES_WORKLOAD_TYPE: workload,
      })
    ).toBe(expected);
  });
});

describe("wal_buffers: 3% of shared_buffers, 1–16 MB, 15 MB rounds up to 16", () => {
  test.each([
    [64, "1"],
    [480, "14"],
    [512, "16"],
    [6553, "16"],
  ])("shared_buffers %d MB → %s MB", (sb, expected) => {
    expect(value("calculate_wal_buffers", { SHARED_BUFFERS_MB: String(sb) })).toBe(expected);
  });
});

describe("io_workers: CPU/4, at least 1", () => {
  test.each([
    [3, "1"],
    [8, "2"],
    [128, "32"],
  ])("%d cores → %s", (cores, expected) => {
    expect(value("calculate_io_workers", { CPU_CORES: String(cores) })).toBe(expected);
  });
});

describe("worker counts from CPU cores", () => {
  const counts = (cores: number, env: Record<string, string> = {}) =>
    value(
      `${workerBlock}\necho "$MAX_WORKER_PROCESSES $MAX_PARALLEL_WORKERS $MAX_PARALLEL_WORKERS_PER_GATHER $MAX_PARALLEL_MAINTENANCE_WORKERS"`,
      { CPU_CORES: String(cores), ...env }
    );

  // "max_worker_processes max_parallel_workers per_gather maintenance"
  test.each([
    [1, "8 1 1 1"], // 1+1 → floor 8; below 4 cores: gather 1, maintenance 1
    [3, "8 3 1 1"],
    [4, "8 4 2 2"],
    [6, "9 6 3 3"], // above 4 cores: CPU×1.5
    [10, "15 10 5 4"], // maintenance capped at 4
    [48, "64 48 24 4"], // 72 → cap 64
  ])("%d cores → %s", (cores, expected) => {
    expect(counts(cores)).toBe(expected);
  });

  test("POSTGRES_MAX_WORKER_PROCESSES replaces the formula but stays within 8–64", () => {
    expect(counts(2, { POSTGRES_MAX_WORKER_PROCESSES: "12" }).split(" ")[0]).toBe("12");
    expect(counts(2, { POSTGRES_MAX_WORKER_PROCESSES: "4" }).split(" ")[0]).toBe("8");
    expect(counts(2, { POSTGRES_MAX_WORKER_PROCESSES: "100" }).split(" ")[0]).toBe("64");
  });
});

describe("POSTGRES_MEMORY is validated before anything is tuned", () => {
  test("a valid value wins over detection", () => {
    expect(bash("detect_ram", { POSTGRES_MEMORY: "1048576" })).toEqual({
      out: "1048576:manual",
      err: "",
      code: 0,
    });
  });

  test.each([
    ["2g", "[POSTGRES] ERROR: POSTGRES_MEMORY must be an integer value in MB"],
    ["0", "[POSTGRES] ERROR: POSTGRES_MEMORY must be a positive integer (MB)"],
    ["1048577", "[POSTGRES] ERROR: POSTGRES_MEMORY exceeds maximum (1TB = 1048576 MB)"],
  ])("%s is refused", (memory, message) => {
    expect(bash("detect_ram", { POSTGRES_MEMORY: memory })).toEqual({
      out: "",
      err: message,
      code: 1,
    });
  });
});

describe("conf_quote writes PostgreSQL config-file string literals", () => {
  test.each([
    ["plain", "'plain'"],
    ["it's", "'it''s'"],
    ["C:\\dir", "'C:\\\\dir'"],
  ])("%s → %s", (input, expected) => {
    expect(bash('conf_quote "$V"', { V: input }).out).toBe(expected);
  });
});
