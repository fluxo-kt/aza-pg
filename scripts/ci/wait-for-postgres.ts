#!/usr/bin/env bun
/**
 * Block until PostgreSQL in a running container is the final server and answers `SELECT 1`;
 * exit non-zero (with the container's last log lines) on timeout or a stopped container.
 *
 * Workflow steps call this instead of a `pg_isready` loop: `pg_isready` already passes while the
 * official entrypoint's temporary init server runs, and a counted loop falls through to the next
 * command when it runs out instead of failing the step.
 *
 * Usage: bun scripts/ci/wait-for-postgres.ts <container> [--timeout=<seconds>]
 */

import { waitForPostgres } from "../utils/docker";
import { getErrorMessage } from "../utils/errors";

const args = Bun.argv.slice(2);
const container = args.find((arg) => !arg.startsWith("--"));
const timeoutArg = args.find((arg) => arg.startsWith("--timeout="));
const timeout = timeoutArg ? Number(timeoutArg.slice("--timeout=".length)) : 60;

if (!container) {
  console.error("Usage: bun scripts/ci/wait-for-postgres.ts <container> [--timeout=<seconds>]");
  process.exit(2);
}

try {
  await waitForPostgres({ container, timeout });
} catch (err) {
  console.error(getErrorMessage(err));
  process.exit(1);
}
