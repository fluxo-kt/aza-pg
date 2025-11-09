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
   * Pre-commit: Run fast validation checks on staged files
   *
   * This ensures code quality before commits are created.
   * Runs fast validation with --staged flag: Oxlint and Prettier check on staged files only, TypeScript type checking on full project.
   */
  "pre-commit": "bun run validate --staged",

  /**
   * Pre-push: Run full validation suite before pushing
   *
   * This catches issues before they reach the remote repository.
   * Includes all linters (oxlint, shellcheck, hadolint, yaml), formatting, and TypeScript type checking.
   */
  "pre-push": "bun run validate:full",

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
