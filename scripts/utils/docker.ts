/**
 * Docker utility functions for test scripts
 * Consolidated from scripts/lib/common.ts and scripts/utils/docker.ts
 *
 * This module provides both boolean-returning and exception-throwing variants:
 * - Boolean variants: Useful for conditional logic, return true/false
 * - Throwing variants: Useful for prerequisite checks, throw descriptive errors
 */
import { getErrorMessage } from "./errors.js";

import { spawn } from "bun";
import { error, info, success } from "./logger.js";

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
    const proc = spawn(["docker", "rm", "-f", containerName], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  } catch {
    // Ignore errors (container might not exist)
  }
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

/**
 * Wait for PostgreSQL to be ready
 * If container is provided, runs pg_isready inside container (for Docker tests)
 *
 * @param options - Configuration options
 * @returns true if PostgreSQL becomes ready, false if timeout reached
 * @throws Error if invalid parameters provided
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
      let proc;
      if (container && container.trim() !== "") {
        // Check from inside container
        proc = spawn(["docker", "exec", container, "pg_isready", "-U", user], {
          stdout: "ignore",
          stderr: "ignore",
        });
      } else {
        // Check from host
        proc = spawn(["pg_isready", "-h", host, "-p", String(port), "-U", user], {
          stdout: "ignore",
          stderr: "ignore",
        });
      }

      const exitCode = await proc.exited;
      if (exitCode === 0) {
        success(`PostgreSQL is ready${container ? "" : ` at ${host}:${port}`}`);
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
 * Run docker command and return stdout
 */
export async function dockerRun(args: string[]): Promise<{ success: boolean; output: string }> {
  try {
    const proc = spawn(["docker", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    return {
      success: exitCode === 0,
      output: output.trim(),
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
