#!/usr/bin/env bun
/**
 * Auto-config's tuning must survive the load it was sized for, at the memory deployments really give PostgreSQL:
 * 1 and 1.5 GB (a 2 GB VPS, the common case) and 3 GB (a 4 GB VPS), with no swap (VPS images ship none). Without it,
 * a formula that overruns its own container passes every other suite and OOM-kills backends in production, as the
 * fixed connection tiers did (oltp at 1 GB).
 *
 * Each case starts the image under one limit and workload, fills every connection slot the tuning allows with a
 * session sorting, hash-joining and hash-aggregating a table larger than work_mem (so each holds its full allowance,
 * parallel workers included), and runs an index build and VACUUM beside them (maintenance_work_mem). It fails on any
 * OOM kill in the container's own cgroup (memory.events, which no host log rotation can lose), any aborted client
 * and any backend killed by a signal. PGDATA is on a volume: tmpfs would charge the WAL to the limit, which a disk
 * never does. The memory model these cases judge sits in docker-auto-config-entrypoint.sh(.template).
 *
 * Routine runs (test-all) cover 1 GB only: the floor, where every formula error overruns first, in one parallel batch.
 * --all adds 1.5 and 3 GB; /update runs it whenever per-backend memory can change (PostgreSQL, nixpkgs or an extension).
 *
 * Usage: bun scripts/test-all.ts scripts/test/test-memory-fit.ts
 *        bun scripts/test/test-memory-fit.ts [--all] [--image=TAG] [--entrypoint=FILE]
 * --entrypoint mounts an edited entrypoint over the image's, so a formula change is tried in seconds instead of a
 * rebuild; the gate always runs the image as built.
 */

import { $ } from "bun";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateUniqueContainerName, waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";

const IMAGE = resolveImageTag();
const ENTRYPOINT = Bun.argv
  .find((a) => a.startsWith("--entrypoint="))
  ?.slice("--entrypoint=".length);
// Load per case. Long enough for every session to be inside a sort or hash at the same moment many times over.
const LOAD_SECONDS = 20;
// Cases run together while their limits sum to at most this: CI runners have 16 GB.
const PARALLEL_MEMORY_MB = 12 * 1024;

interface Case {
  limitMb: number;
  workload: "mixed" | "web" | "oltp" | "dw";
  activePercent?: number;
}

const label = (c: Case) =>
  `${c.limitMb} MB ${c.workload}${c.activePercent ? ` ${c.activePercent}% active` : ""}`;

const CASES: Case[] = [
  ...(Bun.argv.includes("--all") ? [1024, 1536, 3072] : [1024]).flatMap((limitMb) =>
    (["mixed", "web", "oltp", "dw"] as const).map((workload) => ({ limitMb, workload }))
  ),
  // The opt-in trade-off: more work_mem per query, sized for a quarter of the connections busy.
  { limitMb: 1024, workload: "mixed", activePercent: 25 },
];

// Every statement uses more than any tuned work_mem: 400k md5 rows are ~30 MB.
const BUSY_SQL = [
  "SELECT count(*) FROM (SELECT v FROM s ORDER BY v) t;",
  "SELECT count(*) FROM s a JOIN s b USING (v) WHERE a.g % 7 = 0;",
  "SELECT count(*) FROM (SELECT v, count(*) FROM s GROUP BY v) t;",
].join("\n");

