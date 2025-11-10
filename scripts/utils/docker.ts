/**
 * Docker utility functions for test scripts
 * TypeScript equivalent of scripts/lib/common.sh Docker functions
 */
import { getErrorMessage } from "./errors.js";

import { spawn } from "bun";
import { error, info, success } from "./logger.js";

/**
 * Check if Docker daemon is running
 */
export async function checkDockerDaemon(): Promise<boolean> {
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
 * Check if a command exists
 */
export async function checkCommand(cmd: string): Promise<boolean> {
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
 * Clean up Docker container by name
 */
export async function dockerCleanup(containerName: string): Promise<void> {
  try {
    spawn(["docker", "rm", "-f", containerName], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // Ignore errors (container might not exist)
  }
}

/**
 * Wait for PostgreSQL to be ready
 * @param host - PostgreSQL host
 * @param port - PostgreSQL port
 * @param user - PostgreSQL user
 * @param timeout - Timeout in seconds
 * @param container - Optional container name to check from inside container
 */
export async function waitForPostgres(
  host: string = "localhost",
  port: number = 5432,
  user: string = "postgres",
  timeout: number = 60,
  container?: string
): Promise<boolean> {
  info(`Waiting for PostgreSQL at ${host}:${port} (user: ${user}, timeout: ${timeout}s)...`);

  const startTime = Date.now();
  const timeoutMs = timeout * 1000;

  while (Date.now() - startTime < timeoutMs) {
    try {
      let proc;
      if (container) {
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
