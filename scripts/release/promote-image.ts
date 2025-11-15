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
import { error, success, info, warning } from "../utils/logger.js";
import { getErrorMessage } from "../utils/errors.js";

interface Options {
  source: string;
  target: string;
  annotationsFile?: string;
  annotationPrefix: string;
  verifySource: boolean;
  dryRun: boolean;
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
    annotationsFile: undefined,
    annotationPrefix: "index:",
    verifySource: false,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

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
        options.source = args[i + 1];
        i++;
        break;

      case "--target":
        if (i + 1 >= args.length) {
          error("--target requires an argument");
          process.exit(1);
        }
        options.target = args[i + 1];
        i++;
        break;

      case "--annotations":
        if (i + 1 >= args.length) {
          error("--annotations requires a file path");
          process.exit(1);
        }
        options.annotationsFile = args[i + 1];
        i++;
        break;

      case "--annotation-prefix":
        if (i + 1 >= args.length) {
          error("--annotation-prefix requires an argument");
          process.exit(1);
        }
        options.annotationPrefix = args[i + 1];
        i++;
        break;

      case "--verify-source":
        options.verifySource = true;
        break;

      case "--dry-run":
        options.dryRun = true;
        break;

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

  if (!options.target) {
    error("--target is required");
    printHelp();
    process.exit(1);
  }

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

  // Add target tag
  cmd.push("-t", options.target);

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
 * Execute the image promotion
 * @param options - Parsed options
 */
async function promoteImage(options: Options): Promise<void> {
  // Load annotations if file provided
  let annotations: Record<string, string> | undefined;
  if (options.annotationsFile) {
    info(`Loading annotations from: ${options.annotationsFile}`);
    annotations = await loadAnnotations(options.annotationsFile);
    info(`Loaded ${Object.keys(annotations).length} annotations`);
  }

  // Build command
  const cmdArray = buildPromotionCommand(options, annotations);
  const cmdString = cmdArray.join(" ");

  if (options.dryRun) {
    info("Dry-run mode: Promotion command preview");
    console.log("\n" + cmdString + "\n");
    info("Promotion Details:");
    console.log(`  Source: ${options.source}`);
    console.log(`  Target: ${options.target}`);
    if (annotations) {
      console.log(`  Annotations: ${Object.keys(annotations).length} key(s)`);
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
  console.log(`  Target: ${options.target}`);
  if (annotations) {
    console.log(`  Annotations: ${Object.keys(annotations).length} key(s)`);
  }
  console.log("─".repeat(60));
  console.log();

  try {
    // Execute the docker buildx imagetools create command
    const result = await Bun.spawn(cmdArray, {
      stdout: "inherit",
      stderr: "inherit",
    });

    const exitCode = await result.exited;

    if (exitCode !== 0) {
      // GitHub Actions annotations for CI/CD
      if (Bun.env.GITHUB_ACTIONS === "true") {
        console.error(`::error::Image promotion failed with exit code ${exitCode}`);
      }
      error(`Image promotion failed with exit code ${exitCode}`);
      process.exit(1);
    }

    success("Image promoted successfully!");
    console.log();
    console.log("Promotion Summary:");
    console.log("─".repeat(60));
    console.log(`  Production Tag: ${options.target}`);
    console.log(`  Source Digest:  ${options.source}`);
    console.log("─".repeat(60));

    // GitHub Actions annotations for CI/CD
    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.log(`::notice::Image promoted: ${options.target}`);
      console.log(`::notice::Source digest: ${options.source}`);
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
    validateTargetTag(options.target);

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
