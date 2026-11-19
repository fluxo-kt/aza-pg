#!/usr/bin/env bun
/**
 * Lint every GitHub Actions workflow with actionlint, shellcheck included.
 *
 * This is the one definition of the workflow lint: `bun run validate:all` and the CI
 * `lint-workflows` job both run this file, so the version and the flags cannot drift apart.
 * Shellcheck stays enabled because the `run:` blocks are where unquoted variables and
 * scattered `$GITHUB_OUTPUT` writes hide; actionlint is flake.nix's output (scripts/nix/tools.ts),
 * whose wrapper puts its own shellcheck on PATH, so a finding does not depend on the host's.
 *
 * Usage: bun scripts/ci/lint-workflows.ts
 */

import path from "node:path";
import { Glob } from "bun";
import { runTool } from "../nix/tools";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

const workflows = Array.from(
  new Glob(".github/workflows/*.{yml,yaml}").scanSync({ cwd: REPO_ROOT })
).sort();
if (workflows.length === 0) {
  console.error("No workflow files found under .github/workflows — nothing was linted");
  process.exit(1);
}

const exitCode = await runTool("actionlint", workflows).exited;
if (exitCode === 0) console.log(`actionlint: ${workflows.length} workflows clean`);
process.exit(exitCode);
