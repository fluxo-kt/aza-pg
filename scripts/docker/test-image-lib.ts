/**
 * Image behaviour checks — the single owner of "does each shipped extension and tool work".
 *
 * scripts/docker/test-image.ts owns the container lifecycle and runs these against ONE container in
 * order. Every check returns a TestResult instead of throwing so one broken extension never hides
 * the rest. Each check asserts the extension's observable behaviour (a row, a plan, a log line, an
 * error text) — never only that a CREATE or a SELECT succeeded — so it turns red on the defect it names.
 */

import { preloadLibraryName } from "../config-generator/manifest-loader";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MANIFEST_ENTRIES } from "../extensions/manifest-data";
import type { ManifestEntry as SourceManifestEntry } from "../extensions/manifest-data";
import { getErrorMessage } from "../utils/errors";
import type { TestResult } from "../utils/logger";

export const REPO_ROOT = join(import.meta.dir, "../..");
/** Generated JSON copy of the manifest; scripts/test/test-disabled-extensions.ts reads it. */
export const MANIFEST_PATH = join(REPO_ROOT, "docker/postgres/extensions.manifest.json");
const INITDB_EXTENSIONS_SQL = join(
  REPO_ROOT,
  "docker/postgres/docker-entrypoint-initdb.d/01-extensions.sql"
);

/** Shape of MANIFEST_PATH as scripts/test/test-disabled-extensions.ts consumes it. */
export interface ManifestEntry {
  name: string;
  kind: "extension" | "tool" | "builtin";
  install_via?: string;
  enabled?: boolean;
  runtime?: {
    sharedPreload?: boolean;
    defaultEnable?: boolean;
    preloadOnly?: boolean;
    preloadLibraryName?: string;
  };
}

export interface Manifest {
  generatedAt: string;
  entries: ManifestEntry[];
}

export type { TestResult };

const enabledEntries = (): SourceManifestEntry[] =>
  MANIFEST_ENTRIES.filter((entry) => entry.enabled !== false);

const preloadName = (entry: SourceManifestEntry): string => preloadLibraryName(entry);

// ============================================================================
// EXECUTION
// ============================================================================

export interface PsqlResult {
  ok: boolean;
  out: string;
  err: string;
}

/**
 * Run statements in ONE psql session (one `-c` each, so a SET applies to the statements after it)
 * and keep stderr even on success: NOTICE/DEBUG lines are evidence some checks assert on.
 */
export async function psql(container: string, statements: string | string[]): Promise<PsqlResult> {
  const list = Array.isArray(statements) ? statements : [statements];
  const proc = Bun.spawn(
    [
      "docker",
      "exec",
      container,
      "psql",
      "-X",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
      ...list.flatMap((sql) => ["-c", sql]),
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, out: out.trim(), err: err.trim() };
}

/** Run statements and return stdout; throw with psql's error text when any statement fails. */
async function sqlOk(container: string, statements: string | string[]): Promise<string> {
  const result = await psql(container, statements);
  if (!result.ok) {
    // NOTICE lines (e.g. from DROP ... IF EXISTS) precede the error; report the error itself.
    const errors = result.err.split("\n").filter((line) => /ERROR|FATAL|error:/.test(line));
    throw new Error(`SQL failed: ${errors.join("\n") || result.err || result.out}`);
  }
  return result.out;
}

/** Last non-empty stdout line: a session's earlier statements print their own rows first. */
function lastLine(output: string): string {
  return output.split("\n").filter(Boolean).at(-1)?.trim() ?? "";
}

export async function execCommand(
  command: string[],
  container: string,
  user?: string
): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(["docker", "exec", ...(user ? ["-u", user] : []), container, ...command], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, output: `${out}${err}`.trim() };
}

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Wrap one check so a thrown assertion becomes a failed TestResult with its message. */
async function check(name: string, body: () => Promise<string | void>): Promise<TestResult> {
  const start = Date.now();
  try {
    const detail = await body();
    return {
      name: detail ? `${name} (${detail})` : name,
      passed: true,
      duration: Date.now() - start,
    };
  } catch (err) {
    return { name, passed: false, duration: Date.now() - start, error: getErrorMessage(err) };
  }
}

// ============================================================================
// IMAGE CONTENTS AND STARTUP STATE
// ============================================================================

/**
 * A module whose library is missing still installs and lists in pg_available_extensions; it fails only
 * when a backend loads it, which for most extensions no other check does. Libraries built from source
 * (SOURCE_LIBRARIES) have no Debian package behind them, so this is what catches one left unshipped.
 */
export function testSharedLibrariesResolve(container: string): Promise<TestResult> {
  return check("Shared libraries resolve", async () => {
    const scan = await execCommand(
      [
        "sh",
        "-c",
        'n=0; for f in "$(pg_config --pkglibdir)"/*.so /usr/local/lib/*.so*; do [ -f "$f" ] || continue; ' +
          'n=$((n+1)); ldd "$f" 2>&1 | grep "not found" | sed "s|^|$f: |"; done; echo "scanned $n"',
      ],
      container
    );
    const lines = scan.output.split("\n");
    const scanned = Number(lines.at(-1)?.match(/^scanned (\d+)$/)?.[1] ?? 0);
    const unresolved = lines.filter((line) => line.includes("not found"));
    expect(scan.ok && scanned > 0, `scan failed: ${scan.output}`);
    expect(unresolved.length === 0, unresolved.join("\n"));
    return `${scanned} objects`;
  });
}

