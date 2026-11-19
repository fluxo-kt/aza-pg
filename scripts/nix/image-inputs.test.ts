import { expect, test } from "bun:test";
import { IMAGE_INPUTS } from "./image-inputs";

// The CI cache keys must hash exactly what the local stale-image check diffs: a path in one list only either reuses a
// stale cached image in CI or lets a stale local one pass.
test.each([".github/workflows/ci.yml", ".github/actions/setup-nix/action.yml"])(
  "%s hashes IMAGE_INPUTS",
  async (file) => {
    const call = /hashFiles\(([^)]*)\)/.exec(await Bun.file(file).text())?.[1] ?? "";
    const paths = [...call.matchAll(/'([^']+)'/g)].map((m) => m[1]!.replace(/\/\*\*$/, ""));
    expect(paths.sort()).toEqual([...IMAGE_INPUTS].sort());
  }
);
