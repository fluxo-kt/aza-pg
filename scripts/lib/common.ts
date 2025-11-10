/**
 * Common library for aza-pg scripts
 * Provides shared functions for Docker cleanup and PostgreSQL health checks
 *
 * Note: Logging functions have been moved to ../utils/logger.ts
 *
 * Usage:
 *   import { dockerCleanup, waitForPostgres } from './lib/common.ts';
 *   import { info, success, warning, error } from '../utils/logger.ts';
 */

import { $ } from "bun";
import { info, success } from "../utils/logger.js";

/**
 * Remove a Docker container by name
 * Suppresses errors if the container doesn't exist
 *
 * @param containerName - Name of the container to remove
 * @throws Error if container name is empty
 */
export async function dockerCleanup(containerName: string): Promise<void> {
  if (!containerName || containerName.trim() === "") {
    throw new Error("docker_cleanup: container name is required");
  }

  try {
    await $`docker rm -f ${containerName}`.quiet();
  } catch {
    // Suppress errors if container doesn't exist
  }
}

/**
 * Check if a command exists in PATH
 *
 * @param command - Command name to check
 * @throws Error if command name is empty or command not found
 */
export async function checkCommand(command: string): Promise<void> {
  if (!command || command.trim() === "") {
    throw new Error("check_command: command name is required");
  }

  try {
    await $`command -v ${command}`.quiet();
  } catch {
    throw new Error(`Required command not found: ${command}`);
  }
}

/**
 * Check if Docker daemon is running
 *
 * @throws Error if Docker daemon is not running
 */
export async function checkDockerDaemon(): Promise<void> {
  try {
    await $`docker info`.quiet();
  } catch {
    throw new Error("Docker daemon is not running");
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
 * @throws Error if PostgreSQL is not ready within timeout or invalid parameters
 */
export async function waitForPostgres(options: WaitForPostgresOptions = {}): Promise<void> {
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

  let secondsWaited = 0;
  while (secondsWaited < timeout) {
    try {
      // If container specified, check from inside container
      if (container && container.trim() !== "") {
        await $`docker exec ${container} pg_isready -U ${user}`.quiet();
        success("PostgreSQL is ready");
        return;
      } else {
        // Check from host
        await $`pg_isready -h ${host} -p ${port.toString()} -U ${user}`.quiet();
        success(`PostgreSQL is ready at ${host}:${port}`);
        return;
      }
    } catch {
      // Not ready yet, continue waiting
    }

    await Bun.sleep(2000); // Sleep for 2 seconds
    secondsWaited += 2;
  }

  throw new Error(`PostgreSQL not ready after ${timeout} seconds`);
}
