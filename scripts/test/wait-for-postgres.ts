#!/usr/bin/env bun
/**
 * Wait for PostgreSQL to be ready
 * Usage: ./wait-for-postgres.ts [host] [port] [user] [timeout]
 * Environment variables: PGHOST, PGPORT, PGUSER (defaults if not provided)
 *
 * Examples:
 *   ./wait-for-postgres.ts                              # localhost:5432, postgres user, 60s timeout
 *   ./wait-for-postgres.ts db.example.com 5432 admin    # Remote host with custom user
 *   PGHOST=localhost PGPORT=6432 ./wait-for-postgres.ts # Via PgBouncer
 *   ./wait-for-postgres.ts localhost 5432 postgres 120  # 2 minute timeout
 */

import { checkCommand, waitForPostgres } from "../lib/common.ts";

/**
 * Parse CLI arguments and environment variables
 */
interface ParsedArgs {
  host: string;
  port: number;
  user: string;
  timeout: number;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);

  const host = args[0] ?? process.env.PGHOST ?? "localhost";
  const portStr = args[1] ?? process.env.PGPORT ?? "5432";
  const user = args[2] ?? process.env.PGUSER ?? "postgres";
  const timeoutStr = args[3] ?? "60";

  // Parse port
  const port = Number.parseInt(portStr, 10);
  if (Number.isNaN(port)) {
    console.error(`Error: Invalid port value: ${portStr} (must be a number between 1-65535)`);
    process.exit(1);
  }

  // Parse timeout
  const timeout = Number.parseInt(timeoutStr, 10);
  if (Number.isNaN(timeout)) {
    console.error(`Error: Invalid timeout value: ${timeoutStr} (must be a positive integer)`);
    process.exit(1);
  }

  return { host, port, user, timeout };
}

/**
 * Main execution
 */
async function main(): Promise<void> {
  try {
    // Guard: Check required commands
    await checkCommand("pg_isready");

    // Parse arguments
    const { host, port, user, timeout } = parseArgs();

    // Wait for PostgreSQL
    await waitForPostgres({ host, port, user, timeout });
  } catch (error) {
    if (error instanceof Error) {
      console.error(`\nError: ${error.message}`);
    } else {
      console.error(`\nError: ${String(error)}`);
    }

    // Print troubleshooting info if PostgreSQL timeout
    if (error instanceof Error && error.message.includes("not ready after")) {
      const { host, port } = parseArgs();
      console.error("\nTroubleshooting:");
      console.error("  - Check PostgreSQL is running: docker ps | grep postgres");
      console.error(`  - Verify host/port: pg_isready -h ${host} -p ${port}`);
      console.error("  - Check container logs: docker logs <postgres-container>");
      console.error(`  - Check network connectivity: nc -zv ${host} ${port}`);
      console.error("  - Verify PostgreSQL is accepting connections (not in recovery mode)");
    }

    // Print installation info if pg_isready not found
    if (
      error instanceof Error &&
      error.message.includes("Required command not found: pg_isready")
    ) {
      console.error("   Install PostgreSQL client tools: https://www.postgresql.org/download/");
    }

    process.exit(1);
  }
}

main();
