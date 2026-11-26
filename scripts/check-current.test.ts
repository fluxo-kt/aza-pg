import { describe, expect, test } from "bun:test";
import { actionUpdates, outdatedPackages } from "./check-current";

describe("outdatedPackages", () => {
  // Shapes captured from `bun outdated` 1.4.5: it exits 0 in both cases, so the table is the only verdict.
  test("lists package rows, never the header or separators", () => {
    const out = [
      "bun outdated v1.4.5 (a7733435c)",
      "|----------------------------------------------------|",
      "| Package              | Current | Update  | Latest  |",
      "|----------------------|---------|---------|---------|",
      "| @pgflow/client (dev) | 0.17.2  | 0.17.2  | 0.18.0  |",
      "|----------------------|---------|---------|---------|",
      "| oxlint (dev)         | 1.94.0  | 1.95.0  | 1.95.0  |",
    ].join("\n");
    expect(outdatedPackages(out)).toEqual(["@pgflow/client (dev)", "oxlint (dev)"]);
  });

  test("nothing outdated prints only the banner", () => {
    expect(outdatedPackages("bun outdated v1.4.5 (a7733435c)\n")).toEqual([]);
  });
});

describe("actionUpdates", () => {
  test("reads summary.totalUpdates", () => {
    expect(actionUpdates(JSON.stringify({ summary: { totalUpdates: 4, totalActions: 72 } }))).toBe(
      4
    );
  });

  // A changed report shape must fail the check, never read as zero updates.
  test("a report without the count throws", () => {
    expect(() => actionUpdates(JSON.stringify({ summary: {} }))).toThrow();
  });
});
