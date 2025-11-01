#!/usr/bin/env bun

/**
 * Promote Tested Images from Testing to Production Repository
 *
 * Promotes validated images from aza-pg-testing to aza-pg repository using
 * digest-based copying. Ensures promoted image is byte-for-byte identical to
 * tested image. Used in production release workflow.
 *
 * Usage:
 *   bun scripts/release/promote-image.ts --source DIGEST --target TAG [OPTIONS]
 *
 * Required Options:
 *   --source DIGEST         Source image digest reference (e.g., "ghcr.io/org/aza-pg-testing@sha256:...")
 *   --target TAG            Target tag in production repo (e.g., "ghcr.io/org/aza-pg:18.1-single-node")
 *
 * Optional Flags:
 *   --annotations FILE      Path to JSON file with OCI annotations (key-value pairs)
 *   --annotation-prefix PFX Annotation key prefix (default: "index:")
 *   --verify-source         Verify source digest exists before promoting
 *   --dry-run               Show promotion command without executing
 *   --help                  Show this help message
 *
 * Examples:
 *   # Basic promotion from testing to production
 *   bun scripts/release/promote-image.ts \
 *     --source ghcr.io/fluxo-kt/aza-pg-testing@sha256:abc123... \
 *     --target ghcr.io/fluxo-kt/aza-pg:18.1-single-node
 *
 *   # Promotion with OCI annotations
 *   bun scripts/release/promote-image.ts \
 *     --source ghcr.io/fluxo-kt/aza-pg-testing@sha256:abc123... \
 *     --target ghcr.io/fluxo-kt/aza-pg:18.1-202511142330-single-node \
 *     --annotations /tmp/annotations.json
 *
 *   # Promotion with source verification
 *   bun scripts/release/promote-image.ts \
 *     --source ghcr.io/fluxo-kt/aza-pg-testing@sha256:abc123... \
 *     --target ghcr.io/fluxo-kt/aza-pg:18 \
 *     --verify-source
 *
 *   # Dry-run preview
 *   bun scripts/release/promote-image.ts \
 *     --source ghcr.io/fluxo-kt/aza-pg-testing@sha256:abc123... \
 *     --target ghcr.io/fluxo-kt/aza-pg:18.1-single-node \
 *     --dry-run
 *
 * Annotations File Format (JSON):
 *   {
 *     "org.opencontainers.image.version": "18.1-202511142330-single-node",
 *     "org.opencontainers.image.created": "2025-11-14T23:30:00Z",
 *     "org.opencontainers.image.revision": "abc123",
 *     "org.opencontainers.image.source": "https://github.com/fluxo-kt/aza-pg"
 *   }
 *
 * OCI Annotation Notes:
 *   - Annotations REQUIRE "index:" prefix for manifest-level annotations
 *   - Without prefix, annotations apply to individual images, not the manifest
 *   - Default prefix is "index:" (customizable via --annotation-prefix)
 *   - Each annotation becomes: --annotation "index:key=value"
 *
 * Digest-Based Promotion Benefits:
 *   - Promotes exact tested image (no rebuild, cryptographically verified)
 *   - Atomic operation (no intermediate state)
 *   - Fast (metadata-only operation in registry)
 *   - Ensures production image matches tested artifact
 *
 * Exit Codes:
 *   0 - Success
 *   1 - Failure (validation error, command execution failed)
 */

import { $ } from "bun";
import { error, success, info, warning } from "../utils/logger";
import { getErrorMessage } from "../utils/errors";
import {
  type OCIMetadataOptions,
  parseOCIMetadataArg,
  buildOCIAnnotations,
  validateOCIMetadata,
} from "../utils/oci-metadata";

interface Options extends OCIMetadataOptions {
  source: string;
  target: string;
  tags: string[]; // Multiple target tags (comma-separated)
  annotationsFile?: string;
  annotationPrefix: string;
  verifySource: boolean;
  dryRun: boolean;
  expectedDigest?: string; // Expected digest for verification
}

