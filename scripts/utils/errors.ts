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
 * True iff the error is a "command could not be launched because its executable is missing" failure.
 * Bun.spawn throws an Error with `code === "ENOENT"` ("Executable not found in $PATH") in this case.
 * Lets callers treat a genuinely-absent tool as "unavailable/skipped" rather than a real failure,
 * without an `any` cast.
 */
export function isExecutableNotFoundError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
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
