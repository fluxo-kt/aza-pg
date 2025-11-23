#!/usr/bin/env bun
/**
 * SQL Validation Script
 * Validates SQL files for formatting and basic syntax issues
 *
 * Usage:
 *   bun scripts/check-sql.ts           # Check all SQL files
 *   bun scripts/check-sql.ts --help    # Show help
 *
 * Exit codes:
 *   0: All checks passed
 *   1: Some checks failed
 */

import { format } from "sql-formatter";

const REPO_ROOT = new URL("../", import.meta.url).pathname;

// Files to exclude from validation
const EXCLUDE_PATTERNS = ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.git/**"];

interface ValidationResult {
  file: string;
  formatted: boolean;
  errors: string[];
  warnings: string[];
}

async function loadFormatterConfig(): Promise<Record<string, unknown>> {
  try {
    const configPath = new URL("../.sql-formatter.json", import.meta.url);
    const configFile = Bun.file(configPath);
    return await configFile.json();
  } catch (error) {
    console.warn("Warning: Could not load .sql-formatter.json, using defaults");
    return {
      language: "postgresql",
      tabWidth: 2,
      useTabs: false,
      keywordCase: "upper",
    };
  }
}

async function validateSqlFile(
  filePath: string,
  config: Record<string, unknown>
): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    const file = Bun.file(filePath);
    const content = await file.text();

    // Check 1: Formatting validation
    let formatted = true;
    try {
      const formattedContent = format(content, config);
      if (content !== formattedContent) {
        formatted = false;
        errors.push("File is not properly formatted");
      }
    } catch (formatError) {
      errors.push(
        `Formatting validation failed: ${formatError instanceof Error ? formatError.message : String(formatError)}`
      );
    }

    // Check 2: Basic SQL sanity checks
    const lines = content.split("\n");

    // Check for unmatched parentheses
    let parenDepth = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;

      // Skip comments
      if (line.trim().startsWith("--")) continue;

      for (const char of line) {
        if (char === "(") parenDepth++;
        if (char === ")") parenDepth--;
        if (parenDepth < 0) {
          errors.push(`Line ${i + 1}: Unmatched closing parenthesis`);
          parenDepth = 0; // Reset to continue checking
        }
      }
    }
    if (parenDepth > 0) {
      errors.push(`Unmatched opening parenthesis (${parenDepth} unclosed)`);
    }

    // Check 3: Trailing whitespace
    const trailingWhitespaceLines = lines
      .map((line, idx) => ({ line, idx }))
      .filter(({ line }) => line.length > 0 && line !== line.trimEnd())
      .map(({ idx }) => idx + 1);

    if (trailingWhitespaceLines.length > 0) {
      warnings.push(
        `Trailing whitespace on line(s): ${trailingWhitespaceLines.slice(0, 5).join(", ")}${trailingWhitespaceLines.length > 5 ? ` and ${trailingWhitespaceLines.length - 5} more` : ""}`
      );
    }

    // Check 4: Mixed line endings
    const hasCRLF = content.includes("\r\n");
    const hasLF = content.includes("\n") && !content.includes("\r\n");
    if (hasCRLF && hasLF) {
      warnings.push("Mixed line endings detected (CRLF and LF)");
    }

    // Check 5: Empty file
    if (content.trim().length === 0) {
      warnings.push("File is empty");
    }

    return {
      file: filePath,
      formatted,
      errors,
      warnings,
    };
  } catch (error) {
    return {
      file: filePath,
      formatted: false,
      errors: [error instanceof Error ? error.message : String(error)],
      warnings: [],
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
  const showHelp = args.includes("--help") || args.includes("-h");

  if (showHelp) {
    console.log(`
SQL Validation

Usage:
  bun scripts/check-sql.ts           # Check all SQL files
  bun scripts/check-sql.ts --help    # Show this help

Checks performed:
  - Formatting validation (sql-formatter)
  - Parenthesis matching
  - Trailing whitespace detection
  - Mixed line endings detection
  - Empty file detection

Exit codes:
  0: All checks passed
  1: Some checks failed
`);
    process.exit(0);
  }

  console.log(`🔍 Finding SQL files...`);
  const sqlFiles = await findSqlFiles();

  if (sqlFiles.length === 0) {
    console.log("No SQL files found.");
    process.exit(0);
  }

  console.log(`📝 Validating ${sqlFiles.length} SQL file(s)\n`);

  const config = await loadFormatterConfig();
  const results: ValidationResult[] = [];

  for (const file of sqlFiles) {
    const result = await validateSqlFile(file, config);
    results.push(result);

    const relativePath = file.replace(REPO_ROOT, "");
    const hasIssues = result.errors.length > 0 || result.warnings.length > 0;

    if (hasIssues) {
      console.log(`  ❌ ${relativePath}`);
      result.errors.forEach((err) => console.log(`      ✗ ${err}`));
      result.warnings.forEach((warn) => console.log(`      ⚠ ${warn}`));
    } else {
      console.log(`  ✓ ${relativePath}`);
    }
  }

  // Summary
  const filesWithErrors = results.filter((r) => r.errors.length > 0).length;
  const filesWithWarnings = results.filter(
    (r) => r.warnings.length > 0 && r.errors.length === 0
  ).length;
  const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);
  const totalWarnings = results.reduce((sum, r) => sum + r.warnings.length, 0);

  console.log();
  if (filesWithErrors > 0) {
    console.log(
      `❌ ${filesWithErrors} file(s) with ${totalErrors} error(s), ${totalWarnings} warning(s)`
    );
    console.log(`\nRun 'bun scripts/format-sql.ts --write' to fix formatting issues.`);
    process.exit(1);
  } else if (filesWithWarnings > 0) {
    console.log(`⚠️  ${filesWithWarnings} file(s) with ${totalWarnings} warning(s)`);
    console.log(`✅ No errors found`);
    process.exit(0);
  } else {
    console.log(`✅ All ${sqlFiles.length} file(s) passed validation`);
    process.exit(0);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
