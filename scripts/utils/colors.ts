/**
 * ANSI color codes for terminal output
 * Shared across all scripts for consistent colored logging
 */

export const COLORS = {
  RED: "\x1b[31m",
  GREEN: "\x1b[32m",
  YELLOW: "\x1b[33m",
  BLUE: "\x1b[34m",
  RESET: "\x1b[0m",
} as const;

// Legacy aliases for backwards compatibility
export const RED = COLORS.RED;
export const GREEN = COLORS.GREEN;
export const YELLOW = COLORS.YELLOW;
export const BLUE = COLORS.BLUE;
export const RESET = COLORS.RESET;
export const NC = COLORS.RESET; // No Color alias
