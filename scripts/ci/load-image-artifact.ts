#!/usr/bin/env bun
/**
 * Load Docker Image from Artifact
 *
 * Loads a Docker image tarball and tags it for use in CI/CD workflows.
 * Consolidates the image loading pattern used across multiple test jobs.
 *
 * Usage:
 *   bun scripts/ci/load-image-artifact.ts \
 *     --artifact /tmp/image.tar \
 *     --tag aza-pg-ci:test
 *
 *   With label-based image ID detection:
 *     bun scripts/ci/load-image-artifact.ts \
 *       --artifact ./docker-image.tar \
 *       --tag aza-pg:latest \
 *       --label org.opencontainers.image.source
 *
 * Exit Codes:
 *   0 - Success
 *   1 - Failed to load or tag image
 */

import { $ } from "bun";
import { parseArgs } from "node:util";
import { info, success, error, section } from "../utils/logger";

interface LoadOptions {
  artifact: string;
  tag: string;
  label?: string;
}

/**
 * Load Docker image from tarball
 */
async function loadImageArtifact(options: LoadOptions): Promise<number> {
  section("Loading Docker Image from Artifact");
  info(`Artifact: ${options.artifact}`);
  info(`Target tag: ${options.tag}`);

  // Verify artifact exists
  if (!(await Bun.file(options.artifact).exists())) {
    error(`Artifact not found: ${options.artifact}`);
    return 1;
  }

  try {
    // Load image into Docker
    info("Loading image into Docker...");
    const loadResult = await $`docker load -i ${options.artifact}`.nothrow();

    if (loadResult.exitCode !== 0) {
      error("Failed to load image");
      error(loadResult.stderr.toString());
      return 1;
    }

    // Extract image ID from docker load output
    // Output format: "Loaded image: repository:tag" or "Loaded image ID: sha256:..."
    const loadOutput = loadResult.stdout.toString();
    info(loadOutput.trim());

    // Method 1: If load output contains repository:tag, use that
    const imageMatch = loadOutput.match(/Loaded image: (.+)/);
    if (imageMatch) {
      const loadedImage = imageMatch[1]!.trim();
      info(`Loaded image: ${loadedImage}`);

      // If loaded image is different from target tag, retag
      if (loadedImage !== options.tag) {
        info(`Tagging as ${options.tag}...`);
        const tagResult = await $`docker tag ${loadedImage} ${options.tag}`.nothrow();

        if (tagResult.exitCode !== 0) {
          error("Failed to tag image");
          error(tagResult.stderr.toString());
          return 1;
        }
      }

      success(`✓ Image ready: ${options.tag}`);
      return 0;
    }

    // Method 2: Find image by label (if provided)
    if (options.label) {
      info(`Finding image by label: ${options.label}`);
      const imageID =
        await $`docker images --format "{{.ID}}" --filter "label=${options.label}" | head -1`
          .nothrow()
          .text();

      if (!imageID.trim()) {
        error(`No image found with label: ${options.label}`);
        return 1;
      }

      info(`Found image: ${imageID.trim()}`);
      info(`Tagging as ${options.tag}...`);

      const tagResult = await $`docker tag ${imageID.trim()} ${options.tag}`.nothrow();

      if (tagResult.exitCode !== 0) {
        error("Failed to tag image");
        error(tagResult.stderr.toString());
        return 1;
      }

      success(`✓ Image ready: ${options.tag}`);
      return 0;
    }

    // Method 3: Use most recent image (fallback)
    info("Finding most recent image...");
    const recentImage = await $`docker images --format "{{.ID}}" | head -1`.nothrow().text();

    if (!recentImage.trim()) {
      error("No images found");
      return 1;
    }

    info(`Found image: ${recentImage.trim()}`);
    info(`Tagging as ${options.tag}...`);

    const tagResult = await $`docker tag ${recentImage.trim()} ${options.tag}`.nothrow();

    if (tagResult.exitCode !== 0) {
      error("Failed to tag image");
      error(tagResult.stderr.toString());
      return 1;
    }

    success(`✓ Image ready: ${options.tag}`);
    return 0;
  } catch (err) {
    error(`Failed to load image: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// Main execution
if (import.meta.main) {
  // Handle --help before parseArgs
  if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
    console.log(
      `
Load Docker Image from Artifact

Usage:
  bun scripts/ci/load-image-artifact.ts --artifact PATH --tag TAG [OPTIONS]

Required Options:
  --artifact PATH         Path to Docker image tarball
  --tag TAG               Target tag for loaded image

Optional Options:
  --label LABEL           Find image by label filter
  --help, -h              Show this help message

Examples:
  # Basic image loading
  bun scripts/ci/load-image-artifact.ts \\
    --artifact /tmp/image.tar \\
    --tag aza-pg-ci:test

  # With label-based detection
  bun scripts/ci/load-image-artifact.ts \\
    --artifact ./docker-image.tar \\
    --tag aza-pg:latest \\
    --label org.opencontainers.image.source

Exit Codes:
  0 - Success
  1 - Failed to load or tag image
    `.trim()
    );
    process.exit(0);
  }

  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      artifact: { type: "string" },
      tag: { type: "string" },
      label: { type: "string" }, // optional
    },
  });

  if (!values.artifact || !values.tag) {
    error("Missing required arguments");
    console.log("\nUsage:");
    console.log("  bun scripts/ci/load-image-artifact.ts \\");
    console.log("    --artifact <path/to/image.tar> \\");
    console.log("    --tag <repository:tag> \\");
    console.log("    [--label <label-filter>]");
    process.exit(1);
  }

  const options: LoadOptions = {
    artifact: values.artifact!,
    tag: values.tag!,
    label: values.label,
  };

  process.exit(await loadImageArtifact(options));
}
