/**
 * Error handling utilities
 */

/**
 * Extracts error message from unknown error value
 * @param err - Unknown error value (Error, string, or other)
 * @returns Error message string
 */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Formats error for logging with optional context
 * @param err - Unknown error value
 * @param context - Optional context string (e.g., operation name)
 * @returns Formatted error message
 */
export function formatError(err: unknown, context?: string): string {
  const message = getErrorMessage(err);
  return context ? `${context}: ${message}` : message;
}
