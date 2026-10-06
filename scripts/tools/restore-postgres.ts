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
import { checkCommand, waitForPostgres } from "../utils/docker";
import { info, success, error } from "../utils/logger";

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
      error(`Required command not found: ${cmd}`);
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
  const scriptName = Bun.argv[1];
  process.stdout.write(`Usage: ${scriptName} <backup-file> [database]\n`);
  process.stdout.write(
    "Connection: PGHOST, PGPORT, PGUSER, PGPASSWORD (default localhost:5432, postgres)\n"
  );
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
  const args = Bun.argv.slice(2);

  // Only positional arguments exist; a flag (--help, -h …) would otherwise be read as the backup file's name.
  if (args.length === 0 || !args[0] || args.some((a) => a.startsWith("-"))) {
    showUsage();
  }

  const backupFile = args[0] as string;
  const database = args[1] || "postgres";

  const pgHost = Bun.env.PGHOST || "localhost";
  const pgPort = Number.parseInt(Bun.env.PGPORT || "5432", 10);
  const pgUser = Bun.env.PGUSER || "postgres";
  const pgPassword = Bun.env.PGPASSWORD;

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
    error(`Backup file not found: ${backupFile}`);
    process.stdout.write(`   Check file path: ls -la $(dirname "${backupFile}")\n`);
    process.exit(1);
  }

  // Check if readable by attempting to read file
  try {
    const file = Bun.file(backupFile);
    await file.slice(0, 1).arrayBuffer();
  } catch {
    error(`Backup file not readable: ${backupFile}`);
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
      error("Backup file is corrupted (invalid gzip format)");
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
    error("PGPASSWORD environment variable required for remote connections");
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
  process.stdout.write(
    `\n⚠️  WARNING: This replaces every table, function and other object the backup holds in database '${database}'\n` +
      "with the backup's version; objects the backup lacks stay. Missing roles are created; existing roles are kept.\n" +
      "The restore is one transaction: if any statement fails, nothing changes.\n" +
      // pg_dump leaves out the pgsodium root key, and the entrypoint refuses to switch an existing data directory to
      // another key: a server created without the original key cannot decrypt them, and must be recreated with it.
      "Vault secrets and pgsodium-encrypted values in the backup decrypt only if this server was created with\n" +
      "PGSODIUM_KEY_FILE pointing at a copy of the original server's pgsodium root key; see docs/PGSODIUM-SETUP.md.\n"
  );
  process.stdout.write("Press Ctrl+C to cancel, or Enter to continue...\n");

  for await (const _line of console) {
    return;
  }
  // stdin closed without a line (cron, CI, < /dev/null): nobody confirmed
  error("No confirmation (stdin closed); nothing restored");
  process.exit(1);
}

/**
 * Perform the restore operation
 */
async function performRestore(config: RestoreConfig): Promise<void> {
  info("Restoring backup...");

  // One transaction that stops at the first error, so a failed restore changes nothing. backup-postgres dumps with
  // --clean --if-exists, which replaces the objects a new aza-pg server creates at init instead of failing on them.
  // TimescaleDB needs its restore mode around a dump holding hypertables; the dump empties search_path, hence
  // public.-qualified calls, guarded because the target database may lack the extension.
  const psqlArgs = [
    "-h",
    config.pgHost,
    "-p",
    config.pgPort.toString(),
    "-U",
    config.pgUser,
    "-d",
    config.database,
  ];
  const tsdb = (fn: string) =>
    `DO $t$ BEGIN IF to_regproc('public.${fn}') IS NOT NULL THEN PERFORM public.${fn}(); END IF; END $t$;`;
  const script =
    'set -euo pipefail; f=$1; shift; { echo "$PRE"; if [[ $f == *.gz ]]; then gunzip -c "$f"; else cat "$f"; fi; echo "$POST"; } | psql "$@" -X -q -1 -v ON_ERROR_STOP=1';
  const result = await $`bash -c ${script} bash ${config.backupFile} ${psqlArgs}`
    .env({
      ...Bun.env,
      PRE: tsdb("timescaledb_pre_restore"),
      POST: tsdb("timescaledb_post_restore"),
    })
    .nothrow()
    .quiet();
  if (result.exitCode !== 0) {
    process.stderr.write(result.stderr);
    process.stdout.write("\n");
    error("Restore failed");
    process.stdout.write("   Common issues:\n");
    process.stdout.write(
      `   - Database '${config.database}' does not exist: createdb -h ${config.pgHost} -U ${config.pgUser} ${config.database}\n`
    );
    process.stdout.write(`   - Insufficient permissions for user ${config.pgUser}\n`);
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
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
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
  success("Restore complete!");
  process.stdout.write(`Database: ${config.database}\n`);
  process.stdout.write("\n");

  await verifyRestore(config);
}

// Run main function
main().catch((err) => {
  error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
