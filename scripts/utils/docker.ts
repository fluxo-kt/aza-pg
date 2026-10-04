/**
 * Docker utility functions for test scripts
 * Consolidated from scripts/lib/common.ts and scripts/utils/docker.ts
 *
 * This module provides both boolean-returning and exception-throwing variants:
 * - Boolean variants: Useful for conditional logic, return true/false
 * - Throwing variants: Useful for prerequisite checks, throw descriptive errors
 */
import { getErrorMessage } from "./errors";

import { spawn } from "bun";
import { error, info, success } from "./logger";

/**
 * Check if Docker daemon is running
 * @returns true if Docker daemon is accessible, false otherwise
 */
export async function isDockerDaemonRunning(): Promise<boolean> {
  try {
    const proc = spawn(["docker", "info"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Check if Docker daemon is running (throws on failure)
 * @throws Error if Docker daemon is not running
 */
export async function checkDockerDaemon(): Promise<void> {
  const isRunning = await isDockerDaemonRunning();
  if (!isRunning) {
    throw new Error("Docker daemon is not running");
  }
}

/**
 * Check if a command exists in PATH
 * @param cmd - Command name to check
 * @returns true if command exists, false otherwise
 */
export async function hasCommand(cmd: string): Promise<boolean> {
  if (!cmd || cmd.trim() === "") {
    return false;
  }

  try {
    const proc = spawn(["which", cmd], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Check if a command exists in PATH (throws on failure)
 * @param cmd - Command name to check
 * @throws Error if command name is empty or command not found
 */
export async function checkCommand(cmd: string): Promise<void> {
  if (!cmd || cmd.trim() === "") {
    throw new Error("checkCommand: command name is required");
  }

  const exists = await hasCommand(cmd);
  if (!exists) {
    throw new Error(`Required command not found: ${cmd}`);
  }
}

/**
 * Remove a Docker container by name
 * Suppresses errors if the container doesn't exist
 * @param containerName - Name of the container to remove
 * @throws Error if container name is empty
 */
export async function dockerCleanup(containerName: string): Promise<void> {
  if (!containerName || containerName.trim() === "") {
    throw new Error("dockerCleanup: container name is required");
  }

  try {
    // `-v` removes the container's ANONYMOUS volumes (never named ones). Test containers run the
    // image without an explicit `-v`, so PG18's anonymous `/var/lib/postgresql` PGDATA volume would
    // otherwise be orphaned on every teardown — the source of large dangling-volume accumulation.
    const proc = spawn(["docker", "rm", "-f", "-v", containerName], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  } catch {
    // Ignore errors (container might not exist)
  }
}

/**
 * Ensure Docker image is available locally
 * If the image is not found locally and appears to be a registry image,
 * attempts to pull it automatically.
 *
 * @param imageTag - Docker image tag (e.g., "aza-pg:pg18" or "ghcr.io/org/image:tag")
 * @throws Error if image cannot be found or pulled
 */
export async function ensureImageAvailable(imageTag: string): Promise<void> {
  if (!imageTag || imageTag.trim() === "") {
    throw new Error("ensureImageAvailable: image tag is required");
  }

  // Check if image exists locally
  try {
    const proc = spawn(["docker", "image", "inspect", imageTag], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      return; // Image found locally
    }
  } catch {
    // Image not in local cache, continue to pull logic
  }

  // Determine if this is a registry image (not a simple tag or localhost)
  const isRegistryImage = imageTag.includes("/") && !imageTag.startsWith("localhost/");

  if (isRegistryImage) {
    info(`Image not found locally, pulling from registry: ${imageTag}`);
    try {
      const pullProc = spawn(["docker", "pull", imageTag], {
        stdout: "inherit",
        stderr: "inherit",
      });
      const pullExitCode = await pullProc.exited;

      if (pullExitCode === 0) {
        success(`Successfully pulled image: ${imageTag}`);
        return;
      } else {
        error(`Failed to pull image: ${imageTag}`);
        throw new Error(`Docker pull failed with exit code ${pullExitCode}`);
      }
    } catch (pullError) {
      error(`Failed to pull image: ${imageTag}`);
      throw pullError;
    }
  }

  // Local image that doesn't exist
  error(`Docker image not found: ${imageTag}`);
  console.log("   Build it first: bun run build");
  throw new Error(`Image not available: ${imageTag}`);
}

/**
 * Options for waiting for PostgreSQL to be ready
 */
export interface WaitForPostgresOptions {
  /** PostgreSQL host (default: localhost) */
  host?: string;
  /** PostgreSQL port (default: 5432) */
  port?: number;
  /** PostgreSQL user (default: postgres) */
  user?: string;
  /** Timeout in seconds (default: 60) */
  timeout?: number;
  /** Docker container name (if checking from inside container) */
  container?: string;
}

async function dockerText(args: string[]): Promise<{ code: number; text: string }> {
  const proc = spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, text: out + err };
}

/**
 * Wait until the container's FINAL PostgreSQL server accepts queries; throws on timeout or if the container stops.
 *
 * Why not pg_isready: on a fresh data directory the official entrypoint first runs a temporary server for the init
 * scripts, and pg_isready succeeds against it moments before it is shut down for the real start — so tests began
 * against a server about to vanish. Readiness is therefore read from the logs of the CURRENT container start
 * (`docker logs --since StartedAt`, so restarts are handled): after "init process complete" (fresh data) or
 * "Skipping initialization" (existing data), the next "ready to accept connections" (a standby says "read-only
 * connections") is the final server; a `SELECT 1` then confirms it. Fixed sleeps only pace the polling; they never decide readiness.
 */
async function waitForContainerPostgres(
  container: string,
  user: string,
  timeoutSeconds: number
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const startedAt = (
    await dockerText(["inspect", "-f", "{{.State.StartedAt}}", container])
  ).text.trim();
  let logs = "";
  while (Date.now() < deadline) {
    logs = (await dockerText(["logs", "--since", startedAt, container])).text;
    const marker = Math.max(
      logs.lastIndexOf("PostgreSQL init process complete"),
      logs.lastIndexOf("Skipping initialization")
    );
    if (marker >= 0 && /ready to accept (read-only )?connections/.test(logs.slice(marker))) {
      const probe = await dockerText([
        "exec",
        container,
        "psql",
        "-X",
        "-U",
        user,
        "-tAc",
        "SELECT 1",
      ]);
      if (probe.code === 0 && probe.text.trim() === "1") {
        success(`PostgreSQL in ${container} is ready`);
        return;
      }
    }
    const running = (
      await dockerText(["inspect", "-f", "{{.State.Running}}", container])
    ).text.trim();
    if (running !== "true") {
      throw new Error(
        `Container ${container} stopped before PostgreSQL was ready. Last log lines:\n${lastLines(logs, 40)}`
      );
    }
    await Bun.sleep(250);
  }
  throw new Error(
    `PostgreSQL in ${container} not ready after ${timeoutSeconds}s. Last log lines:\n${lastLines(logs, 40)}`
  );
}

function lastLines(text: string, count: number): string {
  return text.trimEnd().split("\n").slice(-count).join("\n");
}

/**
 * Wait for PostgreSQL to be ready.
 * With `container`: waits for the container's final server (see waitForContainerPostgres) and THROWS on failure,
 * so a caller can never proceed against a server that is not there; it returns true only for callers' convenience.
 * Without `container`: polls pg_isready on host:port and returns false on timeout (host tools decide what to do).
 *
 * @param options - Configuration options
 * @returns true if PostgreSQL becomes ready; false only in host mode on timeout
 * @throws Error on invalid parameters, and in container mode on timeout or a stopped container
 */
export async function waitForPostgres(options: WaitForPostgresOptions = {}): Promise<boolean> {
  const host = options.host ?? "localhost";
  const port = options.port ?? 5432;
  const user = options.user ?? "postgres";
  const timeout = options.timeout ?? 60;
  const container = options.container;

  // Validate timeout is a positive integer
  if (!Number.isInteger(timeout) || timeout < 0) {
    throw new Error(`Invalid timeout value: ${timeout} (must be a positive integer)`);
  }

  if (container && container.trim() !== "") {
    await waitForContainerPostgres(container, user, timeout);
    return true;
  }

  // Validate port is a number
  if (!Number.isInteger(port)) {
    throw new Error(`Invalid port value: ${port} (must be a number between 1-65535)`);
  }

  // Validate port range
  if (port < 1 || port > 65535) {
    throw new Error(`Port out of range: ${port} (must be between 1-65535)`);
  }

  info(`Waiting for PostgreSQL at ${host}:${port} (user: ${user}, timeout: ${timeout}s)...`);

  const startTime = Date.now();
  const timeoutMs = timeout * 1000;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const proc = spawn(["pg_isready", "-h", host, "-p", String(port), "-U", user], {
        stdout: "ignore",
        stderr: "ignore",
      });
      const exitCode = await proc.exited;
      if (exitCode === 0) {
        success(`PostgreSQL is ready at ${host}:${port}`);
        return true;
      }
    } catch {
      // Ignore errors, continue waiting
    }

    await Bun.sleep(2000); // Sleep 2 seconds
  }

  error(`PostgreSQL not ready after ${timeout} seconds`);
  return false;
}

/**
 * Run docker command and return stdout + stderr
 * When command fails, stderr is included in output for error diagnosis
 */
export async function dockerRun(args: string[]): Promise<{ success: boolean; output: string }> {
  try {
    const proc = spawn(["docker", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    // On success, return stdout only
    // On failure, combine stderr (errors) with stdout (if any)
    const output = exitCode === 0 ? stdout.trim() : `${stderr.trim()}\n${stdout.trim()}`.trim();

    return {
      success: exitCode === 0,
      output,
    };
  } catch (err) {
    return {
      success: false,
      output: getErrorMessage(err),
    };
  }
}

/**
 * Run docker command and stream output
 */
export async function dockerRunLive(args: string[]): Promise<number> {
  const proc = spawn(["docker", ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });

  return await proc.exited;
}

/**
 * Generate unique container name for test isolation
 * Format: {prefix}-{timestamp}-{pid}
 * @param prefix - Prefix for the container name (default: "aza-pg-test")
 * @returns Unique container name
 */
export function generateUniqueContainerName(prefix: string = "aza-pg-test"): string {
  return `${prefix}-${Date.now()}-${process.pid}`;
}

/**
 * Generate unique project name for Docker Compose test isolation
 * Format: {prefix}-{timestamp}-{pid}
 * @param prefix - Prefix for the project name (default: "aza-pg-test")
 * @returns Unique project name
 */
export function generateUniqueProjectName(prefix: string = "aza-pg-test"): string {
  return `${prefix}-${Date.now()}-${process.pid}`;
}

/**
 * Cleanup Docker container with verification
 * @param containerName - Name of the container to cleanup
 * @returns true if cleanup succeeded or container doesn't exist, false if container still exists
 */
export async function cleanupContainer(containerName: string): Promise<boolean> {
  if (!containerName || containerName.trim() === "") {
    throw new Error("cleanupContainer: container name is required");
  }

  try {
    // Stop and remove container. `-v` drops its anonymous PGDATA volume too (see dockerCleanup);
    // named volumes are unaffected, so this is safe for stacks that rely on persistence.
    const rmProc = spawn(["docker", "rm", "-f", "-v", containerName], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await rmProc.exited;

    // Verify removal
    const checkProc = spawn(
      ["docker", "ps", "-a", "--filter", `name=${containerName}`, "--format", "{{.Names}}"],
      {
        stdout: "pipe",
        stderr: "ignore",
      }
    );
    const stdout = await new Response(checkProc.stdout).text();
    await checkProc.exited;

    const exists = stdout.trim().length > 0;
    if (exists) {
      error(`Warning: Container ${containerName} still exists after cleanup`);
      return false;
    }
    return true;
  } catch {
    // If docker commands fail, assume container doesn't exist
    return true;
  }
}