/**
 * Forward: every default-enabled preload is loaded. Reverse: everything loaded is a library the
 * manifest declares preloadable, so a rogue or misspelled entry fails too.
 */
export function testPreloadedExtensions(container: string): Promise<TestResult> {
  return check("Preloaded libraries match the manifest", async () => {
    const preloadable = enabledEntries().filter((e) => e.runtime?.sharedPreload === true);
    const required = preloadable.filter((e) => e.runtime?.defaultEnable === true).map(preloadName);
    const allowed = new Set(preloadable.map(preloadName));
    const loaded = (await sqlOk(container, "SHOW shared_preload_libraries"))
      .split(",")
      .map((lib) => lib.trim())
      .filter(Boolean);
    const missing = required.filter((lib) => !loaded.includes(lib));
    const rogue = loaded.filter((lib) => !allowed.has(lib));
    expect(missing.length === 0, `missing from shared_preload_libraries: ${missing.join(", ")}`);
    expect(rogue.length === 0, `not declared preloadable in the manifest: ${rogue.join(", ")}`);
    return `${required.length} required, ${loaded.length} loaded`;
  });
}

/**
 * The initdb scripts create a baseline set of extensions. The expected set is read from the generated
 * 01-extensions.sql (plus pg_cron, which 01b-pg_cron.sh creates), never copied here. The reverse check allows
 * only that set plus what an initdb script creates by name (04-pg_partman-init.sh's pg_partman), so an
 * extension created at init without anyone listing it fails.
 */
export function testPrecreatedExtensions(container: string): Promise<TestResult> {
  return check("Initdb-created extensions exist", async () => {
    const initSql = await Bun.file(INITDB_EXTENSIONS_SQL).text();
    const arrayLiteral = initSql.match(/v_expected_exts\s+TEXT\[\]\s*:=\s*ARRAY\[([^\]]*)\]/)?.[1];
    expect(arrayLiteral !== undefined, "v_expected_exts array not found in 01-extensions.sql");
    const expected = [...arrayLiteral.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
    expect(expected.length > 0, "v_expected_exts array in 01-extensions.sql is empty");
    expected.push("pg_cron");
    const list = expected.map((name) => `'${name}'`).join(",");
    const missing = await sqlOk(
      container,
      `SELECT e FROM unnest(ARRAY[${list}]::text[]) e
       WHERE e NOT IN (SELECT extname FROM pg_extension)
       ORDER BY e`
    );
    expect(missing === "", `not in pg_extension: ${missing.split("\n").join(", ")}`);
    const initDir = dirname(INITDB_EXTENSIONS_SQL);
    const allowed = new Set(expected);
    for (const file of await readdir(initDir)) {
      const text = await Bun.file(join(initDir, file)).text();
      for (const m of text.matchAll(/CREATE EXTENSION IF NOT EXISTS "?(\w+)"?/gi))
        allowed.add(m[1] as string);
    }
    const allowedList = [...allowed].map((name) => `'${name}'`).join(",");
    const unexpected = await sqlOk(
      container,
      `SELECT extname FROM pg_extension WHERE extname <> ALL (ARRAY[${allowedList}]::text[]) ORDER BY extname`
    );
    expect(
      unexpected === "",
      `not created by any initdb script: ${unexpected.split("\n").join(", ")}`
    );
    return `${expected.length} expected`;
  });
}

/**
 * Every enabled extension that needs no optional preload can be created. Optional preloads
 * (sharedPreload with defaultEnable false) are excluded: they refuse CREATE until an operator preloads them.
 */
export function testEnabledExtensions(container: string): Promise<TestResult> {
  return check("Enabled extensions can be created", async () => {
    const creatable = enabledEntries().filter(
      (e) =>
        e.kind !== "tool" &&
        e.runtime?.preloadOnly !== true &&
        !(e.runtime?.sharedPreload === true && e.runtime?.defaultEnable === false)
    );
    const failed: string[] = [];
    for (const entry of creatable) {
      const result = await psql(
        container,
        `CREATE EXTENSION IF NOT EXISTS "${entry.name}" CASCADE`
      );
      if (!result.ok) failed.push(`${entry.name}: ${result.err.slice(0, 160)}`);
    }
    expect(failed.length === 0, failed.join("\n"));
    return `${creatable.length} created`;
  });
}

/**
 * Settings the CDC checks depend on, asserted up front so a wrong value fails with its name instead of
 * as a cryptic slot error later. PostgreSQL 18.6+ refuses logical-decoding plugins missing from
 * output_plugin_libraries (superusers too); splitting into elements also catches the list stored as one
 * quoted element, which is what a single-string SET/ALTER SYSTEM produces and which matches no plugin.
 */
export function testPostgresConfiguration(container: string): Promise<TestResult> {
  return check("CDC settings (wal_level, output_plugin_libraries)", async () => {
    const walLevel = await sqlOk(container, "SELECT current_setting('wal_level')");
    expect(walLevel === "logical", `wal_level = ${walLevel}, expected logical`);
    const plugins = await sqlOk(container, "SELECT current_setting('output_plugin_libraries')");
    const list = plugins.split(",").map((lib) => lib.trim());
    expect(list.includes("wal2json"), `output_plugin_libraries lacks wal2json: ${plugins}`);
  });
}

