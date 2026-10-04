#!/usr/bin/env bun
/**
 * Fail when a package.json script or a documented `bun run <script>` points at nothing.
 *
 * Two ways an instruction silently rots when a file or script is renamed or deleted:
 * - docs (AGENTS.md, README.md, docs/**\/*.md) cite `bun run <name>` for a script package.json lacks;
 * - a package.json script runs a repo file (`bun scripts/x.ts`) or another script (`bun run x`) that
 *   no longer exists, so the documented command fails only when someone runs it.
 * `bun run <path>` forms (containing "/" or ".") run a file, not a script, and are skipped in docs.
 *
 * Usage: bun scripts/ci/check-script-references.ts
 */

import { join } from "node:path";
import { Glob } from "bun";

const PROJECT_ROOT = join(import.meta.dir, "../..");
const DOC_PATTERNS = ["AGENTS.md", "README.md", "docs/**/*.md"];
// Script names may contain digits (`test:image-functional-1`); the lookahead rejects a match that is
// really the start of a path (`bun run scripts/x.ts`, `bun run ./x`).
const SCRIPT_REFERENCE = /bun\s+run\s+([a-z0-9:_-]+)(?![./\w])/gi;
// A repo-relative file argument inside a package.json script, e.g. `scripts/test-all.ts`.
const FILE_ARGUMENT = /^(?:\.\/)?[\w.-]+(?:\/[\w.-]+)+\.(?:ts|js|mjs|sh)$/;

type PackageJson = { scripts?: Record<string, string> };

export async function findBrokenReferences(root: string): Promise<string[]> {
  const packageJson = (await Bun.file(join(root, "package.json")).json()) as PackageJson;
  const scripts = packageJson.scripts ?? {};
  const available = new Set(Object.keys(scripts));
  const problems: string[] = [];

  for (const [name, command] of Object.entries(scripts)) {
    for (const token of command.split(/\s+/)) {
      if (FILE_ARGUMENT.test(token) && !(await Bun.file(join(root, token)).exists())) {
        problems.push(`package.json script "${name}" runs ${token}, which does not exist`);
      }
    }
    for (const match of command.matchAll(SCRIPT_REFERENCE)) {
      const target = match[1];
      if (target && !available.has(target)) {
        problems.push(`package.json script "${name}" runs \`bun run ${target}\`: no such script`);
      }
    }
  }

  const citedIn = new Map<string, Set<string>>();
  for (const pattern of DOC_PATTERNS) {
    for await (const file of new Glob(pattern).scan({ cwd: root })) {
      if (file.includes("node_modules") || file.includes(".archived")) continue;
      const content = await Bun.file(join(root, file)).text();
      for (const match of content.matchAll(SCRIPT_REFERENCE)) {
        const name = match[1];
        if (!name || available.has(name)) continue;
        citedIn.set(name, (citedIn.get(name) ?? new Set()).add(file));
      }
    }
  }
  for (const [name, files] of citedIn) {
    problems.push(
      `bun run ${name}: no such script in package.json (cited in ${[...files].join(", ")})`
    );
  }
  return problems;
}

if (import.meta.main) {
  const problems = await findBrokenReferences(PROJECT_ROOT);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`❌ ${problem}`);
    process.exit(1);
  }
  console.log("✅ Every package.json script target and every documented `bun run <script>` exists");
}
