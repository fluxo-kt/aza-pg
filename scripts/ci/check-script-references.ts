#!/usr/bin/env bun
/**
 * Fail when a package.json script or a documented `bun run <script>` points at nothing.
 *
 * Two ways an instruction silently rots when a file or script is renamed or deleted:
 * - docs (AGENTS.md, README.md, docs/**\/*.md) cite `bun run <name>` for a script package.json lacks;
 * - a package.json script runs a repo file (`bun scripts/x.ts`) or another script (`bun run x`) that
 *   no longer exists, so the documented command fails only when someone runs it.
 * `bun run <path>` forms (containing "/" or ".") run a file, not a script, and are skipped in docs.
 * - docs and the agent commands cite a backticked repo path (`scripts/…`, `docker/…`, `stacks/…`, `tests/…`)
 *   that no longer exists, so a reader (often an agent) follows it into nothing. Globs and placeholders
 *   (`*`, `<name>`, `{a,b}`, `$VAR`) name no single file and are skipped; a `:line` suffix is ignored.
 *
 * Usage: bun scripts/ci/check-script-references.ts
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Glob } from "bun";

const PROJECT_ROOT = join(import.meta.dir, "../..");
const DOC_PATTERNS = ["AGENTS.md", "README.md", "docs/**/*.md"];
// Agent commands are read by agents mid-task, so a dead path there misdirects work, not just a reader.
const PATH_DOC_PATTERNS = [...DOC_PATTERNS, ".claude/commands/*.md"];
const REPO_PATH = /`((?:scripts|docker|stacks|tests)\/[^`\s]*)`/g;
const PLACEHOLDER = /[*<>{}$]|\bX{2,}\b|EXTNAME/;
// GitHub Actions published by the docker org (`docker/login-action`) share the docker/ prefix.
const NOT_A_PATH = /^docker\/[\w-]+-action$/;
// Script names may contain digits (`test:image-functional-1`); the lookahead rejects a match that is
// really the start of a path (`bun run scripts/x.ts`, `bun run ./x`).
const SCRIPT_REFERENCE = /bun\s+run\s+([a-z0-9:_-]+)(?![./\w])/gi;
// `bun <name>` also runs a package.json script; a name with ":" (`bun test:all`) can only be one, never a file.
const SCRIPT_SHORTHAND = /\bbun\s+([a-z0-9_-]+:[a-z0-9:_-]+)(?![./\w])/gi;
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
      for (const match of [
        ...content.matchAll(SCRIPT_REFERENCE),
        ...content.matchAll(SCRIPT_SHORTHAND),
      ]) {
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
  for (const pattern of PATH_DOC_PATTERNS) {
    for await (const file of new Glob(pattern).scan({ cwd: root, dot: true })) {
      if (file.includes("node_modules") || file.includes(".archived")) continue;
      const lines = (await Bun.file(join(root, file)).text()).split("\n");
      for (const [index, line] of lines.entries()) {
        for (const match of line.matchAll(REPO_PATH)) {
          const cited = match[1]?.replace(/:\d.*$/, "").replace(/[.,;:]$/, "");
          if (!cited || PLACEHOLDER.test(cited) || NOT_A_PATH.test(cited)) continue;
          const exists = await stat(join(root, cited)).then(
            () => true,
            () => false
          );
          if (!exists) {
            problems.push(
              `${file}:${index + 1}: \`${cited}\` does not exist; point it at the file that replaced it, or delete the sentence if nothing did`
            );
          }
        }
      }
    }
  }
  return problems;
}

if (import.meta.main) {
  const problems = await findBrokenReferences(PROJECT_ROOT);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`❌ ${problem}`);
    process.exit(1);
  }
  console.log(
    "✅ Every package.json script target, documented `bun run <script>` and backticked repo path exists"
  );
}
