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

  /**
   * Pre-push: Disabled (rely on CI instead)
   *
   * Rationale: Pre-push hooks are slow and annoying during development.
   * CI will catch issues anyway. Trust developers, let CI enforce quality.
   *
   * If you want to run full validation before pushing, manually run:
   *   bun run validate:full
   */
  // "pre-push": "bun run validate:full",

  /**
   * Commit-msg: Validate commit message format (optional, currently disabled)
   *
   * Note: If you have an active commit-msg hook in .git/hooks/ from a previous
   * installation, you may want to uninstall and reinstall hooks to sync with this config.
   *
   * Uncomment to enable conventional commit validation:
   * "commit-msg": "bunx commitlint --edit $1"
   *
   * To sync hooks with this config:
   * - bun run hooks:uninstall
   * - bun run hooks:install
   */

  /**
   * Enable verbose output for debugging hook execution
   */
  verbose: true,
};

export default config;
