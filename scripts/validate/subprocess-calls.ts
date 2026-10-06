#!/usr/bin/env bun
/**
 * Three subprocess mistakes that fail silently, checked in every tracked script, workflow and doc code block:
 *   1. A container `docker rm` / `docker container rm` without `-v` (or `--volumes`) among that call's own arguments.
 *      PG18 images keep PGDATA in an anonymous volume, so each such teardown orphans one; they piled up to tens of
 *      GB. `-v` never removes a NAMED volume, so it is always safe. `docker compose down` is deliberately out of
 *      scope: there `-v` also deletes the stack's named volumes, so it encodes intent, not correctness.
 *   2. A TypeScript subprocess env given as an object literal that does not spread `Bun.env` / `process.env`:
 *      `$\`…\`.env({ … })` and the `env: { … }` option of `spawn`/`spawnSync`. It REPLACES the whole environment,
 *      stripping PATH, HOME and DOCKER_CONFIG (docker credential helpers and cargo then fail). An object that sets
 *      PATH itself is a deliberate minimal environment and passes.
 *   3. `docker exec` / `docker container exec` fed by a heredoc, here-string, `<` redirect or pipe without `-i`.
 *      Without `-i` docker never forwards stdin, so `psql` reads nothing and exits 0: the SQL silently never runs.
 *      `docker compose exec` keeps stdin attached by default (it has no `-i` option), so it is not checked.
 * Comment lines are skipped: prose about a mistake is not a call. Shell text is matched in every scanned file type
 * (TypeScript template literals included); the `["docker", "rm", …]` array form is matched in TypeScript.
 *
 * Usage: bun scripts/validate/subprocess-calls.ts   (exit 1 lists each file:line with what to write instead)
 */

// Git pathspecs: these trees, plus files at the repository root (README, QUICK_START, AGENTS…).
const ROOTS = [
  "scripts/",
  "docker/",
  "deployments/",
  "docs/",
  "stacks/",
  "tests/",
  ".github/",
  ":(glob)*",
];
const SCANNED = /\.(ts|sh|md|ya?ml)$/;
const SELF = new Set([
  "scripts/validate/subprocess-calls.ts",
  "scripts/validate/subprocess-calls.test.ts",
]);

const RM_FIX =
  'container `docker rm` without -v orphans the container\'s anonymous PGDATA volume; write `docker rm -f -v <name>` (array form: ["docker", "rm", "-f", "-v", name])';
const ENV_FIX =
  "this env object replaces the whole subprocess environment (PATH, HOME, DOCKER_CONFIG are lost); write `{ ...Bun.env, KEY: value }`";
const EXEC_FIX =
  "`docker exec` without -i never forwards stdin, so the heredoc/pipe/redirect is dropped and the command silently does nothing; write `docker exec -i <container> …`";

/** Lines that hold code: every line, or only fenced code blocks in Markdown. Index = 0-based line number. */
function codeLines(file: string, text: string): (string | null)[] {
  const lines = text.split("\n");
  if (!file.endsWith(".md")) return lines;
  let fence: string | null = null;
  return lines.map((line) => {
    const m = /^\s*(```|~~~)/.exec(line);
    if (m) {
      fence = fence === null ? m[1]! : fence === m[1] ? null : fence;
      return null;
    }
    return fence === null ? null : line;
  });
}

const isComment = (line: string) => /^\s*(\/\/|#|\*|\/\*)/.test(line);

/**
 * Quoted spans (a quote left open runs to the end of the line, as in a multi-line `bash -c '…'`) and doc placeholders
 * such as `<container>` blanked out, so a `<`, `|` or `;` inside an SQL string, a script run in the container or a
 * placeholder is not taken for shell syntax.
 */
const unquote = (s: string) =>
  s.replace(/'[^']*('|$)|"(?:[^"\\]|\\.)*("|$)|<[A-Za-z][\w-]*>/g, (q) => " ".repeat(q.length));

/** End of the shell command starting at `from`: the next separator, pipe, backtick or `)`. */
function commandEnd(s: string, from: number): number {
  const m = /;|&&|\|\||\||`|\)|\s#/.exec(unquote(s.slice(from)));
  return m ? from + m.index : s.length;
}

const tokens = (s: string) =>
  s
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^["']|["'],?$/g, ""))
    .filter(Boolean);

const hasShortFlag = (token: string, letter: string) =>
  new RegExp(`^-[a-zA-Z]*${letter}[a-zA-Z]*$`).test(token);

// docker exec options that take a value: their argument is not the container name.
const EXEC_VALUE_OPTIONS = new Set([
  "-u",
  "--user",
  "-e",
  "--env",
  "-w",
  "--workdir",
  "--env-file",
  "--detach-keys",
]);

/** True when docker exec's own options (before the container name) include -i. */
function execHasInteractive(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!;
    if (!t.startsWith("-")) return false;
    if (t === "--interactive" || hasShortFlag(t, "i")) return true;
    if (EXEC_VALUE_OPTIONS.has(t) || /^-[a-zA-Z]*[uew]$/.test(t)) i++;
  }
  return false;
}

/** Index of the bracket closing the one at `open` (same kind), or the end of the text. */
function closing(text: string, open: number): number {
  const pair: Record<string, string> = { "[": "]", "{": "}", "(": ")" };
  const o = text[open]!;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === o) depth++;
    else if (text[i] === pair[o] && --depth === 0) return i;
  }
  return text.length;
}