function printHelp(): void {
  const helpText = `
Promote Tested Images from Testing to Production Repository

Promotes validated images from aza-pg-testing to aza-pg repository using
digest-based copying. Ensures promoted image is byte-for-byte identical to
tested image.

Usage:
  bun scripts/release/promote-image.ts --source DIGEST --target TAG [OPTIONS]

Required Options:
  --source DIGEST         Source image digest reference (e.g., "ghcr.io/org/aza-pg-testing@sha256:...")
  --target TAG            Target tag in production repo (e.g., "ghcr.io/org/aza-pg:18.1-single-node")

Optional Flags:
  --annotations FILE      Path to JSON file with OCI annotations
  --annotation-prefix PFX Annotation key prefix (default: "index:")
  --verify-source         Verify source digest exists before promoting
  --dry-run               Show promotion command without executing
  --help                  Show this help message

Examples:
  # Basic promotion from testing to production
  bun scripts/release/promote-image.ts \\
    --source ghcr.io/fluxo-kt/aza-pg-testing@sha256:abc123... \\
    --target ghcr.io/fluxo-kt/aza-pg:18.1-single-node

  # Promotion with OCI annotations
  bun scripts/release/promote-image.ts \\
    --source ghcr.io/fluxo-kt/aza-pg-testing@sha256:abc123... \\
    --target ghcr.io/fluxo-kt/aza-pg:18.1-202511142330-single-node \\
    --annotations /tmp/annotations.json

  # Promotion with source verification
  bun scripts/release/promote-image.ts \\
    --source ghcr.io/fluxo-kt/aza-pg-testing@sha256:abc123... \\
    --target ghcr.io/fluxo-kt/aza-pg:18 \\
    --verify-source

  # Dry-run preview
  bun scripts/release/promote-image.ts \\
    --source ghcr.io/fluxo-kt/aza-pg-testing@sha256:abc123... \\
    --target ghcr.io/fluxo-kt/aza-pg:18.1-single-node \\
    --dry-run

Annotations File Format (JSON):
  {
    "org.opencontainers.image.version": "18.1-202511142330-single-node",
    "org.opencontainers.image.created": "2025-11-14T23:30:00Z",
    "org.opencontainers.image.revision": "abc123",
    "org.opencontainers.image.source": "https://github.com/fluxo-kt/aza-pg"
  }

OCI Annotation Notes:
  - Annotations REQUIRE "index:" prefix for manifest-level annotations
  - Without prefix, annotations apply to individual images, not the manifest
  - Default prefix is "index:" (customizable via --annotation-prefix)
  - Each annotation becomes: --annotation "index:key=value"

Digest-Based Promotion Benefits:
  - Promotes exact tested image (no rebuild, cryptographically verified)
  - Atomic operation (no intermediate state)
  - Fast (metadata-only operation in registry)
  - Ensures production image matches tested artifact

Exit Codes:
  0 - Success
  1 - Failure (validation error, command execution failed)
`;
  console.log(helpText.trim());
}

