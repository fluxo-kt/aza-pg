/**
 * Centralized timeout configuration for test suite
 *
 * Timeouts are environment-aware:
 * - CI: 2x multiplier (slower CI runners)
 * - Local: 1x multiplier (faster local machines)
 *
 * Override via environment variable: TEST_TIMEOUT_MULTIPLIER
 */

const isCI = Bun.env.CI === "true" || Bun.env.GITHUB_ACTIONS === "true";
const defaultMultiplier = isCI ? 2 : 1;
const multiplier = Number(Bun.env.TEST_TIMEOUT_MULTIPLIER) || defaultMultiplier;

/**
 * Base timeout values in seconds
 */
export const BASE_TIMEOUTS = {
  /** Quick health check - service responds */
  health: 30,

  /** Container startup - PostgreSQL ready */
  startup: 60,

  /** Service initialization - extensions loaded */
  initialization: 90,

  /** Replication setup - primary + replica healthy */
  replication: 120,

  /** Complex operations - backup/restore */
  complex: 180,
} as const;

/**
 * Environment-adjusted timeouts (applied multiplier)
 */
export const TIMEOUTS = {
  health: BASE_TIMEOUTS.health * multiplier,
  startup: BASE_TIMEOUTS.startup * multiplier,
  initialization: BASE_TIMEOUTS.initialization * multiplier,
  replication: BASE_TIMEOUTS.replication * multiplier,
  complex: BASE_TIMEOUTS.complex * multiplier,
} as const;

/**
 * Timeout reason codes for better error messages
 */
export const TIMEOUT_REASONS = {
  health: "health check timeout",
  startup: "container startup timeout",
  initialization: "service initialization timeout",
  replication: "replication setup timeout",
  complex: "complex operation timeout",
} as const;

/**
 * Get timeout with custom multiplier
 */
export function getTimeout(
  category: keyof typeof BASE_TIMEOUTS,
  customMultiplier?: number
): number {
  const mult = customMultiplier ?? multiplier;
  return BASE_TIMEOUTS[category] * mult;
}

/**
 * Get timeout reason message
 */
export function getTimeoutReason(category: keyof typeof TIMEOUT_REASONS): string {
  return TIMEOUT_REASONS[category];
}

/**
 * Environment info for debugging
 */
export const TIMEOUT_ENV = {
  isCI,
  multiplier,
  source: Bun.env.TEST_TIMEOUT_MULTIPLIER ? "env var" : "auto-detected",
} as const;