/**
 * Every enabled tool declares its installed file on its manifest entry (binaryPath for an executable,
 * soFileName for a server library under `pg_config --pkglibdir`), and that file exists. An enabled tool
 * declaring neither fails, so a new tool cannot ship unchecked. Its postgresOwnedDirs are postgres:0750,
 * and nothing build-only (bun, the *.ts build scripts) reached /usr/local/bin.
 */
export function testToolsPresent(container: string): Promise<TestResult> {
  return check("Tool files present", async () => {
    const tools = enabledEntries().filter((e) => e.kind === "tool");
    const pkglibdir = (await execCommand(["pg_config", "--pkglibdir"], container)).output;
    const problems: string[] = [];
    for (const tool of tools) {
      const path =
        tool.binaryPath ?? (tool.soFileName ? `${pkglibdir}/${tool.soFileName}` : undefined);
      if (!path) {
        problems.push(`${tool.name}: manifest entry declares neither binaryPath nor soFileName`);
        continue;
      }
      if (!(await execCommand(["test", "-f", path], container)).ok) {
        problems.push(`${tool.name}: ${path} missing`);
      }
      for (const dir of tool.postgresOwnedDirs ?? []) {
        const mode = (await execCommand(["stat", "-c", "%U:%a", dir], container)).output.trim();
        if (mode !== "postgres:750")
          problems.push(`${tool.name}: ${dir} is "${mode}", want postgres:750`);
      }
    }
    const buildOnly = await execCommand(
      ["sh", "-c", "command -v bun; ls /usr/local/bin/*.ts 2>/dev/null; true"],
      container
    );
    if (buildOnly.output.trim() !== "") {
      problems.push(`build-only files shipped: ${buildOnly.output.trim()}`);
    }
    expect(problems.length === 0, problems.join("\n"));
    return `${tools.length} tools`;
  });
}

/**
 * Runs the binary, which loads its shared libraries — a broken dependency fails here. The version must be
 * the manifest's tag, and libssh2 (sftp repositories) and libzstd must be linked: both are "auto" build
 * options upstream, so a missing -dev package drops them without an error. The built-in help lists every
 * repository type whatever was compiled, so only the linked libraries show what was.
 */
export function testPgBackRestFunctional(container: string): Promise<TestResult> {
  return check("pgBackRest runs", async () => {
    const entry = enabledEntries().find((e) => e.name === "pgbackrest");
    const tag =
      entry?.source.type === "git" && "tag" in entry.source ? entry.source.tag : undefined;
    const want = `pgBackRest ${tag?.replace(/^release\//, "")}`;
    const result = await execCommand(["pgbackrest", "version"], container, "postgres");
    expect(
      result.ok && result.output.trim() === want,
      `pgbackrest version: "${result.output.trim()}", want "${want}"`
    );
    const ldd = await execCommand(["ldd", entry?.binaryPath ?? "/usr/bin/pgbackrest"], container);
    const unlinked = ["libssh2.so.1", "libzstd.so.1"].filter(
      (lib) => !ldd.output.includes(`${lib} =>`)
    );
    expect(
      ldd.ok && unlinked.length === 0,
      `pgbackrest lacks ${unlinked.join(", ")} (sftp repositories, zstd):\n${ldd.output}`
    );
  });
}

/** Runs the Perl script, which loads its modules — a missing Perl dependency fails here. */
export function testPgBadgerFunctional(container: string): Promise<TestResult> {
  return check("pgBadger runs", async () => {
    const result = await execCommand(["pgbadger", "--version"], container);
    expect(
      result.ok && result.output.toLowerCase().includes("pgbadger"),
      `pgbadger --version: ${result.output}`
    );
  });
}

// ============================================================================
// EXTENSION BEHAVIOUR
// ============================================================================

export function testPgvectorHnsw(container: string): Promise<TestResult> {
  return check("pgvector - HNSW nearest neighbour", async () => {
    await sqlOk(container, [
      "DROP TABLE IF EXISTS test_vectors",
      "CREATE TABLE test_vectors (id int PRIMARY KEY, embedding vector(3))",
      "INSERT INTO test_vectors VALUES (1, '[1,2,3]'), (2, '[4,5,6]'), (3, '[7,8,9]')",
      "CREATE INDEX test_vectors_hnsw_idx ON test_vectors USING hnsw (embedding vector_l2_ops)",
    ]);
    const out = await sqlOk(container, [
      "SET enable_seqscan = off",
      "EXPLAIN (COSTS OFF) SELECT id FROM test_vectors ORDER BY embedding <-> '[3,1,2]' LIMIT 1",
      "SELECT id FROM test_vectors ORDER BY embedding <-> '[3,1,2]' LIMIT 1",
    ]);
    expect(out.includes("test_vectors_hnsw_idx"), `plan does not use the HNSW index:\n${out}`);
    expect(lastLine(out) === "1", `nearest id should be 1, got ${lastLine(out)}`);
  });
}

/**
 * pgvector 0.8.2 fixed a buffer overflow in parallel HNSW builds. A table this small builds serially
 * unless min_parallel_table_scan_size is 0, so the check sets it and asserts pgvector's own
 * "using N parallel workers" line, proving the parallel path ran.
 */