/** Index of the `(` whose argument list contains `at`, or -1. */
function enclosingParen(text: string, at: number): number {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = text[i]!;
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") {
      if (depth === 0 && c === "(") return i;
      if (depth > 0) depth--;
    }
  }
  return -1;
}

export function findProblems(file: string, text: string): string[] {
  const problems: string[] = [];
  const lines = codeLines(file, text);
  const report = (line: number, why: string) => problems.push(`${file}:${line + 1}: ${why}`);
  const lineOf = (index: number) => text.slice(0, index).split("\n").length - 1;

  // Shell text, one logical line at a time (a trailing `\` continues it).
  for (let i = 0; i < lines.length; i++) {
    const first = lines[i];
    if (first == null || isComment(first)) continue;
    let logical = first;
    const start = i;
    while (/\\\s*$/.test(logical) && lines[i + 1] != null)
      logical = logical.replace(/\\\s*$/, " ") + lines[++i];

    for (const m of logical.matchAll(/\bdocker\s+(?:container\s+)?rm\b/g)) {
      const args = tokens(logical.slice(m.index + m[0].length, commandEnd(logical, m.index)));
      if (!args.some((t) => t === "--volumes" || hasShortFlag(t, "v"))) report(start, RM_FIX);
    }
    for (const m of logical.matchAll(/\bdocker\s+(?:container\s+)?exec\b/g)) {
      const end = commandEnd(logical, m.index);
      const plain = unquote(logical);
      const before = plain.slice(0, m.index);
      // The pipeline this exec belongs to starts after the last command separator before it.
      const cut = Math.max(
        before.lastIndexOf(";") + 1,
        before.lastIndexOf("&&") + 2,
        before.lastIndexOf("||") + 2,
        before.lastIndexOf("`") + 1
      );
      const piped = /(^|[^|])\|(?!\|)/.test(before.slice(cut));
      const redirected = /</.test(plain.slice(m.index, end));
      if (
        (piped || redirected) &&
        !execHasInteractive(tokens(logical.slice(m.index + m[0].length, end)))
      )
        report(start, EXEC_FIX);
    }
  }

  if (!file.endsWith(".ts")) return problems;
  const isCommentAt = (index: number) => isComment(text.split("\n")[lineOf(index)] ?? "");

  for (const m of text.matchAll(
    /\[\s*(["'`])docker\1\s*,\s*(?:(["'`])container\2\s*,\s*)?(["'`])rm\3/g
  )) {
    if (isCommentAt(m.index)) continue;
    const args = text.slice(m.index, closing(text, m.index));
    if (!/(["'`])(--volumes|-[a-zA-Z]*v[a-zA-Z]*)\1/.test(args)) report(lineOf(m.index), RM_FIX);
  }

  const spreadsEnv = (body: string) =>
    /\.\.\.\s*(Bun|process)\.env\b/.test(body) || /(^|[{,\s])PATH\s*:/.test(body);
  for (const m of text.matchAll(/\.env\(\s*\{/g)) {
    if (isCommentAt(m.index)) continue;
    const open = m.index + m[0].length - 1;
    if (!spreadsEnv(text.slice(open, closing(text, open)))) report(lineOf(m.index), ENV_FIX);
  }
  for (const m of text.matchAll(/\benv\s*:\s*\{/g)) {
    if (isCommentAt(m.index)) continue;
    // Only a spawn option replaces a subprocess env; other `env:` keys (a test case's container env) are data.
    const paren = enclosingParen(text, m.index);
    if (paren < 0 || !/\b(?:Bun\.)?spawn(?:Sync)?\s*$/.test(text.slice(0, paren))) continue;
    const open = m.index + m[0].length - 1;
    if (!spreadsEnv(text.slice(open, closing(text, open)))) report(lineOf(m.index), ENV_FIX);
  }
  return problems;
}

if (import.meta.main) {
  const list = async (flags: string[]) =>
    (await Bun.$`git ls-files ${flags}`.quiet().text()).split("\n").filter(Boolean);
  const deleted = new Set(await list(["--deleted"]));
  const files = (await list(["--cached", "--others", "--exclude-standard", "--", ...ROOTS]))
    // This file and its test are skipped: its messages quote the forms it forbids, and the test plants them.
    .filter((f) => SCANNED.test(f) && !deleted.has(f) && !SELF.has(f))
    .sort();
  const problems: string[] = [];
  for (const file of files) problems.push(...findProblems(file, await Bun.file(file).text()));
  if (problems.length > 0) {
    console.error(`Unsafe subprocess calls:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`Subprocess calls safe in ${files.length} files`);
}
