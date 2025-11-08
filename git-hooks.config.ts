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
   * Pre-commit: Run linting and formatting checks on staged files
   *
   * This ensures code quality before commits are created.
   * Runs fast linting with Oxlint and formatting check with Prettier.
   */
  "pre-commit": "bun run lint && bun run format:check",

  /**
   * Pre-push: Run full validation suite before pushing
   *
   * This catches issues before they reach the remote repository.
   * Includes linting, formatting, and TypeScript type checking.
   */
  "pre-push": "bun run validate",

  /**
   * Commit-msg: Validate commit message format (optional, currently disabled)
   *
   * Uncomment to enable conventional commit validation:
   * "commit-msg": "bunx commitlint --edit $1"
   */

  /**
   * Enable verbose output for debugging hook execution
   */
  verbose: true,
};

export default config;