export function testPgvectorParallelHnswBuild(container: string): Promise<TestResult> {
  return check("pgvector - parallel HNSW build", async () => {
    await sqlOk(container, [
      "DROP TABLE IF EXISTS test_vectors_parallel",
      "CREATE TABLE test_vectors_parallel (id int PRIMARY KEY, embedding vector(3))",
      "INSERT INTO test_vectors_parallel SELECT g, ARRAY[g, g, g]::vector(3) FROM generate_series(1, 5000) g",
    ]);
    const build = await psql(container, [
      "SET max_parallel_maintenance_workers = 2",
      "SET min_parallel_table_scan_size = 0",
      "SET client_min_messages = debug1",
      "CREATE INDEX test_vectors_parallel_idx ON test_vectors_parallel USING hnsw (embedding vector_l2_ops)",
    ]);
    expect(build.ok, `parallel HNSW build failed: ${build.err.slice(-400)}`);
    const workers = build.err.match(/using (\d+) parallel workers/);
    expect(workers !== null && Number(workers[1]) > 0, "build did not take the parallel path");
    const nearest = lastLine(
      await sqlOk(container, [
        "SET enable_seqscan = off",
        "SELECT id FROM test_vectors_parallel ORDER BY embedding <-> '[4200,4200,4200]' LIMIT 1",
      ])
    );
    expect(nearest === "4200", `nearest id should be 4200, got ${nearest}`);
    return `${workers[1]} workers`;
  });
}

/**
 * DiskANN indexes cosine distance by default, so the query uses <=>; a query on <-> would never reach
 * the index. The query vector points at row 3, so a scan returning any other row fails.
 */
export function testVectorscaleDiskann(container: string): Promise<TestResult> {
  return check("vectorscale - DiskANN nearest neighbour", async () => {
    await sqlOk(container, [
      "CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE",
      "DROP TABLE IF EXISTS test_vectorscale",
      "CREATE TABLE test_vectorscale (id int PRIMARY KEY, vec vector(3))",
      "INSERT INTO test_vectorscale VALUES (1, '[1,0,0]'), (2, '[0,1,0]'), (3, '[0,0,1]')",
      "CREATE INDEX test_vectorscale_diskann_idx ON test_vectorscale USING diskann (vec)",
    ]);
    const out = await sqlOk(container, [
      "SET enable_seqscan = off",
      "EXPLAIN (COSTS OFF) SELECT id FROM test_vectorscale ORDER BY vec <=> '[0.1,0.2,0.9]' LIMIT 1",
      "SELECT id FROM test_vectorscale ORDER BY vec <=> '[0.1,0.2,0.9]' LIMIT 1",
    ]);
    expect(out.includes("test_vectorscale_diskann_idx"), `plan does not use DiskANN:\n${out}`);
    expect(lastLine(out) === "3", `nearest id should be 3, got ${lastLine(out)}`);
  });
}

export function testHllCardinality(container: string): Promise<TestResult> {
  return check("hll - cardinality estimate", async () => {
    await sqlOk(container, "CREATE EXTENSION IF NOT EXISTS hll CASCADE");
    const estimate = await sqlOk(
      container,
      "SELECT round(hll_cardinality(hll_add_agg(hll_hash_integer(g % 1000))))::int FROM generate_series(1, 10000) g"
    );
    // hll's default precision has about 2% standard error; 1000 distinct values must land near 1000.
    expect(Math.abs(Number(estimate) - 1000) < 100, `estimate ${estimate}, expected about 1000`);
  });
}

/** The slot output must contain the INSERT itself; format-version 2 also emits B/C records for DDL. */
export function testWal2jsonReplication(container: string): Promise<TestResult> {
  return check("wal2json - captures an INSERT", async () => {
    const dropSlot =
      "SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = 'test_wal2json_slot'";
    await sqlOk(container, [
      dropSlot,
      "DROP TABLE IF EXISTS test_wal2json_table",
      "CREATE TABLE test_wal2json_table (id int PRIMARY KEY, data text)",
      "SELECT pg_create_logical_replication_slot('test_wal2json_slot', 'wal2json')",
    ]);
    try {
      await sqlOk(container, "INSERT INTO test_wal2json_table VALUES (42, 'wal2json-marker')");
      const changes = await sqlOk(
        container,
        "SELECT data FROM pg_logical_slot_get_changes('test_wal2json_slot', NULL, NULL, 'format-version', '2')"
      );
      const insert = changes
        .split("\n")
        .map((line) => JSON.parse(line) as { action?: string; table?: string; columns?: unknown })
        .find((change) => change.action === "I" && change.table === "test_wal2json_table");
      expect(insert !== undefined, `no INSERT record for test_wal2json_table in:\n${changes}`);
      expect(
        JSON.stringify(insert.columns).includes("wal2json-marker"),
        `INSERT record lacks the inserted value: ${JSON.stringify(insert)}`
      );
    } finally {
      await psql(container, dropSlot);
    }
  });
}

