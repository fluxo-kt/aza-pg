import { describe, expect, test } from "bun:test";

import { summarizeResults, type CheckOutcome } from "./validate-summary";

const pass: CheckOutcome = { passed: true, critical: true };
const skip: CheckOutcome = { passed: false, skipped: true, critical: false };
const failNonCritical: CheckOutcome = { passed: false, critical: false };
const failCritical: CheckOutcome = { passed: false, critical: true };

describe("summarizeResults", () => {
  // The bug this guards: a sanctioned skip was returned as { passed: false } and the summary counted
  // every !passed as "Failed", so a clean Docker-less run reported "Failed: 1". A skip is NOT a fail.
  test("a skip counts as skipped, never as failed or passed", () => {
    const s = summarizeResults([skip]);
    expect(s).toEqual({ total: 1, passed: 0, skipped: 1, failed: 0, critical: 0 });
  });

  test("a real non-critical failure still counts as failed (not skipped)", () => {
    const s = summarizeResults([failNonCritical]);
    expect(s).toEqual({ total: 1, passed: 0, skipped: 0, failed: 1, critical: 0 });
  });

  test("critical only counts genuine (non-skipped) failures", () => {
    const s = summarizeResults([failCritical, skip]);
    expect(s.critical).toBe(1);
    expect(s.failed).toBe(1); // the skip is excluded
    expect(s.skipped).toBe(1);
  });

  test("mixed run partitions cleanly and totals match", () => {
    const s = summarizeResults([pass, pass, skip, failNonCritical, failCritical]);
    expect(s).toEqual({ total: 5, passed: 2, skipped: 1, failed: 2, critical: 1 });
    expect(s.passed + s.skipped + s.failed).toBe(s.total); // invariant: every outcome lands in exactly one bucket
  });

  test("all-passed run reports zero failed and zero skipped", () => {
    expect(summarizeResults([pass, pass])).toEqual({
      total: 2,
      passed: 2,
      skipped: 0,
      failed: 0,
      critical: 0,
    });
  });

  test("empty run is all zeros", () => {
    expect(summarizeResults([])).toEqual({
      total: 0,
      passed: 0,
      skipped: 0,
      failed: 0,
      critical: 0,
    });
  });
});