function parseArgs(): Options {
  const args = Bun.argv.slice(2);

  const options: Options = {
    source: "",
    target: "",
    tags: [],
    annotationsFile: undefined,
    annotationPrefix: "index:",
    verifySource: false,
    dryRun: false,
    expectedDigest: undefined,
    // OCIMetadataOptions fields inherited (no need to initialize)
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Try parsing OCI metadata arguments first
    const iObj = { value: i };
    if (parseOCIMetadataArg(args, iObj, options)) {
      i = iObj.value; // Update i if argument was consumed
      continue;
    }

    switch (arg) {
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;

      case "--source":
        if (i + 1 >= args.length) {
          error("--source requires an argument");
          process.exit(1);
        }
        {
          const value = args[i + 1];
          if (!value) {
            error("--source requires an argument");
            process.exit(1);
          }
          options.source = value;
        }
        i++;
        break;

      case "--target":
      case "--target-repo": // Alias for --target
        if (i + 1 >= args.length) {
          error(`${arg} requires an argument`);
          process.exit(1);
        }
        {
          const value = args[i + 1];
          if (!value) {
            error(`${arg} requires an argument`);
            process.exit(1);
          }
          options.target = value;
        }
        i++;
        break;

      case "--tags":
        if (i + 1 >= args.length) {
          error("--tags requires an argument");
          process.exit(1);
        }
        {
          const value = args[i + 1];
          if (!value) {
            error("--tags requires an argument");
            process.exit(1);
          }
          // Parse comma-separated tags
          options.tags = value
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t.length > 0);
        }
        i++;
        break;

      case "--annotations":
        if (i + 1 >= args.length) {
          error("--annotations requires a file path");
          process.exit(1);
        }
        {
          const value = args[i + 1];
          if (!value) {
            error("--annotations requires a file path");
            process.exit(1);
          }
          options.annotationsFile = value;
        }
        i++;
        break;

      case "--annotation-prefix":
        if (i + 1 >= args.length) {
          error("--annotation-prefix requires an argument");
          process.exit(1);
        }
        {
          const value = args[i + 1];
          if (!value) {
            error("--annotation-prefix requires an argument");
            process.exit(1);
          }
          options.annotationPrefix = value;
        }
        i++;
        break;

      case "--verify-source":
        options.verifySource = true;
        break;

      case "--dry-run":
        options.dryRun = true;
        break;

      case "--expected-digest":
        if (i + 1 >= args.length) {
          error("--expected-digest requires an argument");
          process.exit(1);
        }
        {
          const value = args[i + 1];
          if (!value) {
            error("--expected-digest requires an argument");
            process.exit(1);
          }
          options.expectedDigest = value;
        }
        i++;
        break;

      // OCI metadata arguments now handled by parseOCIMetadataArg above

      default:
        error(`Unknown option: ${arg}`);
        printHelp();
        process.exit(1);
    }
  }

  // Validate required options
  if (!options.source) {
    error("--source is required");
    printHelp();
    process.exit(1);
  }

  // Either --target or --tags (or both) must be provided
  if (!options.target && options.tags.length === 0) {
    error("Either --target or --tags (or both) is required");
    printHelp();
    process.exit(1);
  }

  // Track original parsing state before modifications (for validation)
  const hadTargetOnly = options.target && options.tags.length === 0;
  const hadCombined = options.target && options.tags.length > 0;
  const hadTagsOnly = !options.target && options.tags.length > 0;

  // If --target-repo was provided but no --tags, populate tags from target
  if (options.target && options.tags.length === 0) {
    // --target becomes the single tag
    options.tags = [options.target];
  } else if (options.target && options.tags.length > 0) {
    // Both --target and --tags provided - combine them, with target as base repo
    // Tags should be full references, not just tag names
    // But if --target-repo was provided, we might need to prepend it
    // For now, just use tags as-is if they're full refs, or prepend target repo if not
    options.tags = options.tags.map((tag) => {
      // If tag contains ':', it's likely a full reference
      if (tag.includes(":")) {
        return tag;
      } else {
        // Prepend target repository
        const repoBase = options.target.split(":")[0];
        return `${repoBase}:${tag}`;
      }
    });
  } else if (!options.target && options.tags.length > 0) {
    // Only --tags provided, use first tag as primary target
    options.target = options.tags[0]!;
  }

  // Store original parsing mode for validation
  (options as any).usageMode = hadTargetOnly
    ? "target-only"
    : hadCombined
      ? "combined"
      : hadTagsOnly
        ? "tags-only"
        : "unknown";

  return options;
}

/**
 * Validate source is a digest reference (contains @sha256:)
 * @param source - Source image reference
 */
function validateSourceDigest(source: string): void {
  if (!source.includes("@sha256:")) {
    error(`Source must be a digest reference (contain @sha256:): ${source}`);
    console.error("  Example: ghcr.io/fluxo-kt/aza-pg-testing@sha256:abc123...");
    process.exit(1);
  }
}

