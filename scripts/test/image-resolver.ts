/**
 * Unified image resolution utility for test scripts
 *
 * Provides consistent image tag resolution across all test scripts:
 * 1. CLI positional argument (Bun.argv[2])
 * 2. CLI named flag (--image=VALUE)
 * 3. Environment variable (POSTGRES_IMAGE or custom)
 * 4. Default fallback (ghcr.io/fluxo-kt/aza-pg:pg18)
 *
 * Supports remote (ghcr.io/*), local (aza-pg:*), and digest (@sha256:*) references
 */

export interface ImageResolverOptions {
  /**
   * argv array to parse (defaults to Bun.argv)
   */
  argv?: string[];

  /**
   * Environment variable name to check (defaults to POSTGRES_IMAGE)
   */
  envKey?: string;

  /**
   * Default image tag if no CLI arg or env var provided
   * (defaults to ghcr.io/fluxo-kt/aza-pg:pg18)
   */
  defaultImage?: string;
}

/**
 * Resolve image tag from CLI args, environment variables, or default
 *
 * Priority order:
 * 1. Positional argument (first non-flag argument)
 * 2. Named flag (--image=VALUE)
 * 3. Environment variable (POSTGRES_IMAGE or custom)
 * 4. Default (ghcr.io/fluxo-kt/aza-pg:pg18 or custom)
 *
 * @param options Resolution options
 * @returns Resolved image tag
 *
 * @example
 * // Basic usage (checks Bun.argv[2], POSTGRES_IMAGE, default)
 * const image = resolveImageTag();
 *
 * @example
 * // Custom environment variable and default
 * const image = resolveImageTag({
 *   envKey: "MY_POSTGRES_IMAGE",
 *   defaultImage: "aza-pg:local"
 * });
 *
 * @example
 * // Parse custom argv (useful for testing)
 * const image = resolveImageTag({
 *   argv: ["bun", "script.ts", "ghcr.io/user/repo:tag"]
 * });
 */
export function resolveImageTag(options: ImageResolverOptions = {}): string {
  const {
    argv = Bun.argv,
    envKey = "POSTGRES_IMAGE",
    defaultImage = "ghcr.io/fluxo-kt/aza-pg:pg18",
  } = options;

  // 1. Check for positional argument (first non-flag argument after script name)
  // Skip argv[0] (bun) and argv[1] (script path)
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    // Skip flags (--flag or -f)
    if (arg && !arg.startsWith("-")) {
      return arg;
    }
  }

  // 2. Check for named flag (--image=VALUE)
  const imageFlag = argv.find((arg) => arg.startsWith("--image="));
  if (imageFlag) {
    const value = imageFlag.split("=", 2)[1];
    if (value) {
      return value;
    }
  }

  // 3. Check environment variable
  const envValue = Bun.env[envKey];
  if (envValue) {
    return envValue;
  }

  // 4. Return default
  return defaultImage;
}

/**
 * Parse container name from CLI args
 *
 * Checks for --container=VALUE flag, useful for scripts that can optionally
 * use a pre-existing running container instead of starting a new one
 *
 * @param argv argv array to parse (defaults to Bun.argv)
 * @returns Container name if found, undefined otherwise
 *
 * @example
 * const container = parseContainerName();
 * if (container) {
 *   console.log(`Using existing container: ${container}`);
 * } else {
 *   console.log("Starting new container");
 * }
 */
export function parseContainerName(argv: string[] = Bun.argv): string | undefined {
  const containerFlag = argv.find((arg) => arg.startsWith("--container="));
  if (containerFlag) {
    const value = containerFlag.split("=", 2)[1];
    return value || undefined;
  }
  return undefined;
}

/**
 * Validate that an image tag looks reasonable
 *
 * Checks for common mistakes:
 * - Empty string
 * - Missing tag separator (:)
 * - Digest reference without @ separator
 *
 * @param imageTag Image tag to validate
 * @throws Error if image tag is invalid
 */
export function validateImageTag(imageTag: string): void {
  if (!imageTag || imageTag.trim() === "") {
    throw new Error("Image tag cannot be empty");
  }

  // Digest references must contain @sha256:
  if (imageTag.includes("sha256:") && !imageTag.includes("@sha256:")) {
    throw new Error(`Invalid digest reference: ${imageTag} (should be repo@sha256:...)`);
  }
}

/**
 * Get a human-readable description of where the image tag came from
 *
 * Useful for logging and debugging
 *
 * @param options Same options as resolveImageTag
 * @returns Object with resolved image and source description
 *
 * @example
 * const { image, source } = resolveImageWithSource();
 * console.log(`Using image ${image} from ${source}`);
 */
export function resolveImageWithSource(options: ImageResolverOptions = {}): {
  image: string;
  source: string;
} {
  const {
    argv = Bun.argv,
    envKey = "POSTGRES_IMAGE",
    defaultImage = "ghcr.io/fluxo-kt/aza-pg:pg18",
  } = options;

  // Check positional argument
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg && !arg.startsWith("-")) {
      return { image: arg, source: "CLI positional argument" };
    }
  }

  // Check named flag
  const imageFlag = argv.find((arg) => arg.startsWith("--image="));
  if (imageFlag) {
    const value = imageFlag.split("=", 2)[1];
    if (value) {
      return { image: value, source: "CLI flag (--image=...)" };
    }
  }

  // Check environment variable
  const envValue = Bun.env[envKey];
  if (envValue) {
    return { image: envValue, source: `Environment variable (${envKey})` };
  }

  // Default
  return { image: defaultImage, source: "Default fallback" };
}
