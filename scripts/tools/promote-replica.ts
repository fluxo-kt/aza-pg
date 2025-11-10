#!/usr/bin/env bun
/**
 * Promote PostgreSQL replica to primary
 *
 * USAGE:
 *   ./promote-replica.ts [OPTIONS]
 *
 * OPTIONS:
 *   -c, --container NAME    Container name (default: postgres-replica)
 *   -d, --data-dir PATH     Data directory path (default: /var/lib/postgresql/data)
 *   -n, --no-backup         Skip backup before promotion (not recommended)
 *   -y, --yes               Skip confirmation prompt
 *   -h, --help              Show this help message
 *
 * DESCRIPTION:
 *   Promotes a PostgreSQL replica to primary role by:
 *   1. Verifying replica is in recovery mode
 *   2. Creating backup of current state (optional)
 *   3. Stopping the replica container
 *   4. Promoting replica using pg_ctl promote
 *   5. Updating configuration for primary role
 *   6. Restarting as primary
 *
 * EXAMPLES:
 *   # Promote default replica container
 *   ./promote-replica.ts
 *
 *   # Promote specific container without confirmation
 *   ./promote-replica.ts -c my-replica -y
 *
 *   # Promote without backup (fast, risky)
 *   ./promote-replica.ts -n -y
 *
 * PREREQUISITES:
 *   - Docker or Docker Compose installed
 *   - Replica container running in standby mode
 *   - Sufficient disk space for backup (unless -n used)
 *
 * WARNINGS:
 *   - This is a one-way operation - cannot revert to replica after promotion
 *   - Old primary must be stopped before promoting replica to avoid split-brain
 *   - Ensure clients are redirected to new primary after promotion
 */

import { $ } from "bun";
import { logInfo, logSuccess, logWarning, logError } from "../lib/common.ts";

interface PromoteConfig {
  containerName: string;
  dataDir: string;
  createBackup: boolean;
  skipConfirmation: boolean;
}

/**
 * Show usage information
 */
function showHelp(): void {
  process.stdout.write(`
Promote PostgreSQL replica to primary

USAGE:
  ./promote-replica.ts [OPTIONS]

OPTIONS:
  -c, --container NAME    Container name (default: postgres-replica)
  -d, --data-dir PATH     Data directory path (default: /var/lib/postgresql/data)
  -n, --no-backup         Skip backup before promotion (not recommended)
  -y, --yes               Skip confirmation prompt
  -h, --help              Show this help message

DESCRIPTION:
  Promotes a PostgreSQL replica to primary role by:
  1. Verifying replica is in recovery mode
  2. Creating backup of current state (optional)
  3. Stopping the replica container
  4. Promoting replica using pg_ctl promote
  5. Updating configuration for primary role
  6. Restarting as primary

EXAMPLES:
  # Promote default replica container
  ./promote-replica.ts

  # Promote specific container without confirmation
  ./promote-replica.ts -c my-replica -y

  # Promote without backup (fast, risky)
  ./promote-replica.ts -n -y

PREREQUISITES:
  - Docker or Docker Compose installed
  - Replica container running in standby mode
  - Sufficient disk space for backup (unless -n used)

WARNINGS:
  - This is a one-way operation - cannot revert to replica after promotion
  - Old primary must be stopped before promoting replica to avoid split-brain
  - Ensure clients are redirected to new primary after promotion
`);
  process.exit(0);
}

/**
 * Parse command line arguments
 */
function parseArgs(): PromoteConfig {
  const args = process.argv.slice(2);
  const config: PromoteConfig = {
    containerName: process.env.POSTGRES_CONTAINER_NAME || "postgres-replica",
    dataDir: "/var/lib/postgresql/data",
    createBackup: true,
    skipConfirmation: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "-c":
      case "--container":
        if (i + 1 >= args.length) {
          logError("Missing value for --container option");
          process.exit(1);
        }
        config.containerName = args[++i] ?? "";
        break;

      case "-d":
      case "--data-dir":
        if (i + 1 >= args.length) {
          logError("Missing value for --data-dir option");
          process.exit(1);
        }
        config.dataDir = args[++i] ?? "";
        break;

      case "-n":
      case "--no-backup":
        config.createBackup = false;
        break;

      case "-y":
      case "--yes":
        config.skipConfirmation = true;
        break;

      case "-h":
      case "--help":
        showHelp();
        break;

      default:
        logError(`Unknown option: ${arg}. Use -h for help.`);
        process.exit(1);
    }
  }

  return config;
}

/**
 * Check prerequisites
 */
