import { describe, expect, test } from "bun:test";

import {
  canUseCandidateTag,
  compareTagVersions,
  isPreReleaseTag,
  parseLsRemoteHeadOutput,
  refsPointToSameCommit,
} from "./check-updates";

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

describe("git-ref helpers", () => {
  test("parses HEAD commit from ls-remote output", () => {
    const output = "cbe74b570d38aa0c4d42914e7a118bcb3adaee7a\tHEAD\n";
    expect(parseLsRemoteHeadOutput(output)).toBe("cbe74b570d38aa0c4d42914e7a118bcb3adaee7a");
  });

  test("ignores non-head refs and invalid hashes", () => {
    const output = [
      "notasha\tHEAD",
      "1234567890abcdef1234567890abcdef12345678\trefs/heads/main",
      "feedbeef\tHEAD",
    ].join("\n");
    expect(parseLsRemoteHeadOutput(output)).toBeNull();
  });

  test("treats matching full refs as equal", () => {
    expect(
      refsPointToSameCommit(
        "cbe74b570d38aa0c4d42914e7a118bcb3adaee7a",
        "cbe74b570d38aa0c4d42914e7a118bcb3adaee7a"
      )
    ).toBeTrue();
  });

  test("treats matching short/full refs as equal when prefix is long enough", () => {
    expect(refsPointToSameCommit("cbe74b570d38aa0c4d42914e7a118bcb3adaee7a", "cbe74b5")).toBeTrue();
  });

  test("does not match unrelated refs", () => {
    expect(
      refsPointToSameCommit(
        "cbe74b570d38aa0c4d42914e7a118bcb3adaee7a",
        "7c8603f14d8d20ea84435b0b8409a4e1a40147b0"
      )
    ).toBeFalse();
  });
});
