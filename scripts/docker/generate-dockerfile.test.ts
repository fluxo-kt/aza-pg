#!/usr/bin/env bun
/**
 * Properties of the committed, generated Dockerfile whose loss changes the shipped image or makes its
 * build unsafe: no unfilled template placeholder, fail-fast RUN chains, a module-file check per
 * installed entry, a shared-library check after the last package removal, locked cache mounts,
 * digest-pinned bases, the security upgrade, build-metadata ARGs that leave the RUN cache alone, and no
 * whole-context COPY. Whether the committed file matches
 * the template is scripts/verify-generated.ts's job, not this file's.
 *
 * Usage: bun test scripts/docker/generate-dockerfile.test.ts
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { join } from "node:path";
import { MANIFEST_ENTRIES, MANIFEST_METADATA } from "../extensions/manifest-data";

const DOCKERFILE_PATH = join(import.meta.dir, "../../docker/postgres/Dockerfile");

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

/** The text of the last build stage, from its FROM line on. */
function finalStage(dockerfile: string): string {
  return dockerfile.slice(dockerfile.lastIndexOf("\nFROM ") + 1);
}

const sourceToolBinaries = MANIFEST_ENTRIES.filter(
  (e) =>
    e.kind === "tool" &&
    (e.install_via ?? "source") === "source" &&
    (e.enabled ?? true) &&
    e.binaryPath
).map((e) => e.binaryPath as string);

describe("Generated Dockerfile", () => {
  let dockerfile: string;
  let runs: string[];

  beforeAll(async () => {
    dockerfile = await Bun.file(DOCKERFILE_PATH).text();
    runs = runInstructions(dockerfile);
  });

  test("no template placeholder is left unfilled", () => {
    expect(dockerfile.match(/\{\{[A-Z0-9_]+\}\}/g) ?? []).toEqual([]);
  });

  test("every RUN that chains commands starts with set -euo pipefail", () => {
    // -u and pipefail catch unset variables and failed pipe stages; a single command needs neither.
    expect(runs.length).toBeGreaterThan(0);
    const unguarded = runs.filter((run) => {
      const body = runBody(run);
      return !body.startsWith("set -euo pipefail") && /&&|\|\||;|\|/.test(body);
    });
    expect(unguarded).toEqual([]);
  });

  test("every RUN is one && chain, so any failed step fails the layer", () => {
    // set -e never exits for a command inside an && list, so `a && b; c` and `a && b || true` both exit
    // 0 when a or b fails and the layer builds without the step. Best-effort steps go in `{ cmd || true; }`
    // and conditionals in if/for blocks, which keep their ; and || out of the top level.
    const escaping = runs
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

  test("every enabled apt module entry has its module file checked at build time", () => {
    const pgMajor = MANIFEST_METADATA.pgVersion.split(".")[0];
    const viaPackage = new Set(["pgdg", "percona", "timescale"]);
    const unchecked = MANIFEST_ENTRIES.filter(
      (e) => e.kind === "extension" && viaPackage.has(e.install_via ?? "") && (e.enabled ?? true)
    )
      .filter(
        (e) => !dockerfile.includes(`test -f /usr/lib/postgresql/${pgMajor}/lib/${e.soFileName}`)
      )
      .map((e) => `${e.name} (${e.install_via}, soFileName ${e.soFileName ?? "missing"})`);
    expect(unchecked).toEqual([]);
  });

  test("every build.patches file exists and the builder copies it to where build-extensions.ts reads it", async () => {
    // build-extensions.ts applies build.patches from /opt/patches; without the COPY, git apply fails on a missing file.
    const copy = "COPY docker/postgres/patches/ /opt/patches/";
    expect(dockerfile.includes(copy)).toBe(true);
    const patches = MANIFEST_ENTRIES.flatMap((e) => e.build?.patches ?? []);
    const missing: string[] = [];
    for (const patch of patches) {
      if (!(await Bun.file(join(import.meta.dir, "../../docker/postgres/patches", patch)).exists()))
        missing.push(patch);
    }
    expect(missing).toEqual([]);
  });

  test("builders ship each source tool's binaryPath and never a whole bin directory", () => {
    // A whole-directory copy of the builder's /usr/local/bin once shipped bun and the build scripts.
    expect(dockerfile.match(/^.*rsync[^\n]*\/bin\/ .*$/gm) ?? []).toEqual([]);
    const unshipped = sourceToolBinaries.filter(
      (bin) => !dockerfile.includes(`install -D -m 0755 ${bin} /opt/ext-out${bin}`)
    );
    expect(unshipped).toEqual([]);
  });

  test("every module, source library and source tool binary is ldd-checked after the last package removal", () => {
    // apt-get purge --auto-remove drops libraries that only an unrelated package held; objects built from
    // source declare no package dependency, so a check that runs before the purge certifies a broken image.
    const pgMajor = MANIFEST_METADATA.pgVersion.split(".")[0];
    const check = runs.findLastIndex((run) => run.includes('ldd "$f"'));
    const lastRemoval = runs.findLastIndex((run) =>
      /apt-get (-\S+ )*(purge|remove|autoremove)\b/.test(run)
    );
    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(lastRemoval);
    const objects = runs[check]!.match(/for f in ([^;]*); do/)?.[1]?.split(/\s+/) ?? [];
    expect(objects).toEqual(
      expect.arrayContaining([
        `/usr/lib/postgresql/${pgMajor}/lib/*.so`,
        "/usr/local/lib/*.so*",
        ...sourceToolBinaries,
      ])
    );
  });

  test("cache mounts use sharing=locked", () => {
    // builder-pgxs and builder-cargo run concurrently and both mount /root/.cache.
    const unlocked = dockerfile
      .split("\n")
      .filter((line) => line.includes("--mount=type=cache") && !line.trimStart().startsWith("#"))
      .filter((line) => !line.includes("sharing=locked"));
    expect(unlocked).toEqual([]);
  });

  test("every postgres base image is digest-pinned", () => {
    const bases = dockerfile.match(/^FROM\s+postgres:.*$/gm) ?? [];
    expect(bases.length).toBeGreaterThanOrEqual(2); // builder-base and the final stage
    expect(bases.filter((line) => !/@sha256:[a-f0-9]{64}\b/.test(line))).toEqual([]);
  });

  test("final image refreshes security updates before its first package install", () => {
    // The pinned base digest freezes Debian packages at its build date; only the upgrade brings security fixes.
    const commands = runInstructions(finalStage(dockerfile)).map(runBody).join("\n");
    const upgrade = commands.indexOf("apt-get upgrade -y --no-install-recommends");
    expect(upgrade).toBeGreaterThanOrEqual(0);
    expect(upgrade).toBeLessThan(commands.indexOf("apt-get install"));
  });

  test("build-metadata ARGs come after the final stage's last RUN", () => {
    // Every RUN after an ARG gets it in its environment and cache key; a per-build BUILD_DATE would
    // re-run each of those RUNs on every build.
    const stage = finalStage(dockerfile);
    const firstArg = stage.search(/^ARG\s/m);
    expect(firstArg).toBeGreaterThanOrEqual(0);
    expect(runInstructions(stage.slice(firstArg))).toEqual([]);
  });

  test("no COPY of the whole build context", () => {
    expect(dockerfile.match(/^COPY (--\S+\s+)*\.\s/gm) ?? []).toEqual([]);
  });
});
