/**
 * Validation result tallying — extracted as a pure function so the pass/skip/fail accounting is
 * unit-testable in isolation (validate.ts auto-runs on import via top-level await, so it cannot be
 * imported by a test without executing the whole validation run).
 */

/** Minimal shape needed to tally an outcome — ValidationResult is assignable to this. */
export type CheckOutcome = {
  passed: boolean;
  skipped?: boolean;
  critical: boolean;
};

export type ValidationSummary = {
  total: number;
  passed: number;
  skipped: number;
  failed: number;
  critical: number;
};

/**
 * A sanctioned skip (e.g. a `requiresDocker` check when the daemon is absent and its envOverride is
 * set) is neither a pass nor a fail. It gets its own bucket and is excluded from `failed`/`passed`:
 * counting an accepted skip as "Failed" trains readers to distrust the count, letting a genuine
 * failure hide among the noise. `critical` only ever counts real (non-skipped) failures.
 */
export function summarizeResults(outcomes: CheckOutcome[]): ValidationSummary {
  const skipped = outcomes.filter((o) => o.skipped).length;
  const passed = outcomes.filter((o) => o.passed).length;
  const failed = outcomes.filter((o) => !o.passed && !o.skipped).length;
  const critical = outcomes.filter((o) => !o.passed && !o.skipped && o.critical).length;
  return { total: outcomes.length, passed, skipped, failed, critical };
}
