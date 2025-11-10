#!/usr/bin/env bun
/**
 * Restore PostgreSQL database from backup
 * Usage: ./restore-postgres.ts <backup-file> [database]
 * Environment: PGHOST, PGPORT, PGUSER, PGPASSWORD
 *
 * Examples:
 *   ./restore-postgres.ts backup.sql.gz                    # Restore to 'postgres' database
 *   ./restore-postgres.ts backup.sql.gz mydb                # Restore to 'mydb' database
 *   PGHOST=db.example.com ./restore-postgres.ts backup.sql.gz
 */

import { $ } from "bun";
import { checkCommand, waitForPostgres, logInfo, logSuccess, logError } from "../lib/common.ts";

interface RestoreConfig {
  backupFile: string;
  database: string;
  pgHost: string;
  pgPort: number;
  pgUser: string;
  pgPassword?: string;
}

/**
 * Check if a command exists in PATH
 */
async function commandExists(command: string): Promise<boolean> {
  try {
    await checkCommand(command);
    return true;
  } catch {
    return false;
  }
}

/**
 * Guard: Check required commands
 */
async function checkRequiredCommands(): Promise<void> {
  const commands = ["psql", "pg_isready", "gunzip"];

  for (const cmd of commands) {
    if (!(await commandExists(cmd))) {
      logError(`Required command not found: ${cmd}`);
      process.stdout.write(
        "   Install PostgreSQL client tools: https://www.postgresql.org/download/\n"
      );
      process.exit(1);
    }
  }
}

/**
 * Show usage information
 */
function showUsage(): void {
  const scriptName = process.argv[1];
  logError("Backup file argument required");
  process.stdout.write("\n");
  process.stdout.write(`Usage: ${scriptName} <backup-file> [database]\n`);
  process.stdout.write("\n");
  process.stdout.write("Examples:\n");
  process.stdout.write(
    `  ${scriptName} backup_20250131_120000.sql.gz                # Restore to 'postgres' db\n`
  );
  process.stdout.write(
    `  ${scriptName} backup_20250131_120000.sql.gz mydb            # Restore to 'mydb' db\n`
  );
  process.stdout.write(
    `  PGHOST=remote.host ${scriptName} backup.sql.gz              # Restore to remote host\n`
  );
  process.exit(1);
}

/**
 * Parse configuration from arguments and environment
 */
function parseConfig(): RestoreConfig {
  const args = process.argv.slice(2);

  // Guard: Check backup file argument
  if (args.length === 0 || !args[0]) {
    showUsage();
  }

  const backupFile = args[0];
  const database = args[1] || "postgres";

  const pgHost = process.env.PGHOST || "localhost";
  const pgPort = Number.parseInt(process.env.PGPORT || "5432", 10);
  const pgUser = process.env.PGUSER || "postgres";
  const pgPassword = process.env.PGPASSWORD;

  return {
    backupFile,
    database,
    pgHost,
    pgPort,
    pgUser,
    pgPassword,
  };
}

/**
 * Guard: Verify backup file exists
 */
async function verifyBackupFile(backupFile: string): Promise<void> {
  const exists = await Bun.file(backupFile).exists();
  if (!exists) {
    logError(`Backup file not found: ${backupFile}`);
    process.stdout.write(`   Check file path: ls -la $(dirname "${backupFile}")\n`);
    process.exit(1);
  }

  // Check if readable by attempting to read file
  try {
    const file = Bun.file(backupFile);
    await file.slice(0, 1).arrayBuffer();
  } catch {
    logError(`Backup file not readable: ${backupFile}`);
    process.stdout.write(`   Check permissions: ls -la ${backupFile}\n`);
    process.exit(1);
  }
}

/**
 * Guard: Verify backup file format
 */
async function verifyBackupFormat(backupFile: string): Promise<void> {
  if (backupFile.endsWith(".gz")) {
    try {
      await $`gzip -t ${backupFile}`.quiet();
    } catch {
      logError("Backup file is corrupted (invalid gzip format)");
      process.stdout.write(`   File: ${backupFile}\n`);
      process.stdout.write(`   Try: gunzip -t ${backupFile}\n`);
      process.exit(1);
    }
  }
}

/**
 * Guard: Check PGPASSWORD for remote connections
 */
