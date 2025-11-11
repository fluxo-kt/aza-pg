#!/usr/bin/env bun
/**
 * Backup PostgreSQL database using pg_dump
 * Usage: ./backup-postgres.ts [database] [output-file]
 * Environment: PGHOST, PGPORT, PGUSER, PGPASSWORD
 *
 * Examples:
 *   ./backup-postgres.ts                           # Backup 'postgres' db to auto-named file
 *   ./backup-postgres.ts mydb                       # Backup 'mydb' to auto-named file
 *   ./backup-postgres.ts mydb backup.sql.gz         # Backup 'mydb' to specific file
 *   PGHOST=db.example.com PGUSER=admin ./backup-postgres.ts mydb
 */

import { $ } from "bun";
import { checkCommand, waitForPostgres } from "../utils/docker.js";
import { info, success, error } from "../utils/logger.ts";
import { dirname } from "path";

interface BackupConfig {
  database: string;
  outputFile: string;
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
  const commands = ["pg_dump", "pg_isready", "gzip", "du"];

  for (const cmd of commands) {
    if (!(await commandExists(cmd))) {
      error(`Required command not found: ${cmd}`);
      process.stdout.write(
        "   Install PostgreSQL client tools: https://www.postgresql.org/download/\n"
      );
      process.exit(1);
    }
  }
}

/**
 * Parse configuration from arguments and environment
 */
function parseConfig(): BackupConfig {
  const args = Bun.argv.slice(2);
  const database = args[0] || "postgres";

  // Generate default output filename with timestamp
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, "_")
    .replace(/\.\d{3}Z$/, "");
  const outputFile = args[1] || `backup_${database}_${timestamp}.sql.gz`;

  const pgHost = Bun.env.PGHOST || "localhost";
  const pgPort = Number.parseInt(Bun.env.PGPORT || "5432", 10);
  const pgUser = Bun.env.PGUSER || "postgres";
  const pgPassword = Bun.env.PGPASSWORD;

  return {
    database,
    outputFile,
    pgHost,
    pgPort,
    pgUser,
    pgPassword,
  };
}

/**
 * Guard: Check PGPASSWORD for remote connections
 */
function checkPgPassword(config: BackupConfig): void {
  if (config.pgHost !== "localhost" && config.pgHost !== "127.0.0.1" && !config.pgPassword) {
    error("PGPASSWORD environment variable required for remote connections");
    process.stdout.write("   Set password: export PGPASSWORD='your_password'\n");
    process.stdout.write(
      "   Or use .pgpass file: https://www.postgresql.org/docs/current/libpq-pgpass.html\n"
    );
    process.exit(1);
  }
}

/**
 * Guard: Check output directory is writable
 */
async function checkOutputDirectory(outputFile: string): Promise<void> {
  const outputDir = dirname(outputFile);

  // Check if directory exists
  try {
    const stat = await Bun.file(outputDir).exists();
    if (!stat) {
      error(`Output directory does not exist: ${outputDir}`);
      process.stdout.write(`   Create directory: mkdir -p ${outputDir}\n`);
      process.exit(1);
    }
  } catch {
    error(`Output directory does not exist: ${outputDir}`);
    process.stdout.write(`   Create directory: mkdir -p ${outputDir}\n`);
    process.exit(1);
  }

  // Check if directory is writable by attempting to create a test file
  try {
    const testFile = `${outputDir}/.write-test-${Date.now()}`;
    await Bun.write(testFile, "test");
    await $`rm -f ${testFile}`.quiet();
  } catch {
    error(`Output directory not writable: ${outputDir}`);
    process.stdout.write(`   Check permissions: ls -la ${outputDir}\n`);
    process.exit(1);
  }
}

/**
 * Guard: Prevent overwriting existing files
 */
async function checkFileExists(outputFile: string): Promise<void> {
  const exists = await Bun.file(outputFile).exists();
  if (exists) {
    error(`Output file already exists: ${outputFile}`);
    process.stdout.write(`   Remove existing file: rm ${outputFile}\n`);
    process.stdout.write("   Or specify different output file as second argument\n");
    process.exit(1);
  }
}

/**
 * Perform the backup operation
 */