/**
 * Validate target is a tag reference (contains :)
 * @param target - Target image reference
 */
function validateTargetTag(target: string): void {
  if (!target.includes(":")) {
    error(`Target must be a tag reference (contain :): ${target}`);
    console.error("  Example: ghcr.io/fluxo-kt/aza-pg:18.1-single-node");
    process.exit(1);
  }

  // Warn if target looks like a digest
  if (target.includes("@sha256:")) {
    warning("Target appears to be a digest reference, expected a tag");
    console.warn("  Target will be treated as-is, but this is unusual");
  }
}

/**
 * Load and validate OCI annotations from JSON file
 * @param filePath - Path to annotations JSON file
 * @returns Object with string key-value pairs
 */
async function loadAnnotations(filePath: string): Promise<Record<string, string>> {
  try {
    // Check if file exists
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      error(`Annotations file not found: ${filePath}`);
      process.exit(1);
    }

    // Read and parse JSON
    const content = await file.json();

    // Validate it's an object
    if (typeof content !== "object" || content === null || Array.isArray(content)) {
      error(`Annotations file must contain a JSON object: ${filePath}`);
      process.exit(1);
    }

    // Validate all values are strings
    const annotations: Record<string, string> = {};
    for (const [key, value] of Object.entries(content)) {
      if (typeof value !== "string") {
        error(`Annotation value for key "${key}" must be a string, got: ${typeof value}`);
        process.exit(1);
      }
      annotations[key] = value;
    }

    return annotations;
  } catch (err) {
    error(`Failed to load annotations file: ${getErrorMessage(err)}`);
    process.exit(1);
  }
}

/**
 * Build OCI annotations from metadata options
 * @param options - Parsed options with metadata
 * @returns Object with OCI annotation key-value pairs
 */
function buildMetadataAnnotations(options: Options): Record<string, string> {
  // Validate metadata before building annotations
  const errors = validateOCIMetadata(options);
  if (errors.length > 0) {
    errors.forEach((err) => error(err));
    process.exit(1);
  }

  return buildOCIAnnotations(options);
}

/**
 * Check if Docker Buildx is available
 */
async function checkBuildxAvailable(): Promise<void> {
  try {
    const result = await $`docker buildx version`.nothrow().quiet();
    if (result.exitCode !== 0) {
      error("Docker Buildx is not available");
      console.error("  Install Docker Buildx: https://docs.docker.com/buildx/working-with-buildx/");
      process.exit(1);
    }
  } catch (err) {
    error(`Failed to check Docker Buildx: ${getErrorMessage(err)}`);
    process.exit(1);
  }
}

/**
 * Verify source digest exists (optional, requires docker manifest inspect)
 * @param source - Source digest reference
 */
async function verifySourceExists(source: string): Promise<void> {
  try {
    info(`Verifying source digest exists: ${source}`);
    const result = await $`docker manifest inspect ${source}`.nothrow().quiet();

    if (result.exitCode !== 0) {
      error(`Source digest not found or inaccessible: ${source}`);
      console.error("  Ensure the source image exists and you have access to it");
      console.error("  You may need to: docker login <registry>");
      process.exit(1);
    }

    success("Source digest verified");
  } catch (err) {
    error(`Failed to verify source digest: ${getErrorMessage(err)}`);
    process.exit(1);
  }
}

/**
 * Build the docker buildx imagetools create command for promotion
 * @param options - Parsed options
 * @param annotations - Optional annotations object
 * @returns Array of command arguments
 */
function buildPromotionCommand(options: Options, annotations?: Record<string, string>): string[] {
  const cmd: string[] = ["docker", "buildx", "imagetools", "create"];

  // Add all target tags
  for (const tag of options.tags) {
    cmd.push("-t", tag);
  }

  // Add annotations if provided
  if (annotations) {
    for (const [key, value] of Object.entries(annotations)) {
      // Prepend annotation prefix (e.g., "index:org.opencontainers.image.version")
      const prefixedKey = `${options.annotationPrefix}${key}`;
      cmd.push("--annotation", `${prefixedKey}=${value}`);
    }
  }

  // Add source digest (last argument)
  cmd.push(options.source);

  return cmd;
}