/** Equality on a plain integer in a GiST exclusion constraint needs btree_gist's operator class. */
export function testBtreeGistExclusion(container: string): Promise<TestResult> {
  return check("btree_gist - integer equality exclusion", async () => {
    await sqlOk(container, [
      "CREATE EXTENSION IF NOT EXISTS btree_gist",
      "DROP TABLE IF EXISTS test_exclusion",
      "CREATE TABLE test_exclusion (room int, EXCLUDE USING gist (room WITH =))",
      "INSERT INTO test_exclusion VALUES (1), (2)",
    ]);
    const duplicate = await psql(container, "INSERT INTO test_exclusion VALUES (1)");
    expect(
      !duplicate.ok &&
        duplicate.err.includes("conflicting key value violates exclusion constraint"),
      `duplicate room was not rejected by the exclusion constraint: ${duplicate.err || duplicate.out}`
    );
  });
}

/** A GIN index on a plain integer needs btree_gin's operator class; the plan must use it. */
export function testBtreeGinIndex(container: string): Promise<TestResult> {
  return check("btree_gin - integer GIN index", async () => {
    await sqlOk(container, [
      "CREATE EXTENSION IF NOT EXISTS btree_gin",
      "DROP TABLE IF EXISTS test_btree_gin",
      "CREATE TABLE test_btree_gin (id int, val int)",
      "INSERT INTO test_btree_gin SELECT g, g % 100 FROM generate_series(1, 1000) g",
      "CREATE INDEX test_btree_gin_idx ON test_btree_gin USING gin (val)",
    ]);
    const out = await sqlOk(container, [
      "SET enable_seqscan = off",
      "EXPLAIN (COSTS OFF) SELECT count(*) FROM test_btree_gin WHERE val = 42",
      "SELECT count(*) FROM test_btree_gin WHERE val = 42",
    ]);
    expect(out.includes("test_btree_gin_idx"), `plan does not use the GIN index:\n${out}`);
    expect(lastLine(out) === "10", `expected 10 rows with val = 42, got ${lastLine(out)}`);
  });
}

/**
 * A request to a closed local port must reach libcurl and come back as a curl connection error. That
 * needs no network, and fails if the extension is missing, its function signatures changed, or the
 * library cannot load libcurl.
 */
export function testHttpRequests(container: string): Promise<TestResult> {
  return check("http - request reaches libcurl", async () => {
    await sqlOk(container, "CREATE EXTENSION IF NOT EXISTS http");
    const result = await psql(container, "SELECT status FROM http_get('http://127.0.0.1:1/')");
    expect(!result.ok, `request to a closed port succeeded: ${result.out}`);
    expect(
      /Failed to connect to 127\.0\.0\.1 port 1/.test(result.err),
      `expected a curl connection error, got: ${result.err}`
    );
  });
}

/**
 * pgsodium's DDL event trigger fires on pg_partman's child-table creation and can interfere; it is
 * disabled for this check and always re-enabled, since every later check shares this container.
 */
export function testPgPartmanPartitioning(container: string): Promise<TestResult> {
  return check("pg_partman - creates partitions", async () => {
    await sqlOk(container, [
      "CREATE EXTENSION IF NOT EXISTS pg_partman CASCADE",
      "DROP TABLE IF EXISTS test_partman CASCADE",
      "DELETE FROM part_config WHERE parent_table = 'public.test_partman'",
      "CREATE TABLE test_partman (id int, created_at timestamp NOT NULL) PARTITION BY RANGE (created_at)",
    ]);
    await psql(container, "ALTER EVENT TRIGGER pgsodium_trg_mask_update DISABLE");
    try {
      await sqlOk(
        container,
        "SELECT create_parent('public.test_partman', 'created_at', '1 day', 'range', p_start_partition := (now() - interval '7 days')::text)"
      );
      const partitions = await sqlOk(
        container,
        "SELECT count(*) FROM pg_inherits WHERE inhparent = 'public.test_partman'::regclass"
      );
      expect(Number(partitions) > 7, `expected more than 7 partitions, got ${partitions}`);
      return `${partitions} partitions`;
    } finally {
      await psql(container, "ALTER EVENT TRIGGER pgsodium_trg_mask_update ENABLE");
    }
  });
}

export function testPgStatStatements(container: string): Promise<TestResult> {
  return check("pg_stat_statements - records a query", async () => {
    await sqlOk(container, "SELECT pg_stat_statements_reset()");
    // The marker is a column alias: pg_stat_statements normalises constants to $1, never identifiers.
    await sqlOk(container, "SELECT 1 AS pgss_marker");
    const calls = await sqlOk(
      container,
      "SELECT coalesce(sum(calls), 0) FROM pg_stat_statements WHERE query LIKE '%AS pgss_marker%' AND query NOT LIKE '%pg_stat_statements%'"
    );
    expect(Number(calls) >= 1, `the marker query was not recorded (calls = ${calls})`);
  });
}

/**
 * pg_cron runs jobs through its launcher in cron.database_name; a wrong database, a dead launcher or a
 * failing connection leaves no 'succeeded' run. Jobs are filtered by id because the image schedules its
 * own (pgflow) jobs too.
 */
