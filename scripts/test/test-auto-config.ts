#!/usr/bin/env bun
/**
 * Auto-config in the shipped image: what the entrypoint hands PostgreSQL for given container limits, and whether
 * PostgreSQL accepts it.
 *
 * Dry-run table: each row starts the image with real `--memory`/CPU limits (so detection reads the container's own
 * cgroup files) but with /usr/local/bin/docker-entrypoint.sh replaced by a stub that prints its argv and the generated
 * config file, then exits. Rows assert exact `name = 'value'` lines of that file, the startup log line, and the exit
 * code. CPU counts use --cpu-quota rather than --cpus, because Docker refuses --cpus above the host's CPU count but
 * accepts any quota — so the 14-core rows also run on hosts with fewer CPUs.
 *
 * Real boots: two containers start PostgreSQL for real (512 MB / 1 CPU, and the largest dw tier); every generated
 * setting must be in effect from the generated file, so a value PostgreSQL rejects fails the boot and the suite.
 *
 * Usage: bun scripts/test/test-auto-config.ts [image]   (also --image=TAG or POSTGRES_IMAGE; default: the local build)
 */

import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateUniqueProjectName, waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";

const IMAGE = resolveImageTag();
const RUN_ID = generateUniqueProjectName("aza-pg-autoconfig");
const AUTO_CONFIG_FILE = "/var/run/postgresql/aza-auto-config.conf";
const BASE_CONFIG = "/etc/postgresql/postgresql-base.conf";
const IMAGE_ENTRYPOINT = "/usr/local/bin/docker-auto-config-entrypoint.sh";
const DRY_RUN_CONCURRENCY = 8;

interface CaseResult {
  name: string;
  passed: boolean;
  ms: number;
  error?: string;
}
const results: CaseResult[] = [];
const containers = new Set<string>();

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const start = performance.now();
  try {
    await fn();
    const ms = Math.round(performance.now() - start);
    results.push({ name, passed: true, ms });
    console.log(`✅ ${name} (${ms}ms)`);
  } catch (err) {
    const ms = Math.round(performance.now() - start);
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, ms, error: message });
    console.log(`❌ ${name} (${ms}ms)\n   ${message.replaceAll("\n", "\n   ")}`);
  }
}

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

const cpus = (count: number) => ["--cpu-period=100000", `--cpu-quota=${count * 100000}`];

/** Parses `name = 'value'` lines of the generated config file (no value here contains a quote). */
function parseConf(text: string): Map<string, string> {
  const settings = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^([a-z_.]+) = '(.*)'$/);
    if (match) settings.set(match[1]!, match[2]!);
  }
  return settings;
}

interface Row {
  name: string;
  docker: string[];
  env?: Record<string, string>;
  args?: string[];
  exit?: number;
  /** Exact prefix of the summary log line, up to the arrow. */
  detected?: string;
  /** Exact lines expected anywhere in stdout / stderr. */
  stdoutLines?: string[];
  stderrLines?: string[];
  settings?: Record<string, string>;
  argv?: string[];
  include?: string;
}