/**
 * Verify promoted image digest matches expected digest
 * @param imageRef - Image reference to verify (tag)
 * @param expectedDigest - Expected sha256 digest
 */
async function verifyExpectedDigest(imageRef: string, expectedDigest: string): Promise<void> {
  try {
    info(`Verifying promoted image digest matches expected: ${expectedDigest}`);

    // Get actual digest from manifest
    const result =
      await $`docker buildx imagetools inspect ${imageRef} --format "{{.Manifest.Digest}}"`
        .nothrow()
        .quiet();

    if (result.exitCode !== 0) {
      error(`Failed to inspect promoted image: ${imageRef}`);
      error(result.stderr.toString());
      process.exit(1);
    }

    const actualDigest = result.stdout.toString().trim();

    if (!actualDigest) {
      error(`Could not retrieve digest for promoted image: ${imageRef}`);
      process.exit(1);
    }

    // Compare digests (both should be sha256:...)
    if (actualDigest !== expectedDigest) {
      error(`Digest verification failed!`);
      console.error(`  Expected: ${expectedDigest}`);
      console.error(`  Actual:   ${actualDigest}`);
      console.error(`  Image:    ${imageRef}`);
      console.error("");
      console.error("This indicates the promoted image does not match the tested image.");
      console.error("This should never happen with digest-based promotion.");
      process.exit(1);
    }

    success(`✓ Digest verified: ${actualDigest}`);
  } catch (err) {
    error(`Failed to verify digest: ${getErrorMessage(err)}`);
    process.exit(1);
  }
}

/**
 * Execute docker buildx imagetools create with retry logic for rate limiting
 * @param cmdArray - Command array to execute
 * @param maxRetries - Maximum number of retries (default: 7)
 * @param initialDelayMs - Initial retry delay in milliseconds (default: 2000)
 * @returns Exit code
 */
async function executeWithRetry(
  cmdArray: string[],
  maxRetries: number = 7,
  initialDelayMs: number = 2000
): Promise<number> {
  let attempt = 0;
  let delayMs = initialDelayMs;

  while (attempt <= maxRetries) {
    attempt++;

    if (attempt > 1) {
      info(`Retry attempt ${attempt - 1}/${maxRetries} after ${delayMs}ms delay...`);
      await Bun.sleep(delayMs);
    }

    try {
      // Capture stderr to detect rate limiting errors
      const result = await Bun.spawn(cmdArray, {
        stdout: "inherit",
        stderr: "pipe",
      });

      // Capture stderr for error detection
      const stderrText = await new Response(result.stderr).text();

      // Display stderr (buildx progress and errors)
      if (stderrText.trim()) {
        console.error(stderrText.trim());
      }

      const exitCode = await result.exited;

      // Success
      if (exitCode === 0) {
        return 0;
      }

      // Check if error is due to rate limiting (429)
      const is429Error =
        stderrText.includes("429 Too Many Requests") || stderrText.includes("toomanyrequests");

      if (is429Error && attempt <= maxRetries) {
        warning(`Rate limit hit (429 Too Many Requests), retrying in ${delayMs}ms...`);

        // Parse retry-after from error message if available
        const retryAfterMatch = stderrText.match(/retry-after:\s*([0-9.]+)(ms|s)?/i);
        if (retryAfterMatch) {
          const value = parseFloat(retryAfterMatch[1]!);
          const unit = retryAfterMatch[2]?.toLowerCase();

          // Convert to milliseconds
          let suggestedDelayMs = value;
          if (unit === "s") {
            suggestedDelayMs = value * 1000;
          }

          // Use suggested delay if it's reasonable (between 100ms and 60s)
          if (suggestedDelayMs >= 100 && suggestedDelayMs <= 60000) {
            delayMs = Math.ceil(suggestedDelayMs);
            info(`Using retry-after hint: ${delayMs}ms`);
          }
        }

        // Exponential backoff for next retry
        delayMs = delayMs * 2;
        continue;
      }

      // Non-429 error or max retries exceeded
      return exitCode;
    } catch (err) {
      error(`Command execution failed: ${getErrorMessage(err)}`);
      return 1;
    }
  }

  // Should never reach here, but just in case
  error("Max retries exceeded");
  return 1;
}

