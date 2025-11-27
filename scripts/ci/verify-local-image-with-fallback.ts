#!/usr/bin/env bun

/**
 * Verify local image with fallback tag detection
 *
 * When loaded locally, image may not include registry prefix.
 * Try with registry prefix first, fallback to local tag pattern matching.
 *
 * Usage:
 *   bun scripts/ci/verify-local-image-with-fallback.ts --image-ref=ghcr.io/repo:tag --ref-name=main
 *
 * Arguments:
 *   --image-ref     Full image reference (e.g., ghcr.io/repo:tag) (required)
 *   --ref-name      Git ref name for tag pattern (e.g., "main", "dev") (required)
 *
 * Exit codes:
 *   0 - Image verified successfully
 *   1 - Image verification failed
 */

// Empty export makes this file a module (enables top-level await)
export {};

import { $ } from "bun";

interface VerifyOptions {
  imageRef: string;
  refName: string;
}

async function verifyLocalImage(options: VerifyOptions): Promise<void> {
  const { imageRef, refName } = options;

  console.log(`Verifying local image: ${imageRef}...`);

  // Try with registry prefix first
  try {
    await $`docker run --rm ${imageRef} psql --version`.quiet();
    console.log("✅ Local image verified (with registry prefix)");
    return;
  } catch {
    console.log("Image not found with registry prefix, trying local tag pattern...");
  }

  // Fallback to finding local tag
  try {
    // Find image by tag pattern (e.g., dev-main)
    const tagPattern = `dev-${refName}$`;
    const images = await $`docker images --format '{{.Repository}}:{{.Tag}}'`.text();
    const matchingImage = images
      .trim()
      .split("\n")
      .find((img) => img.match(new RegExp(tagPattern)));

    if (!matchingImage) {
      throw new Error(`No local image found matching pattern: ${tagPattern}`);
    }

    console.log(`Found local image: ${matchingImage}`);

    // Verify it works
    await $`docker run --rm ${matchingImage} psql --version`.quiet();
    console.log("✅ Local image verified (local tag)");
  } catch (error) {
    console.error("❌ Failed to verify local image");
    throw error;
  }
}

// Parse CLI arguments
const args = Bun.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Verify local image with fallback tag detection

Usage:
  bun scripts/ci/verify-local-image-with-fallback.ts --image-ref=IMAGE --ref-name=REF

Arguments:
  --image-ref     Full image reference (required)
  --ref-name      Git ref name for tag pattern (required)
  --help, -h      Show this help message

Examples:
  bun scripts/ci/verify-local-image-with-fallback.ts --image-ref=ghcr.io/repo:dev-main --ref-name=main
`);
  process.exit(0);
}

const imageRef = args.find((arg) => arg.startsWith("--image-ref="))?.split("=")[1];
const refName = args.find((arg) => arg.startsWith("--ref-name="))?.split("=")[1];

if (!imageRef) {
  console.error("Error: --image-ref argument is required");
  process.exit(1);
}

if (!refName) {
  console.error("Error: --ref-name argument is required");
  process.exit(1);
}

try {
  await verifyLocalImage({ imageRef, refName });
} catch (error) {
  console.error("Error:", error);
  process.exit(1);
}
