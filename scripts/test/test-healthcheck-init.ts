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
 * So: an init script holds the temporary server open until the test releases it, and the health check is probed
 * inside that hold, where it must fail while pg_isready succeeds (proving the probe hit the temporary server).
 * Holding beats sampling the natural window, which lasts about a second: a fast host can finish before any sample
 * lands and the run then proves nothing. After release, once the final server is up, the health check must pass.
 * Proven discriminating: run with `--image ghcr.io/fluxo-kt/aza-pg:18.6-202610312251-single-node`, it fails.
 *
 * Usage: bun scripts/test/test-healthcheck-init.ts [image] [--image=TAG]
 */
import { $ } from "bun";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TIMEOUTS } from "../config/test-timeouts";
import { TEST_SERVER, generateUniqueContainerName, waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";

const container = generateUniqueContainerName("aza-pg-healthcheck-init");
const scratch = await mkdtemp(path.join(tmpdir(), "aza-pg-healthcheck-init-"));
const exec = async (...cmd: string[]) =>
  (await $`docker exec ${container} ${cmd}`.quiet().nothrow()).exitCode === 0;

// Runs as an init script, i.e. while the temporary server serves: signals the hold, then waits for release. The loop
// bound only stops a hang if the test dies; readiness is the files, never a delay.
const HOLD = `#!/bin/sh
touch /tmp/held
i=0; until [ -e /tmp/release ]; do i=$((i+1)); [ "$i" -gt 1200 ] && exit 1; sleep 0.1; done
`;
// One exec waits for the hold, then probes. Exit 3: the hold never started; 2: no server answers; 0: answering and
// healthy (the defect); 1: answering and rejected.
const PROBE = `i=0; until [ -e /tmp/held ]; do i=$((i+1)); [ "$i" -gt 1200 ] && exit 3; sleep 0.1; done
pg_isready -q || exit 2
exec /usr/local/bin/healthcheck.sh >/dev/null 2>&1`;

async function run(): Promise<void> {
  const hold = path.join(scratch, "zz-hold.sh");
  await Bun.write(hold, HOLD);
  await chmod(hold, 0o755);
  await $`docker run -d --name ${container} ${TEST_SERVER} -e POSTGRES_PASSWORD=postgres -v ${hold}:/docker-entrypoint-initdb.d/zz-hold.sh:ro ${resolveImageTag()}`.quiet();

  const probe = (await $`docker exec ${container} sh -c ${PROBE}`.quiet().nothrow()).exitCode;
  if (probe === 0)
    throw new Error("the health check passed against the temporary initialization server");
  if (probe !== 1)
    throw new Error(
      probe === 3
        ? "the init script never ran: initialization failed before init scripts (see docker logs)"
        : `the temporary server did not answer pg_isready during the hold (probe exit ${probe})`
    );

  await $`docker exec ${container} touch /tmp/release`.quiet();
  await waitForPostgres({ container, timeout: TIMEOUTS.startup });
  if (!(await exec("/usr/local/bin/healthcheck.sh")))
    throw new Error("the health check fails against the final server");
  console.log(
    "PASS: health check failed against the temporary server, then passed on the final server"
  );
}

let failure: string | null = null;
try {
  await run();
} catch (err) {
  failure = err instanceof Error ? err.message : String(err);
} finally {
  await $`docker rm -f -v ${container}`.quiet().nothrow();
  await rm(scratch, { recursive: true, force: true });
}
if (failure) {
  console.error(`FAIL: healthcheck-init: ${failure}`);
  process.exit(1);
}
