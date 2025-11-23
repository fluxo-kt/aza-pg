#!/usr/bin/env bun
/**
 * Base Image SHA Validator
 *
 * Validates that the hardcoded PostgreSQL base image SHA in Dockerfile is still valid
 * and checks if it matches the latest available version on Docker Hub.
 *
 * This script:
 * - Extracts PG_VERSION and PG_BASE_IMAGE_SHA from Dockerfile
 * - Verifies the SHA exists using docker manifest inspect
 * - Compares with the latest available version tag
 * - Provides clear warnings if the SHA is stale
 *
 * Usage:
 *   bun scripts/validate-base-image-sha.ts           # Exit 1 if stale or invalid
 *   bun scripts/validate-base-image-sha.ts --check   # Exit 0 even if stale (warn only)
 *   bun scripts/validate-base-image-sha.ts --help    # Show help
 *
 * Exit codes:
 *   0: SHA is valid (and current, unless --check used)
 *   1: SHA is invalid or stale (or Docker unavailable)
 *
 * Environment variables:
 *   ALLOW_STALE_BASE_IMAGE=1  # Treat stale image as warning instead of error
 */

import { join } from "node:path";
import { getErrorMessage } from "./utils/errors";
import { error, info, section, success, warning } from "./utils/logger.ts";
import { isDockerDaemonRunning, dockerRun } from "./utils/docker";

const PROJECT_ROOT = join(import.meta.dir, "..");
const DOCKERFILE_PATH = join(PROJECT_ROOT, "docker/postgres/Dockerfile");

interface BaseImageInfo {
  version: string;
  sha: string;
  image: string;
}

/**
 * Extract PG_VERSION and PG_BASE_IMAGE_SHA from Dockerfile
 */
async function extractDockerfileInfo(): Promise<BaseImageInfo> {
  const dockerfileContent = await Bun.file(DOCKERFILE_PATH).text();

  // Extract PG_VERSION
  const versionMatch = dockerfileContent.match(/^ARG PG_VERSION=(\d+)/m);
  if (!versionMatch || !versionMatch[1]) {
    throw new Error("Could not find PG_VERSION in Dockerfile");
  }
  const version = versionMatch[1];

  // Extract PG_BASE_IMAGE_SHA
  const shaMatch = dockerfileContent.match(/^ARG PG_BASE_IMAGE_SHA=(sha256:[a-f0-9]{64})/m);
  if (!shaMatch || !shaMatch[1]) {
    throw new Error("Could not find PG_BASE_IMAGE_SHA in Dockerfile");
  }
  const sha = shaMatch[1];

  // Construct base image name
  const image = `postgres:${version}-trixie`;

  return { version, sha, image };
}

/**
 * Verify SHA exists using docker manifest inspect
 */
async function verifyShaExists(image: string, sha: string): Promise<boolean> {
  info(`Verifying SHA exists: ${image}@${sha}`);

  const fullImage = `${image}@${sha}`;
  const result = await dockerRun(["manifest", "inspect", fullImage]);

  if (!result.success) {
    error(`SHA validation failed: ${result.output}`);
    return false;
  }

  success("SHA is valid and exists on Docker Hub");
  return true;
}

/**
 * Get the latest SHA for the given image tag
 */
async function getLatestSha(image: string): Promise<string | null> {
  info(`Fetching latest SHA for: ${image}`);

  // First, try to get the digest directly using docker pull (dry-run)
  // This is more reliable than parsing manifest JSON
  const pullResult = await dockerRun(["pull", image]);

  if (pullResult.success) {
    // Extract digest from pull output (e.g., "Digest: sha256:...")
    const digestMatch = pullResult.output.match(/Digest:\s+(sha256:[a-f0-9]{64})/);
    if (digestMatch && digestMatch[1]) {
      return digestMatch[1];
    }
  }

  // Fallback: Try docker inspect on local image
  const inspectResult = await dockerRun([
    "image",
    "inspect",
    image,
    "--format",
    "{{.RepoDigests}}",
  ]);
  if (inspectResult.success) {
    // Parse output like: [docker.io/library/postgres@sha256:... postgres@sha256:...]
    // We want the first one that matches the expected format
    const digestMatch = inspectResult.output.match(/postgres@(sha256:[a-f0-9]{64})/);
    if (digestMatch && digestMatch[1]) {
      return digestMatch[1];
    }
  }

  // Last resort: Try manifest inspect
  const manifestResult = await dockerRun(["manifest", "inspect", image]);
  if (manifestResult.success) {
    try {
      const manifest = JSON.parse(manifestResult.output);

      // Handle manifest list (multi-arch)
      if (
        manifest.schemaVersion === 2 &&
        manifest.mediaType === "application/vnd.docker.distribution.manifest.list.v2+json"
      ) {
        // Get the linux/amd64 entry
        const amd64Manifest = manifest.manifests?.find(
          (m: { platform?: { architecture?: string; os?: string } }) =>
            m.platform?.architecture === "amd64" && m.platform?.os === "linux"
        );

        if (amd64Manifest?.digest) {
          return amd64Manifest.digest;
        }
      }
    } catch (err) {
      warning(`Failed to parse manifest JSON: ${getErrorMessage(err)}`);
    }
  }

  warning("Could not determine latest SHA using any method");
  return null;
}

