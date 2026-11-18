#!/usr/bin/env bun
/**
 * The health check must never pass while first-start initialization runs.
 *
 * On a fresh data directory the entrypoint runs initdb and the init scripts against a temporary server that accepts
 * connections, then stops it and starts the final one. A health check that passes against the temporary server lets
 * dependents (Compose `service_healthy`, setup SQL) connect to a server about to shut down. The auto-config wrapper
 * sources the upstream entrypoint, so no separate docker-entrypoint.sh process exists to look for; release
 * v18.6-202610312251 checked only for that process and passed during initialization.
 *
 * So: sample the temporary server while it answers (pg_isready succeeds and the log has not yet said
 * "init process complete") and require the health check to fail at every such sample; at least one sample must hit
 * that window, or the run proves nothing. After the final server is up the health check must pass.
 * Proven discriminating: run with `--image ghcr.io/fluxo-kt/aza-pg:18.6-202610312251-single-node`, it fails.
 *
 * Usage: bun scripts/test/test-healthcheck-init.ts [image] [--image=TAG]
 */
import { $ } from "bun";
import { TIMEOUTS } from "../config/test-timeouts";
import { TEST_SERVER, generateUniqueContainerName, waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";

const container = generateUniqueContainerName("aza-pg-healthcheck-init");
const initDone = async () => {
  const logs = await $`docker logs ${container}`.quiet().nothrow();
  return `${logs.stdout}${logs.stderr}`.includes("PostgreSQL init process complete");
};
const exec = async (...cmd: string[]) =>
  (await $`docker exec ${container} ${cmd}`.quiet().nothrow()).exitCode === 0;

async function run(): Promise<void> {
  await $`docker run -d --name ${container} ${TEST_SERVER} -e POSTGRES_PASSWORD=postgres ${resolveImageTag()}`.quiet();

  let windowSamples = 0;
  const deadline = Date.now() + TIMEOUTS.startup * 1000;
  while (!(await initDone())) {
    if (Date.now() > deadline)
      throw new Error(`initialization did not finish within ${TIMEOUTS.startup} s`);
    // Both probes in one exec: the window lasts about a second on tmpfs, and each exec costs tens of milliseconds.
    // Exit 2: no server answers; 0: answering and healthy; 1: answering and rejected.
    const probe =
      await $`docker exec ${container} sh -c ${"pg_isready -q || exit 2; /usr/local/bin/healthcheck.sh >/dev/null 2>&1"}`
        .quiet()
        .nothrow();
    // Count the sample only if initialization was still running after the probe: otherwise it may have seen the
    // final server, which the health check is right to accept.
    if (probe.exitCode === 2 || (await initDone())) continue;
    const healthy = probe.exitCode === 0;
    windowSamples++;
    if (healthy)
      throw new Error("the health check passed against the temporary initialization server");
  }
  if (windowSamples === 0)
    throw new Error(
      "no sample hit the temporary server; the run proves nothing (initialization finished too fast to observe)"
    );

  await waitForPostgres({ container, timeout: TIMEOUTS.startup });
  if (!(await exec("/usr/local/bin/healthcheck.sh")))
    throw new Error("the health check fails against the final server");
  console.log(
    `PASS: health check failed on ${windowSamples} temporary-server samples, then passed on the final server`
  );
}

let failure: string | null = null;
try {
  await run();
} catch (err) {
  failure = err instanceof Error ? err.message : String(err);
} finally {
  await $`docker rm -f -v ${container}`.quiet().nothrow();
}
if (failure) {
  console.error(`FAIL: healthcheck-init: ${failure}`);
  process.exit(1);
}
