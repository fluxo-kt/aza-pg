import { describe, expect, test } from "bun:test";

import { canUseCandidateTag, compareTagVersions, isPreReleaseTag } from "./check-updates";

describe("compareTagVersions", () => {
  test("detects newer and older comparable tags", () => {
    expect(compareTagVersions("2.3.2", "2.3.3")).toBe(1);
    expect(compareTagVersions("2.3.2", "2.3.2")).toBe(0);
    expect(compareTagVersions("2.3.2", "2.3.1")).toBe(-1);
  });

  test("handles prefixed tag families", () => {
    expect(compareTagVersions("release/2.58.0", "release/2.59.0")).toBe(1);
    expect(compareTagVersions("wal2json_2_6", "wal2json_2_7")).toBe(1);
  });

  test("rejects mismatched tag families", () => {
    expect(compareTagVersions("pgflow@0.13.3", "@pgflow/edge-worker@0.13.3")).toBeNull();
  });
});

describe("pre-release filtering", () => {
  test("detects common pre-release markers", () => {
    expect(isPreReleaseTag("2.0.0beta")).toBeTrue();
    expect(isPreReleaseTag("v1.0.0-rc1")).toBeTrue();
    expect(isPreReleaseTag("1.6.7")).toBeFalse();
  });

  test("rejects pre-release upgrades for stable current tags", () => {
    expect(canUseCandidateTag("1.4.2", "2.0.0beta")).toBeFalse();
    expect(canUseCandidateTag("1.4.2", "1.5.0")).toBeTrue();
    expect(canUseCandidateTag("2.0.0-rc1", "2.0.0beta")).toBeTrue();
  });
});
