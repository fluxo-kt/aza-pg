#!/usr/bin/env bun
/**
 * The one list of Docker test suites, and the runner every workflow and `bun run test` goes through.
 *
 * Why one list: suites used to be listed separately here, in five workflows and in package.json, so the lists
 * drifted — some suites ran nowhere, workflows called deleted files. `scripts/validate/check-suite-registry.ts`
 * fails `validate` when a `scripts/**\/test-*.ts` suite is missing from SUITES or a workflow names an unknown group.
 *
 * Every suite gets the image as POSTGRES_IMAGE, runs in its own process group, and is reported when it finishes.
 * Then every container, volume and network carrying its scope is removed (TEST_SCOPE_ENV in utils/docker.ts): a suite
 * killed at its timeout never runs its own teardown, and one that passed but left anything behind fails. Suites
 * run in parallel up to the CPU count: each one isolates its containers, volumes, networks and ports, so order and
 * neighbours must not matter (--shuffle proves it). Any failed suite makes the run exit 1.
 *
 * Usage: bun scripts/test-all.ts [--group G[,G…]] [--image REF] [--shuffle[=SEED]]
 *   --group    default: every group except "nightly", which needs the regression image
 *   --image    default: POSTGRES_IMAGE, else the local build (aza-pg:pg18)
 *   --shuffle  random suite order; prints the seed so a failing order can be replayed
 */

import { availableParallelism } from "node:os";
import { join } from "node:path";
import { ensureImageAvailable, sweepTestScope, TEST_SCOPE_ENV } from "./utils/docker";
import { DEFAULT_TEST_IMAGE } from "./test/image-resolver";

export const GROUPS = [
  "extensions",
  "security",
  "stacks",
  "features",
  "regression",
  "nightly",
] as const;
export type Group = (typeof GROUPS)[number];

export interface Suite {
  /** Repository-relative path of the suite's entry file. */
  path: string;
  group: Group;
  args?: string[];
}

export const SUITES: Suite[] = [
  { path: "scripts/docker/test-image.ts", group: "extensions" },
  { path: "scripts/docker/verify-runtime.ts", group: "extensions" },
  { path: "scripts/docker/verify-filesystem.ts", group: "extensions" },
  { path: "scripts/test/run-extension-smoke.ts", group: "extensions" },
  { path: "scripts/test/test-extension-versions.ts", group: "extensions" },
  { path: "scripts/test/test-timescaledb-breaking-changes.ts", group: "extensions" },
  { path: "scripts/test/test-pgmq-functional.ts", group: "extensions" },
  { path: "scripts/test/test-supautils-functional.ts", group: "extensions" },
  { path: "scripts/test/test-pg-net-functional.ts", group: "extensions" },
  { path: "scripts/test/test-hook-extensions.ts", group: "extensions" },
  { path: "scripts/test/test-disabled-extensions.ts", group: "extensions" },
  { path: "scripts/test/test-integration-extension-combinations.ts", group: "extensions" },
  { path: "scripts/test/test-security.ts", group: "security" },
  { path: "scripts/test/test-pgbouncer-healthcheck.ts", group: "stacks" },
  { path: "scripts/test/test-pgbouncer-failures.ts", group: "stacks" },
  { path: "scripts/test/test-replica-stack.ts", group: "stacks" },
  { path: "scripts/test/test-single-stack.ts", group: "stacks" },
  { path: "scripts/test/test-auto-config.ts", group: "features" },
  { path: "scripts/test/test-backup-restore.ts", group: "features" },
  { path: "scripts/test/test-negative-scenarios.ts", group: "features" },
  { path: "scripts/test/test-pg-cron-postgres-db.ts", group: "features" },
  { path: "scripts/test/test-pgflow.ts", group: "features" },
  { path: "scripts/test/test-pgflow-upgrade.ts", group: "features" },
  // Runs test-extension-regression.ts and test-extension-interactions.ts.
  { path: "scripts/test/run-all-regression-tests.ts", group: "regression" },
  {
    path: "scripts/test/run-all-regression-tests.ts",
    group: "nightly",
    args: ["--mode=regression"],
  },
];

// A suite past this is already over the whole lane's error ceiling (A8: 5 min); killing it keeps CI from hanging.
const SUITE_TIMEOUT_MS = 5 * 60_000;
// A23 target per suite; slower suites are named in the summary.
const SLOW_SUITE_MS = 30_000;
const ROOT = join(import.meta.dir, "..");

interface Outcome {
  suite: Suite;
  passed: boolean;
  ms: number;
}

