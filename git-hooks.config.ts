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
   * Pre-commit: auto-fix and stage the fixes (oxlint --fix, prettier --write, regenerate when manifest-data.ts
   * changed), then run `bun run validate`, so a failing fast check stops the commit instead of reaching CI.
   */
  "pre-commit": "bun scripts/pre-commit.ts",

  // Override bun-git-hooks default commit-msg (bunx gitlint) with no-op
  "commit-msg": "true",

  // Pre-push disabled - CI enforces quality
  // "pre-push": "bun run validate:all",

  verbose: true,
};

export default config;
