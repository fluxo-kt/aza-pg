import { describe, expect, test } from "bun:test";

import { runCheck, type ValidationCheck } from "./validate";

// Exercises the real classification in runCheck against REAL spawns (no mocks): a missing executable
// throws ENOENT, an exit code is a ran-and-failed result. bufferOutput=true keeps logs quiet.
const OVERRIDE = "ALLOW_MISSING_VALIDATE_TEST_TOOL";
Bun.env[OVERRIDE] = "1";

const base = (over: Partial<ValidationCheck>): ValidationCheck => ({
  name: "probe",
  command: ["true"],
  description: "",
  required: true,
  ...over,
});

describe("runCheck classification", () => {
  // ATTACK 1 regression guard: an OPTIONAL tool that is absent must be a SKIP, not a failure —
  // previously this hit the catch and returned { passed: false } counted as "Failed".
  test("optional + missing binary → skipped, not failed", async () => {
    const r = await runCheck(
      base({ command: ["definitely-not-a-real-binary-xyz-123"], envOverride: OVERRIDE }),
      true
    );
    expect(r.skipped).toBe(true);
    expect(r.critical).toBe(false);
  });

  // The other half of the Docker-path mirror: a REQUIRED missing tool is a hard failure, never a skip.
  test("required + missing binary → critical failure, not skipped", async () => {
    const r = await runCheck(base({ command: ["definitely-not-a-real-binary-xyz-123"] }), true);
    expect(r.skipped).toBeFalsy();
    expect(r.passed).toBe(false);
    expect(r.critical).toBe(true);
  });

  // A real failure must NOT be laundered into a skip: the tool ran and exited non-zero.
  test("optional + non-zero exit → failed (non-critical), never skipped", async () => {
    const r = await runCheck(
      base({ command: ["sh", "-c", "exit 3"], envOverride: OVERRIDE }),
      true
    );
    expect(r.skipped).toBeFalsy();
    expect(r.passed).toBe(false);
    expect(r.critical).toBe(false);
  });

  test("exit 0 → passed", async () => {
    const r = await runCheck(base({ command: ["sh", "-c", "exit 0"] }), true);
    expect(r.passed).toBe(true);
  });
});