/** mulberry32: a seeded PRNG, so a shuffled order can be replayed from its printed seed. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], seed: number): T[] {
  const random = seededRandom(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function parseArgs(argv: string[]): { groups: Group[]; image: string; seed: number | null } {
  let groups: string[] = GROUPS.filter((g) => g !== "nightly");
  let image = Bun.env.POSTGRES_IMAGE || DEFAULT_TEST_IMAGE;
  let seed: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (!v) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === "--group") groups = value().split(",");
    else if (flag === "--image") image = value();
    else if (flag === "--shuffle")
      seed = inline === undefined ? Math.floor(Math.random() * 2 ** 31) : Number(inline);
    else
      throw new Error(
        `unknown argument ${arg}; usage: bun scripts/test-all.ts [--group G[,G…]] [--image REF] [--shuffle[=SEED]]`
      );
  }
  const unknown = groups.filter((g) => !(GROUPS as readonly string[]).includes(g));
  if (unknown.length > 0)
    throw new Error(`unknown group ${unknown.join(", ")}; groups: ${GROUPS.join(", ")}`);
  if (seed !== null && !Number.isInteger(seed))
    throw new Error("--shuffle=SEED needs an integer seed");
  return { groups: groups as Group[], image, seed };
}

async function runSuite(suite: Suite, image: string, scope: string): Promise<Outcome> {
  const started = performance.now();
  // A file written for bun's test runner registers nothing when run as a script, so how it runs follows its imports.
  const usesTestRunner = (await Bun.file(join(ROOT, suite.path)).text()).includes(
    'from "bun:test"'
  );
  const command = usesTestRunner
    ? ["bun", "test", `./${suite.path}`, "--timeout", String(SUITE_TIMEOUT_MS)]
    : ["bun", suite.path, ...(suite.args ?? [])];
  // detached: the suite leads its own process group, so one kill also stops the docker/compose clients it started;
  // killing only the suite left `docker compose up` running, creating containers after the suite's teardown.
  const proc = Bun.spawn(command, {
    cwd: ROOT,
    env: { ...Bun.env, POSTGRES_IMAGE: image, [TEST_SCOPE_ENV]: scope },
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  live.add(proc.pid);
  const timer = setTimeout(() => killGroup(proc.pid), SUITE_TIMEOUT_MS);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  // A killed suite never ran its teardown; one that passed and still left something behind has a cleanup defect.
  const leftovers = await sweepTestScope(scope);
  live.delete(proc.pid);
  const ms = Math.round(performance.now() - started);
  const passed = code === 0 && leftovers.length === 0;
  const name = [suite.path, ...(suite.args ?? [])].join(" ");
  const verdict = passed
    ? "✅ PASS"
    : `❌ FAIL (exit ${code}${ms >= SUITE_TIMEOUT_MS ? ", killed at timeout" : ""})`;
  const leftNote =
    leftovers.length === 0
      ? ""
      : `\n${code === 0 ? "❌ Passed but left" : "Removed what it left"}: ${leftovers.join(", ")}\n`;
  console.log(
    `\n━━━━ ${verdict} ${name} [${suite.group}] ${(ms / 1000).toFixed(1)}s ━━━━\n${out}${err}${leftNote}`
  );
  return { suite, passed, ms };
}

/** Process-group leaders of the suites still running. */
const live = new Set<number>();
let interrupted = false;

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group already exited.
  }
}

/**
 * Suites run in their own process groups, so the terminal's Ctrl-C no longer reaches them. Killing them here is
 * enough: each runSuite then sweeps its own scope, and the workers start nothing new.
 */
function stopAllOnSignal(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      interrupted = true;
      for (const pid of live) killGroup(pid);
    });
  }
}

async function main(): Promise<void> {
  const { groups, image, seed } = parseArgs(Bun.argv.slice(2));
  let queue = SUITES.filter((s) => groups.includes(s.group));
  if (seed !== null) {
    queue = shuffle(queue, seed);
    console.log(`Shuffle seed: ${seed} (replay with --shuffle=${seed})`);
  }
  const workers = Math.min(availableParallelism(), queue.length);
  console.log(
    `Image ${image}; groups ${groups.join(", ")}; ${queue.length} suites, ${workers} at a time`
  );
  await ensureImageAvailable(image);

  const started = performance.now();
  const outcomes: Outcome[] = [];
  // Scope tokens are unique on this host while this run lives: this process's pid plus the suite's position.
  const pending = queue.map((suite, i) => ({ suite, scope: `t${process.pid}x${i}` }));
  stopAllOnSignal();
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (let next = pending.shift(); next && !interrupted; next = pending.shift()) {
        outcomes.push(await runSuite(next.suite, image, next.scope));
      }
    })
  );

  const failed = outcomes.filter((o) => !o.passed);
  const slow = outcomes.filter((o) => o.ms > SLOW_SUITE_MS).sort((a, b) => b.ms - a.ms);
  console.log("\n━━━━ Summary ━━━━");
  for (const o of failed) console.log(`❌ ${o.suite.path} [${o.suite.group}]`);
  for (const o of slow)
    console.log(`⏱  ${o.suite.path} ${(o.ms / 1000).toFixed(1)}s (over ${SLOW_SUITE_MS / 1000}s)`);
  console.log(
    `Passed: ${outcomes.length - failed.length}  Failed: ${failed.length}  Wall: ${((performance.now() - started) / 1000).toFixed(1)}s` +
      (seed !== null ? `  Seed: ${seed}` : "")
  );
  process.exit(interrupted ? 130 : failed.length === 0 && outcomes.length > 0 ? 0 : 1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
