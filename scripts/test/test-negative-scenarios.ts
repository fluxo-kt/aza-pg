#!/usr/bin/env bun
/**
 * Inputs the image must refuse, each by stopping the container with a specific error.
 *
 * A container that keeps running on bad input is the failure: it either serves with a configuration the operator
 * did not ask for or fails later and further from the cause. Every case therefore asserts a non-zero exit AND the
 * message naming the input; exit is observed with `docker wait`, never assumed after a delay.
 * Each case owns its container, so the cases run concurrently: run serially, the suite took the sum of four container
 * lifecycles, and under CPU contention the last full-initdb case ran past its 90 s hang bound.
 * PgBouncer's entrypoint validation lives in test-pgbouncer-failures.ts.
 *
 * Usage: bun test ./scripts/test/test-negative-scenarios.ts
 */

import { $ } from "bun";
import { afterAll, expect, test } from "bun:test";
import { generateUniqueContainerName } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";

const IMAGE = resolveImageTag({ argv: [] });
const created: string[] = [];

afterAll(async () => {
  for (const name of created) await $`docker rm -f -v ${name}`.nothrow().quiet();
});

/** Start the image with `env`, wait for the container to stop, return its exit code and full log. */
async function runToExit(
  prefix: string,
  env: Record<string, string>
): Promise<{ code: number; logs: string }> {
  const name = generateUniqueContainerName(`aza-pg-negative-${prefix}`);
  created.push(name);
  const envArgs = Object.entries({ POSTGRES_PASSWORD: "negative-test", ...env }).flatMap(
    ([k, v]) => ["-e", `${k}=${v}`]
  );
  await $`docker run -d --name ${name} ${envArgs} ${IMAGE}`.quiet();
  const code = Number((await $`docker wait ${name}`.quiet().text()).trim());
  const r = await $`docker logs ${name}`.nothrow().quiet();
  return { code, logs: r.stdout.toString() + r.stderr.toString() };
}

test.concurrent(
  "RAM below the 512 MB minimum stops the container",
  async () => {
    const { code, logs } = await runToExit("ram-low", { POSTGRES_MEMORY: "128" });
    expect(code).toBe(1);
    expect(logs).toContain("[POSTGRES] FATAL: Detected 128MB RAM - minimum 512MB REQUIRED");
  },
  30_000
);

test.concurrent(
  "non-numeric POSTGRES_MEMORY stops the container",
  async () => {
    const { code, logs } = await runToExit("ram-invalid", { POSTGRES_MEMORY: "2g" });
    expect(code).toBe(1);
    expect(logs).toContain("[POSTGRES] ERROR: POSTGRES_MEMORY must be an integer value in MB");
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