export function testPgCronScheduling(container: string): Promise<TestResult> {
  return check("pg_cron - a scheduled job runs", async () => {
    await psql(container, "SELECT cron.unschedule('test-cron-run')");
    const jobId = await sqlOk(
      container,
      "SELECT cron.schedule('test-cron-run', '1 seconds', 'SELECT 1')"
    );
    try {
      const deadline = Date.now() + 20_000;
      let runs = "";
      while (Date.now() < deadline) {
        runs = await sqlOk(
          container,
          `SELECT status || ': ' || coalesce(return_message, '') FROM cron.job_run_details WHERE jobid = ${Number(jobId)} AND status IN ('succeeded', 'failed') ORDER BY runid`
        );
        if (runs !== "") break;
        await Bun.sleep(250);
      }
      expect(runs !== "", "no run of the job finished within 20 s");
      expect(runs.split("\n")[0]?.startsWith("succeeded") === true, `job run failed: ${runs}`);
    } finally {
      await psql(container, "SELECT cron.unschedule('test-cron-run')");
    }
  });
}

/** The planner must choose the hypothetical index, which exists only inside hypopg. */
export function testHypopgHypotheticalIndexes(container: string): Promise<TestResult> {
  return check("hypopg - planner uses a hypothetical index", async () => {
    await sqlOk(container, [
      "CREATE EXTENSION IF NOT EXISTS hypopg",
      "DROP TABLE IF EXISTS test_hypopg",
      "CREATE TABLE test_hypopg (id int, val int)",
      "INSERT INTO test_hypopg SELECT g, g FROM generate_series(1, 10000) g",
      "ANALYZE test_hypopg",
    ]);
    const plan = await sqlOk(container, [
      "SELECT indexname FROM hypopg_create_index('CREATE INDEX ON test_hypopg (val)')",
      "EXPLAIN (COSTS OFF) SELECT * FROM test_hypopg WHERE val = 5",
    ]);
    expect(
      /Index Scan using "?<\d+>btree_test_hypopg_val/.test(plan),
      `plan ignores the hypothetical index:\n${plan}`
    );
  });
}

export function testIndexAdvisor(container: string): Promise<TestResult> {
  return check("index_advisor - recommends an index", async () => {
    await sqlOk(container, [
      "CREATE EXTENSION IF NOT EXISTS index_advisor CASCADE",
      "DROP TABLE IF EXISTS test_index_advisor",
      "CREATE TABLE test_index_advisor (id int, val int)",
    ]);
    const advice = await sqlOk(
      container,
      "SELECT index_statements::text || ' ' || errors::text FROM index_advisor('SELECT * FROM test_index_advisor WHERE val = 5')"
    );
    expect(
      advice.includes("CREATE INDEX ON public.test_index_advisor USING btree (val)"),
      `unexpected advice: ${advice}`
    );
  });
}

/** A wrong return type must be reported and a clean function must produce no rows. */
export function testPlpgsqlCheck(container: string): Promise<TestResult> {
  return check("plpgsql_check - reports a type error, passes clean code", async () => {
    await sqlOk(container, [
      "CREATE EXTENSION IF NOT EXISTS plpgsql_check",
      "CREATE OR REPLACE FUNCTION test_plcheck_bad() RETURNS int LANGUAGE plpgsql AS $$ DECLARE v text := 'x'; BEGIN RETURN v; END $$",
      "CREATE OR REPLACE FUNCTION test_plcheck_good() RETURNS int LANGUAGE plpgsql AS $$ DECLARE v int := 42; BEGIN RETURN v; END $$",
    ]);
    try {
      const bad = await sqlOk(
        container,
        "SELECT * FROM plpgsql_check_function('test_plcheck_bad()')"
      );
      expect(
        /target type is different type than source type/.test(bad),
        `type error not reported: ${bad}`
      );
      const good = await sqlOk(
        container,
        "SELECT * FROM plpgsql_check_function('test_plcheck_good()')"
      );
      expect(good === "", `clean function reported: ${good}`);
    } finally {
      await psql(container, "DROP FUNCTION IF EXISTS test_plcheck_bad(), test_plcheck_good()");
    }
  });
}

/**
 * The image does not preload plan_filter (defaultEnable false); LOAD installs the same planner hook for
 * the session. A limit of 1 must reject a real scan and still admit a constant SELECT, so a filter that
 * blocks nothing and one that blocks everything both fail.
 */
export function testPgPlanFilter(container: string): Promise<TestResult> {
  return check("pg_plan_filter - rejects plans above the cost limit only", async () => {
    const limited = ["LOAD 'plan_filter'", "SET plan_filter.statement_cost_limit = 1"];
    const costly = await psql(container, [
      ...limited,
      "SELECT count(*) FROM generate_series(1, 100000)",
    ]);
    expect(
      !costly.ok && costly.err.includes("plan cost limit exceeded"),
      `costly plan was not rejected: ${costly.err || costly.out}`
    );
    const cheap = await psql(container, [...limited, "SELECT 1"]);
    expect(cheap.ok, `plan under the limit was rejected: ${cheap.err}`);
  });
}

/**
 * Runs the pg_repack client against the server extension: a client/extension version mismatch or a
 * broken client fails, and a successful repack rewrites the table (new relfilenode) keeping every row.
 * It runs with the image defaults: the shipped wrapper turns safeupdate off for pg_repack alone, so a bare
 * DELETE in an ordinary session must still be rejected.
 */
