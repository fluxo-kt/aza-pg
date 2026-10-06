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
 * 6. Only fail if there are REAL errors that can't be auto-fixed — or if a file it would restage has unstaged
 *    changes, which restaging would commit unseen

 *
 * Philosophy: Hooks should HELP, not BLOCK development
 */

import { $ } from "bun";
import { basename } from "node:path";
import { GENERATED_FILES } from "./generated-files";
import { error, info, success, warning } from "./utils/logger";

/**
 * Staged regular files. Symlinks (mode 120000, e.g. this repo's `CLAUDE.md -> AGENTS.md`) are skipped: every fixer
 * below acts on the target, staged on its own when it changed, and Prettier exits 2 on an explicitly named symlink.
 */
async function getStagedFiles(): Promise<string[]> {
  // --raw lines: ":<old mode> <new mode> <old sha> <new sha> <status>\t<path>"
  const result = await $`git diff --cached --raw --diff-filter=ACM`.text();
  return result
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [meta = "", path = ""] = line.split("\t");
      return meta.split(" ")[1] === "120000" ? [] : [path];
    });
}

/**
 * Stage files after auto-fixing
 */
async function stageFiles(files: string[]): Promise<void> {
  if (files.length === 0) return;
  await $`git add ${files}`;
  // Under `git commit --only -- <paths>` this hook stages into a temporary candidate index (next-index-*.lock): the
  // fixes reach the commit, but git then writes the real index from the pre-hook bytes, leaving every fixed file
  // differing from HEAD in the index. git holds the real index's lock for the whole hook and renames it into place
  // when the commit lands, so staging into that lock too keeps the real index equal to the commit. The path comes
  // from --git-dir: `git rev-parse --git-path index` answers with $GIT_INDEX_FILE, the candidate, inside a hook.
  if (basename(Bun.env.GIT_INDEX_FILE ?? "").startsWith("next-index-")) {
    const gitDir = (await $`git rev-parse --git-dir`.text()).trim();
    await $`git add ${files}`.env({ ...Bun.env, GIT_INDEX_FILE: `${gitDir}/index.lock` });
  }
}

/**
 * Files whose working copy differs from what is staged. The fixers rewrite working copies and `git add` them back,
 * which stages the WHOLE working copy: a partially staged file, or another person's unfinished edit sitting in it,
 * would land in this commit unseen. Under `git commit --only -- <paths>` git hands the hook a temporary index
 * holding exactly those paths' working copies, so the paths named there never show up here.
 */
async function withUnstagedChanges(files: string[]): Promise<string[]> {
  if (files.length === 0) return [];
  const out = await $`git diff --name-only -- ${files}`.text();
  return out.trim().split("\n").filter(Boolean);
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
  const manifestStaged = stagedFiles.includes("scripts/extensions/manifest-data.ts");

  // Checked before any fixer writes: afterwards every fixed file differs from its staged copy.
  const unstaged = await withUnstagedChanges(
    manifestStaged ? [...stagedFiles, ...GENERATED_FILES] : stagedFiles
  );
  if (unstaged.length > 0) {
    throw new Error(
      `these files have changes that are not staged, and this hook's auto-fix would commit them too:\n` +
        unstaged.map((f) => `  ${f}`).join("\n") +
        `\nCommit finished files whole with: git commit --only -m "<message>" -- <files>` +
        (manifestStaged
          ? `\nA generated file listed here means its manifest change and the \`bun run generate\` output must be committed together.`
          : "")
    );
  }

  // 1. Check if manifest-data.ts changed → auto-regenerate everything
  if (manifestStaged) {
    info("📦 Manifest changed - auto-regenerating all artifacts...");
    try {
      await $`bun run generate`.quiet();
      success("✅ Auto-regenerated all artifacts");

      // Stage all generated files (imported from generated-files.ts - single source of truth)
      await stageFiles([...GENERATED_FILES]);
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
      await $`bun scripts/format-sql.ts --write ${sqlFiles}`.quiet();
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

  // The hook only fixes; checking (tsc, tests, shellcheck…) is `bun run validate` locally and `validate:all` in CI.
  success("✅ Pre-commit auto-fixes complete!");
  info("   💡 Not checked here: run `bun run validate` (CI runs `bun run validate:all`)");
}

// Run and exit with appropriate code
try {
  await preCommit();
  process.exit(0);
} catch (err) {
  error("❌ Pre-commit failed", err);
  process.exit(1);
}
