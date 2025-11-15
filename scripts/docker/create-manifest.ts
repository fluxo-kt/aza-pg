#!/usr/bin/env bun

/**
 * Create and push OCI multi-arch image manifests
 *
 * This script creates and pushes OCI Image Index manifests (multi-platform images)
 * by combining platform-specific images and optionally applying OCI annotations.
 * Replaces duplicate `docker buildx imagetools create` blocks in workflows.
 *
 * Usage:
 *   bun scripts/docker/create-manifest.ts --tag TAG --sources SRC1,SRC2 [OPTIONS]
 *
 * Required Options:
 *   --tag TAG               Target manifest tag (e.g., "ghcr.io/org/repo:18-single-node")
 *   --sources CSV           Comma-separated source images (e.g., "repo@sha256:aaa,repo@sha256:bbb")
 *
 * Optional Flags:
 *   --annotations FILE      Path to JSON file with OCI annotations (key-value pairs)
 *   --annotation-prefix PFX Annotation key prefix (default: "index:")
 *   --dry-run               Show command without executing
 *   --help                  Show this help message
 *
 * Examples:
 *   # Create manifest from two digest references (amd64 + arm64)
 *   bun scripts/docker/create-manifest.ts \
 *     --tag ghcr.io/fluxo-kt/aza-pg:18.1-single-node \
 *     --sources "ghcr.io/fluxo-kt/aza-pg@sha256:abc123,ghcr.io/fluxo-kt/aza-pg@sha256:def456"
 *
 *   # Create manifest with OCI annotations from JSON file
 *   bun scripts/docker/create-manifest.ts \
 *     --tag ghcr.io/fluxo-kt/aza-pg:18-single-node \
 *     --sources "ghcr.io/fluxo-kt/aza-pg@sha256:abc,ghcr.io/fluxo-kt/aza-pg@sha256:def" \
 *     --annotations /tmp/annotations.json
 *
 *   # Dry-run to preview command
 *   bun scripts/docker/create-manifest.ts \
 *     --tag ghcr.io/fluxo-kt/aza-pg:18 \
 *     --sources "ghcr.io/fluxo-kt/aza-pg@sha256:abc,ghcr.io/fluxo-kt/aza-pg@sha256:def" \
 *     --dry-run
 *
 * Annotations File Format:
 *   {
 *     "org.opencontainers.image.version": "18.1-202511142330-single-node",
 *     "org.opencontainers.image.created": "2025-11-14T23:30:00Z",
 *     "org.opencontainers.image.revision": "abc123",
 *     "org.opencontainers.image.source": "https://github.com/fluxo-kt/aza-pg",
 *     "com.example.custom": "value"
 *   }
 *
 * OCI Annotation Notes:
 *   - Annotations REQUIRE "index:" prefix for manifest-level annotations
 *   - Without prefix, annotations apply to individual images, not the manifest
 *   - Default prefix is "index:" (can be changed via --annotation-prefix)
 *   - Each annotation becomes: --annotation "index:key=value"
 *
 * Exit Codes:
 *   0 - Success
 *   1 - Failure (validation error, command execution failed)
 */

import { $ } from "bun";
import { error, success, info } from "../utils/logger.js";
import { getErrorMessage } from "../utils/errors.js";

interface Options {
  tag: string;
  sources: string[];
  annotationsFile?: string;
  annotationPrefix: string;
  dryRun: boolean;
}

function printHelp(): void {
  const helpText = `
Create and push OCI multi-arch image manifests

This script creates OCI Image Index manifests by combining platform-specific
images and optionally applying OCI annotations. Replaces duplicate imagetools
create blocks in workflows.

Usage:
  bun scripts/docker/create-manifest.ts --tag TAG --sources SRC1,SRC2 [OPTIONS]

Required Options:
  --tag TAG               Target manifest tag (e.g., "ghcr.io/org/repo:18")
  --sources CSV           Comma-separated source images (digest refs)

Optional Flags:
  --annotations FILE      Path to JSON file with OCI annotations
  --annotation-prefix PFX Annotation key prefix (default: "index:")
  --dry-run               Show command without executing
  --help                  Show this help message

Examples:
  # Create manifest from two digest references (amd64 + arm64)
  bun scripts/docker/create-manifest.ts \\
    --tag ghcr.io/fluxo-kt/aza-pg:18.1-single-node \\
    --sources "ghcr.io/fluxo-kt/aza-pg@sha256:abc,ghcr.io/fluxo-kt/aza-pg@sha256:def"

  # Create manifest with OCI annotations from JSON file
  bun scripts/docker/create-manifest.ts \\
    --tag ghcr.io/fluxo-kt/aza-pg:18 \\
    --sources "ghcr.io/fluxo-kt/aza-pg@sha256:abc,ghcr.io/fluxo-kt/aza-pg@sha256:def" \\
    --annotations /tmp/annotations.json

  # Dry-run to preview command
  bun scripts/docker/create-manifest.ts \\
    --tag ghcr.io/fluxo-kt/aza-pg:18 \\
    --sources "ghcr.io/fluxo-kt/aza-pg@sha256:abc,ghcr.io/fluxo-kt/aza-pg@sha256:def" \\
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

Exit Codes:
  0 - Success
  1 - Failure (validation error, command execution failed)
`;
  console.log(helpText.trim());
}

