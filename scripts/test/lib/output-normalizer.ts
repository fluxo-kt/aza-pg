/**
 * Output normalization for PostgreSQL regression test results.
 *
 * Handles platform-specific variations and psql formatting differences
 * to make test output comparable across different environments.
 *
 * NOTE: This normalizer is conservative - it only handles known safe variations.
 * Actual data differences are intentionally NOT normalized and will cause test failures.
 */

/**
 * Normalize PostgreSQL regression test output for cross-platform comparison.
 *
 * Normalizations applied:
 * 1. Line endings (CRLF → LF)
 * 2. psql connection headers and prompts
 * 3. Trailing whitespace
 * 4. Empty lines at end of file
 * 5. Minor floating-point display variations (platform-dependent rounding)
 *
 * NOT normalized (intentional failures):
 * - Actual data values
 * - SQL errors and messages (except cosmetic formatting)
 * - Result row counts
 * - Major numerical differences
 *
 * @param output Raw psql output
 * @returns Normalized output ready for comparison
 */
export function normalizeRegressionOutput(output: string): string {
  let normalized = output;

  // 1. Normalize line endings (CRLF → LF)
  normalized = normalized.replace(/\r\n/g, "\n");

  // 2. Remove psql connection headers
  // Example: "psql (18.1 (Debian 18.1-1.pgdg120+1))"
  normalized = normalized.replace(/^psql \([^)]+\)\n/gm, "");

  // 3. Remove psql prompts (postgres=#, postgres->, etc.)
  normalized = normalized.replace(/^postgres[=-]#\s*/gm, "");
  normalized = normalized.replace(/^postgres[=-]>\s*/gm, "");

  // 4. Remove connection status messages
  normalized = normalized.replace(/^You are now connected to database.*\n/gm, "");
  normalized = normalized.replace(/^SSL connection.*\n/gm, "");

  // 5. Normalize trailing whitespace on each line
  normalized = normalized.replace(/[ \t]+$/gm, "");

  // 6. Normalize multiple consecutive blank lines to single blank line
  normalized = normalized.replace(/\n{3,}/g, "\n\n");

  // 7. Remove trailing blank lines at end of output
  normalized = normalized.replace(/\n+$/, "\n");

  // 8. Normalize minor floating-point variations
  // PostgreSQL may display floats slightly differently across platforms
  // Example: "1.2345678" vs "1.234568" (precision differences)
  // We DON'T normalize major differences - only trailing zeros and minor rounding
  normalized = normalizeFloatingPoint(normalized);

  // 9. Normalize whitespace in table formatting (column alignment)
  normalized = normalizeTableFormatting(normalized);

  return normalized;
}

/**
 * Normalize minor floating-point display variations.
 *
 * This is conservative - only handles:
 * - Trailing zeros after decimal point (1.2000 → 1.2)
 * - Scientific notation variations (1e10 vs 1E10)
 *
 * Does NOT normalize:
 * - Different precision (1.23 vs 1.234)
 * - Different rounding (1.235 vs 1.236)
 */
function normalizeFloatingPoint(text: string): string {
  let normalized = text;

  // Normalize scientific notation case (1e10 → 1e10, 1E10 → 1e10)
  normalized = normalized.replace(/(\d+(?:\.\d+)?)E([+-]?\d+)/g, "$1e$2");

  // Remove trailing zeros after decimal point (but keep at least one digit)
  // Example: 1.2000 → 1.2, but 1.0 stays 1.0
  normalized = normalized.replace(/(\d+\.\d*[1-9])0+(?!\d)/g, "$1");

  return normalized;
}

/**
 * Normalize table formatting variations (column alignment, spacing).
 *
 * PostgreSQL's psql formats tables with column alignment, but exact spacing
 * can vary based on data width. This normalizes spacing while preserving structure.
 *
 * Example:
 *   "  id  |  name   "  →  "id | name"
 *   "------+---------"  →  (preserved)
 */
