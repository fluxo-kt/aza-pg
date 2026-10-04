#!/usr/bin/env bun
/**
 * Lint every GitHub Actions workflow with the pinned actionlint image, shellcheck included.
 *
 * This is the one definition of the workflow lint: `bun run validate:all` and the CI
 * `lint-workflows` job both run this file, so the pin and the flags cannot drift apart.
 * Shellcheck stays enabled because the `run:` blocks are where unquoted variables and
 * scattered `$GITHUB_OUTPUT` writes hide; the image bundles the shellcheck it runs, so a
 * finding does not depend on which shellcheck the host has.
 *
 * Usage: bun scripts/ci/lint-workflows.ts
 */

import path from "node:path";
import { Glob } from "bun";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const ACTIONLINT_IMAGE =
  "rhysd/actionlint:1.7.10@sha256:ef8299f97635c4c30e2298f48f30763ab782a4ad2c95b744649439a039421e36";

const workflows = Array.from(
  new Glob(".github/workflows/*.{yml,yaml}").scanSync({ cwd: REPO_ROOT })
).sort();
if (workflows.length === 0) {
  console.error("No workflow files found under .github/workflows — nothing was linted");
  process.exit(1);
}

const proc = Bun.spawn(
  [
    "docker",
    "run",
    "--rm",
    "-v",
    `${REPO_ROOT}:/work:ro`,
    "-w",
    "/work",
    ACTIONLINT_IMAGE,
    ...workflows,
  ],
  { stdout: "inherit", stderr: "inherit" }
);
const exitCode = await proc.exited;
if (exitCode === 0) console.log(`actionlint: ${workflows.length} workflows clean`);
process.exit(exitCode);
