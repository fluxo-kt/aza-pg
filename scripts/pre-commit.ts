#!/usr/bin/env bun
/**
 * Pre-commit hook: Auto-fix issues and stage fixes
 *
 * This hook AUTO-FIXES issues instead of failing:
 * 1. Auto-regenerate if manifest-data.ts changed
 * 2. Auto-fix linting issues (oxlint --fix)
 * 3. Auto-format code (prettier --write)
 * 4. Auto-format SQL files (sql-formatter)
 * 5. Auto-stage all fixes
 * 6. Only fail if there are REAL errors that can't be auto-fixed
 *
 * Philosophy: Hooks should HELP, not BLOCK development
 */

import { $ } from "bun";
import { error, info, success, warning } from "./utils/logger";

/**
 * Get list of staged files
 */
async function getStagedFiles(): Promise<string[]> {
  const result = await $`git diff --cached --name-only --diff-filter=ACM`.text();
  return result.trim().split("\n").filter(Boolean);
}

/**
 * Stage files after auto-fixing
 */
async function stageFiles(files: string[]): Promise<void> {
  if (files.length === 0) return;
  await $`git add ${files}`;
}

/**
 * Main pre-commit logic
 */
async function preCommit(): Promise<void> {
  info("🔧 Pre-commit: Auto-fixing issues...");

  const stagedFiles = await getStagedFiles();
  if (stagedFiles.length === 0) {
    info("No staged files to check");
    return;
  }

  const filesToRestage: string[] = [];

  // 1. Check if manifest-data.ts changed → auto-regenerate everything
  if (stagedFiles.includes("scripts/extensions/manifest-data.ts")) {
    info("📦 Manifest changed - auto-regenerating all artifacts...");
    try {
      await $`bun run generate`.quiet();
      success("✅ Auto-regenerated all artifacts");

      // Stage all generated files
      const generatedFiles = [
        "docker/postgres/Dockerfile",
        "docker/postgres/extensions.manifest.json",
        "docker/postgres/extensions.build-packages.txt",
        "docker/postgres/healthcheck.sh",
        "docs/.generated/docs-data.json",
        "docs/EXTENSIONS.md",
        "docker/postgres/configs/postgresql-base.conf",
        "stacks/primary/configs/postgresql-primary.conf",
        "stacks/primary/configs/pg_hba.conf",
        "stacks/replica/configs/postgresql-replica.conf",
        "stacks/replica/configs/pg_hba.conf",
        "stacks/single/configs/postgresql.conf",
        "stacks/single/configs/pg_hba.conf",
        "docker/postgres/docker-entrypoint-initdb.d/01-extensions.sql",
      ];
      await stageFiles(generatedFiles);
      info("📝 Auto-staged generated files");
    } catch (err) {
      error("❌ Failed to regenerate artifacts", err);
      throw err;
    }
  }

  // 2. Auto-fix linting issues
  const lintableFiles = stagedFiles.filter(
    (f) => f.endsWith(".ts") || f.endsWith(".js") || f.endsWith(".tsx") || f.endsWith(".jsx")
  );

  if (lintableFiles.length > 0) {
    info("🔍 Auto-fixing linting issues...");
    try {
      await $`bun run oxlint:fix ${lintableFiles}`.quiet();
      success("✅ Auto-fixed linting issues");
      filesToRestage.push(...lintableFiles);
    } catch (err) {
      // Oxlint --fix doesn't fail on unfixable issues, so this is a real error.
      warning("⚠️  Some linting issues couldn't be auto-fixed", err);
    }
  }

  // 3. Auto-format code
  const formattableFiles = stagedFiles.filter(
    (f) =>
      f.endsWith(".ts") ||
      f.endsWith(".js") ||
      f.endsWith(".tsx") ||
      f.endsWith(".jsx") ||
      f.endsWith(".json") ||
      f.endsWith(".md") ||
      f.endsWith(".yaml") ||
      f.endsWith(".yml")
  );

  if (formattableFiles.length > 0) {
    info("💅 Auto-formatting code...");
    try {
      await $`bun run prettier:write ${formattableFiles}`.quiet();
      success("✅ Auto-formatted code");
      filesToRestage.push(...formattableFiles);
    } catch (err) {
      error("❌ Failed to format code", err);
      throw err;
    }
  }

  // 3.5. Auto-format SQL files
  const sqlFiles = stagedFiles.filter((f) => f.endsWith(".sql"));

  if (sqlFiles.length > 0) {
    info("🗄️  Auto-formatting SQL files...");
    try {
      await $`bun scripts/format-sql.ts --write`.quiet();
      success("✅ Auto-formatted SQL files");
      filesToRestage.push(...sqlFiles);
    } catch (err) {
      warning("⚠️  Some SQL files couldn't be auto-formatted", err);
    }
  }

  // 4. Re-stage all auto-fixed files
  if (filesToRestage.length > 0) {
    await stageFiles([...new Set(filesToRestage)]); // deduplicate
    info("📝 Auto-staged fixed files");
  }

  // 5. Skip type checking (too slow for pre-commit, let CI handle it)
  // Type checking is comprehensive and slow - better suited for CI
  // Developers can run `bun run type-check` manually if needed

  success("✅ Pre-commit auto-fixes complete!");
  info("   💡 CI will run full validation (type-check, shellcheck, etc.)");
}

// Run and exit with appropriate code
try {
  await preCommit();
  process.exit(0);
} catch (err) {
  error("❌ Pre-commit failed", err);
  process.exit(1);
}
