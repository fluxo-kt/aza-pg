import { describe, expect, test } from "bun:test";
import {
  checkIgnoreSchema,
  checkScannerPin,
  REQUIRED_SCANNER,
  type Violation,
} from "./validate-bun-osv";

// Fixed clock so `expires` boundary tests are deterministic (the pure functions take `now` explicitly).
const NOW = new Date("2026-06-02T00:00:00Z");
const FUTURE = "2026-12-31";
const PAST = "2020-01-01";

function messages(violations: Violation[]): string {
  return violations.map((v) => `${v.source}: ${v.message}`).join("\n");
}

/** Assert at least one violation whose combined source+message contains every needle. */
function expectViolation(violations: Violation[], ...needles: string[]): void {
  const hit = violations.some((v) => needles.every((n) => `${v.source} ${v.message}`.includes(n)));
  expect(
    hit,
    `expected a violation matching [${needles.join(", ")}] in:\n${messages(violations)}`
  ).toBe(true);
}

describe("checkIgnoreSchema — green cases", () => {
  test("absent .bun-osv.json and no package.json bunOsv => no violations", () => {
    expect(checkIgnoreSchema(undefined, undefined, NOW)).toEqual([]);
  });

  test("empty canonical { ignore: [] } => no violations", () => {
    expect(checkIgnoreSchema({ ignore: [] }, undefined, NOW)).toEqual([]);
  });

  test("fully-justified, future-dated entry => no violations", () => {
    const file = {
      ignore: [{ advisory: "CVE-2026-12345", reason: "unfixable upstream", expires: FUTURE }],
    };
    expect(checkIgnoreSchema(file, undefined, NOW)).toEqual([]);
  });

  test("package matcher with range + reason + future expires => no violations", () => {
    const file = {
      ignore: [{ package: "left-pad", range: "<1.3.0", reason: "no patch", expires: FUTURE }],
    };
    expect(checkIgnoreSchema(file, undefined, NOW)).toEqual([]);
  });
});

describe("checkIgnoreSchema — entry justification (RED)", () => {
  test("missing reason fails", () => {
    const v = checkIgnoreSchema(
      { ignore: [{ advisory: "CVE-2026-1", expires: FUTURE }] },
      undefined,
      NOW
    );
    expectViolation(v, "reason");
  });

  test("missing expires fails (permanent silent suppression)", () => {
    const v = checkIgnoreSchema(
      { ignore: [{ advisory: "CVE-2026-1", reason: "x" }] },
      undefined,
      NOW
    );
    expectViolation(v, "expires");
  });

  test("past expires fails", () => {
    const v = checkIgnoreSchema(
      { ignore: [{ advisory: "CVE-2026-1", reason: "x", expires: PAST }] },
      undefined,
      NOW
    );
    expectViolation(v, "past");
  });

  test("unparseable expires fails (scanner would treat as never-expiring)", () => {
    const v = checkIgnoreSchema(
      { ignore: [{ advisory: "CVE-2026-1", reason: "x", expires: "soon-ish" }] },
      undefined,
      NOW
    );
    expectViolation(v, "parseable");
  });

  test("no matcher (only reason+expires) fails", () => {
    const v = checkIgnoreSchema({ ignore: [{ reason: "x", expires: FUTURE }] }, undefined, NOW);
    expectViolation(v, "matcher");
  });

  test("non-object entry fails", () => {
    const v = checkIgnoreSchema({ ignore: ["CVE-2026-1"] }, undefined, NOW);
    expectViolation(v, "must be a JSON object");
  });
});

describe("checkIgnoreSchema — forbidden .bun-osv.json shapes (RED)", () => {
  test("bare array is rejected", () => {
    const v = checkIgnoreSchema(
      [{ advisory: "CVE-2026-1", reason: "x", expires: FUTURE }],
      undefined,
      NOW
    );
    expectViolation(v, ".bun-osv.json", "bare array");
  });

  test("{ packages: {...} } shorthand is rejected (cannot carry reason/expires)", () => {
    const v = checkIgnoreSchema({ packages: { uuid: "*" } }, undefined, NOW);
    expectViolation(v, ".bun-osv.json", "packages");
  });

  test("non-array ignore is rejected", () => {
    const v = checkIgnoreSchema({ ignore: "CVE-2026-1" }, undefined, NOW);
    expectViolation(v, ".bun-osv.json", "must be an array");
  });

  test("non-object, non-array JSON is rejected", () => {
    const v = checkIgnoreSchema(42, undefined, NOW);
    expectViolation(v, ".bun-osv.json");
  });
});

describe("checkIgnoreSchema — package.json#bunOsv.ignore source (RED)", () => {
  test("bad entry in package.json bunOsv.ignore is caught and attributed", () => {
    const pkg = { bunOsv: { ignore: [{ advisory: "CVE-2026-1" }] } };
    const v = checkIgnoreSchema(undefined, pkg, NOW);
    expectViolation(v, "package.json", "reason");
    expectViolation(v, "package.json", "expires");
  });

  test("non-array bunOsv.ignore is rejected", () => {
    const v = checkIgnoreSchema(undefined, { bunOsv: { ignore: "CVE-2026-1" } }, NOW);
    expectViolation(v, "package.json", "must be an array");
  });

  test("package.json with no bunOsv key => no violations from source B", () => {
    expect(checkIgnoreSchema(undefined, { name: "aza-pg" }, NOW)).toEqual([]);
  });
});

describe("checkScannerPin", () => {
  test("correct scanner => no violations", () => {
    expect(checkScannerPin({ install: { security: { scanner: REQUIRED_SCANNER } } })).toEqual([]);
  });

  test("stock @bun-security-scanner/osv (no ignore capability) is rejected", () => {
    const v = checkScannerPin({ install: { security: { scanner: "@bun-security-scanner/osv" } } });
    expectViolation(v, "scanner");
  });

  test("missing scanner is rejected", () => {
    expectViolation(checkScannerPin({}), "scanner");
  });

  test("missing install.security is rejected", () => {
    expectViolation(checkScannerPin({ install: {} }), "scanner");
  });
});