export function testPgRepack(container: string): Promise<TestResult> {
  return check("pg_repack - repacks a table online", async () => {
    await sqlOk(container, [
      "CREATE EXTENSION IF NOT EXISTS pg_repack",
      "DROP TABLE IF EXISTS test_repack",
      "CREATE TABLE test_repack (id int PRIMARY KEY, val text)",
      "INSERT INTO test_repack SELECT g, md5(g::text) FROM generate_series(1, 1000) g",
      "DELETE FROM test_repack WHERE id % 2 = 0",
    ]);
    const before = await sqlOk(container, "SELECT pg_relation_filenode('test_repack')");
    const run = await execCommand(
      ["pg_repack", "-U", "postgres", "-d", "postgres", "-t", "public.test_repack"],
      container,
      "postgres"
    );
    expect(run.ok, `pg_repack failed: ${run.output}`);
    const after = await sqlOk(container, [
      "SELECT pg_relation_filenode('test_repack') || ' ' || count(*) FROM test_repack",
    ]);
    const [filenode, rows] = after.split(" ");
    expect(filenode !== before, "table was not rewritten (relfilenode unchanged)");
    expect(rows === "500", `expected 500 rows after repack, got ${rows}`);
    const bare = await psql(container, "DELETE FROM test_repack");
    expect(
      !bare.ok && bare.err.includes("DELETE requires a WHERE clause"),
      `bare DELETE was not rejected by safeupdate: ${bare.err || bare.out}`
    );
  });
}

export function testPgmqQueue(container: string): Promise<TestResult> {
  return check("pgmq - send then read returns the message", async () => {
    await psql(container, "SELECT pgmq.drop_queue('test_queue')");
    await sqlOk(container, "SELECT pgmq.create('test_queue')");
    try {
      const sent = await sqlOk(
        container,
        `SELECT pgmq.send('test_queue', '{"order_id": 123}'::jsonb)`
      );
      const read = await sqlOk(
        container,
        "SELECT msg_id || ' ' || (message->>'order_id') FROM pgmq.read('test_queue', 30, 1)"
      );
      expect(read === `${sent} 123`, `read returned '${read}', expected '${sent} 123'`);
    } finally {
      await psql(container, "SELECT pgmq.drop_queue('test_queue')");
    }
  });
}

export function testPgTrgmSimilarity(container: string): Promise<TestResult> {
  return check("pg_trgm - similarity search through a GIN index", async () => {
    await sqlOk(container, [
      "DROP TABLE IF EXISTS test_trgm",
      "CREATE TABLE test_trgm (id int, text_col text)",
      "INSERT INTO test_trgm VALUES (1, 'hello world'), (2, 'hello universe'), (3, 'goodbye world')",
      "CREATE INDEX test_trgm_idx ON test_trgm USING gin (text_col gin_trgm_ops)",
    ]);
    const out = await sqlOk(container, [
      "SET enable_seqscan = off",
      "SELECT text_col FROM test_trgm WHERE text_col % 'helo wrld' ORDER BY similarity(text_col, 'helo wrld') DESC LIMIT 1",
    ]);
    expect(
      lastLine(out) === "hello world",
      `top match should be 'hello world', got '${lastLine(out)}'`
    );
  });
}

/**
 * PGroonga keeps index data in external Groonga files that TRUNCATE does not clear, so the index is
 * dropped with the table and created after the INSERTs.
 */
export function testPgroongaFullText(container: string): Promise<TestResult> {
  return check("pgroonga - full-text search", async () => {
    await sqlOk(container, [
      "CREATE EXTENSION IF NOT EXISTS pgroonga",
      "DROP TABLE IF EXISTS test_pgroonga",
      "CREATE TABLE test_pgroonga (id int, content text)",
      "INSERT INTO test_pgroonga VALUES (1, 'PostgreSQL full-text search'), (2, 'Groonga is fast'), (3, 'Full-text search engine')",
      "CREATE INDEX test_pgroonga_idx ON test_pgroonga USING pgroonga (content)",
    ]);
    const ids = await sqlOk(container, [
      "SET enable_seqscan = off",
      "SELECT string_agg(id::text, ',' ORDER BY id) FROM test_pgroonga WHERE content &@~ 'full-text'",
    ]);
    expect(lastLine(ids) === "1,3", `expected rows 1,3 to match, got '${lastLine(ids)}'`);
  });
}

/**
 * <=> on tsvector is RUM's ranking operator; it does not exist without the extension. The three matching rows hold
 * 'fox' three, two and one times, so the ranked order (2,3,1, which ts_rank agrees with) differs from id and insertion
 * order, and the plan must take that order from the RUM index.
 */
