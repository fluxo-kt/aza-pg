#!/usr/bin/env bun

/**
 * Get Docker Image Metrics
 *
 * Extracts image size and layer metrics from Docker without starting a container.
 * Outputs JSON format suitable for CI/CD workflows and release tooling.
 *
 * Usage:
 *   bun scripts/release/get-image-metrics.ts --image=<image-ref>
 *
 * Examples:
 *   # Query by tag
 *   bun scripts/release/get-image-metrics.ts --image=ghcr.io/fluxo-kt/aza-pg:18.1-202511231356-single-node
 *
 *   # Query by digest
 *   bun scripts/release/get-image-metrics.ts --image=ghcr.io/fluxo-kt/aza-pg@sha256:abc123...
 *
 * Output (JSON):
 *   {
 *     "compressedBytes": 259815436,
 *     "uncompressedBytes": 937508864,
 *     "layerCount": 36,
 *     "compressedFormatted": "247.79 MB",
 *     "uncompressedFormatted": "894.07 MB"
 *   }
 *
 * Exit Codes:
 *   0 - Success
 *   1 - Error (missing arguments, Docker errors, etc.)
 */

import { getImageMetrics } from "../docker/image-metrics";
import { getErrorMessage } from "../utils/errors";

function printHelp(): void {
  const helpText = `
Get Docker Image Metrics

Extracts image size and layer metrics without starting a container.
Outputs JSON format for CI/CD workflows and release tooling.

Usage:
  bun scripts/release/get-image-metrics.ts --image=<image-ref>

Arguments:
  --image    Image reference (tag or digest)

Examples:
  # Query by tag
  bun scripts/release/get-image-metrics.ts --image=ghcr.io/fluxo-kt/aza-pg:18.1-202511231356-single-node

  # Query by digest
  bun scripts/release/get-image-metrics.ts --image=ghcr.io/fluxo-kt/aza-pg@sha256:abc123...

Output (JSON):
  {
    "compressedBytes": 259815436,
    "uncompressedBytes": 937508864,
    "layerCount": 36,
    "compressedFormatted": "247.79 MB",
    "uncompressedFormatted": "894.07 MB"
  }

Exit Codes:
  0 - Success
  1 - Error
`;
  console.log(helpText.trim());
}

function parseArgs(): string | null {
  const args = Bun.argv.slice(2);

  // Check for help flag
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  // Parse --image flag
  const imageArg = args.find((arg) => arg.startsWith("--image="));
  if (!imageArg) {
    console.error("ERROR: Missing required argument: --image");
    console.error("");
    console.error("Usage:");
    console.error("  bun scripts/release/get-image-metrics.ts --image=<image-ref>");
    console.error("");
    console.error("Run with --help for more information");
    return null;
  }

  const image = imageArg.split("=")[1];
  if (!image || image.trim() === "") {
    console.error("ERROR: --image argument cannot be empty");
    return null;
  }

  return image;
}

async function main() {
  const image = parseArgs();
  if (!image) {
    process.exit(1);
  }

  try {
    const metrics = await getImageMetrics(image);

    // Output JSON to stdout (machine-readable)
    console.log(JSON.stringify(metrics, null, 2));

    process.exit(0);
  } catch (err) {
    console.error(`ERROR: ${getErrorMessage(err)}`);
    process.exit(1);
  }
}

main();
