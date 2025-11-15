#!/usr/bin/env bun

/**
 * Validate OCI Multi-Arch Image Manifest
 *
 * Validates that an OCI Image Index manifest exists in the registry with expected
 * platforms and annotations. Replaces inline `docker buildx imagetools inspect`
 * validation in workflows (publish.yml lines 317-326).
 *
 * Usage:
 *   bun scripts/docker/validate-manifest.ts --manifest REF [OPTIONS]
 *
 * Required Options:
 *   --manifest REF          Manifest reference to validate (e.g., "ghcr.io/org/repo:tag")
 *
 * Optional Flags:
 *   --platforms CSV         Expected platforms (comma-separated, default: "linux/amd64,linux/arm64")
 *   --require-annotations   Fail if no annotations present
 *   --verbose               Show full manifest details
 *   --help                  Show this help message
 *
 * Examples:
 *   # Validate manifest with default platforms (linux/amd64, linux/arm64)
 *   bun scripts/docker/validate-manifest.ts \
 *     --manifest ghcr.io/fluxo-kt/aza-pg:18.1-single-node
 *
 *   # Validate with custom platforms
 *   bun scripts/docker/validate-manifest.ts \
 *     --manifest ghcr.io/fluxo-kt/aza-pg:18 \
 *     --platforms "linux/amd64,linux/arm64,linux/arm/v7"
 *
 *   # Validate with annotation requirement
 *   bun scripts/docker/validate-manifest.ts \
 *     --manifest ghcr.io/fluxo-kt/aza-pg:18.1-202511142330-single-node \
 *     --require-annotations
 *
 *   # Verbose mode showing full manifest details
 *   bun scripts/docker/validate-manifest.ts \
 *     --manifest ghcr.io/fluxo-kt/aza-pg:18 \
 *     --verbose
 *
 * OCI Image Index Format:
 *   {
 *     "schemaVersion": 2,
 *     "mediaType": "application/vnd.oci.image.index.v1+json",
 *     "manifests": [
 *       {
 *         "mediaType": "application/vnd.oci.image.manifest.v1+json",
 *         "digest": "sha256:...",
 *         "size": 1234,
 *         "platform": {
 *           "architecture": "amd64",
 *           "os": "linux"
 *         }
 *       }
 *     ],
 *     "annotations": {
 *       "org.opencontainers.image.version": "18.1",
 *       ...
 *     }
 *   }
 *
 * Exit Codes:
 *   0 - Manifest valid
 *   1 - Manifest invalid or missing
 */

import { $ } from "bun";
import { error, success, info, warning } from "../utils/logger.js";
import { getErrorMessage } from "../utils/errors.js";

interface Options {
  manifest: string;
  platforms: string[];
  requireAnnotations: boolean;
  verbose: boolean;
}

interface Platform {
  os: string;
  architecture: string;
  variant?: string;
}

interface ManifestEntry {
  mediaType: string;
  digest: string;
  size: number;
  platform: Platform;
}

interface OCIImageIndex {
  schemaVersion: number;
  mediaType: string;
  manifests: ManifestEntry[];
  annotations?: Record<string, string>;
}

function printHelp(): void {
  const helpText = `
Validate OCI Multi-Arch Image Manifest

Validates that an OCI Image Index manifest exists in the registry with expected
platforms and annotations. Replaces inline imagetools inspect validation.

Usage:
  bun scripts/docker/validate-manifest.ts --manifest REF [OPTIONS]

Required Options:
  --manifest REF          Manifest reference to validate (e.g., "ghcr.io/org/repo:tag")

Optional Flags:
  --platforms CSV         Expected platforms (comma-separated)
                          Default: "linux/amd64,linux/arm64"
  --require-annotations   Fail if no annotations present
  --verbose               Show full manifest details
  --help                  Show this help message

Examples:
  # Validate manifest with default platforms (linux/amd64, linux/arm64)
  bun scripts/docker/validate-manifest.ts \\
    --manifest ghcr.io/fluxo-kt/aza-pg:18.1-single-node

  # Validate with custom platforms
  bun scripts/docker/validate-manifest.ts \\
    --manifest ghcr.io/fluxo-kt/aza-pg:18 \\
    --platforms "linux/amd64,linux/arm64,linux/arm/v7"

  # Validate with annotation requirement
  bun scripts/docker/validate-manifest.ts \\
    --manifest ghcr.io/fluxo-kt/aza-pg:18.1-202511142330-single-node \\
    --require-annotations

  # Verbose mode showing full manifest details
  bun scripts/docker/validate-manifest.ts \\
    --manifest ghcr.io/fluxo-kt/aza-pg:18 \\
    --verbose

OCI Image Index Format:
  The script validates the OCI Image Index structure with:
  - schemaVersion: 2
  - mediaType: "application/vnd.oci.image.index.v1+json"
  - manifests: array of platform-specific images
  - annotations: optional OCI metadata

Exit Codes:
  0 - Manifest valid
  1 - Manifest invalid or missing
`;
  console.log(helpText.trim());
}