export function testRumRankedSearch(container: string): Promise<TestResult> {
  return check("rum - ranked full-text search", async () => {
    await sqlOk(container, [
      "CREATE EXTENSION IF NOT EXISTS rum",
      "DROP TABLE IF EXISTS test_rum",
      "CREATE TABLE test_rum (id int, content tsvector)",
      "INSERT INTO test_rum VALUES (1, to_tsvector('english', 'fox')), (2, to_tsvector('english', 'fox fox fox dog')), (3, to_tsvector('english', 'fox fox cat')), (4, to_tsvector('english', 'cat'))",
      "CREATE INDEX test_rum_idx ON test_rum USING rum (content rum_tsvector_ops)",
    ]);
    const query =
      "SELECT id FROM test_rum WHERE content @@ to_tsquery('english', 'fox') ORDER BY content <=> to_tsquery('english', 'fox')";
    const out = await sqlOk(container, [
      "SET enable_seqscan = off",
      `EXPLAIN (COSTS OFF) ${query}`,
      `SELECT string_agg(id::text, ',') FROM (${query}) s`,
    ]);
    expect(
      /Index Scan using test_rum_idx/.test(out) && /Order By: \(content <=>/.test(out),
      `ranking not served by the RUM index:\n${out}`
    );
    expect(lastLine(out) === "2,3,1", `expected rank order 2,3,1, got '${lastLine(out)}'`);
  });
}

/**
 * A dotted GUC is accepted as a placeholder even when pgaudit is not loaded, so SHOW proves nothing;
 * the AUDIT line in the server log (stderr, which `docker logs` reads) is the only evidence.
 */
export function testPgauditLogging(container: string): Promise<TestResult> {
  return check("pgaudit - writes an AUDIT line for DDL", async () => {
    const marker = `test_pgaudit_${Date.now()}`;
    await sqlOk(container, ["SET pgaudit.log = 'ddl'", `CREATE TABLE ${marker} (id int)`]);
    await psql(container, `DROP TABLE IF EXISTS ${marker}`);
    const deadline = Date.now() + 5_000;
    let found = false;
    while (!found && Date.now() < deadline) {
      const logs = Bun.spawn(["docker", "logs", container], { stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([
        new Response(logs.stdout).text(),
        new Response(logs.stderr).text(),
        logs.exited,
      ]);
      found = `${out}${err}`
        .split("\n")
        .some((line) => line.includes("AUDIT: SESSION") && line.includes(`public.${marker}`));
      if (!found) await Bun.sleep(200);
    }
    expect(found, `no 'AUDIT: SESSION' line naming public.${marker} in docker logs`);
  });
}

/**
 * pgsodium's DDL event trigger is disabled for the crypto calls and always re-enabled, since every later
 * check shares this container.
 */
export function testPgsodiumEncryption(container: string): Promise<TestResult> {
  return check("pgsodium - secretbox round trip", async () => {
    await psql(container, "ALTER EVENT TRIGGER pgsodium_trg_mask_update DISABLE");
    try {
      const plaintext = await sqlOk(
        container,
        `WITH k AS (SELECT pgsodium.crypto_secretbox_keygen() AS key, pgsodium.crypto_secretbox_noncegen() AS nonce)
         SELECT convert_from(pgsodium.crypto_secretbox_open(pgsodium.crypto_secretbox('secret data'::bytea, nonce, key), nonce, key), 'utf8') FROM k`
      );
      expect(plaintext === "secret data", `decrypted '${plaintext}', expected 'secret data'`);
    } finally {
      await psql(container, "ALTER EVENT TRIGGER pgsodium_trg_mask_update ENABLE");
    }
  });
}

export function testTimescaledbHypertables(container: string): Promise<TestResult> {
  return check("timescaledb - hypertable chunks data", async () => {
    await sqlOk(container, [
      "DROP TABLE IF EXISTS test_timescale",
      "CREATE TABLE test_timescale (time timestamptz NOT NULL, device_id int, temperature float)",
      "SELECT create_hypertable('test_timescale', by_range('time', interval '1 day'))",
      "INSERT INTO test_timescale SELECT t, 1, 20 FROM generate_series(now() - interval '7 days', now(), interval '1 hour') t",
    ]);
    const chunks = await sqlOk(
      container,
      "SELECT count(*) FROM timescaledb_information.chunks WHERE hypertable_name = 'test_timescale'"
    );
    expect(Number(chunks) >= 7, `7 days of data in 1-day chunks gave ${chunks} chunks`);
  });
}

export function testPgHashidsEncoding(container: string): Promise<TestResult> {
  return check("pg_hashids - encode/decode round trip", async () => {
    await sqlOk(container, "CREATE EXTENSION IF NOT EXISTS pg_hashids");
    const decoded = await sqlOk(container, "SELECT (id_decode(id_encode(12345)))[1]::text");
    expect(decoded === "12345", `round trip gave '${decoded}'`);
  });
}

export function testPgJsonschemaValidation(container: string): Promise<TestResult> {
  return check("pg_jsonschema - accepts valid, rejects invalid", async () => {
    await sqlOk(container, "CREATE EXTENSION IF NOT EXISTS pg_jsonschema");
    const schema = `'{"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}'::json`;
    const verdicts = await sqlOk(
      container,
      `SELECT json_matches_schema(${schema}, '{"name": "John"}'::json)::text || ',' || json_matches_schema(${schema}, '{"age": 30}'::json)::text`
    );
    expect(verdicts === "true,false", `valid,invalid gave '${verdicts}', expected 'true,false'`);
  });
}

/** Drops what the checks create, so a run against a reused container (--container) starts clean. */
export async function cleanupTestData(container: string): Promise<void> {
  await psql(
    container,
    `DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'test%' ORDER BY tablename LOOP
    EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', t);
  END LOOP;
END $$`
  );
  await psql(container, "DELETE FROM part_config WHERE parent_table LIKE 'public.test_%'");
  await psql(container, "SELECT pgmq.drop_queue('test_queue')");
  await psql(container, "SELECT cron.unschedule('test-cron-run')");
}