// Expected values come from the entrypoint's formulas worked by hand (see the inline arithmetic), not from its output.
const ROWS: Row[] = [
  {
    name: "POSTGRES_MEMORY=1536 overrides detection",
    docker: [],
    env: { POSTGRES_MEMORY: "1536" },
    // 1536×25% = 384; mixed 120×50% (<2 GB) = 60; cache floor 2×384 = 768; work_mem pool floor 256/240 = 1
    settings: {
      shared_buffers: "384MB",
      max_connections: "60",
      effective_cache_size: "768MB",
      work_mem: "1MB",
      maintenance_work_mem: "96MB",
    },
  },
  {
    name: "2 GB / 2 CPU cgroup",
    docker: ["--memory=2g", ...cpus(2)],
    detected: "RAM: 2048MB (cgroup-v2), CPU: 2 cores (cgroup-v2), Workload: mixed, Storage: ssd",
    // 120×70% = 84; <4 cores: workers 2+1 → floor 8, gather 1, maintenance 1
    settings: {
      shared_buffers: "512MB",
      max_connections: "84",
      effective_cache_size: "1024MB",
      work_mem: "1MB",
      max_worker_processes: "8",
      max_parallel_workers: "2",
      max_parallel_workers_per_gather: "1",
      max_parallel_maintenance_workers: "1",
      io_workers: "1",
    },
  },
  {
    name: "512 MB cgroup is the accepted minimum",
    docker: ["--memory=512m"],
    detected: "RAM: 512MB (cgroup-v2)",
    // cache: 512−128−512 < 0 → floor 2×128 = 256; wal_buffers 128×3% = 3
    settings: {
      shared_buffers: "128MB",
      max_connections: "60",
      effective_cache_size: "256MB",
      work_mem: "1MB",
      maintenance_work_mem: "32MB",
      wal_buffers: "3MB",
    },
  },
  {
    name: "256 MB cgroup is refused before PostgreSQL starts",
    docker: ["--memory=256m"],
    exit: 1,
    stdoutLines: ["[POSTGRES] FATAL: Detected 256MB RAM - minimum 512MB REQUIRED"],
  },
  {
    name: "POSTGRES_MEMORY=65536 (15% shared_buffers tier)",
    docker: [],
    env: { POSTGRES_MEMORY: "65536" },
    // 65536×15% = 9830; pool 65536−9830−1200−512 = 53994 / 480 = 112 (mixed cap 256)
    settings: {
      shared_buffers: "9830MB",
      max_connections: "120",
      work_mem: "112MB",
      effective_cache_size: "29819MB",
      maintenance_work_mem: "2048MB",
    },
  },
  {
    name: "4 GB cgroup",
    docker: ["--memory=4g"],
    detected: "RAM: 4096MB (cgroup-v2)",
    // 120×85% = 102; pool 4096−1024−1020−512 = 1540 / 408 = 3; cache floor 2×1024
    settings: {
      shared_buffers: "1024MB",
      max_connections: "102",
      work_mem: "3MB",
      effective_cache_size: "2048MB",
      checkpoint_completion_target: "0.9",
    },
  },
  {
    name: "8 GB cgroup, default workload and storage",
    docker: ["--memory=8g"],
    detected: "RAM: 8192MB (cgroup-v2)",
    // pool 8192−2048−1200−512 = 4432 / 480 = 9; wal_buffers 2048×3% = 61 → cap 16
    settings: {
      shared_buffers: "2048MB",
      max_connections: "120",
      work_mem: "9MB",
      effective_cache_size: "4096MB",
      wal_buffers: "16MB",
      min_wal_size: "1024MB",
      max_wal_size: "4096MB",
      default_statistics_target: "100",
      random_page_cost: "1.1",
      maintenance_io_concurrency: "20",
      effective_io_concurrency: "200",
    },
  },
  {
    name: "16 GB cgroup (20% shared_buffers tier)",
    docker: ["--memory=16g"],
    // 16384×20% = 3276; pool 16384−3276−1200−512 = 11396 / 480 = 23; cache (16384−3276−3276)×70% = 6882
    settings: {
      shared_buffers: "3276MB",
      max_connections: "120",
      work_mem: "23MB",
      effective_cache_size: "6882MB",
    },
  },
  {
    name: "1 GB / 1 CPU",
    docker: ["--memory=1g", ...cpus(1)],
    detected: "RAM: 1024MB (cgroup-v2), CPU: 1 cores (cgroup-v2)",
    settings: {
      shared_buffers: "256MB",
      max_connections: "60",
      max_worker_processes: "8",
      max_parallel_workers: "1",
      max_parallel_workers_per_gather: "1",
      max_parallel_maintenance_workers: "1",
      io_workers: "1",
    },
  },
  {
    name: "3 GB / 2 CPU",
    docker: ["--memory=3g", ...cpus(2)],
    // pool 3072−768−840−512 = 952 / 336 = 2
    settings: { shared_buffers: "768MB", max_connections: "84", work_mem: "2MB" },
  },
  {
    name: "6 GB / 4 CPU (parallel workers threshold)",
    docker: ["--memory=6g", ...cpus(4)],
    settings: {
      shared_buffers: "1536MB",
      max_connections: "102",
      max_worker_processes: "8",
      max_parallel_workers: "4",
      max_parallel_workers_per_gather: "2",
      max_parallel_maintenance_workers: "2",
    },
  },
  {
    name: "12 GB / 4 CPU",
    docker: ["--memory=12g", ...cpus(4)],
    settings: { shared_buffers: "2457MB", io_workers: "1" },
  },
  {
    name: "24 GB / 4 CPU",
    docker: ["--memory=24g", ...cpus(4)],
    settings: { shared_buffers: "4915MB", io_workers: "1", max_worker_processes: "8" },
  },
  {
    name: "POSTGRES_MEMORY=32768, dw, 14 CPU",
    docker: cpus(14),
    env: { POSTGRES_MEMORY: "32768", POSTGRES_WORKLOAD_TYPE: "dw" },
    detected: "RAM: 32768MB (manual), CPU: 14 cores (cgroup-v2), Workload: dw, Storage: ssd",
    // pool 32768−6553−1000−512 = 24703 / 400 = 61 (dw cap 256); 32768/8 → cap 2048; workers 14+7 = 21
    settings: {
      max_connections: "100",
      work_mem: "61MB",
      maintenance_work_mem: "2048MB",
      default_statistics_target: "500",
      min_wal_size: "4096MB",
      max_wal_size: "16384MB",
      max_worker_processes: "21",
      max_parallel_workers: "14",
      max_parallel_workers_per_gather: "7",
      max_parallel_maintenance_workers: "4",
      io_workers: "3",
    },
  },
  {
    name: "POSTGRES_MEMORY=131072, 14 CPU",
    docker: cpus(14),
    env: { POSTGRES_MEMORY: "131072" },
    settings: { shared_buffers: "19660MB", io_workers: "3", max_worker_processes: "21" },
  },
  {
    name: "POSTGRES_MEMORY=196608, 14 CPU",
    docker: cpus(14),
    env: { POSTGRES_MEMORY: "196608" },
    settings: { shared_buffers: "29491MB", max_worker_processes: "21" },
  },
  {
    name: "8 GB web",
    docker: ["--memory=8g"],
    env: { POSTGRES_WORKLOAD_TYPE: "web" },
    // pool 8192−2048−2000−512 = 3632 / 800 = 4 (web cap 32)
    settings: {
      max_connections: "200",
      work_mem: "4MB",
      default_statistics_target: "100",
      min_wal_size: "1024MB",
      max_wal_size: "4096MB",
    },
  },
  {
    name: "8 GB oltp",
    docker: ["--memory=8g"],
    env: { POSTGRES_WORKLOAD_TYPE: "oltp" },
    settings: { max_connections: "300", min_wal_size: "2048MB", max_wal_size: "8192MB" },
  },
  {
    name: "16 GB dw",
    docker: ["--memory=16g"],
    env: { POSTGRES_WORKLOAD_TYPE: "dw" },
    settings: {
      max_connections: "100",
      default_statistics_target: "500",
      min_wal_size: "4096MB",
      maintenance_work_mem: "2048MB",
    },
  },
  {
    name: "8 GB hdd",
    docker: ["--memory=8g"],
    env: { POSTGRES_STORAGE_TYPE: "hdd" },
    settings: {
      random_page_cost: "4.0",
      maintenance_io_concurrency: "10",
      effective_io_concurrency: "2",
    },
  },
  {
    name: "8 GB san",
    docker: ["--memory=8g"],
    env: { POSTGRES_STORAGE_TYPE: "san" },
    settings: {
      random_page_cost: "1.1",
      maintenance_io_concurrency: "20",
      effective_io_concurrency: "300",
    },
  },
  {
    name: "16 GB / 14 CPU",
    docker: ["--memory=16g", ...cpus(14)],
    settings: { io_workers: "3", max_parallel_maintenance_workers: "4" },
  },
  {
    name: "4 GB / 4 CPU",
    docker: ["--memory=4g", ...cpus(4)],
    settings: {
      max_parallel_workers: "4",
      max_parallel_workers_per_gather: "2",
      max_parallel_maintenance_workers: "2",
    },
  },
  {
    name: "invalid POSTGRES_WORKLOAD_TYPE falls back to mixed and says so",
    docker: ["--memory=4g"],
    env: { POSTGRES_WORKLOAD_TYPE: "invalid" },
    exit: 0,
    detected: "RAM: 4096MB (cgroup-v2)",
    stderrLines: [
      "[POSTGRES] WARNING: Invalid POSTGRES_WORKLOAD_TYPE='invalid' - defaulting to 'mixed'",
    ],
    settings: { max_connections: "102", min_wal_size: "1024MB" },
  },
  {
    name: "invalid POSTGRES_STORAGE_TYPE falls back to ssd and says so",
    docker: ["--memory=4g"],
    env: { POSTGRES_STORAGE_TYPE: "invalid" },
    exit: 0,
    stderrLines: [
      "[POSTGRES] WARNING: Invalid POSTGRES_STORAGE_TYPE='invalid' - defaulting to 'ssd'",
    ],
    settings: { random_page_cost: "1.1", maintenance_io_concurrency: "20" },
  },
  {
    name: "POSTGRES_MEMORY=32768, dw, san",
    docker: [],
    env: {
      POSTGRES_MEMORY: "32768",
      POSTGRES_WORKLOAD_TYPE: "dw",
      POSTGRES_STORAGE_TYPE: "san",
    },
    settings: {
      max_connections: "100",
      random_page_cost: "1.1",
      maintenance_io_concurrency: "20",
      effective_io_concurrency: "300",
      default_statistics_target: "500",
    },
  },
  {
    name: "1.5 GB cgroup",
    docker: ["--memory=1536m"],
    detected: "RAM: 1536MB (cgroup-v2)",
    settings: { shared_buffers: "384MB", max_connections: "60" },
  },
  {
    name: "512 MB + hdd + web",
    docker: ["--memory=512m"],
    env: { POSTGRES_STORAGE_TYPE: "hdd", POSTGRES_WORKLOAD_TYPE: "web" },
    // web 200×50% = 100
    settings: { shared_buffers: "128MB", random_page_cost: "4.0", max_connections: "100" },
  },
  {
    name: "6 GB + oltp + san + 4 CPU",
    docker: ["--memory=6g", ...cpus(4)],
    env: { POSTGRES_WORKLOAD_TYPE: "oltp", POSTGRES_STORAGE_TYPE: "san" },
    // oltp 300×85% = 255
    settings: {
      shared_buffers: "1536MB",
      max_connections: "255",
      random_page_cost: "1.1",
      max_parallel_workers: "4",
    },
  },
  // Art's ruling: a value the operator sets with -c or ALTER SYSTEM overrides auto-tuning; the log names each override.
  {
    name: "operator -c max_connections=7 follows the generated config_file and is logged",
    docker: ["--memory=2g"],
    args: ["postgres", "-c", "max_connections=7"],
    argv: ["postgres", "-c", `config_file=${AUTO_CONFIG_FILE}`, "-c", "max_connections=7"],
    stdoutLines: ["[POSTGRES] [AUTO-CONFIG] max_connections: -c 7 overrides auto-tuned 84"],
    include: "/var/lib/postgresql/18/docker/postgresql.conf",
  },
  {
    name: "operator --config-file is included, not passed as a second config_file",
    docker: ["--memory=2g"],
    args: ["postgres", "--config-file=/x.conf"],
    argv: ["postgres", "-c", `config_file=${AUTO_CONFIG_FILE}`],
    include: "/x.conf",
  },
];

