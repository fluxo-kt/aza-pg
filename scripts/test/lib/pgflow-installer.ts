/**
 * pgflow Schema Auto-Installer for Tests
 *
 * Provides idempotent pgflow schema installation for test containers.
 * Automatically checks if schema exists and installs only if missing.
 *
 * Usage:
 *   import { installPgflowSchemaIfNeeded } from "../test/lib/pgflow-installer";
 *   const installed = await installPgflowSchemaIfNeeded("container-name");
 */

import { isPgflowInstalled, installPgflowSchema } from "../../../tests/fixtures/pgflow/install";
import { info, success, warning, error as logError } from "../../utils/logger";

export interface PgflowInstallResult {
  /**
   * Whether installation was needed and successful
   */
  installed: boolean;

  /**
   * Whether pgflow schema is now available (installed or already present)
   */
  available: boolean;

  /**
   * Error message if installation failed
   */
  error?: string;

  /**
   * Statistics from installation
   */
  stats?: {
    tablesCreated?: number;
    functionsCreated?: number;
  };
}

/**
 * Install pgflow schema if it's not already present in the container.
 * This function is idempotent - safe to call multiple times.
 *
 * @param containerName - Docker container name
 * @param database - Database name (default: "postgres")
 * @param user - PostgreSQL user (default: "postgres")
 * @returns Installation result with status
 */
export async function installPgflowSchemaIfNeeded(
  containerName: string,
  database: string = "postgres",
  user: string = "postgres"
): Promise<PgflowInstallResult> {
  try {
    // Check if pgflow schema already exists
    info(`Checking pgflow schema status in ${containerName}...`);
    const isInstalled = await isPgflowInstalled(containerName, database, user);

    if (isInstalled) {
      success("pgflow schema already installed, skipping");
      return {
        installed: false,
        available: true,
      };
    }

    // Install pgflow schema
    info("pgflow schema not found, installing...");
    const result = await installPgflowSchema(containerName, database, user);

    if (!result.success) {
      logError(`Failed to install pgflow schema: ${result.stderr}`);
      return {
        installed: false,
        available: false,
        error: result.stderr,
      };
    }

    success(
      `pgflow schema installed successfully (${result.tablesCreated} tables, ${result.functionsCreated} functions)`
    );

    return {
      installed: true,
      available: true,
      stats: {
        tablesCreated: result.tablesCreated,
        functionsCreated: result.functionsCreated,
      },
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logError(`pgflow installation error: ${errorMessage}`);
    return {
      installed: false,
      available: false,
      error: errorMessage,
    };
  }
}

/**
 * Verify pgflow schema is available in container.
 * Use this to check schema status without installing.
 *
 * @param containerName - Docker container name
 * @param database - Database name (default: "postgres")
 * @param user - PostgreSQL user (default: "postgres")
 * @returns True if schema exists, false otherwise
 */
export async function verifyPgflowSchema(
  containerName: string,
  database: string = "postgres",
  user: string = "postgres"
): Promise<boolean> {
  try {
    return await isPgflowInstalled(containerName, database, user);
  } catch (err) {
    warning(`Failed to verify pgflow schema: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