function parseArgs(): Options {
  const args = Bun.argv.slice(2);

  const options: Options = {
    manifest: "",
    platforms: ["linux/amd64", "linux/arm64"],
    requireAnnotations: false,
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

      case "--manifest":
        if (i + 1 >= args.length) {
          error("--manifest requires an argument");
          process.exit(1);
        }
        options.manifest = args[i + 1]!;
        i++;
        break;

      case "--platforms":
        if (i + 1 >= args.length) {
          error("--platforms requires a comma-separated list");
          process.exit(1);
        }
        // Split comma-separated platforms and trim whitespace
        options.platforms = args[i + 1]!.split(",")
          .map((p) => p.trim())
          .filter((p) => p.length > 0);
        i++;
        break;

      case "--require-annotations":
        options.requireAnnotations = true;
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
  if (!options.manifest) {
    error("--manifest is required");
    printHelp();
    process.exit(1);
  }

  if (options.platforms.length === 0) {
    error("--platforms must not be empty");
    printHelp();
    process.exit(1);
  }

  return options;
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
 * Fetch raw manifest JSON from registry
 * @param manifestRef - Manifest reference (e.g., "ghcr.io/org/repo:tag")
 * @returns Parsed OCI Image Index
 */
async function fetchManifest(manifestRef: string): Promise<OCIImageIndex> {
  try {
    info(`Fetching manifest: ${manifestRef}`);

    // Use docker buildx imagetools inspect --raw to get raw manifest JSON
    const result = await $`docker buildx imagetools inspect --raw ${manifestRef}`.nothrow();

    if (result.exitCode !== 0) {
      const errorMsg = `Failed to fetch manifest: ${manifestRef}`;
      error(errorMsg);

      // GitHub Actions annotation
      if (Bun.env.GITHUB_ACTIONS === "true") {
        console.error(`::error::${errorMsg}`);
      }

      // Show stderr if available
      const stderr = result.stderr.toString().trim();
      if (stderr) {
        console.error(`  ${stderr}`);
      }

      process.exit(1);
    }

    // Parse JSON output
    const stdout = result.stdout.toString().trim();
    const manifest = JSON.parse(stdout) as OCIImageIndex;

    return manifest;
  } catch (err) {
    const errorMsg = `Failed to parse manifest JSON: ${getErrorMessage(err)}`;
    error(errorMsg);

    // GitHub Actions annotation
    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.error(`::error::${errorMsg}`);
    }

    process.exit(1);
  }
}

/**
 * Format platform as "os/architecture[/variant]"
 * @param platform - Platform object
 * @returns Formatted platform string
 */
function formatPlatform(platform: Platform): string {
  let formatted = `${platform.os}/${platform.architecture}`;
  if (platform.variant) {
    formatted += `/${platform.variant}`;
  }
  return formatted;
}

/**
 * Validate OCI Image Index structure
 * @param manifest - Parsed manifest object
 * @param manifestRef - Manifest reference (for error messages)
 */
function validateManifestStructure(manifest: OCIImageIndex, _manifestRef: string): void {
  // Check schemaVersion
  if (manifest.schemaVersion !== 2) {
    const errorMsg = `Invalid schemaVersion: expected 2, got ${manifest.schemaVersion}`;
    error(errorMsg);

    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.error(`::error::${errorMsg}`);
    }

    process.exit(1);
  }

  // Check mediaType
  const expectedMediaType = "application/vnd.oci.image.index.v1+json";
  if (manifest.mediaType !== expectedMediaType) {
    const errorMsg = `Invalid mediaType: expected "${expectedMediaType}", got "${manifest.mediaType}"`;
    error(errorMsg);

    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.error(`::error::${errorMsg}`);
    }

    process.exit(1);
  }

  // Check manifests array exists
  if (!manifest.manifests || !Array.isArray(manifest.manifests)) {
    const errorMsg = "Invalid manifest structure: manifests array missing or not an array";
    error(errorMsg);

    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.error(`::error::${errorMsg}`);
    }

    process.exit(1);
  }

  // Check manifests array not empty
  if (manifest.manifests.length === 0) {
    const errorMsg = "Invalid manifest: manifests array is empty";
    error(errorMsg);

    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.error(`::error::${errorMsg}`);
    }

    process.exit(1);
  }
}

