/**
 * GitHub Actions utility functions for writing outputs, step summaries, and annotations.
 *
 * Provides type-safe, validated operations for GitHub Actions integration.
 */

/**
 * Sets a GitHub Actions output variable.
 *
 * Writes to $GITHUB_OUTPUT file with validation and error handling.
 *
 * @param key - Output variable name
 * @param value - Output variable value (will be converted to string)
 * @throws Error if GITHUB_OUTPUT is not set or file is not writable
 *
 * @example
 * ```typescript
 * setGitHubOutput("image_digest", "sha256:abc123");
 * setGitHub Output("cache_hit", "true");
 * ```
 */
export async function setGitHubOutput(
  key: string,
  value: string | number | boolean
): Promise<void> {
  const outputFile = Bun.env.GITHUB_OUTPUT;

  if (!outputFile) {
    throw new Error(
      "GITHUB_OUTPUT environment variable is not set. " +
        "This function must be called from within a GitHub Actions workflow."
    );
  }

  // Validate key format (alphanumeric, hyphens, underscores only)
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(key)) {
    throw new Error(
      `Invalid output key format: "${key}". ` +
        "Keys must start with a letter or underscore, and contain only alphanumeric characters, hyphens, or underscores."
    );
  }

  // Convert value to string and validate
  const stringValue = String(value);
  if (stringValue.includes("\n")) {
    throw new Error(
      `Output value for "${key}" contains newlines. ` +
        "Multi-line outputs are not supported. Use JSON encoding if needed."
    );
  }

  try {
    // Append to output file (GitHub Actions format: key=value)
    await Bun.write(outputFile, `${key}=${stringValue}\n`, { append: true });
  } catch (error) {
    throw new Error(
      `Failed to write GitHub output for key "${key}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Adds content to GitHub Actions step summary (Markdown).
 *
 * Writes to $GITHUB_STEP_SUMMARY file with validation.
 *
 * @param content - Markdown content to append
 * @throws Error if GITHUB_STEP_SUMMARY is not set or file is not writable
 *
 * @example
 * ```typescript
 * await appendStepSummary("## Build Complete\n\n✅ Image built successfully");
 * ```
 */
export async function appendStepSummary(content: string): Promise<void> {
  const summaryFile = Bun.env.GITHUB_STEP_SUMMARY;

  if (!summaryFile) {
    throw new Error(
      "GITHUB_STEP_SUMMARY environment variable is not set. " +
        "This function must be called from within a GitHub Actions workflow."
    );
  }

  try {
    await Bun.write(summaryFile, content, { append: true });
  } catch (error) {
    throw new Error(
      `Failed to write GitHub step summary: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Creates a GitHub Actions annotation (error, warning, or notice).
 *
 * Outputs formatted annotation to stdout for GitHub Actions to parse.
 *
 * @param type - Annotation type (error, warning, notice)
 * @param message - Annotation message
 * @param file - Optional file path
 * @param line - Optional line number
 * @param col - Optional column number
 *
 * @example
 * ```typescript
 * createAnnotation("error", "Build failed: missing dependency", "Dockerfile", 42);
 * createAnnotation("warning", "Deprecated API usage detected");
 * ```
 */
export function createAnnotation(
  type: "error" | "warning" | "notice",
  message: string,
  file?: string,
  line?: number,
  col?: number
): void {
  let annotation = `::${type}`;

  const params: string[] = [];
  if (file) params.push(`file=${file}`);
  if (line) params.push(`line=${line}`);
  if (col) params.push(`col=${col}`);

  if (params.length > 0) {
    annotation += ` ${params.join(",")}`;
  }

  annotation += `::${message}`;

  console.log(annotation);
}

/**
 * Checks if running in GitHub Actions environment.
 *
 * @returns true if GITHUB_ACTIONS environment variable is set
 */
export function isGitHubActions(): boolean {
  return Bun.env.GITHUB_ACTIONS === "true";
}

/**
 * Validates that required GitHub Actions environment variables are set.
 *
 * @param variables - List of required environment variable names
 * @throws Error if any required variable is missing
 */
export function validateGitHubEnv(...variables: string[]): void {
  const missing = variables.filter((v) => !Bun.env[v]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required GitHub Actions environment variables: ${missing.join(", ")}. ` +
        "This script must be run from within a GitHub Actions workflow."
    );
  }
}
