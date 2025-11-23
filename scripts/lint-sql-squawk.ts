#!/usr/bin/env bun
/**
 * Squawk SQL Linter Wrapper
 * Runs Squawk (PostgreSQL-specific migration/SQL linter) on SQL files
 *
 * Usage:
 *   bun scripts/lint-sql-squawk.ts           # Lint all SQL files
 *   bun scripts/lint-sql-squawk.ts --help    # Show help
 *
 * Exit codes:
 *   0: No issues found
 *   1: Issues found or linter error
 */

import { $ } from "bun";

// SQL files to lint
const SQL_FILES = [
  "docker/postgres/docker-entrypoint-initdb.d/01-extensions.sql",
  "docker/postgres/docker-entrypoint-initdb.d/05-pgflow.sql",
  "examples/pgflow/10-pgflow.sql",
];

async function main() {
  const args = process.argv.slice(2);
  const showHelp = args.includes("--help") || args.includes("-h");

  if (showHelp) {
    console.log(`
Squawk PostgreSQL Linter

Usage:
  bun scripts/lint-sql-squawk.ts           # Lint all SQL files
  bun scripts/lint-sql-squawk.ts --help    # Show this help

PostgreSQL-specific checks:
  - Prefer bigint over int (avoid 32-bit int limit)
  - Prefer IDENTITY over SERIAL (better schema management)
  - Require CONCURRENT for index creation (avoid blocking writes)
  - Require timeout settings for slow operations
  - Detect dangerous migrations (locks, downtime risks)
  - Many more PostgreSQL best practices

Exit codes:
  0: No issues found
  1: Issues found or linter error

Documentation: https://squawkhq.com/docs/rules
`);
    process.exit(0);
  }

  console.log("🐘 Running Squawk PostgreSQL linter...\n");

  try {
    // Run Squawk on all SQL files
    const result = await $`bunx squawk ${SQL_FILES}`.nothrow();

    if (result.exitCode === 0) {
      console.log("\n✅ No PostgreSQL-specific issues found");
      process.exit(0);
    } else {
      console.log("\n⚠️  Squawk found issues (see above)");
      console.log("📖 For details: https://squawkhq.com/docs/rules");
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ Squawk linter error:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