async function checkPrerequisites(config: PromoteConfig): Promise<void> {
  logInfo("Checking prerequisites...");

  // Check if docker is available
  try {
    await $`command -v docker`.quiet();
  } catch {
    logError("Docker is not installed or not in PATH");
    process.exit(1);
  }

  // Check if container exists
  try {
    const containers = await $`docker ps -a --format {{.Names}}`.text();
    const containerList = containers.split("\n").filter((name) => name.trim() !== "");
    if (!containerList.includes(config.containerName)) {
      logError(`Container '${config.containerName}' does not exist`);
      process.exit(1);
    }
  } catch {
    logError(`Failed to check if container '${config.containerName}' exists`);
    process.exit(1);
  }

  // Check if container is running
  try {
    const runningContainers = await $`docker ps --format {{.Names}}`.text();
    const runningList = runningContainers.split("\n").filter((name) => name.trim() !== "");
    if (!runningList.includes(config.containerName)) {
      logError(`Container '${config.containerName}' is not running`);
      process.exit(1);
    }
  } catch {
    logError(`Failed to check if container '${config.containerName}' is running`);
    process.exit(1);
  }

  logSuccess("Prerequisites check passed");
}

/**
 * Verify replica is in recovery mode
 */
async function verifyReplicaState(config: PromoteConfig): Promise<void> {
  logInfo("Verifying replica state...");

  try {
    const result =
      await $`docker exec ${config.containerName} psql -U postgres -t -c "SELECT pg_is_in_recovery();"`.text();
    const inRecovery = result.trim();

    if (inRecovery !== "t") {
      logError(`Container '${config.containerName}' is not in recovery mode (already a primary?)`);
      process.exit(1);
    }

    logSuccess("Confirmed: Container is in standby/recovery mode");
  } catch {
    logError("Failed to verify replica state");
    process.exit(1);
  }
}

/**
 * Create backup before promotion
 */
async function createBackup(config: PromoteConfig): Promise<void> {
  if (!config.createBackup) {
    logWarning("Skipping backup (--no-backup flag set)");
    return;
  }

  logInfo("Creating backup before promotion...");

  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, "_")
    .replace(/\.\d{3}Z$/, "");
  const backupName = `pre-promotion-backup-${timestamp}`;

  try {
    await $`docker exec ${config.containerName} pg_basebackup -D /backup/${backupName} -F tar -z -P`;
    logSuccess(`Backup created: /backup/${backupName}`);
  } catch {
    logWarning("Backup failed, but continuing with promotion");
    logWarning("Manual backup recommended if this is production");
  }
}

/**
 * Confirm promotion
 */
async function confirmPromotion(config: PromoteConfig): Promise<void> {
  if (config.skipConfirmation) {
    return;
  }

  process.stdout.write("\n");
  logWarning("=========================================");
  logWarning("REPLICA PROMOTION WARNING");
  logWarning("=========================================");
  process.stdout.write("You are about to promote replica to primary.\n");
  process.stdout.write("\n");
  process.stdout.write(`Container: ${config.containerName}\n`);
  process.stdout.write(`Data Dir:  ${config.dataDir}\n`);
  process.stdout.write(`Backup:    ${config.createBackup ? "Yes" : "No"}\n`);
  process.stdout.write("\n");
  logWarning("IMPORTANT:");
  process.stdout.write("  - This is a ONE-WAY operation\n");
  process.stdout.write("  - Ensure old primary is STOPPED to avoid split-brain\n");
  process.stdout.write("  - Clients must be redirected to new primary after promotion\n");
  process.stdout.write("  - Replication slots from old primary will be lost\n");
  process.stdout.write("\n");
  process.stdout.write("Continue with promotion? [yes/NO]: ");

  // Read user input
  const input = await readLine();
  const response = input.trim().toLowerCase();

  if (response !== "yes") {
    logInfo("Promotion cancelled by user");
    process.exit(0);
  }
}

/**
 * Read a line from stdin
 */
async function readLine(): Promise<string> {
  const decoder = new TextDecoder();
  const bytesRead = await Bun.stdin.stream().getReader().read();
  if (bytesRead.value) {
    return decoder.decode(bytesRead.value);
  }
  return "";
}

/**
 * Stop replica container
 */
async function stopContainer(config: PromoteConfig): Promise<void> {
  logInfo(`Stopping container '${config.containerName}'...`);

  try {
    await $`docker stop ${config.containerName}`.quiet();
    logSuccess("Container stopped");
  } catch {
    logError("Failed to stop container");
    process.exit(1);
  }
}

/**
 * Promote replica using pg_ctl
 */
