import { describe, expect, test } from "bun:test";

import {
  builderPresentInList,
  ids,
  isAzaImageTitle,
  parseImageInspectLine,
  parseVolumeProbeMatches,
} from "./cleanup-artifacts";

// These functions decide what cleanup DELETES. The overriding safety property: an artifact belonging
// to any other project must NEVER be selected. Tests below try to break that, not confirm it.

describe("isAzaImageTitle — foreign images must never match", () => {
  test("aza-pg's own title matches", () => {
    expect(isAzaImageTitle("aza-pg PostgreSQL 18")).toBe(true);
    expect(isAzaImageTitle("aza-pg PostgreSQL 18.4")).toBe(true);
  });

  test("foreign / empty titles do NOT match", () => {
    for (const t of ["postgres", "postgres:18-trixie", "redis", "my-app", "", undefined]) {
      expect(isAzaImageTitle(t)).toBe(false);
    }
  });

  // The bug startsWith prevents: a substring match (includes) would sweep a foreign project whose
  // name merely contains "aza-pg". Anchoring at the start is the safety boundary.
  test("a name merely CONTAINING aza-pg does not match (anchored, not substring)", () => {
    expect(isAzaImageTitle("my-aza-pg-fork PostgreSQL 18")).toBe(false);
    expect(isAzaImageTitle("not-aza-pg")).toBe(false);
  });
});

describe("parseImageInspectLine", () => {
  test("splits title|size and coerces size", () => {
    expect(parseImageInspectLine("aza-pg PostgreSQL 18|524288000")).toEqual({
      title: "aza-pg PostgreSQL 18",
      size: 524288000,
    });
  });

  test("missing/blank label yields undefined title and 0 size (never NaN)", () => {
    expect(parseImageInspectLine("|")).toEqual({ title: undefined, size: 0 });
    expect(parseImageInspectLine("aza-pg|notanumber")).toEqual({ title: "aza-pg", size: 0 });
  });
});

describe("parseVolumeProbeMatches — only positively-marked volumes, correct ids", () => {
  const batch = ["volA", "volB", "volC", "volD"];

  test("maps emitted indices back to the right volume ids", () => {
    expect(parseVolumeProbeMatches("0\n2", batch)).toEqual(["volA", "volC"]);
  });

  test("empty probe output selects nothing", () => {
    expect(parseVolumeProbeMatches("", batch)).toEqual([]);
    expect(parseVolumeProbeMatches("\n  \n", batch)).toEqual([]);
  });

  // A glitch must never select an unmarked volume: out-of-range / non-numeric indices are dropped,
  // not coerced into a wrong id.
  test("malformed or out-of-range indices are ignored, not mapped to a wrong volume", () => {
    expect(parseVolumeProbeMatches("99\nfoo\n-1\n1", batch)).toEqual(["volB"]);
  });
});

describe("builderPresentInList", () => {
  test("detects the dedicated builder, ignores others", () => {
    const ls =
      "NAME/NODE          DRIVER\ndefault            docker\naza-pg-builder *   docker-container";
    expect(builderPresentInList(ls)).toBe(true);
    expect(builderPresentInList("default docker\nother-builder docker-container")).toBe(false);
  });
});

describe("ids", () => {
  test("trims and drops blank lines", () => {
    expect(ids("a\n  b  \n\n c\n")).toEqual(["a", "b", "c"]);
    expect(ids("")).toEqual([]);
  });
});