/**
 * Compare current SHA with latest
 */
function compareShas(currentSha: string, latestSha: string | null, image: string): boolean {
  if (!latestSha) {
    warning("Could not determine latest SHA - skipping staleness check");
    return true;
  }

  if (currentSha === latestSha) {
    success(`SHA is current (matches latest ${image})`);
    return true;
  } else {
    warning(`SHA appears to be stale`);
    warning(`  Current: ${currentSha}`);
    warning(`  Latest:  ${latestSha}`);
    warning(``);
    warning(
      `The base image may have been updated. Consider updating PG_BASE_IMAGE_SHA in Dockerfile.`
    );
    warning(`To update, run:`);
    warning(`  docker pull ${image}`);
    warning(`  docker inspect ${image} --format '{{.RepoDigests}}'`);
    warning(``);
    return false;
  }
}

/**
 * Main validation function
 */
async function validate(checkMode: boolean): Promise<void> {
  const startTime = Date.now();

  section("Base Image SHA Validation");

  // Check Docker availability
  if (!(await isDockerDaemonRunning())) {
    error("Docker daemon is not running or not available");
    error("Please start Docker to run this validation");
    throw new Error("Docker not available");
  }

  // Extract Dockerfile info
  info(`Reading Dockerfile: ${DOCKERFILE_PATH}`);
  const imageInfo = await extractDockerfileInfo();

  info(`PostgreSQL Version: ${imageInfo.version}`);
  info(`Base Image: ${imageInfo.image}`);
  info(`Hardcoded SHA: ${imageInfo.sha}`);
  console.log("");

  // Verify SHA exists
  const shaExists = await verifyShaExists(imageInfo.image, imageInfo.sha);
  console.log("");

  if (!shaExists) {
    error("SHA validation FAILED: The hardcoded SHA does not exist");
    error("This likely means the SHA is invalid or the image was removed from Docker Hub");
    error("");
    error("Action required:");
    error(`  1. Pull the latest image: docker pull ${imageInfo.image}`);
    error(`  2. Inspect to get SHA: docker inspect ${imageInfo.image} --format '{{.RepoDigests}}'`);
    error(`  3. Update PG_BASE_IMAGE_SHA in ${DOCKERFILE_PATH}`);
    throw new Error("Invalid base image SHA");
  }

  // Check if SHA is latest (staleness check)
  const latestSha = await getLatestSha(imageInfo.image);
  const isCurrent = compareShas(imageInfo.sha, latestSha, imageInfo.image);
  console.log("");

  // Determine if staleness should fail the validation
  const allowStale = checkMode || Bun.env.ALLOW_STALE_BASE_IMAGE === "1";

  if (!isCurrent) {
    if (allowStale) {
      warning(
        "SHA is stale but validation passing due to --check flag or ALLOW_STALE_BASE_IMAGE=1"
      );
    } else {
      error("SHA is stale - update required");
      error("Run with --check flag or set ALLOW_STALE_BASE_IMAGE=1 to treat as warning");
      throw new Error("Stale base image SHA");
    }
  }

  // Summary
  const duration = Date.now() - startTime;
  success(`Validation completed in ${(duration / 1000).toFixed(2)}s`);

  if (!isCurrent && allowStale) {
    console.log("");
    warning("Note: Base image SHA is stale - consider updating for latest security patches");
  }
}

/**
 * Show help message
 */
function showHelp(): void {
  console.log(`
Base Image SHA Validator

Validates that the hardcoded PostgreSQL base image SHA in Dockerfile is still
valid and checks if it matches the latest available version.

USAGE:
  bun scripts/validate-base-image-sha.ts [FLAGS]

FLAGS:
  --check    Check mode: Exit 0 even if SHA is stale (warn only)
  --help     Show this help message

EXAMPLES:
  # Fail if SHA is stale or invalid
  bun scripts/validate-base-image-sha.ts

  # Warn if stale but don't fail
  bun scripts/validate-base-image-sha.ts --check

  # Allow stale via environment variable
  ALLOW_STALE_BASE_IMAGE=1 bun scripts/validate-base-image-sha.ts

EXIT CODES:
  0: SHA is valid (and current, unless --check used)
  1: SHA is invalid or stale (or Docker unavailable)

ENVIRONMENT:
  ALLOW_STALE_BASE_IMAGE=1   Treat stale image as warning instead of error

For more information, see docs/BUILD.md
`);
}

// Parse command line arguments
const args = new Set(Bun.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
  showHelp();
  process.exit(0);
}

const checkMode = args.has("--check");

// Run validation
try {
  await validate(checkMode);
} catch (err) {
  error(`Validation failed: ${getErrorMessage(err)}`);
  process.exit(1);
}