function normalizeTableFormatting(text: string): string {
  let normalized = text;

  // Normalize column separator spacing (preserve | but normalize surrounding spaces)
  // Example: "  id  |  name  " → "id | name"
  normalized = normalized.replace(/\s+\|\s+/g, " | ");

  // Normalize leading/trailing spaces in table rows
  normalized = normalized.replace(/^\s+/gm, "");

  return normalized;
}

/**
 * Check if output difference is acceptable (known platform variation).
 *
 * Some differences are expected and acceptable:
 * - Locale-dependent sorting (collation)
 * - Minor floating-point display differences
 * - Timezone formatting variations
 *
 * @param expected Expected output (from official test)
 * @param actual Actual output (from our test run)
 * @returns true if difference is acceptable, false if it's a real failure
 */
export function isAcceptableVariation(expected: string, actual: string): boolean {
  // Normalize both for comparison
  const normalizedExpected = normalizeRegressionOutput(expected);
  const normalizedActual = normalizeRegressionOutput(actual);

  // If they match after normalization, it's acceptable
  if (normalizedExpected === normalizedActual) {
    return true;
  }

  // Check for known acceptable variations
  return (
    isAcceptableLocaleVariation(normalizedExpected, normalizedActual) ||
    isAcceptableTimezoneVariation(normalizedExpected, normalizedActual)
  );
}

/**
 * Check if difference is due to locale/collation variation.
 *
 * Example: Sorting order may differ based on LC_COLLATE
 */
function isAcceptableLocaleVariation(_expected: string, _actual: string): boolean {
  // For now, we don't auto-accept locale variations
  // This is a placeholder for future enhancement if needed
  // Most tests don't depend on locale-specific sorting
  return false;
}

/**
 * Check if difference is due to timezone formatting variation.
 *
 * Example: "2024-01-01 12:00:00+00" vs "2024-01-01 12:00:00 UTC"
 */
function isAcceptableTimezoneVariation(_expected: string, _actual: string): boolean {
  // For now, we don't auto-accept timezone variations
  // This is a placeholder for future enhancement if needed
  // Most core tests don't involve timezone-sensitive operations
  return false;
}

/**
 * Remove psql-specific output artifacts that shouldn't be in test comparison.
 *
 * This is a more aggressive normalization used for actual test execution,
 * not for expected output files (which are already clean).
 *
 * @param output Raw psql output
 * @returns Cleaned output suitable for comparison
 */
export function cleanPsqlOutput(output: string): string {
  let cleaned = output;

  // Remove psql file path prefix from ERROR/FATAL/WARNING/NOTICE messages
  // Example: "psql:/tmp/boolean.sql:145: ERROR:" → "ERROR:"
  // Example: "psql:/tmp/float4.sql:156: NOTICE:" → "NOTICE:"
  // This happens because we use `psql -a -f file` which prefixes messages with file:line
  cleaned = cleaned.replace(/^psql:[^:]+:\d+:\s+(ERROR|FATAL|WARNING|NOTICE):/gm, "$1:");

  // NOTE: Do NOT strip \pset and other meta-commands from output!
  // PostgreSQL regression tests use psql -a flag which echoes commands,
  // and the expected output files include these echoed meta-commands.
  // Removing them causes output mismatches.

  // Remove timing information if present
  cleaned = cleaned.replace(/^Time: \d+\.\d+ ms\n/gm, "");

  // NOTE: Do NOT remove NOTICE messages! They are part of the expected test output.
  // The expected output files include NOTICE messages that the tests generate.

  // Apply standard normalization
  cleaned = normalizeRegressionOutput(cleaned);

  return cleaned;
}

/**
 * Extract error message from psql output for diagnostic purposes.
 *
 * @param output psql output containing error
 * @returns Extracted error message or null if no error
 */
export function extractErrorMessage(output: string): string | null {
  // Look for ERROR: lines
  const errorMatch = output.match(/^ERROR:  (.+)$/m);
  if (errorMatch?.[1]) {
    return errorMatch[1];
  }

  // Look for FATAL: lines
  const fatalMatch = output.match(/^FATAL:  (.+)$/m);
  if (fatalMatch?.[1]) {
    return fatalMatch[1];
  }

  return null;
}