/** Runs one case; returns null when it held, else what broke. */
async function runCase(c: Case, entrypoint: string | null): Promise<string | null> {
  const name = generateUniqueContainerName("aza-pg-memfit");
  const volume = `${name}-data`;
  const limit = `${c.limitMb}m`;
  const env = ["-e", "POSTGRES_PASSWORD=memfit", "-e", `POSTGRES_WORKLOAD_TYPE=${c.workload}`];
  if (c.activePercent) env.push("-e", `POSTGRES_ACTIVE_CONNECTIONS_PERCENT=${c.activePercent}`);
  const mount = entrypoint
    ? ["-v", `${entrypoint}:/usr/local/bin/docker-auto-config-entrypoint.sh:ro`]
    : [];
  const exec = (script: string) => $`docker exec ${name} sh -c ${script}`.quiet().nothrow();
  const sql = async (query: string) =>
    (await $`docker exec ${name} psql -U postgres -Atqc ${query}`.quiet().text()).trim();
  try {
    await $`docker run -d --name ${name} --memory ${limit} --memory-swap ${limit} --cpus 2 -v ${volume}:/var/lib/postgresql ${env} ${mount} ${IMAGE}`.quiet();
    await waitForPostgres({ container: name, timeout: 120 });
    await sql(
      "CREATE TABLE s AS SELECT g, md5(g::text) v FROM generate_series(1, 400000) g; ANALYZE s"
    );
    const [max, reserved] = (
      await sql(
        "SELECT current_setting('max_connections')::int, current_setting('superuser_reserved_connections')::int + current_setting('reserved_connections')::int"
      )
    ).split("|");
    // One slot for the maintenance loop, one for the checks after the load.
    const sessions = Number(max) - Number(reserved) - 2;
    // The active percentage is the share of sessions the tuning expects inside a query at once: that many run
    // queries, the rest stay connected and idle, which is what that setting promises to fit.
    const busy = Math.ceil((sessions * (c.activePercent ?? 100)) / 100);
    await $`docker exec -i ${name} sh -c ${"cat > /tmp/busy.sql"} < ${new Response(BUSY_SQL)}`.quiet();
    const idle =
      sessions > busy
        ? exec(
            `echo 'SELECT pg_sleep(${LOAD_SECONDS});' > /tmp/idle.sql && ` +
              `pgbench -U postgres -n -c ${sessions - busy} -j 1 -t 1 -f /tmp/idle.sql postgres`
          )
        : null;
    const maintenance = exec(
      `end=$(( $(date +%s) + ${LOAD_SECONDS} )); while [ "$(date +%s)" -lt "$end" ]; do ` +
        "psql -U postgres -qc 'CREATE INDEX s_v ON s (v)' -c 'DROP INDEX s_v' -c 'VACUUM s'; done"
    );
    const load = await exec(
      `pgbench -U postgres -n -c ${busy} -j 2 -T ${LOAD_SECONDS} -f /tmp/busy.sql postgres 2>&1`
    );
    await maintenance;
    await idle;
    const oomKills = (await exec("awk '/^oom_kill / {print $2}' /sys/fs/cgroup/memory.events"))
      .text()
      .trim();
    const logs = await $`docker logs ${name}`.quiet().nothrow();
    const killed = (logs.stdout.toString() + logs.stderr.toString())
      .split("\n")
      .filter((l) => l.includes("terminated by signal"));
    const output = load.stdout.toString();
    const aborted = output.split("\n").filter((l) => /aborted|error/i.test(l));
    const tuning = await sql(
      "SELECT string_agg(name || '=' || current_setting(name), ' ' ORDER BY name) FROM unnest(ARRAY['max_connections','work_mem','maintenance_work_mem','shared_buffers']) name"
    );
    const problems = [
      oomKills !== "0" ? `${oomKills} OOM kill(s) in the container's cgroup` : "",
      killed.length > 0 ? `backends killed: ${killed[0]}` : "",
      aborted.length > 0 ? `clients failed: ${aborted[0]}` : "",
      load.exitCode !== 0 && aborted.length === 0
        ? `pgbench exited ${load.exitCode}: ${output.trim()}`
        : "",
    ].filter(Boolean);
    // An aborted client names no cause; the server log says whether it was memory, a limit or a crash.
    const serverErrors = (logs.stdout.toString() + logs.stderr.toString())
      .split("\n")
      .filter((l) => /FATAL|PANIC|out of memory|terminated by signal/.test(l));
    if (problems.length && serverErrors.length)
      problems.push(`server: ${serverErrors.slice(0, 3).join(" | ")}`);
    console.log(
      `${problems.length ? "❌" : "✅"} ${label(c)}: ${busy} busy + ${sessions - busy} idle sessions, ${tuning}`
    );
    return problems.length ? `${label(c)} (${tuning}): ${problems.join("; ")}` : null;
  } catch (err) {
    // A Bun shell error's message is only "Failed with exit code N"; the cause is in its stderr and the server log.
    const stderr = err instanceof $.ShellError ? err.stderr.toString().trim() : String(err);
    const logs = await $`docker logs --tail 15 ${name}`.quiet().nothrow();
    // A container killed whole (OOM on the postmaster) leaves only its exit state to read.
    const state =
      await $`docker inspect -f ${"{{.State.Status}}/exit={{.State.ExitCode}}/oom={{.State.OOMKilled}}"} ${name}`
        .quiet()
        .nothrow();
    const tail = (logs.stdout.toString() + logs.stderr.toString()).trim();
    return `${label(c)}: ${stderr} [container ${state.stdout.toString().trim()}]\n    server log:\n${tail.replace(/^/gm, "      ")}`;
  } finally {
    await $`docker rm -f -v ${name}`.quiet().nothrow();
    await $`docker volume rm ${volume}`.quiet().nothrow();
  }
}

// The image's entrypoint is executable there; a bind-mounted file keeps its host mode, so mount an executable copy.
let scratch: string | null = null;
let entrypoint: string | null = null;
if (ENTRYPOINT) {
  scratch = await mkdtemp(join(tmpdir(), "aza-pg-memfit-"));
  entrypoint = join(scratch, "entrypoint.sh");
  await copyFile(ENTRYPOINT, entrypoint);
  await chmod(entrypoint, 0o755);
}

const failures: string[] = [];
try {
  // Greedy batches under the memory budget, largest limits first so they do not end up alone.
  const pending = [...CASES].sort((a, b) => b.limitMb - a.limitMb);
  while (pending.length > 0) {
    const batch: Case[] = [];
    let used = 0;
    for (const c of pending.slice()) {
      if (batch.length === 0 || used + c.limitMb <= PARALLEL_MEMORY_MB) {
        batch.push(c);
        used += c.limitMb;
        pending.splice(pending.indexOf(c), 1);
      }
    }
    for (const failure of await Promise.all(batch.map((c) => runCase(c, entrypoint))))
      if (failure) failures.push(failure);
  }
} finally {
  if (scratch) await rm(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(
    `\n${failures.length} case(s) overran their memory:\n${failures.map((f) => `  - ${f}`).join("\n")}`
  );
  process.exit(1);
}
console.log(`\nAll ${CASES.length} cases held their memory under full load (${IMAGE})`);