/**
 * Validate platforms in manifest match expected platforms
 * @param manifest - Parsed manifest object
 * @param expectedPlatforms - Expected platform strings (e.g., ["linux/amd64", "linux/arm64"])
 */
function validatePlatforms(manifest: OCIImageIndex, expectedPlatforms: string[]): void {
  // Extract actual platforms from manifest
  const actualPlatforms = manifest.manifests.map((entry) => formatPlatform(entry.platform));

  // Check if all expected platforms are present
  const missingPlatforms: string[] = [];

  for (const expected of expectedPlatforms) {
    if (!actualPlatforms.includes(expected)) {
      missingPlatforms.push(expected);
    }
  }

  if (missingPlatforms.length > 0) {
    const errorMsg = `Missing expected platforms: ${missingPlatforms.join(", ")}`;
    error(errorMsg);
    console.error(`  Expected: ${expectedPlatforms.join(", ")}`);
    console.error(`  Actual:   ${actualPlatforms.join(", ")}`);

    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.error(`::error::${errorMsg}`);
    }

    process.exit(1);
  }

  // Warn about extra platforms (not an error, just informational)
  const extraPlatforms = actualPlatforms.filter((actual) => !expectedPlatforms.includes(actual));
  if (extraPlatforms.length > 0) {
    warning(`Additional platforms found (not expected): ${extraPlatforms.join(", ")}`);
  }
}

/**
 * Validate annotations exist if required
 * @param manifest - Parsed manifest object
 * @param required - Whether annotations are required
 */
function validateAnnotations(manifest: OCIImageIndex, required: boolean): void {
  if (required) {
    if (!manifest.annotations || Object.keys(manifest.annotations).length === 0) {
      const errorMsg = "Annotations required but not present in manifest";
      error(errorMsg);

      if (Bun.env.GITHUB_ACTIONS === "true") {
        console.error(`::error::${errorMsg}`);
      }

      process.exit(1);
    }
  }
}

/**
 * Print validation summary
 * @param manifest - Parsed manifest object
 * @param verbose - Whether to show verbose details
 */
function printSummary(manifest: OCIImageIndex, verbose: boolean): void {
  const platforms = manifest.manifests.map((entry) => formatPlatform(entry.platform));
  const annotationCount = manifest.annotations ? Object.keys(manifest.annotations).length : 0;

  console.log();
  success(
    `Manifest valid: ${platforms.length} platform${platforms.length !== 1 ? "s" : ""} (${platforms.join(", ")})${annotationCount > 0 ? `, ${annotationCount} annotation${annotationCount !== 1 ? "s" : ""}` : ""}`
  );

  if (verbose) {
    console.log();
    console.log("Manifest Details:");
    console.log("─".repeat(60));
    console.log(`  Schema Version: ${manifest.schemaVersion}`);
    console.log(`  Media Type:     ${manifest.mediaType}`);
    console.log();

    // Platform details
    console.log("Platforms:");
    for (const entry of manifest.manifests) {
      const platform = formatPlatform(entry.platform);
      console.log(`  - ${platform}`);
      console.log(`    Digest: ${entry.digest}`);
      console.log(`    Size:   ${formatSize(entry.size)}`);
    }

    // Annotation details
    if (manifest.annotations && Object.keys(manifest.annotations).length > 0) {
      console.log();
      console.log("Annotations:");
      for (const [key, value] of Object.entries(manifest.annotations)) {
        console.log(`  - ${key}: ${value}`);
      }
    } else {
      console.log();
      console.log("Annotations: (none)");
    }

    console.log("─".repeat(60));
  }
}

/**
 * Format bytes to human-readable size
 * @param bytes - Size in bytes
 * @returns Formatted size string
 */
function formatSize(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(2)} KB`;
  }

  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(2)} MB`;
  }

  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

/**
 * Validate manifest
 * @param options - Parsed options
 */
async function validateManifest(options: Options): Promise<void> {
  // Fetch manifest from registry
  const manifest = await fetchManifest(options.manifest);

  // Validate manifest structure
  validateManifestStructure(manifest, options.manifest);

  // Validate platforms
  validatePlatforms(manifest, options.platforms);

  // Validate annotations if required
  validateAnnotations(manifest, options.requireAnnotations);

  // Print summary
  printSummary(manifest, options.verbose);
}

async function main(): Promise<void> {
  const options = parseArgs();

  try {
    // Check Docker Buildx availability
    await checkBuildxAvailable();

    // Validate manifest
    await validateManifest(options);
  } catch (err) {
    error(getErrorMessage(err));
    process.exit(1);
  }
}

main();
