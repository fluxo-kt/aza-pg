#!/usr/bin/env bun
/**
 * Properties of the committed, generated Dockerfiles whose loss changes the shipped image or makes its
 * build unsafe: no unfilled template placeholder, fail-fast RUN chains (both Dockerfiles), a module-file
 * check per installed entry, locked cache mounts, a digest-pinned base, the security upgrade, and no
 * whole-context COPY. Whether the committed file matches
 * the template is scripts/verify-generated.ts's job, not this file's.
 *
 * Usage: bun test scripts/docker/generate-dockerfile.test.ts
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { join } from "node:path";
import { MANIFEST_ENTRIES, MANIFEST_METADATA } from "../extensions/manifest-data";

const DOCKERFILE_PATH = join(import.meta.dir, "../../docker/postgres/Dockerfile");
const REGRESSION_DOCKERFILE_PATH = join(
  import.meta.dir,
  "../../docker/postgres/regression.Dockerfile"
);

/** Each RUN instruction with its continuation lines joined, comment lines dropped. */
function runInstructions(dockerfile: string): string[] {
  const runs: string[] = [];
  let current: string | null = null;
  for (const line of dockerfile.split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    if (current === null && !/^RUN\s/.test(line)) continue;
    current = current === null ? line : `${current}\n${line}`;
    if (!line.endsWith("\\")) {
      runs.push(current);
      current = null;
    }
  }
  return runs;
}

/** A RUN instruction's shell script: mount flags and line continuations removed. */
function runBody(run: string): string {
  return run
    .replace(/^RUN\s+((--mount=\S+)\s*\\?\s*)*/, "")
    .replace(/\\\n/g, " ")
    .trim();
}

/**
 * The script with quoted strings, `\;`, find's `{}`, $(…), (…) subshells, { …; } groups and if/for/while blocks removed,
 * innermost first, leaving only the operators that join its top-level commands. `|| exit 1` and
 * `|| { …; exit 1; }` go too: they turn a failure into an exit, never into success.
 */
function topLevel(script: string): string {
  let text = script.replace(/'[^']*'|"(?:[^"\\]|\\.)*"|\\;|\{\}/g, "");
  const nested =
    /\|\|\s*(?:exit 1\b|\{ [^{}]*; exit 1; \})|\$?\([^()]*\)|\{ [^{}]*; \}|\bif\b(?:(?!\b(?:if|fi)\b)[\s\S])*\bfi\b|\b(?:for|while)\b(?:(?!\b(?:for|while|done)\b)[\s\S])*\bdone\b/g;
  for (let previous = ""; previous !== text;) {
    previous = text;
    text = text.replace(nested, "");
  }
  return text;
}

describe("Generated Dockerfile", () => {
  let dockerfile: string;
  let bothRuns: string[];

  beforeAll(async () => {
    dockerfile = await Bun.file(DOCKERFILE_PATH).text();
    const regression = await Bun.file(REGRESSION_DOCKERFILE_PATH).text();
    bothRuns = [...runInstructions(dockerfile), ...runInstructions(regression)];
  });

  test("no template placeholder is left unfilled", () => {
    expect(dockerfile.match(/\{\{[A-Z0-9_]+\}\}/g) ?? []).toEqual([]);
  });

  test("every RUN that chains commands starts with set -euo pipefail", () => {
    // -u and pipefail catch unset variables and failed pipe stages; a single command needs neither.
    expect(bothRuns.length).toBeGreaterThan(0);
    const unguarded = bothRuns.filter((run) => {
      const body = runBody(run);
      return !body.startsWith("set -euo pipefail") && /&&|\|\||;|\|/.test(body);
    });
    expect(unguarded).toEqual([]);
  });

  test("every RUN is one && chain, so any failed step fails the layer", () => {
    // set -e never exits for a command inside an && list, so `a && b; c` and `a && b || true` both exit
    // 0 when a or b fails and the layer builds without the step. Best-effort steps go in `{ cmd || true; }`
    // and conditionals in if/for blocks, which keep their ; and || out of the top level.
    const escaping = bothRuns
      .map((run) => ({ run, top: topLevel(runBody(run)) }))
      .filter(({ top }) => /;|\|\|/.test(top))
      .map(({ run }) => run);
    expect(escaping).toEqual([]);
  });

  test("the top-level reduction keeps exactly the separators that escape the chain", () => {
    expect(topLevel("a && b; c || true")).toBe("a && b; c || true");
    expect(topLevel('test -s f || { echo "empty"; exit 1; } && [ x ] || exit 1')).toBe(
      "test -s f  && [ x ] "
    );
    expect(topLevel("a && { c || true; } && if x; then y; fi && for i in 1; do z; done")).toBe(
      "a &&  &&  && "
    );
    expect(topLevel("find . -exec strip {} \\; && echo 'a; b' \"c || d\" && v=$(x || y)")).toBe(
      "find . -exec strip   && echo   && v="
    );
    expect(topLevel("a && { find . -exec strip {} \\; || true; }")).toBe("a && ");
  });

  test("every enabled apt or release module entry has its module file checked at build time", () => {
    const pgMajor = MANIFEST_METADATA.pgVersion.split(".")[0];
    const viaPackage = new Set(["pgdg", "percona", "timescale", "github-release"]);
    const unchecked = MANIFEST_ENTRIES.filter(
      (e) => e.kind === "extension" && viaPackage.has(e.install_via ?? "") && (e.enabled ?? true)
    )
      .filter(
        (e) => !dockerfile.includes(`test -f /usr/lib/postgresql/${pgMajor}/lib/${e.soFileName}`)
      )
      .map((e) => `${e.name} (${e.install_via}, soFileName ${e.soFileName ?? "missing"})`);
    expect(unchecked).toEqual([]);
  });

  test("cache mounts use sharing=locked", () => {
    const unlocked = dockerfile
      .split("\n")
      .filter((line) => line.includes("--mount=type=cache") && !line.trimStart().startsWith("#"))
      .filter((line) => !line.includes("sharing=locked"));
    expect(unlocked).toEqual([]);
  });

  test("the postgres base image is digest-pinned", () => {
    const baseImage = dockerfile.match(/^FROM .*postgres:.*/m)?.[0];
    expect(baseImage).toMatch(/@sha256:[a-f0-9]{64}/);
  });

  test("final image refreshes security updates before runtime package installs", () => {
    expect(dockerfile).toContain("apt-get upgrade -y --no-install-recommends");
  });

  test("no COPY of the whole build context", () => {
    expect(dockerfile.match(/^COPY (--\S+\s+)*\.\s/gm) ?? []).toEqual([]);
  });
});