function checkPgPassword(config: RestoreConfig): void {
  if (config.pgHost !== "localhost" && config.pgHost !== "127.0.0.1" && !config.pgPassword) {
    logError("PGPASSWORD environment variable required for remote connections");
    process.stdout.write("   Set password: export PGPASSWORD='your_password'\n");
    process.stdout.write(
      "   Or use .pgpass file: https://www.postgresql.org/docs/current/libpq-pgpass.html\n"
    );
    process.exit(1);
  }
}

/**
 * Warn about destructive operation and get user confirmation
 */
async function confirmRestore(database: string): Promise<void> {
  process.stdout.write(`\n⚠️  WARNING: This will overwrite the database '${database}'\n`);
  process.stdout.write("Press Ctrl+C to cancel, or Enter to continue...\n");

  // Read user input
  for await (const line of console) {
    // User pressed Enter, continue
    return;
  }
}

/**
 * Perform the restore operation
 */
async function performRestore(config: RestoreConfig): Promise<void> {
  logInfo("Restoring backup...");

  try {
    if (config.backupFile.endsWith(".gz")) {
      process.stdout.write("Decompressing and restoring...\n");
      await $`gunzip -c ${config.backupFile} | psql -h ${config.pgHost} -p ${config.pgPort.toString()} -U ${config.pgUser} -d ${config.database} --quiet`.quiet();
    } else {
      process.stdout.write("Restoring uncompressed backup...\n");
      await $`psql -h ${config.pgHost} -p ${config.pgPort.toString()} -U ${config.pgUser} -d ${config.database} -f ${config.backupFile} --quiet`.quiet();
    }
  } catch {
    process.stdout.write("\n");
    logError("Restore failed");
    process.stdout.write("   Check psql output above for details\n");
    process.stdout.write("   Common issues:\n");
    process.stdout.write(
      `   - Database '${config.database}' does not exist: createdb -h ${config.pgHost} -U ${config.pgUser} ${config.database}\n`
    );
    process.stdout.write(`   - Insufficient permissions for user ${config.pgUser}\n`);
    process.stdout.write("   - Conflicting extensions: DROP EXTENSION ... CASCADE\n");
    process.stdout.write("   - Check PostgreSQL logs: docker logs <postgres-container>\n");
    process.exit(1);
  }
}

/**
 * Verify restore by showing database stats
 */
async function verifyRestore(config: RestoreConfig): Promise<void> {
  process.stdout.write("\nDatabase stats:\n");

  try {
    const stats =
      await $`psql -h ${config.pgHost} -p ${config.pgPort.toString()} -U ${config.pgUser} -d ${config.database} -c "SELECT schemaname, tablename, pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC LIMIT 10;"`.text();
    process.stdout.write(stats);
  } catch {
    process.stdout.write("(Could not retrieve table statistics)\n");
  }
}

/**
 * Main function
 */
async function main(): Promise<void> {
  await checkRequiredCommands();

  const config = parseConfig();

  await verifyBackupFile(config.backupFile);
  await verifyBackupFormat(config.backupFile);
  checkPgPassword(config);

  process.stdout.write("========================================\n");
  process.stdout.write("PostgreSQL Restore\n");
  process.stdout.write("========================================\n");
  process.stdout.write(`Backup file: ${config.backupFile}\n`);
  process.stdout.write(`Database: ${config.database}\n`);
  process.stdout.write(`Host: ${config.pgHost}:${config.pgPort}\n`);
  process.stdout.write(`User: ${config.pgUser}\n`);
  process.stdout.write("\n");

  // Check PostgreSQL is accessible
  try {
    await waitForPostgres({
      host: config.pgHost,
      port: config.pgPort,
      user: config.pgUser,
      timeout: 10,
    });
  } catch {
    process.stdout.write("   Troubleshooting:\n");
    process.stdout.write(
      `   - Verify host/port: pg_isready -h ${config.pgHost} -p ${config.pgPort}\n`
    );
    process.stdout.write("   - Check PostgreSQL is running: docker ps | grep postgres\n");
    process.stdout.write("   - Check network/firewall rules\n");
    process.stdout.write("   - Verify credentials (PGUSER, PGPASSWORD)\n");
    process.exit(1);
  }

  process.stdout.write("\n");

  await confirmRestore(config.database);

  await performRestore(config);

  process.stdout.write("\n");
  logSuccess("Restore complete!");
  process.stdout.write(`Database: ${config.database}\n`);
  process.stdout.write("\n");

  await verifyRestore(config);
}

// Run main function
main().catch((error) => {
  logError(error.message);
  process.exit(1);
});