async function promoteReplica(config: PromoteConfig): Promise<void> {
  logInfo("Promoting replica to primary...");

  // Start container temporarily to run pg_ctl promote
  try {
    await $`docker start ${config.containerName}`.quiet();
  } catch {
    logError("Failed to start container");
    process.exit(1);
  }

  // Wait for container to be ready
  await Bun.sleep(2000);

  // Run pg_ctl promote
  try {
    await $`docker exec ${config.containerName} su - postgres -c "pg_ctl promote -D ${config.dataDir}"`;
    logSuccess("Replica promoted successfully");
  } catch {
    logError("Failed to promote replica");
    process.exit(1);
  }

  // Wait for promotion to complete
  logInfo("Waiting for promotion to complete...");
  await Bun.sleep(5000);

  // Verify promotion
  try {
    const result =
      await $`docker exec ${config.containerName} psql -U postgres -t -c "SELECT pg_is_in_recovery();"`.text();
    const inRecovery = result.trim();

    if (inRecovery === "f") {
      logSuccess("Promotion verified: Container is now a primary");
    } else {
      logError("Promotion verification failed: Container still in recovery mode");
      process.exit(1);
    }
  } catch {
    logError("Failed to verify promotion");
    process.exit(1);
  }
}

/**
 * Update configuration for primary role
 */
async function updateConfiguration(config: PromoteConfig): Promise<void> {
  logInfo("Updating configuration for primary role...");

  // Remove standby.signal if it exists
  try {
    const testResult =
      await $`docker exec ${config.containerName} test -f ${config.dataDir}/standby.signal`.quiet();
    if (testResult.exitCode === 0) {
      await $`docker exec ${config.containerName} rm -f ${config.dataDir}/standby.signal`;
      logSuccess("Removed standby.signal");
    }
  } catch {
    // File doesn't exist or already removed
  }

  // Note: Config changes (e.g., hot_standby settings) are typically handled
  // by postgresql.conf mounted from host. If using auto-config, no changes needed.

  logSuccess("Configuration updated");
}

/**
 * Restart as primary
 */
async function restartPrimary(config: PromoteConfig): Promise<void> {
  logInfo("Restarting container as primary...");

  // Stop container
  try {
    await $`docker stop ${config.containerName}`.quiet();
  } catch {
    logError("Failed to stop container");
    process.exit(1);
  }

  // Start container
  try {
    await $`docker start ${config.containerName}`.quiet();
    logSuccess("Container restarted");
  } catch {
    logError("Failed to restart container");
    process.exit(1);
  }

  // Wait for PostgreSQL to be ready
  logInfo("Waiting for PostgreSQL to accept connections...");
  const maxAttempts = 30;
  let attempt = 0;

  while (attempt < maxAttempts) {
    try {
      await $`docker exec ${config.containerName} pg_isready -U postgres`.quiet();
      logSuccess("PostgreSQL is ready and accepting connections");
      return;
    } catch {
      // Not ready yet
    }

    attempt++;
    await Bun.sleep(1000);
  }

  logError(`PostgreSQL failed to start within ${maxAttempts} seconds`);
  process.exit(1);
}

/**
 * Display post-promotion instructions
 */
function showPostPromotionInstructions(config: PromoteConfig): void {
  process.stdout.write("\n");
  logSuccess("=========================================");
  logSuccess("PROMOTION COMPLETE");
  logSuccess("=========================================");
  process.stdout.write("\n");
  process.stdout.write("Next steps:\n");
  process.stdout.write("\n");
  process.stdout.write("1. Verify primary status:\n");
  process.stdout.write(
    `   docker exec ${config.containerName} psql -U postgres -c "SELECT pg_is_in_recovery();"\n`
  );
  process.stdout.write("\n");
  process.stdout.write("2. Check replication slots (if setting up new replicas):\n");
  process.stdout.write(
    `   docker exec ${config.containerName} psql -U postgres -c "SELECT * FROM pg_replication_slots;"\n`
  );
  process.stdout.write("\n");
  process.stdout.write("3. Update application connection strings to point to new primary\n");
  process.stdout.write("\n");
  process.stdout.write("4. Configure new replicas to connect to this primary (if needed)\n");
  process.stdout.write("\n");
  process.stdout.write("5. Stop or reconfigure old primary to prevent split-brain\n");
  process.stdout.write("\n");
  logWarning("IMPORTANT: Ensure only ONE primary exists in your cluster!");
  process.stdout.write("\n");
}

/**
 * Main function
 */
async function main(): Promise<void> {
  const config = parseArgs();

  process.stdout.write("\n");
  logInfo("=========================================");
  logInfo("PostgreSQL Replica Promotion Script");
  logInfo("=========================================");
  process.stdout.write("\n");

  await checkPrerequisites(config);
  await verifyReplicaState(config);
  await confirmPromotion(config);
  await createBackup(config);
  await stopContainer(config);
  await promoteReplica(config);
  await updateConfiguration(config);
  await restartPrimary(config);
  showPostPromotionInstructions(config);
}

// Run main function
main().catch((error) => {
  logError(error.message);
  process.exit(1);
});
