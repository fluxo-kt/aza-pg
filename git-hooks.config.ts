import type { GitHooksConfig } from "bun-git-hooks";

/**
 * Git hooks configuration for aza-pg
 *
 * Hooks are managed by bun-git-hooks for Bun-optimized TypeScript projects.
 *
 * Installation: bun run hooks:install
 * Uninstall: bun run hooks:uninstall
 */
const config: GitHooksConfig = {
  /**
   * Pre-commit: Auto-fix issues and stage fixes
   *
   * Philosophy: Hooks should HELP, not BLOCK development
   *
   * Auto-fixes:
   * - Linting issues (oxlint --fix)
   * - Code formatting (prettier --write)
   * - Regenerates artifacts if manifest-data.ts changed
   * - Auto-stages all fixes
   *
   * Only fails if there are real errors that can't be auto-fixed (e.g., type errors)
   */
  "pre-commit": "bun scripts/pre-commit.ts",

  // Pre-push disabled - CI enforces quality
  // "pre-push": "bun run validate:all",

  verbose: true,
};

export default config;
