#!/usr/bin/env bun
/**
 * SQL Formatter Script
 * Formats SQL files using sql-formatter with PostgreSQL dialect
 *
 * Usage:
 *   bun scripts/format-sql.ts           # Check formatting (dry-run)
 *   bun scripts/format-sql.ts --write   # Format files in-place
 *   bun scripts/format-sql.ts --help    # Show help
 *
 * Exit codes:
 *   0: All files properly formatted (or successfully formatted with --write)
 *   1: Some files need formatting (check mode) or formatting failed
 */

import { format } from "sql-formatter";

const REPO_ROOT = new URL("../", import.meta.url).pathname;

// Files to exclude from formatting
const EXCLUDE_PATTERNS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.git/**",
  "**/tests/regression/**", // Official PostgreSQL test fixtures - must not be modified
];

interface FormatResult {
  file: string;
  status: "ok" | "needs-formatting" | "formatted" | "error";
  error?: string;
}

async function loadFormatterConfig(): Promise<Record<string, unknown>> {
  try {
    const configPath = new URL("../.sql-formatter.json", import.meta.url);
    const configFile = Bun.file(configPath);
    return await configFile.json();
  } catch {
    console.warn("Warning: Could not load .sql-formatter.json, using defaults");
    return {
      language: "postgresql",
      tabWidth: 2,
      useTabs: false,
      keywordCase: "upper",
    };
  }
}

async function formatSqlFile(
  filePath: string,
  config: Record<string, unknown>,
  writeMode: boolean
): Promise<FormatResult> {
  try {
    const file = Bun.file(filePath);
    const originalContent = await file.text();

    // Format the SQL
    const formattedContent = format(originalContent, config);

    if (writeMode) {
      // Write formatted content back to file
      await Bun.write(filePath, formattedContent);
      return { file: filePath, status: "formatted" };
    } else {
      // Check if formatting is needed
      const needsFormatting = originalContent !== formattedContent;
      return {
        file: filePath,
        status: needsFormatting ? "needs-formatting" : "ok",
      };
    }
  } catch (error) {
    return {
      file: filePath,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function findSqlFiles(): Promise<string[]> {
  const glob = new Bun.Glob("**/*.sql");
  const files: string[] = [];

  for await (const file of glob.scan({ cwd: REPO_ROOT, absolute: true })) {
    // Skip excluded patterns
    const shouldExclude = EXCLUDE_PATTERNS.some((pattern) => {
      const regex = new RegExp(pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*"));
      return regex.test(file);
    });

    if (!shouldExclude) {
      files.push(file);
    }
  }

  return files;
}

async function main() {
  const args = process.argv.slice(2);
  const writeMode = args.includes("--write") || args.includes("-w");
  const showHelp = args.includes("--help") || args.includes("-h");

  if (showHelp) {
    console.log(`
SQL Formatter

Usage:
  bun scripts/format-sql.ts           # Check formatting (dry-run)
  bun scripts/format-sql.ts --write   # Format files in-place
  bun scripts/format-sql.ts --help    # Show this help

Options:
  --write, -w    Format files in-place
  --help, -h     Show this help message

Exit codes:
  0: All files properly formatted (or successfully formatted with --write)
  1: Some files need formatting (check mode) or formatting failed
`);
    process.exit(0);
  }

  console.log(`🔍 Finding SQL files...`);
  const sqlFiles = await findSqlFiles();

  if (sqlFiles.length === 0) {
    console.log("No SQL files found.");
    process.exit(0);
  }

  console.log(`📝 Found ${sqlFiles.length} SQL file(s)\n`);

  const config = await loadFormatterConfig();
  const results: FormatResult[] = [];

  for (const file of sqlFiles) {
    const result = await formatSqlFile(file, config, writeMode);
    results.push(result);

    const relativePath = file.replace(REPO_ROOT, "");

    switch (result.status) {
      case "ok":
        console.log(`  ✓ ${relativePath}`);
        break;
      case "formatted":
        console.log(`  ✨ ${relativePath} (formatted)`);
        break;
      case "needs-formatting":
        console.log(`  ✗ ${relativePath} (needs formatting)`);
        break;
      case "error":
        console.error(`  ❌ ${relativePath} (error: ${result.error})`);
        break;
    }
  }

  // Summary
  const needsFormatting = results.filter((r) => r.status === "needs-formatting").length;
  const formatted = results.filter((r) => r.status === "formatted").length;
  const errors = results.filter((r) => r.status === "error").length;
  const ok = results.filter((r) => r.status === "ok").length;

  console.log();
  if (writeMode) {
    console.log(`✅ Formatted ${formatted} file(s)`);
    if (errors > 0) {
      console.error(`❌ ${errors} file(s) had errors`);
      process.exit(1);
    }
  } else {
    if (needsFormatting > 0) {
      console.log(`⚠️  ${needsFormatting} file(s) need formatting`);
      console.log(`\nRun 'bun scripts/format-sql.ts --write' to format them.`);
      process.exit(1);
    } else {
      console.log(`✅ All ${ok} file(s) are properly formatted`);
    }
  }

  process.exit(0);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