/**
 * Execute the image promotion
 * @param options - Parsed options
 */
async function promoteImage(options: Options): Promise<void> {
  // Build metadata annotations from CLI arguments
  const metadataAnnotations = buildMetadataAnnotations(options);

  // Load annotations from file if provided
  let fileAnnotations: Record<string, string> | undefined;
  if (options.annotationsFile) {
    info(`Loading annotations from: ${options.annotationsFile}`);
    fileAnnotations = await loadAnnotations(options.annotationsFile);
    info(`Loaded ${Object.keys(fileAnnotations).length} annotations from file`);
  }

  // Merge annotations (file takes precedence over metadata)
  const annotations = { ...metadataAnnotations, ...fileAnnotations };

  if (Object.keys(annotations).length > 0) {
    info(`Total annotations: ${Object.keys(annotations).length}`);
  }

  // Build command
  const cmdArray = buildPromotionCommand(options, annotations);
  const cmdString = cmdArray.join(" ");

  if (options.dryRun) {
    info("Dry-run mode: Promotion command preview");
    console.log("\n" + cmdString + "\n");
    info("Promotion Details:");
    console.log(`  Source: ${options.source}`);
    console.log(`  Target Tags (${options.tags.length}):`);
    for (const tag of options.tags) {
      console.log(`    - ${tag}`);
    }
    if (Object.keys(annotations).length > 0) {
      console.log(`  Annotations: ${Object.keys(annotations).length} key(s)`);
    }
    if (options.expectedDigest) {
      console.log(`  Expected Digest: ${options.expectedDigest}`);
    }
    success("Dry-run completed (no execution)");
    return;
  }

  // Execute promotion
  info("Promoting image from testing to production...");
  console.log();
  console.log("Promotion Details:");
  console.log("─".repeat(60));
  console.log(`  Source: ${options.source}`);
  console.log(`  Target Tags (${options.tags.length}):`);
  for (const tag of options.tags) {
    console.log(`    - ${tag}`);
  }
  if (Object.keys(annotations).length > 0) {
    console.log(`  Annotations: ${Object.keys(annotations).length} key(s)`);
  }
  if (options.expectedDigest) {
    console.log(`  Expected Digest: ${options.expectedDigest}`);
  }
  console.log("─".repeat(60));
  console.log();

  try {
    // Execute the docker buildx imagetools create command with retry logic
    const exitCode = await executeWithRetry(cmdArray);

    if (exitCode !== 0) {
      // GitHub Actions annotations for CI/CD
      if (Bun.env.GITHUB_ACTIONS === "true") {
        console.error(`::error::Image promotion failed with exit code ${exitCode}`);
      }
      error(`Image promotion failed with exit code ${exitCode}`);
      process.exit(1);
    }

    success("Image promoted successfully!");

    // Extract image metrics for release notes
    console.log();
    info("Extracting image metrics from promoted image...");

    try {
      // Dynamic import to avoid circular dependencies
      const { getImageMetrics } = await import("../docker/image-metrics");

      // Pull first tag to enable local inspection
      const firstTag = options.tags[0]!;
      info(`Pulling image for metrics extraction: ${firstTag}`);
      const pullResult = await $`docker pull ${firstTag}`.nothrow();

      if (pullResult.exitCode !== 0) {
        warning("Failed to pull image for metrics extraction");
        warning("Metrics will not be available in release notes");
      } else {
        // Extract metrics
        const metrics = await getImageMetrics(firstTag);

        success("Metrics extracted successfully");

        // Output for GitHub Actions
        if (Bun.env.GITHUB_ACTIONS === "true") {
          const githubOutput = Bun.env.GITHUB_OUTPUT;
          if (githubOutput) {
            // Use modern $GITHUB_OUTPUT file approach (::set-output is deprecated)
            const outputs = [
              `compressed_size=${metrics.compressedFormatted}`,
              `uncompressed_size=${metrics.uncompressedFormatted}`,
              `layer_count=${metrics.layerCount}`,
              `base_image_name=${metrics.baseImage?.name || ""}`,
              `base_image_digest=${metrics.baseImage?.digest || ""}`,
            ].join("\n");

            // Append to GITHUB_OUTPUT file
            const file = Bun.file(githubOutput);
            const existingContent = (await file.exists()) ? await file.text() : "";
            await Bun.write(githubOutput, existingContent + outputs + "\n");

            info("Metrics set as GitHub Actions outputs");
          } else {
            warning("GITHUB_OUTPUT not set, metrics will not be available");
          }
        }
      }
    } catch (err) {
      warning(`Failed to extract metrics: ${getErrorMessage(err)}`);
      warning("Metrics will not be available in release notes");
      // Don't fail the promotion
    }

    console.log();

    // Verify expected digest if provided
    if (options.expectedDigest) {
      console.log();
      await verifyExpectedDigest(options.tags[0]!, options.expectedDigest);
    }

    console.log();
    console.log("Promotion Summary:");
    console.log("─".repeat(60));
    console.log(`  Production Tags (${options.tags.length}):`);
    for (const tag of options.tags) {
      console.log(`    - ${tag}`);
    }
    console.log(`  Source Digest: ${options.source}`);
    if (options.expectedDigest) {
      console.log(`  Verified:      ✓ Digest matches expected`);
    }
    console.log("─".repeat(60));

    // GitHub Actions annotations for CI/CD
    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.log(`::notice::Image promoted to ${options.tags.length} tag(s)`);
      console.log(`::notice::Source digest: ${options.source}`);
      for (const tag of options.tags) {
        console.log(`::notice::Promoted tag: ${tag}`);
      }
    }
  } catch (err) {
    // GitHub Actions annotations for CI/CD
    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.error(`::error::Failed to execute image promotion: ${getErrorMessage(err)}`);
    }
    error(`Failed to execute image promotion: ${getErrorMessage(err)}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const options = parseArgs();

  try {
    // Validate source and target formats
    validateSourceDigest(options.source);

    // Conditional validation based on original usage mode (before parseArgs modifications):
    // - Target-only mode: --target "ghcr.io/org/aza-pg:18.1" (validate full tag)
    // - Combined mode: --target-repo "ghcr.io/org/aza-pg" + --tags "18.1,18" (skip : validation)
    // - Tags-only mode: --tags "ghcr.io/org/aza-pg:18.1,..." (validate first tag)
    const usageMode = (options as any).usageMode;

    if (usageMode === "target-only") {
      // Target-only mode: validate full tag reference (must contain :)
      validateTargetTag(options.target);
    } else if (usageMode === "combined") {
      // Combined mode: target is repo base, tags will be appended
      // Validate target has repo structure (for combining)
      if (!options.target.includes("/")) {
        error(`Target repository must include registry and org: ${options.target}`);
        console.error("  Example: ghcr.io/fluxo-kt/aza-pg");
        process.exit(1);
      }
    } else if (usageMode === "tags-only") {
      // Tags-only mode: first tag becomes primary target, validate it
      validateTargetTag(options.tags[0]!);
    }

    // Check Docker Buildx availability
    await checkBuildxAvailable();

    // Optionally verify source exists
    if (options.verifySource) {
      await verifySourceExists(options.source);
    }

    // Promote image
    await promoteImage(options);
  } catch (err) {
    error(getErrorMessage(err));
    process.exit(1);
  }
}

main();
