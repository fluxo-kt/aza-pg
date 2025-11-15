#!/usr/bin/env bun

/**
 * Verify Docker Image Exists Locally
 *
 * Verifies that a Docker image exists in the local Docker cache before using it
 * in workflows. Prevents "image not found" errors during tag/push operations.
 *
 * Usage:
 *   bun scripts/docker/verify-local-image.ts --image IMAGE [OPTIONS]
 *
 * Options:
 *   --image IMAGE    Image reference to verify (required)
 *   --verbose        Show detailed image information
 *   --help           Show this help message
 *
 * Examples:
 *   # Verify local image built by buildx
 *   bun scripts/docker/verify-local-image.ts --image aza-pg:pg18
 *
 *   # Verify with detailed metadata
 *   bun scripts/docker/verify-local-image.ts --image aza-pg:pg18 --verbose
 *
 *   # Check remote reference (will fail if not pulled locally)
 *   bun scripts/docker/verify-local-image.ts --image ghcr.io/fluxo-kt/aza-pg:18.1-202511142330-single-node
 *
 * Exit codes:
 *   0 - Image exists in local cache
 *   1 - Image not found or Docker error
 */

import { $ } from "bun";
import { error, success, info } from "../utils/logger.js";
import { getErrorMessage } from "../utils/errors.js";

interface Options {
  image: string;
  verbose: boolean;
}

interface ImageMetadata {
  Id: string;
  RepoTags: string[];
  RepoDigests: string[];
  Created: string;
  Size: number;
}

function printHelp(): void {
  const helpText = `
Verify Docker Image Exists Locally

Usage:
  bun scripts/docker/verify-local-image.ts --image IMAGE [OPTIONS]

Options:
  --image IMAGE    Image reference to verify (required)
  --verbose        Show detailed image information (digest, created, size)
  --help           Show this help message

Examples:
  # Verify local image built by buildx
  bun scripts/docker/verify-local-image.ts --image aza-pg:pg18

  # Verify with detailed metadata
  bun scripts/docker/verify-local-image.ts --image aza-pg:pg18 --verbose

  # Check remote reference (will fail if not pulled locally)
  bun scripts/docker/verify-local-image.ts --image ghcr.io/fluxo-kt/aza-pg:18.1-202511142330-single-node

Exit codes:
  0 - Image exists in local cache
  1 - Image not found or Docker error
`;
  console.log(helpText.trim());
}

function parseArgs(): Options {
  const args = Bun.argv.slice(2);

  const options: Options = {
    image: "",
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;

      case "--image":
        if (i + 1 >= args.length) {
          error("--image requires an argument");
          process.exit(1);
        }
        options.image = args[i + 1];
        i++;
        break;

      case "--verbose":
      case "-v":
        options.verbose = true;
        break;

      default:
        error(`Unknown option: ${arg}`);
        printHelp();
        process.exit(1);
    }
  }

  // Validate required options
  if (!options.image) {
    error("--image is required");
    printHelp();
    process.exit(1);
  }

  return options;
}

async function checkDockerAvailable(): Promise<void> {
  try {
    const result = await $`docker --version`.nothrow();
    if (result.exitCode !== 0) {
      error("Docker is not available or not running");
      process.exit(1);
    }
  } catch (err) {
    error(`Failed to check Docker availability: ${getErrorMessage(err)}`);
    process.exit(1);
  }
}

function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) {
    return `${mb.toFixed(2)} MB`;
  } else {
    const gb = mb / 1024;
    return `${gb.toFixed(2)} GB`;
  }
}

function formatTimestamp(timestamp: string): string {
  // Parse ISO 8601 timestamp and format as human-readable
  try {
    const date = new Date(timestamp);
    return date.toISOString();
  } catch {
    return timestamp;
  }
}

async function verifyImage(imageRef: string, verbose: boolean): Promise<void> {
  try {
    // Use docker image inspect to check if image exists locally
    const result = await $`docker image inspect ${imageRef}`.nothrow().json();

    if (!result || !Array.isArray(result) || result.length === 0) {
      // Image not found
      const errorMsg = `Image not found in local Docker cache: ${imageRef}`;
      error(errorMsg);

      // GitHub Actions annotation
      if (Bun.env.GITHUB_ACTIONS === "true") {
        console.log(`::error::${errorMsg}`);
      }

      // Helpful suggestion if it looks like a remote reference
      if (imageRef.includes("/") && !imageRef.startsWith("localhost")) {
        console.log();
        info(`💡 Tip: If this is a remote image, pull it first with:`);
        console.log(`   docker pull ${imageRef}`);
        console.log(`   or`);
        console.log(`   bun scripts/docker/pull-with-retry.ts --image ${imageRef}`);
      }

      process.exit(1);
    }

    // Image exists
    const metadata = result[0] as ImageMetadata;

    if (!verbose) {
      success(`Image exists locally: ${imageRef}`);
    } else {
      success(`Image exists locally: ${imageRef}`);
      console.log();
      console.log("Image Details:");
      console.log("─".repeat(60));

      // Image ID (short format)
      const shortId = metadata.Id.replace("sha256:", "").slice(0, 12);
      console.log(`  Image ID:     ${shortId}`);

      // Created timestamp
      if (metadata.Created) {
        console.log(`  Created:      ${formatTimestamp(metadata.Created)}`);
      }

      // Size
      if (metadata.Size) {
        console.log(`  Size:         ${formatSize(metadata.Size)}`);
      }

      // RepoTags
      if (metadata.RepoTags && metadata.RepoTags.length > 0) {
        console.log(`  Tags:         ${metadata.RepoTags.join(", ")}`);
      }

      // RepoDigests (if available)
      if (metadata.RepoDigests && metadata.RepoDigests.length > 0) {
        console.log(`  Digests:`);
        metadata.RepoDigests.forEach((digest) => {
          console.log(`    - ${digest}`);
        });
      }

      console.log("─".repeat(60));
    }

    process.exit(0);
  } catch (err) {
    error(`Failed to verify image: ${getErrorMessage(err)}`);

    // GitHub Actions annotation
    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.log(`::error::Failed to verify image ${imageRef}: ${getErrorMessage(err)}`);
    }

    process.exit(1);
  }
}

async function main(): Promise<void> {
  const options = parseArgs();

  // Check Docker availability first
  await checkDockerAvailable();

  // Verify the image exists
  await verifyImage(options.image, options.verbose);
}

main();
