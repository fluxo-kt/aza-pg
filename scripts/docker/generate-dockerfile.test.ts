#!/usr/bin/env bun
/**
 * Properties of the committed, generated Dockerfile whose loss changes the shipped image or makes its
 * build unsafe: no unfilled template placeholder, fail-fast RUN chains, locked cache mounts, a
 * digest-pinned base, the security upgrade, and no whole-context COPY. Whether the committed file matches
 * the template is scripts/verify-generated.ts's job, not this file's.
 *
 * Usage: bun test scripts/docker/generate-dockerfile.test.ts
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { join } from "node:path";

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

describe("Generated Dockerfile", () => {
  let dockerfile: string;

  beforeAll(async () => {
    dockerfile = await Bun.file(DOCKERFILE_PATH).text();
  });

  test("no template placeholder is left unfilled", () => {
    expect(dockerfile.match(/\{\{[A-Z0-9_]+\}\}/g) ?? []).toEqual([]);
  });

  test("every RUN that chains commands starts with set -euo pipefail", () => {
    // SHELL already sets pipefail, but without -e a failed step mid-chain is ignored and the layer still
    // builds. A single command needs no -e, so only chains (&&, ||, ;, |) are held to it.
    const runs = runInstructions(dockerfile);
    expect(runs.length).toBeGreaterThan(0);
    const unguarded = runs.filter((run) => {
      const body = run.replace(/^RUN\s+((--mount=\S+)\s*\\?\s*)*/, "").trimStart();
      return !body.startsWith("set -euo pipefail") && /&&|\|\||;|\|/.test(body);
    });
    expect(unguarded).toEqual([]);
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
