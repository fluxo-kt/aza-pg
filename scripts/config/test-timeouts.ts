/**
 * Timeouts (seconds) for Docker-backed test suites, doubled on CI runners, which are slower than a local machine.
 * Override the multiplier with TEST_TIMEOUT_MULTIPLIER.
 */

const isCI = Bun.env.CI === "true" || Bun.env.GITHUB_ACTIONS === "true";
const multiplier = Number(Bun.env.TEST_TIMEOUT_MULTIPLIER) || (isCI ? 2 : 1);

export const TIMEOUTS = {
  /** A running service answers (exporter metrics, a polled query). */
  health: 30 * multiplier,
  /** A container's final PostgreSQL server is ready, initdb included. */
  startup: 60 * multiplier,
} as const;
