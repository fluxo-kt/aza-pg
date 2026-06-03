import { describe, expect, test } from "bun:test";

import { formatError, getErrorMessage, isExecutableNotFoundError } from "./errors";

describe("isExecutableNotFoundError", () => {
  // The real thing it must catch: Bun.spawn on a missing binary throws an Error with code "ENOENT".
  test("true for a real Bun spawn-of-missing-binary error", () => {
    let caught: unknown;
    try {
      Bun.spawnSync(["definitely-not-a-real-binary-xyz-123"]);
    } catch (e) {
      caught = e;
    }
    expect(isExecutableNotFoundError(caught)).toBe(true);
  });

  test("true for any object carrying code ENOENT", () => {
    expect(isExecutableNotFoundError({ code: "ENOENT" })).toBe(true);
    expect(isExecutableNotFoundError(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe(true);
  });

  // Must NOT swallow genuine failures as "unavailable": a non-zero exit, a different errno, or a
  // plain error are real problems, not a missing tool.
  test("false for non-ENOENT errors and non-objects", () => {
    for (const e of [
      new Error("lint failed"),
      { code: "EACCES" },
      { code: 1 },
      "ENOENT", // a string, not an object with a code field
      null,
      undefined,
      42,
    ]) {
      expect(isExecutableNotFoundError(e)).toBe(false);
    }
  });
});

describe("getErrorMessage / formatError", () => {
  test("getErrorMessage extracts from Error and stringifies the rest", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
    expect(getErrorMessage("raw")).toBe("raw");
  });

  test("formatError prefixes context when given", () => {
    expect(formatError(new Error("boom"), "build")).toBe("build: boom");
    expect(formatError(new Error("boom"))).toBe("boom");
  });
});