/** Stub for the official entrypoint: prints its argv, then the config file it was told to use. */
const STUB = [
  "#!/bin/sh",
  'for a in "$@"; do printf \'ARGV %s\\n\' "$a"; done',
  'for a in "$@"; do',
  '  case "$a" in config_file=*) echo "CONFIG ${a#config_file=}"; cat "${a#config_file=}" ;; esac',
  "done",
  "",
].join("\n");

function checkRow(row: Row, result: { code: number; stdout: string; stderr: string }): string[] {
  const failures: string[] = [];
  const expectedExit = row.exit ?? 0;
  if (result.code !== expectedExit) failures.push(`exit ${result.code}, expected ${expectedExit}`);
  const stdoutLines = result.stdout.split("\n");
  const stderrLines = result.stderr.split("\n");
  for (const line of row.stdoutLines ?? []) {
    if (!stdoutLines.includes(line)) failures.push(`stdout lacks line: ${line}`);
  }
  for (const line of row.stderrLines ?? []) {
    if (!stderrLines.includes(line)) failures.push(`stderr lacks line: ${line}`);
  }
  if (row.detected) {
    const prefix = `[POSTGRES] [AUTO-CONFIG] ${row.detected}`;
    if (
      !stdoutLines.some(
        (line) => line.startsWith(prefix) && /^[,→ ]/.test(line.slice(prefix.length))
      )
    ) {
      failures.push(`no summary line starting: ${prefix}`);
    }
  }
  if (expectedExit !== 0) return failures;

  const argv = stdoutLines.filter((l) => l.startsWith("ARGV ")).map((l) => l.slice(5));
  if (argv[0] !== "postgres" || argv[1] !== "-c" || argv[2] !== `config_file=${AUTO_CONFIG_FILE}`) {
    failures.push(
      `stub argv does not start with the generated config_file: ${JSON.stringify(argv)}`
    );
  }
  if (row.argv && JSON.stringify(argv) !== JSON.stringify(row.argv)) {
    failures.push(`argv ${JSON.stringify(argv)}, expected ${JSON.stringify(row.argv)}`);
  }
  const confStart = stdoutLines.indexOf(`CONFIG ${AUTO_CONFIG_FILE}`);
  if (confStart < 0) return [...failures, "stub printed no config file"];
  const confLines = stdoutLines.slice(confStart + 1);
  const includes = confLines.filter((l) => !l.startsWith("#")).slice(0, 2);
  const wantIncludes = [`include '${BASE_CONFIG}'`, `include '${row.include}'`];
  if (row.include && JSON.stringify(includes) !== JSON.stringify(wantIncludes)) {
    failures.push(
      `first setting lines ${JSON.stringify(includes)}, expected ${JSON.stringify(wantIncludes)}`
    );
  }
  const conf = parseConf(confLines.join("\n"));
  for (const [name, value] of Object.entries(row.settings ?? {})) {
    if (conf.get(name) !== value) {
      failures.push(`${name} = ${JSON.stringify(conf.get(name))}, expected '${value}'`);
    }
  }
  return failures;
}