async function performBackup(config: BackupConfig): Promise<void> {
  info("Creating backup...");

  try {
    // Run pg_dump and pipe to gzip
    const result = await $`pg_dump \
      -h ${config.pgHost} \
      -p ${config.pgPort.toString()} \
      -U ${config.pgUser} \
      -d ${config.database} \
      --format=plain \
      --no-owner \
      --no-acl \
      --verbose`.quiet();

    // Compress output
    const compressed = Bun.gzipSync(new Uint8Array(await result.arrayBuffer()));
    await Bun.write(config.outputFile, compressed);
  } catch {
    process.stdout.write("\n");
    error("Backup failed");
    process.stdout.write("   Check pg_dump output above for details\n");
    process.stdout.write("   Common issues:\n");
    process.stdout.write(
      `   - Database does not exist: psql -h ${config.pgHost} -U ${config.pgUser} -l\n`
    );
    process.stdout.write(`   - Insufficient permissions for user ${config.pgUser}\n`);
    process.stdout.write(`   - Disk space: df -h ${dirname(config.outputFile)}\n`);

    // Clean up partial backup
    try {
      await $`rm -f ${config.outputFile}`.quiet();
    } catch {
      // Ignore cleanup errors
    }

    process.exit(1);
  }
}

/**
 * Verify backup file was created and has content
 */
async function verifyBackup(outputFile: string): Promise<void> {
  const file = Bun.file(outputFile);
  const exists = await file.exists();

  if (!exists) {
    error("Backup file is empty or was not created");
    process.stdout.write("   This usually indicates pg_dump failed silently\n");
    try {
      await $`rm -f ${outputFile}`.quiet();
    } catch {
      // Ignore cleanup errors
    }
    process.exit(1);
  }

  const size = file.size;
  if (size === 0) {
    error("Backup file is empty or was not created");
    process.stdout.write("   This usually indicates pg_dump failed silently\n");
    try {
      await $`rm -f ${outputFile}`.quiet();
    } catch {
      // Ignore cleanup errors
    }
    process.exit(1);
  }

  // Verify backup is valid gzip
  try {
    await $`gzip -t ${outputFile}`.quiet();
  } catch {
    error("Backup file is corrupted (invalid gzip format)");
    process.stdout.write("   The backup process may have been interrupted\n");
    try {
      await $`rm -f ${outputFile}`.quiet();
    } catch {
      // Ignore cleanup errors
    }
    process.exit(1);
  }
}

/**
 * Show backup information
 */
async function showBackupInfo(config: BackupConfig): Promise<void> {
  // Get file size
  const duResult = await $`du -h ${config.outputFile}`.text();
  const backupSize = duResult.split("\t")[0];

  process.stdout.write("\n");
  success("Backup complete!");
  process.stdout.write(`File: ${config.outputFile}\n`);
  process.stdout.write(`Size: ${backupSize}\n`);
  process.stdout.write("\n");

  // Show backup contents preview
  process.stdout.write("Backup contains:\n");
  try {
    const preview =
      await $`zcat ${config.outputFile} | grep -E "^(CREATE TABLE|CREATE INDEX|CREATE EXTENSION)" | head -20`.text();
    process.stdout.write(preview);
  } catch {
    process.stdout.write("(no tables/indexes/extensions found)\n");
  }
  process.stdout.write("...\n");
  process.stdout.write("\n");
  process.stdout.write(
    `To restore: gunzip -c ${config.outputFile} | psql -h HOST -U USER -d DATABASE\n`
  );
}

/**
 * Main function
 */
async function main(): Promise<void> {
  await checkRequiredCommands();

  const config = parseConfig();

  checkPgPassword(config);
  await checkOutputDirectory(config.outputFile);
  await checkFileExists(config.outputFile);

  process.stdout.write("========================================\n");
  process.stdout.write("PostgreSQL Backup\n");
  process.stdout.write("========================================\n");
  process.stdout.write(`Database: ${config.database}\n`);
  process.stdout.write(`Host: ${config.pgHost}:${config.pgPort}\n`);
  process.stdout.write(`User: ${config.pgUser}\n`);
  process.stdout.write(`Output: ${config.outputFile}\n`);
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

  await performBackup(config);
  await verifyBackup(config.outputFile);
  await showBackupInfo(config);
}

// Run main function
main().catch((error) => {
  error(error.message);
  process.exit(1);
});
