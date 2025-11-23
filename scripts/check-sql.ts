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

    // PostgreSQL-specific linting rules

    // Check 6: DELETE without WHERE (dangerous)
    const deleteWithoutWhere = /\bDELETE\s+FROM\s+\w+(?:\.\w+)?(?:\s*;|\s+(?!WHERE))/gi;
    if (deleteWithoutWhere.test(content)) {
      errors.push("DELETE without WHERE clause detected (dangerous operation)");
    }

    // Check 7: UPDATE without WHERE (dangerous)
    const updateWithoutWhere = /\bUPDATE\s+\w+(?:\.\w+)?\s+SET\s+.*?(?:;|$)(?!.*WHERE)/gis;
    const updateMatches = content.match(updateWithoutWhere) || [];
    for (const match of updateMatches) {
      if (!/WHERE/i.test(match) && !/RETURNING/i.test(match)) {
        // Skip if it's part of a constraint or function
        if (!/ON\s+UPDATE/i.test(match) && !/DO\s+UPDATE/i.test(match)) {
          warnings.push("UPDATE without WHERE clause - verify this is intentional");
        }
      }
    }

    // Check 8: TRUNCATE usage (warn about data loss)
    if (/\bTRUNCATE\s+TABLE/i.test(content)) {
      warnings.push("TRUNCATE TABLE found - permanent data deletion");
    }

    // Check 9: Missing transaction control for DDL
    const hasDDL = /\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|CONSTRAINT)/i.test(content);
    const hasTransaction =
      /\b(BEGIN|START\s+TRANSACTION)\b/i.test(content) && /\b(COMMIT|ROLLBACK)\b/i.test(content);
    if (hasDDL && !hasTransaction && !content.includes("DO $$")) {
      // Skip if using DO block (has implicit transaction)
      warnings.push(
        "DDL operations without explicit transaction control - consider wrapping in BEGIN/COMMIT"
      );
    }

    // Check 10: Potential SQL injection in dynamic SQL
    if (/EXECUTE\s+(['"]|\$\$|format\()/i.test(content)) {
      const hasFormatI = /%I/i.test(content); // Safe identifier interpolation
      const hasFormatL = /%L/i.test(content); // Safe literal interpolation
      if (!hasFormatI && !hasFormatL) {
        warnings.push(
          "Dynamic SQL (EXECUTE) without format() interpolation - potential SQL injection risk"
        );
      }
    }

    // Check 11: Missing indexes on foreign keys (basic heuristic)
    const foreignKeyPattern = /FOREIGN\s+KEY\s*\([^)]+\)/gi;
    const foreignKeys = content.match(foreignKeyPattern) || [];
    const indexPattern = /CREATE\s+INDEX/gi;
    const indexes = content.match(indexPattern) || [];
    if (foreignKeys.length > indexes.length) {
      warnings.push(
        `Found ${foreignKeys.length} foreign keys but only ${indexes.length} indexes - consider indexing foreign key columns`
      );
    }

    // Check 12: Using SELECT * (performance anti-pattern)
    if (/SELECT\s+\*/i.test(content) && !/COUNT\(\*\)/i.test(content)) {
      warnings.push("SELECT * usage detected - consider specifying explicit column names");
    }

    // Check 13: Long transaction blocks (potential lock issues)
    const doBlocks = content.match(/DO\s+\$\$[\s\S]*?\$\$/gi) || [];
    for (const block of doBlocks) {
      const statementCount = (block.match(/;/g) || []).length;
      if (statementCount > 50) {
        warnings.push(
          `DO block with ${statementCount} statements - consider splitting to avoid long locks`
        );
      }
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

Formatting checks:
  - SQL formatting validation (sql-formatter with PostgreSQL dialect)
  - Parenthesis matching
  - Trailing whitespace detection
  - Mixed line endings detection

PostgreSQL-specific linting:
  - DELETE/UPDATE without WHERE clause (dangerous operations)
  - TRUNCATE usage (data loss warnings)
  - Missing transaction control for DDL
  - Potential SQL injection in dynamic SQL (EXECUTE without format())
  - Missing indexes on foreign keys
  - SELECT * anti-pattern
  - Long transaction blocks (lock concerns)

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
