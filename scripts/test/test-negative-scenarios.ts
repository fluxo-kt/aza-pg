#!/usr/bin/env bun
/**
 * Inputs the image must refuse, each by stopping the container with a specific error.
 *
 * A container that keeps running on bad input is the failure: it either serves with a configuration the operator
 * did not ask for or fails later and further from the cause. Every case therefore asserts a non-zero exit AND the
 * message naming the input; exit is observed with `docker wait`, never assumed after a delay.
 * Each case owns its container, so the cases run concurrently: run serially, the suite takes the sum of every case's
 * container lifecycle, and under CPU contention the last full-initdb case can run past its 90 s hang bound.
 * RAM below the 512 MB minimum is test-auto-config.ts's "256 MB cgroup is refused" row: the refusal follows detection
 * whatever the RAM source.
 * PgBouncer's entrypoint validation lives in test-pgbouncer-failures.ts.
 *
 * Usage: bun test ./scripts/test/test-negative-scenarios.ts
 */

import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { EPHEMERAL_PGDATA, generateUniqueContainerName } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";

const IMAGE = resolveImageTag({ argv: [] });
const created: string[] = [];
const scratchDirs: string[] = [];

// Cleanup lives here, not in each test's finally: bun abandons a timed-out test's body, so its finally never runs,
// while afterAll still does.
afterAll(async () => {
  for (const name of created) await $`docker rm -f -v ${name}`.nothrow().quiet();
  for (const dir of scratchDirs) await rm(dir, { recursive: true, force: true });
});

/** Start the image with `env`, wait for the container to stop, return its exit code and full log. */
async function runToExit(
  prefix: string,
  env: Record<string, string>,
  dockerArgs: string[] = []
): Promise<{ code: number; logs: string }> {
  const name = generateUniqueContainerName(`aza-pg-negative-${prefix}`);
  created.push(name);
  const envArgs = Object.entries({ POSTGRES_PASSWORD: "negative-test", ...env }).flatMap(
    ([k, v]) => ["-e", `${k}=${v}`]
  );
  await $`docker run -d --name ${name} ${EPHEMERAL_PGDATA} ${dockerArgs} ${envArgs} ${IMAGE}`.quiet();
  const code = Number((await $`docker wait ${name}`.quiet().text()).trim());
  const r = await $`docker logs ${name}`.nothrow().quiet();
  return { code, logs: r.stdout.toString() + r.stderr.toString() };
}

test.concurrent(
  "non-numeric POSTGRES_MEMORY stops the container",
  async () => {
    const { code, logs } = await runToExit("ram-invalid", { POSTGRES_MEMORY: "2g" });
    expect(code).toBe(1);
    expect(logs).toContain("[POSTGRES] ERROR: POSTGRES_MEMORY must be an integer value in MB");
  },
  30_000
);

test.concurrent(
  "a CPU below the compiled baseline stops the container, naming the missing feature",
  async () => {
    // Every feature the entrypoint requires on either architecture except one each (avx2, asimddp), so whichever
    // architecture runs this, exactly one is missing: the check must find a single gap, not only an empty line.
    const dir = await mkdtemp(path.join(tmpdir(), "aza-cpuinfo-"));
    scratchDirs.push(dir);
    const cpuinfo = path.join(dir, "cpuinfo");
    await Bun.write(
      cpuinfo,
      "processor\t: 0\nflags\t: fpu cx16 lahf_lm popcnt pni sse4_1 sse4_2 ssse3 avx bmi1 bmi2 f16c fma abm movbe crc32 atomics asimdrdm aes sha2\n"
    );
    const { code, logs } = await runToExit("cpu-baseline", {}, [
      "-v",
      `${cpuinfo}:/proc/cpuinfo:ro`,
    ]);
    expect(code).toBe(1);
    expect(logs).toMatch(/lacks features the image is compiled for: (avx2|asimddp)\./);
  },
  30_000
);

// The two cases below get through initdb, so the final server is what must refuse the input.
test.concurrent(
  "unloadable POSTGRES_SHARED_PRELOAD_LIBRARIES entry stops the server",
  async () => {
    const { code, logs } = await runToExit("preload-invalid", {
      POSTGRES_SHARED_PRELOAD_LIBRARIES: "no_such_library",
    });
    expect(code).not.toBe(0);
    expect(logs).toMatch(/FATAL: +could not access file "no_such_library"/);
  },
  90_000
);

test.concurrent(
  "invalid POSTGRES_BIND_IP stops the server instead of listening elsewhere",
  async () => {
    const { code, logs } = await runToExit("bind-ip-invalid", {
      POSTGRES_BIND_IP: "999.999.999.999",
    });
    expect(code).not.toBe(0);
    expect(logs).toMatch(/could not translate host name "999\.999\.999\.999"/);
    expect(logs).toMatch(/FATAL: +could not create any TCP\/IP sockets/);
  },
  90_000
);
