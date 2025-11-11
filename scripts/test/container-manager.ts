/**
 * Docker Container Manager
 * Provides centralized Docker container lifecycle management for tests
 */

import { $ } from "bun";

export class ContainerManager {
  /**
   * Start Docker containers using docker compose
   * @param stackPath - Path to the stack directory containing docker-compose.yml
   * @param composeFile - Optional compose file name (defaults to docker-compose.yml)
   * @throws Error if containers fail to start
   */
  async start(stackPath: string, composeFile?: string): Promise<void> {
    const composeFileArg = composeFile ? `-f ${composeFile}` : "";

    try {
      await $`cd ${stackPath} && docker compose ${composeFileArg} up -d`.quiet();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to start containers in ${stackPath}: ${errorMsg}`, { cause: error });
    }
  }

  /**
   * Stop and remove Docker containers
   * @param stackPath - Path to the stack directory containing docker-compose.yml
   * @throws Error if containers fail to stop
   */
  async stop(stackPath: string): Promise<void> {
    try {
      await $`cd ${stackPath} && docker compose down -v`.quiet();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to stop containers in ${stackPath}: ${errorMsg}`, { cause: error });
    }
  }

  /**
   * Wait for PostgreSQL to be ready in a container
   * @param containerName - Name of the container running PostgreSQL
   * @param timeout - Maximum wait time in seconds (default: 30)
   * @returns true if PostgreSQL is ready, false if timeout
   * @throws Error if container does not exist or other unexpected error
   */
  async waitForPostgres(containerName: string, timeout: number = 30): Promise<boolean> {
    const maxRetries = timeout;
    let retries = maxRetries;

    while (retries > 0) {
      try {
        const result = await $`docker exec ${containerName} pg_isready -U postgres`.nothrow();

        if (result.exitCode === 0) {
          return true;
        }
      } catch {
        // Container might not exist yet, continue waiting
      }

      await Bun.sleep(1000);
      retries--;
    }

    return false;
  }

  /**
   * Execute a command in a running container
   * @param containerName - Name of the container
   * @param command - Command to execute
   * @returns Object with stdout, stderr, exitCode, and success flag
   */
  async exec(
    containerName: string,
    command: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number; success: boolean }> {
    try {
      const result = await $`docker exec ${containerName} ${command}`.nothrow();

      return {
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        exitCode: result.exitCode,
        success: result.exitCode === 0,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        stdout: "",
        stderr: errorMsg,
        exitCode: 1,
        success: false,
      };
    }
  }

  /**
   * Execute a SQL query via psql in a container
   * @param containerName - Name of the container running PostgreSQL
   * @param sql - SQL query to execute
   * @param user - PostgreSQL user (default: postgres)
   * @returns Object with stdout, stderr, exitCode, and success flag
   */
  async execSQL(
    containerName: string,
    sql: string,
    user: string = "postgres"
  ): Promise<{ stdout: string; stderr: string; exitCode: number; success: boolean }> {
    try {
      const result = await $`docker exec ${containerName} psql -U ${user} -c ${sql}`.nothrow();

      return {
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        exitCode: result.exitCode,
        success: result.exitCode === 0,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        stdout: "",
        stderr: errorMsg,
        exitCode: 1,
        success: false,
      };
    }
  }

  /**
   * Start a single container with docker run
   * @param containerName - Name for the container
   * @param image - Docker image to use
   * @param options - Additional docker run options (environment, volumes, etc.)
   * @throws Error if container fails to start
   */
  async startSingleContainer(
    containerName: string,
    image: string,
    options: {
      env?: Record<string, string>;
      platform?: string;
      detach?: boolean;
    } = {}
  ): Promise<void> {
    const envArgs = Object.entries(options.env ?? {})
      .map(([key, value]) => `-e ${key}=${value}`)
      .join(" ");

    const platformArg = options.platform ? `--platform ${options.platform}` : "";
    const detachArg = options.detach !== false ? "-d" : "";

    try {
      await $`docker run ${detachArg} --name ${containerName} ${platformArg} ${envArgs} ${image}`.quiet();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to start container ${containerName}: ${errorMsg}`, { cause: error });
    }
  }

  /**
   * Stop and remove a single container
   * @param containerName - Name of the container
   * @throws Error if container fails to stop
   */
  async stopSingleContainer(containerName: string): Promise<void> {
    try {
      await $`docker rm -f ${containerName}`.quiet();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to stop container ${containerName}: ${errorMsg}`, { cause: error });
    }
  }
}
