#!/usr/bin/env bun
/**
 * Auto-config in the shipped image: what the entrypoint hands PostgreSQL for given container limits, and whether
 * PostgreSQL accepts it.
 *
 * Configuration probes use real `--memory`/CPU limits and PostgreSQL's -C against one initialized cluster mounted
 * read-only. The shipped entrypoints and PostgreSQL parse the generated configuration without starting a server
 * or allocating the configured shared memory. Rows check the file, effective operator overrides and rejection.
 * CPU counts use --cpu-quota rather than --cpus, because Docker refuses --cpus above the host's CPU count but
 * accepts any quota — so the 14-core rows also run on hosts with fewer CPUs.
 *
 * Real boots: two containers start PostgreSQL for real (512 MB / 1 CPU, and the largest dw tier); every generated
 * setting must be in effect from the generated file, so a value PostgreSQL rejects fails the boot and the suite.
 *
 * Usage: bun scripts/test/test-auto-config.ts [image]   (also --image=TAG or POSTGRES_IMAGE; default: the local build)
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TIMEOUTS } from "../config/test-timeouts";
import { generateUniqueProjectName, waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";
import { sqlOk } from "../utils/psql";

const IMAGE = resolveImageTag();
const RUN_ID = generateUniqueProjectName("aza-pg-autoconfig");
const AUTO_CONFIG_FILE = "/var/run/postgresql/aza-auto-config.conf";
const BASE_CONFIG = "/etc/postgresql/postgresql-base.conf";
const IMAGE_ENTRYPOINT = "/usr/local/bin/docker-auto-config-entrypoint.sh";
const PROBE_CONCURRENCY = 8;

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
// No swap, like the VPS hosts deployments run on: `--memory` alone grants as much swap again.
const memory = (size: string) => [`--memory=${size}`, `--memory-swap=${size}`];

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
  effective?: { setting: string; value: string };
  include?: string;
}

// The data directory comes from the image, so the path follows the PostgreSQL major the image ships.
const PGDATA = (
  await run([
    "docker",
    "image",
    "inspect",
    "-f",
    "{{range .Config.Env}}{{println .}}{{end}}",
    IMAGE,
  ])
).stdout
  .split("\n")
  .find((line) => line.startsWith("PGDATA="))
  ?.slice("PGDATA=".length);
if (!PGDATA) throw new Error(`no PGDATA in ${IMAGE}`);

// Expected values come from the entrypoint's formulas worked by hand (see the inline arithmetic), not from its output.
// Memory fit: every connection and parallel worker costs 3 MB, each busy one 4 MB + 4 × work_mem more; "fits" is how
// many connections fit the session pool at the workload's work_mem target (1 MB; dw 8 MB), floor 10.
const ROWS: Row[] = [
  {
    name: "POSTGRES_MEMORY=1536 overrides detection",
    docker: cpus(2),
    env: { POSTGRES_MEMORY: "1536" },
    // 1536×25% = 384; cache floor 2×384 = 768; session pool 1382−384−48−32−96−3×48 = 678 fits 59 < tier 120×50% = 60;
    // work_mem (678−61×3−61×4)×1024/(61×4) = 1053
    settings: {
      shared_buffers: "384MB",
      max_connections: "59",
      effective_cache_size: "768MB",
      work_mem: "1053kB",
      maintenance_work_mem: "96MB",
    },
  },
  {
    name: "2 GB / 2 CPU cgroup",
    docker: [...memory("2g"), ...cpus(2)],
    detected: "RAM: 2048MB (cgroup-v2), CPU: 2 cores (cgroup-v2), Workload: mixed, Storage: ssd",
    // pool 1843−512−48−32−128−3×64 = 931 fits 82 < 120×70% = 84; work_mem (931−84×7)×1024/(84×4) = 1045;
    // <4 cores: workers 2+1 → floor 8, gather 1, maintenance 1
    settings: {
      shared_buffers: "512MB",
      max_connections: "82",
      effective_cache_size: "1024MB",
      work_mem: "1045kB",
      max_worker_processes: "8",
      max_parallel_workers: "2",
      max_parallel_workers_per_gather: "1",
      max_parallel_maintenance_workers: "1",
      io_workers: "1",
    },
  },
  {
    name: "512 MB cgroup is the accepted minimum",
    docker: [...memory("512m"), ...cpus(1)],
    detected: "RAM: 512MB (cgroup-v2)",
    // cache: 512−128−512 < 0 → floor 2×128 = 256; wal_buffers 128×3% = 3; pool 460−128−48−32−32−3×16 = 172
    // fits 14 < tier 60; work_mem (172−15×7)×1024/(15×4) = 1143
    settings: {
      shared_buffers: "128MB",
      max_connections: "14",
      effective_cache_size: "256MB",
      work_mem: "1143kB",
      maintenance_work_mem: "32MB",
      wal_buffers: "3MB",
    },
  },
  {
    name: "256 MB cgroup is refused before PostgreSQL starts",
    docker: [...memory("256m")],
    exit: 1,
    stdoutLines: ["[POSTGRES] FATAL: Detected 256MB RAM - minimum 512MB REQUIRED"],
  },
  {
    name: "POSTGRES_MEMORY=65536 (15% shared_buffers tier)",
    docker: [],
    env: { POSTGRES_MEMORY: "65536" },
    // 65536×15% = 9830; the session pool fits far more than the tier (work_mem follows the host's CPU count here)
    settings: {
      shared_buffers: "9830MB",
      max_connections: "120",
      effective_cache_size: "29819MB",
      maintenance_work_mem: "2048MB",
    },
  },
  {
    name: "4 GB cgroup",
    docker: [...memory("4g")],
    detected: "RAM: 4096MB (cgroup-v2)",
    // 120×85% = 102 (pool 3686−1024−48−32−256−3×128 = 1942 fits more); cache floor 2×1024
    settings: {
      shared_buffers: "1024MB",
      max_connections: "102",
      effective_cache_size: "2048MB",
      checkpoint_completion_target: "0.9",
    },
  },
  {
    name: "8 GB cgroup, default workload and storage",
    docker: [...memory("8g")],
    detected: "RAM: 8192MB (cgroup-v2)",
    // wal_buffers 2048×3% = 61 → cap 16
    settings: {
      shared_buffers: "2048MB",
      max_connections: "120",
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
    name: "1 GB / 1 CPU",
    docker: [...memory("1g"), ...cpus(1)],
    detected: "RAM: 1024MB (cgroup-v2), CPU: 1 cores (cgroup-v2)",
    // pool 921−256−48−32−64−3×32 = 425 fits 37 < tier 60; work_mem (425−38×7)×1024/(38×4) = 1071
    settings: {
      shared_buffers: "256MB",
      max_connections: "37",
      work_mem: "1071kB",
      max_worker_processes: "8",
      max_parallel_workers: "1",
      max_parallel_workers_per_gather: "1",
      max_parallel_maintenance_workers: "1",
      io_workers: "1",
    },
  },
  {
    name: "3 GB / 2 CPU",
    docker: [...memory("3g"), ...cpus(2)],
    // pool 2764−768−48−32−192−3×96 = 1436 fits 128 > tier 84; work_mem (1436−86×7)×1024/(86×4) = 2482
    settings: { shared_buffers: "768MB", max_connections: "84", work_mem: "2482kB" },
  },
  {
    name: "POSTGRES_MEMORY=32768, dw, 14 CPU",
    docker: cpus(14),
    env: { POSTGRES_MEMORY: "32768", POSTGRES_WORKLOAD_TYPE: "dw" },
    detected: "RAM: 32768MB (manual), CPU: 14 cores (cgroup-v2), Workload: dw, Storage: ssd",
    // 32768/8 → cap 2048; pool 29491−6553−48−32−2048−3×256 = 20042; work_mem (20042−114×7)×1024/(114×4) = 43214
    // (dw cap 256 MB); workers 14+7 = 21
    settings: {
      max_connections: "100",
      work_mem: "43214kB",
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
    name: "invalid POSTGRES_WORKLOAD_TYPE falls back to mixed and says so",
    docker: [...memory("4g")],
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
    docker: [...memory("4g")],
    env: { POSTGRES_STORAGE_TYPE: "invalid" },
    exit: 0,
    stderrLines: [
      "[POSTGRES] WARNING: Invalid POSTGRES_STORAGE_TYPE='invalid' - defaulting to 'ssd'",
    ],
    settings: { random_page_cost: "1.1", maintenance_io_concurrency: "20" },
  },
  {
    name: "512 MB + hdd + web",
    docker: [...memory("512m"), ...cpus(1)],
    env: { POSTGRES_STORAGE_TYPE: "hdd", POSTGRES_WORKLOAD_TYPE: "web" },
    // web 200×50% = 100 cut to the 14 the pool fits (same 1 MB target as mixed, see the 512 MB row)
    settings: { shared_buffers: "128MB", random_page_cost: "4.0", max_connections: "14" },
  },
  {
    name: "6 GB + oltp + san + 4 CPU",
    docker: [...memory("6g"), ...cpus(4)],
    env: { POSTGRES_WORKLOAD_TYPE: "oltp", POSTGRES_STORAGE_TYPE: "san" },
    // oltp 300×85% = 255; effective_io_concurrency is the value only san sets
    settings: {
      shared_buffers: "1536MB",
      max_connections: "255",
      effective_io_concurrency: "300",
      max_parallel_workers: "4",
    },
  },
  // A value the operator sets with -c or ALTER SYSTEM overrides auto-tuning; the log names each override.
  {
    name: "operator -c values win and are logged; max_connections is fitted around, not overridden",
    docker: [...memory("2g")],
    args: ["postgres", "-c", "max_connections=7", "-c", "random_page_cost=2"],
    effective: { setting: "max_connections", value: "7" },
    stdoutLines: [
      "[POSTGRES] [AUTO-CONFIG] max_connections: operator value 7 used as given; the memory fit sizes the rest around it",
      "[POSTGRES] [AUTO-CONFIG] random_page_cost: -c 2 overrides auto-tuned 1.1",
    ],
    include: `${PGDATA}/postgresql.conf`,
  },
  {
    name: "operator --config-file is included, not passed as a second config_file",
    docker: [...memory("2g")],
    args: ["postgres", "--config-file=/x.conf"],
    include: "/x.conf",
  },
];

function checkRow(
  row: Row,
  result: { code: number; stdout: string; stderr: string },
  config: string | null
): string[] {
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

  const effective = stdoutLines.findLast((line) => line.trim() !== "");
  const expected = row.effective?.value ?? AUTO_CONFIG_FILE;
  if (effective !== expected)
    failures.push(
      `postgres -C ${row.effective?.setting ?? "config_file"}: ${effective}, expected ${expected}`
    );
  if (config === null) return [...failures, "generated config file was not captured"];
  const confLines = config.split("\n");
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

async function probeConfig(row: Row, seed: string, dir: string): Promise<void> {
  const name = `${RUN_ID}-probe-${ROWS.indexOf(row)}`;
  const configFile = join(dir, `${name}.conf`);
  containers.add(name);
  try {
    const env = Object.entries(row.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const result = await run([
      "docker",
      "run",
      "--name",
      name,
      // Read-only sharing prevents probes from changing one another's cluster; -C allocates no shared buffers.
      "--volumes-from",
      `${seed}:ro`,
      "--network",
      "none",
      ...row.docker,
      ...env,
      ...(row.include === "/x.conf" ? ["-v", `${join(dir, "operator.conf")}:/x.conf:ro`] : []),
      IMAGE,
      ...(row.args ?? ["postgres"]),
      "-C",
      row.effective?.setting ?? "config_file",
    ]);
    let config: string | null = null;
    if (result.code === 0 && (row.exit ?? 0) === 0) {
      const copied = await run(["docker", "cp", `${name}:${AUTO_CONFIG_FILE}`, configFile]);
      if (copied.code !== 0) throw new Error(`cannot capture generated config: ${copied.stderr}`);
      config = await Bun.file(configFile).text();
    }
    const failures = checkRow(row, result, config);
    if (failures.length > 0) {
      throw new Error(
        `${failures.join("\n")}\n--- stdout ---\n${result.stdout}--- stderr ---\n${result.stderr}`
      );
    }
  } finally {
    await run(["docker", "rm", "-f", "-v", name]);
    containers.delete(name);
    await rm(configFile, { force: true });
  }
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
  const rows = await sqlOk(
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
      // No TEST_SERVER: tmpfs pages count against --memory, so the boot would run with less memory than tuned for.
      ...dockerArgs,
      IMAGE,
    ]);
    if (started.code !== 0) throw new Error(`docker run failed: ${started.stderr}`);
    await waitForPostgres({ container: name, timeout: TIMEOUTS.startup });
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
    await Bun.write(join(dir, "operator.conf"), "# Operator-supplied configuration\n");
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
            ...memory("512m"),
            ...cpus(1),
            "-e",
            `POSTGRES_SHARED_PRELOAD_LIBRARIES=${defaultPreload},set_user`,
          ],
          async (container) => {
            await assertGeneratedSettingsApplied(container);
            // Base settings reach a plain container, and the operator's file still beats them: initdb writes
            // log_timezone into the data directory's postgresql.conf, which the base file also sets. pg_settings
            // spells timezone TimeZone, so that name would match no row.
            const sources = await sqlOk(
              container,
              `SELECT string_agg(name || '=' || setting || '@' || sourcefile, ',' ORDER BY name) FROM pg_settings
                 WHERE name IN ('pg_stat_statements.track', 'timescaledb.telemetry_level', 'log_timezone')`
            );
            const pgConf = `${await sqlOk(container, "SHOW data_directory")}/postgresql.conf`;
            const want = `log_timezone=Etc/UTC@${pgConf},pg_stat_statements.track=all@${BASE_CONFIG},timescaledb.telemetry_level=off@${BASE_CONFIG}`;
            if (sources !== want) {
              throw new Error(`base/operator precedence: ${sources}; want ${want}`);
            }
            const preload = await sqlOk(container, "SHOW shared_preload_libraries");
            if (preload !== `${defaultPreload},set_user`) {
              throw new Error(
                `shared_preload_libraries = ${preload}, expected ${defaultPreload},set_user`
              );
            }
            await sqlOk(container, "ALTER SYSTEM SET work_mem = '77MB'");
            await sqlOk(container, "SELECT pg_reload_conf()");
            // Reload is asynchronous: poll until the postmaster has re-read the files.
            const deadline = Date.now() + TIMEOUTS.health * 1000;
            let workMem = "";
            while (Date.now() < deadline) {
              workMem = await sqlOk(container, "SHOW work_mem");
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

    // A fully initialized cluster includes the real extension key. initdb alone leaves -C's preload
    // hooks trying to create it on the read-only volume. One seed serves every resource-limit probe.
    const seed = `${RUN_ID}-seed`;
    containers.add(seed);
    const initialized = await run([
      "docker",
      "run",
      "-d",
      "--name",
      seed,
      ...memory("512m"),
      ...cpus(1),
      "-e",
      `POSTGRES_PASSWORD=autoconfig-${process.pid}`,
      IMAGE,
    ]);
    if (initialized.code !== 0)
      throw new Error(`cannot initialize probe cluster: ${initialized.stderr}`);
    await waitForPostgres({ container: seed, timeout: TIMEOUTS.startup });
    const stopped = await run(["docker", "stop", seed]);
    if (stopped.code !== 0) throw new Error(`cannot stop probe cluster: ${stopped.stderr}`);

    const queue = [...ROWS];
    await Promise.all(
      Array.from({ length: PROBE_CONCURRENCY }, async () => {
        for (let row = queue.shift(); row; row = queue.shift()) {
          const current = row;
          await test(`configuration probe: ${current.name}`, () => probeConfig(current, seed, dir));
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
