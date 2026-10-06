#!/usr/bin/env bun
/**
 * SUITES in scripts/test-all.ts must stay the only list of Docker suites, and complete.
 *
 * Fails when:
 * - a `scripts/**\/test-*.ts` (Docker suite naming; `*.test.ts` are unit tests) is neither in SUITES nor
 *   imported by a file that is (libraries named test-* are covered that way);
 * - a SUITES path does not exist;
 * - a workflow passes `--group` a group test-all does not have, or starts a suite file itself instead of
 *   `bun scripts/test-all.ts --group <group>`.
 *
 * Why: suites were listed in test-all, five workflows and package.json; the lists drifted until suites ran nowhere
 * and workflows called deleted files.
 */
import { Glob } from "bun";
import { dirname, join } from "node:path";
import { GROUPS, SUITES } from "../test-all";

const problems: string[] = [];
const read = (path: string) => Bun.file(path).text();
// Untracked (not ignored) files too: a new suite is most likely unregistered before its first `git add`. Files deleted
// from the working tree but still in the index are gone for every run, so they count as missing.
const lsFiles = async (flags: string[]) =>
  (await Bun.$`git ls-files ${flags}`.quiet().text()).split("\n").filter(Boolean);
const deleted = new Set(await lsFiles(["--deleted"]));
const files = new Set(
  (await lsFiles(["--cached", "--others", "--exclude-standard"])).filter((f) => !deleted.has(f))
);

for (const suite of new Set(SUITES.map((s) => s.path))) {
  if (!files.has(suite)) {
    problems.push(
      `scripts/test-all.ts: SUITES names ${suite}, which does not exist; fix or remove that entry`
    );
  }
}

// Covered = registered, or imported by a covered file; grown to a fixpoint. Imports come from the transpiler, never
// a text search: a path named in a comment or a log line would otherwise count as coverage for a suite that runs
// nowhere.
const candidates = [...files].filter(
  (f) =>
    /^scripts\/(.*\/)?test-[^/]*\.ts$/.test(f) &&
    !f.endsWith(".test.ts") &&
    f !== "scripts/test-all.ts"
);
const covered = new Set(SUITES.map((s) => s.path).filter((p) => files.has(p)));
const transpiler = new Bun.Transpiler({ loader: "ts" });
const importsOf = async (file: string) =>
  transpiler
    // The transpiler rejects a shebang line; blanking it keeps line numbers in its parse errors.
    .scanImports((await read(file)).replace(/^#!.*/, ""))
    .map((i) => i.path)
    .filter((p) => p.startsWith("."))
    .map((p) => {
      const target = join(dirname(file), p);
      return target.endsWith(".ts") ? target : `${target}.ts`;
    });
const scanned = new Set<string>();
for (let grew = true; grew;) {
  grew = false;
  for (const owner of [...covered].filter((f) => !scanned.has(f))) {
    scanned.add(owner);
    for (const target of await importsOf(owner)) {
      if (candidates.includes(target) && !covered.has(target)) {
        covered.add(target);
        grew = true;
      }
    }
  }
}
for (const file of candidates.filter((f) => !covered.has(f)).sort()) {
  problems.push(
    `${file} is not in SUITES, so no workflow or \`bun run test\` runs it; add to scripts/test-all.ts SUITES: { path: "${file}", group: "<${GROUPS.join("|")}>" },`
  );
}

for await (const file of new Glob(".github/**/*.{yml,yaml}").scan({ cwd: ".", dot: true })) {
  if (!files.has(file)) continue;
  const lines = (await read(file)).split("\n");
  // Matrix values feed `--group ${{ matrix.group }}`. Only lines inside a `matrix:` block count: `concurrency:`
  // also has a `group:` key.
  const matrixGroups: { value: string; line: number }[] = [];
  let matrixIndent = -1;
  lines.forEach((l, i) => {
    const indent = l.search(/\S/);
    if (indent < 0) return;
    if (matrixIndent >= 0 && indent <= matrixIndent) matrixIndent = -1;
    if (/^\s*matrix:\s*$/.test(l)) matrixIndent = indent;
    const m =
      matrixIndent >= 0 ? l.match(/^\s*(?:-\s+)?group:\s*["']?([a-z][a-z,-]*)["']?\s*$/) : null;
    if (m) matrixGroups.push({ value: m[1]!, line: i + 1 });
  });
  const literal = lines.flatMap((l, i) =>
    [...l.matchAll(/--group[ =]["']?([a-z][a-z,-]*)/g)].map((m) => ({ value: m[1]!, line: i + 1 }))
  );
  for (const { value, line } of [...matrixGroups, ...literal]) {
    for (const group of value.split(",")) {
      if (!(GROUPS as readonly string[]).includes(group)) {
        problems.push(
          `${file}:${line}: group "${group}" does not exist; groups: ${GROUPS.join(", ")}`
        );
      }
    }
  }
  lines.forEach((l, i) => {
    if (/^\s*#/.test(l)) return;
    for (const m of l.matchAll(/\bbun\s+(?:test\s+)?(?:\.\/)?(scripts\/[\w./-]+\.ts)/g)) {
      const suite = SUITES.find((s) => s.path === m[1]);
      if (suite) {
        problems.push(
          `${file}:${i + 1}: runs ${m[1]} directly; run its group instead: bun scripts/test-all.ts --group ${suite.group} --image <ref>`
        );
      }
    }
  });
}

if (problems.length > 0) {
  console.error(`Suite registry problems:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(
  `Suite registry complete: ${new Set(SUITES.map((s) => s.path)).size} suites, ${covered.size} files covered`
);
