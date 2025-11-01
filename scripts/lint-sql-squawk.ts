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
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const EXCLUDE_PATTERNS = ["**/node_modules/**", "**/.git/**"];

/**
 * Find all SQL files in the repository
 */
async function findSqlFiles(): Promise<string[]> {
  const glob = new Bun.Glob("**/*.sql");
  const files: string[] = [];

  for await (const file of glob.scan({ cwd: REPO_ROOT, absolute: false })) {
    // Skip excluded patterns
    const shouldExclude = EXCLUDE_PATTERNS.some((pattern) => {
      const regex = new RegExp(pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*"));
      return regex.test(file);
    });

    if (!shouldExclude) {
      files.push(file);
    }
  }

  return files.sort();
}

async function main() {
  const args = Bun.argv.slice(2);
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

  const sqlFiles = await findSqlFiles();

  if (sqlFiles.length === 0) {
    console.log("No SQL files found.");
    process.exit(0);
  }

  console.log(`🐘 Running Squawk PostgreSQL linter on ${sqlFiles.length} file(s)...\n`);

  try {
    // Run Squawk on all SQL files
    const result = await $`bunx squawk ${sqlFiles}`.nothrow();

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