async function dryRun(row: Row, stub: string): Promise<void> {
  const name = `${RUN_ID}-dry-${ROWS.indexOf(row)}`;
  containers.add(name);
  try {
    const env = Object.entries(row.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const result = await run([
      "docker",
      "run",
      "--rm",
      "--name",
      name,
      // tmpfs over the image's PGDATA volume: no anonymous volume to create and copy into, nothing left behind
      "--tmpfs",
      "/var/lib/postgresql",
      "--network",
      "none",
      ...row.docker,
      ...env,
      "-v",
      `${stub}:/usr/local/bin/docker-entrypoint.sh:ro`,
      IMAGE,
      ...(row.args ?? []),
    ]);
    const failures = checkRow(row, result);
    if (failures.length > 0) {
      throw new Error(
        `${failures.join("\n")}\n--- stdout ---\n${result.stdout}--- stderr ---\n${result.stderr}`
      );
    }
  } finally {
    await run(["docker", "rm", "-f", "-v", name]);
    containers.delete(name);
  }
}

async function psql(container: string, sql: string): Promise<string> {
  const result = await run([
    "docker",
    "exec",
    container,
    "psql",
    "-X",
    "-U",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-tAc",
    sql,
  ]);
  if (result.code !== 0) throw new Error(`psql failed (${result.code}): ${result.stderr}`);
  return result.stdout.trim();
}

/** Every setting in the generated file must be in effect from that file: PostgreSQL accepted and applied it. */
async function assertGeneratedSettingsApplied(
  container: string,
  except: string[] = []
): Promise<void> {
  const file = await run(["docker", "exec", container, "cat", AUTO_CONFIG_FILE]);
  if (file.code !== 0) throw new Error(`cannot read ${AUTO_CONFIG_FILE}: ${file.stderr}`);
  const names = [...parseConf(file.stdout).keys()].filter((n) => !except.includes(n));
  if (names.length === 0)
    throw new Error(`no settings parsed from ${AUTO_CONFIG_FILE}:\n${file.stdout}`);
  const list = names.map((n) => `'${n}'`).join(",");
  const rows = await psql(
    container,
    `SELECT n || '|' || coalesce(s.sourcefile, '<' || coalesce(s.source, 'missing') || '>')
       FROM unnest(ARRAY[${list}]) AS n LEFT JOIN pg_settings s ON s.name = n ORDER BY n`
  );
  const wrong = rows.split("\n").filter((line) => !line.endsWith(`|${AUTO_CONFIG_FILE}`));
  if (wrong.length > 0)
    throw new Error(`settings not in effect from ${AUTO_CONFIG_FILE}:\n${wrong.join("\n")}`);
}

async function realBoot(
  suffix: string,
  dockerArgs: string[],
  check: (container: string) => Promise<void>
): Promise<void> {
  const name = `${RUN_ID}-${suffix}`;
  containers.add(name);
  try {
    const started = await run([
      "docker",
      "run",
      "-d",
      "--name",
      name,
      "-e",
      `POSTGRES_PASSWORD=autoconfig-${process.pid}`,
      ...dockerArgs,
      IMAGE,
    ]);
    if (started.code !== 0) throw new Error(`docker run failed: ${started.stderr}`);
    await waitForPostgres({ container: name, timeout: 90 });
    await check(name);
  } finally {
    await run(["docker", "rm", "-f", "-v", name]);
    containers.delete(name);
  }
}

async function main(): Promise<void> {
  console.log(`Auto-config suite against ${IMAGE}`);
  const dir = await mkdtemp(join(tmpdir(), "aza-autoconfig-"));
  const removeAll = async () => {
    await Promise.all([...containers].map((c) => run(["docker", "rm", "-f", "-v", c])));
    await rm(dir, { recursive: true, force: true });
  };
  process.on("SIGINT", () => void removeAll().then(() => process.exit(130)));
  try {
    const stub = join(dir, "docker-entrypoint.sh");
    await Bun.write(stub, STUB);
    await chmod(stub, 0o755);
    // Read from the image, not the repo: the suite judges what ships, and a stale image must fail rather than pass on
    // the repo's newer copy.
    const shipped = await run([
      "docker",
      "run",
      "--rm",
      "--entrypoint",
      "cat",
      IMAGE,
      IMAGE_ENTRYPOINT,
    ]);
    const defaultPreload = shipped.stdout.match(
      /^readonly DEFAULT_SHARED_PRELOAD_LIBRARIES="([^"]+)"$/m
    )?.[1];
    if (!defaultPreload)
      throw new Error(
        `DEFAULT_SHARED_PRELOAD_LIBRARIES not found in ${IMAGE}:${IMAGE_ENTRYPOINT} (exit ${shipped.code}): ${shipped.stderr}`
      );

    const boots = Promise.all([
      test("real boot 512 MB / 1 CPU: every tuned value in effect, operator preload and ALTER SYSTEM win", () =>
        realBoot(
          "min",
          [
            "--memory=512m",
            ...cpus(1),
            "-e",
            `POSTGRES_SHARED_PRELOAD_LIBRARIES=${defaultPreload},set_user`,
          ],
          async (container) => {
            await assertGeneratedSettingsApplied(container);
            // Base settings reach a plain container, and the operator's file still beats them: initdb writes
            // log_timezone into the data directory's postgresql.conf, which the base file also sets. pg_settings
            // spells timezone TimeZone, so that name would match no row.
            const sources = await psql(
              container,
              `SELECT string_agg(name || '=' || setting || '@' || sourcefile, ',' ORDER BY name) FROM pg_settings
                 WHERE name IN ('pg_stat_statements.track', 'timescaledb.telemetry_level', 'log_timezone')`
            );
            const pgConf = `${await psql(container, "SHOW data_directory")}/postgresql.conf`;
            const want = `log_timezone=Etc/UTC@${pgConf},pg_stat_statements.track=all@${BASE_CONFIG},timescaledb.telemetry_level=off@${BASE_CONFIG}`;
            if (sources !== want) {
              throw new Error(`base/operator precedence: ${sources}; want ${want}`);
            }
            const preload = await psql(container, "SHOW shared_preload_libraries");
            if (preload !== `${defaultPreload},set_user`) {
              throw new Error(
                `shared_preload_libraries = ${preload}, expected ${defaultPreload},set_user`
              );
            }
            await psql(container, "ALTER SYSTEM SET work_mem = '77MB'");
            await psql(container, "SELECT pg_reload_conf()");
            // Reload is asynchronous: poll until the postmaster has re-read the files.
            const deadline = Date.now() + 10_000;
            let workMem = "";
            while (Date.now() < deadline) {
              workMem = await psql(container, "SHOW work_mem");
              if (workMem === "77MB") break;
              await Bun.sleep(100);
            }
            if (workMem !== "77MB")
              throw new Error(`SHOW work_mem = ${workMem} after ALTER SYSTEM, expected 77MB`);
            await assertGeneratedSettingsApplied(container, ["work_mem"]);
          }
        )),
      test("real boot largest tier (65536 MB, dw, 14 CPU): PostgreSQL accepts every tuned value", () =>
        realBoot(
          "dw",
          [...cpus(14), "-e", "POSTGRES_MEMORY=65536", "-e", "POSTGRES_WORKLOAD_TYPE=dw"],
          (container) => assertGeneratedSettingsApplied(container)
        )),
    ]);

    const queue = [...ROWS];
    await Promise.all(
      Array.from({ length: DRY_RUN_CONCURRENCY }, async () => {
        for (let row = queue.shift(); row; row = queue.shift()) {
          const current = row;
          await test(`dry run: ${current.name}`, () => dryRun(current, stub));
        }
      })
    );
    await boots;
  } finally {
    await removeAll();
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`❌ ${f.name}`);
    process.exit(1);
  }
}

await main();