function parseArgs(): Options {
  const args = Bun.argv.slice(2);

  const options: Options = {
    tag: "",
    sources: [],
    annotationsFile: undefined,
    annotationPrefix: "index:",
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

      case "--tag":
        if (i + 1 >= args.length) {
          error("--tag requires an argument");
          process.exit(1);
        }
        options.tag = args[i + 1];
        i++;
        break;

      case "--sources":
        if (i + 1 >= args.length) {
          error("--sources requires an argument");
          process.exit(1);
        }
        // Split comma-separated sources and trim whitespace
        options.sources = args[i + 1]
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
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
  if (!options.tag) {
    error("--tag is required");
    printHelp();
    process.exit(1);
  }

  if (options.sources.length === 0) {
    error("--sources is required and must not be empty");
    printHelp();
    process.exit(1);
  }

  return options;
}

/**
 * Validate source image references
 * @param sources - Array of source image references
 */
function validateSources(sources: string[]): void {
  for (const source of sources) {
    // Valid image references must contain either @ (digest) or : (tag)
    if (!source.includes("@") && !source.includes(":")) {
      error(`Invalid source image reference: ${source}`);
      console.error("  Source images must be valid references (contain @ or :)");
      process.exit(1);
    }
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
 * Build the docker buildx imagetools create command
 * @param options - Parsed options
 * @param annotations - Optional annotations object
 * @returns Array of command arguments
 */
function buildCommand(options: Options, annotations?: Record<string, string>): string[] {
  const cmd: string[] = ["docker", "buildx", "imagetools", "create"];

  // Add target tag
  cmd.push("-t", options.tag);

  // Add annotations if provided
  if (annotations) {
    for (const [key, value] of Object.entries(annotations)) {
      // Prepend annotation prefix (e.g., "index:org.opencontainers.image.version")
      const prefixedKey = `${options.annotationPrefix}${key}`;
      cmd.push("--annotation", `${prefixedKey}=${value}`);
    }
  }

  // Add source images
  cmd.push(...options.sources);

  return cmd;
}

/**
 * Execute the manifest creation command
 * @param options - Parsed options
 */
async function createManifest(options: Options): Promise<void> {
  // Load annotations if file provided
  let annotations: Record<string, string> | undefined;
  if (options.annotationsFile) {
    info(`Loading annotations from: ${options.annotationsFile}`);
    annotations = await loadAnnotations(options.annotationsFile);
    info(`Loaded ${Object.keys(annotations).length} annotations`);
  }

  // Build command
  const cmdArray = buildCommand(options, annotations);
  const cmdString = cmdArray.join(" ");

  if (options.dryRun) {
    info("Dry-run mode: Command preview");
    console.log("\n" + cmdString + "\n");
    success("Dry-run completed (no execution)");
    return;
  }

  // Execute command
  info("Creating multi-arch manifest...");
  info(`Tag: ${options.tag}`);
  info(`Sources: ${options.sources.length} image(s)`);

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
        console.error(`::error::Manifest creation failed with exit code ${exitCode}`);
      }
      error(`Manifest creation failed with exit code ${exitCode}`);
      process.exit(1);
    }

    success("Manifest created and pushed successfully");
    info(`Tag: ${options.tag}`);
  } catch (err) {
    // GitHub Actions annotations for CI/CD
    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.error(`::error::Failed to execute manifest creation: ${getErrorMessage(err)}`);
    }
    error(`Failed to execute manifest creation: ${getErrorMessage(err)}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const options = parseArgs();

  try {
    // Validate sources
    validateSources(options.sources);

    // Check Docker Buildx availability
    await checkBuildxAvailable();

    // Create manifest
    await createManifest(options);
  } catch (err) {
    error(getErrorMessage(err));
    process.exit(1);
  }
}

main();
