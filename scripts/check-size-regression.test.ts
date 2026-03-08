#!/usr/bin/env bun
/**
 * Unit Test Suite for Extension Size Regression Checker
 *
 * Tests the pure `classifySize` function in isolation — no Docker required.
 * Coverage: all 5 classification branches + boundary conditions + precision display.
 *
 * Usage: bun test scripts/check-size-regression.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  classifySize,
  MAX_SIZE_INCREASE_PERCENT,
  type SizeBaseline,
} from "./check-size-regression";

const baseline: SizeBaseline = { min: 1.0, max: 2.0, description: "test extension" };

describe("classifySize — branch coverage", () => {
  test("null size → not-found advisory (warn, not fail)", () => {
    const result = classifySize("myext", null, baseline);
    expect(result.passed).toBe(true);
    expect(result.warn).toBe(true);
    expect(result.category).toBe("not-found");
    expect(result.message).toContain("not found");
    expect(result.message).toContain("size-baselines.json");
    expect(result.message).toContain("myext");
  });

  test("size exceeds maxAllowed → exceeded failure (not warn, not pass)", () => {
    const maxAllowed = baseline.max * (1 + MAX_SIZE_INCREASE_PERCENT / 100); // 2.4
    const result = classifySize("myext", maxAllowed + 0.01, baseline);
    expect(result.passed).toBe(false);
    expect(result.warn).toBeUndefined();
    expect(result.category).toBe("exceeded");
    expect(result.message).toContain("exceeds baseline max");
    expect(result.message).toContain("myext");
  });

  test("size below baseline.min → below-min advisory (warn, not fail)", () => {
    const result = classifySize("myext", 0.5, baseline); // < min=1.0
    expect(result.passed).toBe(true);
    expect(result.warn).toBe(true);
    expect(result.category).toBe("below-min");
    expect(result.message).toContain("below baseline min");
    expect(result.message).toContain("myext");
  });

  test("size within [min, max] → ok pass (no warn)", () => {
    const result = classifySize("myext", 1.5, baseline);
    expect(result.passed).toBe(true);
    expect(result.warn).toBeUndefined();
    expect(result.category).toBe("ok");
    expect(result.message).toContain("within expected range");
    expect(result.message).toContain("myext");
  });

  test("size in (max, maxAllowed] → tolerance advisory (warn, not fail)", () => {
    const aboveMax = 2.1; // > max=2.0 but < maxAllowed=2.4
    const result = classifySize("myext", aboveMax, baseline);
    expect(result.passed).toBe(true);
    expect(result.warn).toBe(true);
    expect(result.category).toBe("tolerance");
    expect(result.message).toContain("tolerance");
    expect(result.message).toContain("myext");
  });
});

describe("classifySize — boundary conditions", () => {
  test("size exactly at baseline.min → ok (inclusive lower bound)", () => {
    const result = classifySize("myext", 1.0, baseline);
    expect(result.passed).toBe(true);
    expect(result.category).toBe("ok");
  });

  test("size exactly at baseline.max → ok (inclusive upper bound)", () => {
    const result = classifySize("myext", 2.0, baseline);
    expect(result.passed).toBe(true);
    expect(result.category).toBe("ok");
  });

  test("size exactly at maxAllowed → tolerance advisory (inclusive tolerance bound)", () => {
    const maxAllowed = baseline.max * (1 + MAX_SIZE_INCREASE_PERCENT / 100); // 2.4
    const result = classifySize("myext", maxAllowed, baseline);
    // size > max but size <= maxAllowed → tolerance, not exceeded
    expect(result.passed).toBe(true);
    expect(result.category).toBe("tolerance");
  });

  test("size infinitesimally above maxAllowed → exceeded (exclusive upper tolerance bound)", () => {
    const maxAllowed = baseline.max * (1 + MAX_SIZE_INCREASE_PERCENT / 100); // 2.4
    const result = classifySize("myext", maxAllowed + Number.EPSILON * 10, baseline);
    expect(result.passed).toBe(false);
    expect(result.category).toBe("exceeded");
  });
});

describe("classifySize — precision display (toFixed(2) not toFixed(1))", () => {
  test("small baseline values display with 2 decimal places (regression: 0.05 must not show as 0.1)", () => {
    // pg_stat_monitor has min=0.05, max=0.12 — toFixed(1) renders both as "0.1"
    const precisionBaseline: SizeBaseline = { min: 0.05, max: 0.12, description: "precision test" };
    const result = classifySize("myext", 0.08, precisionBaseline);
    expect(result.category).toBe("ok");
    expect(result.message).toContain("0.05"); // must not collapse to "0.1"
    expect(result.message).toContain("0.12"); // must not collapse to "0.1"
  });

  test("timescaledb max=0.35 must display as 0.35 not 0.3 (IEEE754 regression)", () => {
    // 0.35 in IEEE754 is 0.34999... so toFixed(1) rounds DOWN to "0.3" — wrong
    const tsBaseline: SizeBaseline = { min: 0.2, max: 0.35, description: "timescaledb test" };
    const result = classifySize("timescaledb", 0.29, tsBaseline);
    expect(result.category).toBe("ok");
    expect(result.message).toContain("0.35"); // must not show as "0.3"
    expect(result.message).toContain("0.20"); // must not show as "0.2" ambiguously
  });
});

describe("classifySize — custom maxIncreasePercent", () => {
  test("stricter threshold (10%) fails what default (20%) would pass", () => {
    const size = 2.21; // > 10%-allowed=2.2 but < 20%-allowed=2.4
    const defaultResult = classifySize("myext", size, baseline); // default 20%
    const strictResult = classifySize("myext", size, baseline, 10); // 10% → maxAllowed=2.2
    expect(defaultResult.category).toBe("tolerance"); // passes under default
    expect(strictResult.category).toBe("exceeded"); // fails under strict
  });

  test("zero threshold: any size above max fails immediately", () => {
    const result = classifySize("myext", 2.01, baseline, 0);
    expect(result.passed).toBe(false);
    expect(result.category).toBe("exceeded");
  });
});
