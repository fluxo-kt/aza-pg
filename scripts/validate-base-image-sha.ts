#!/usr/bin/env bun
/**
 * Base Image SHA Validator
 *
 * Validates that the generated PostgreSQL base image pin still exists and matches
 * the manifest source of truth.
 *
 * This script:
 * - Extracts PostgreSQL version and base image SHA from Dockerfile
 * - Verifies the SHA exists using docker manifest inspect
 * - Compares with the same-version tag digest
 * - Optionally requires the pinned minor to match the floating major tag
 * - Provides clear warnings if the SHA is stale
 *
 * Usage:
 *   bun scripts/validate-base-image-sha.ts           # Exit 1 if stale or invalid
 *   bun scripts/validate-base-image-sha.ts --check   # Exit 0 even if stale (warn only)
 *   bun scripts/validate-base-image-sha.ts --require-latest-minor
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
import { error, info, section, success, warning } from "./utils/logger";
import { isDockerDaemonRunning, dockerRun } from "./utils/docker";
import { MANIFEST_METADATA } from "./extensions/manifest-data";

const PROJECT_ROOT = join(import.meta.dir, "..");
const DOCKERFILE_PATH = join(PROJECT_ROOT, "docker/postgres/Dockerfile");

interface BaseImageInfo {
  version: string;
  sha: string;
  image: string;
}

interface ShaValidationResult {
  exists: boolean;
  rateLimited: boolean;
  output: string;
}

interface ValidationOptions {
  checkMode: boolean;
  requireLatestMinor: boolean;
}

interface FloatingMajorTagInfo {
  version: string;
  digest: string;
}

function isDockerHubRateLimitError(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("toomanyrequests") ||
    normalized.includes("too many requests") ||
    normalized.includes("rate limit") ||
    normalized.includes("you have reached your pull rate limit") ||
    normalized.includes("429")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function getRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

/**
 * Extract PostgreSQL version and base image SHA from generated FROM statements.
 */
async function extractDockerfileInfo(): Promise<BaseImageInfo> {
  const dockerfileContent = await Bun.file(DOCKERFILE_PATH).text();

  // Extract version and SHA from FROM statement
  // Pattern: FROM postgres:18.1-trixie@sha256:...
  const fromMatch = dockerfileContent.match(
    /^FROM postgres:(\d+\.\d+)-trixie@(sha256:[a-f0-9]{64})/m
  );
  if (!fromMatch || !fromMatch[1] || !fromMatch[2]) {
    throw new Error("Could not find PostgreSQL version and SHA in FROM statement");
  }

  const version = fromMatch[1];
  const sha = fromMatch[2];

  // Construct base image name
  const image = `postgres:${version}-trixie`;

  return { version, sha, image };
}

/**
 * Verify the pinned digest is still served by the registry.
 *
 * Inspects `repo@digest` with the tag stripped on purpose: `docker manifest inspect repo:tag@digest`
 * resolves the TAG and then demands it equal the digest, so it fails with "manifest verification
 * failed" whenever Docker Hub re-pushes the tag, even though the pinned digest still exists and
 * `FROM repo:tag@digest` (which pulls by digest) still builds. A moved tag is staleness, reported
 * separately by compareShas().
 */
async function verifyShaExists(image: string, sha: string): Promise<ShaValidationResult> {
  const repository = image.split(":")[0];
  const fullImage = `${repository}@${sha}`;
  info(`Verifying digest exists: ${fullImage}`);

  const result = await dockerRun(["manifest", "inspect", fullImage]);

  if (!result.success) {
    if (isDockerHubRateLimitError(result.output)) {
      warning("Docker Hub rate limit hit while validating base image SHA");
      warning("Unable to verify digest existence in this run");
      return { exists: false, rateLimited: true, output: result.output };
    }

    error(`SHA validation failed: ${result.output}`);
    return { exists: false, rateLimited: false, output: result.output };
  }

  success("SHA is valid and exists on Docker Hub");
  return { exists: true, rateLimited: false, output: result.output };
}

/**
 * Get the latest SHA for the given image tag
 */
async function getLatestSha(image: string): Promise<string | null> {
  info(`Fetching latest SHA for: ${image}`);

  // Reads the tag's index digest from the registry without downloading layers (a `docker pull`
  // here fetched the whole image on every run). This is the same multi-arch index digest that
  // `docker pull` prints and that MANIFEST_METADATA.baseImageSha pins.
  const result = await dockerRun([
    "buildx",
    "imagetools",
    "inspect",
    image,
    "--format",
    "{{json .Manifest}}",
  ]);
  if (result.success) {
    try {
      const parsed: unknown = JSON.parse(result.output);
      const digest = isRecord(parsed) ? getString(parsed, "digest") : null;
      if (digest && /^sha256:[a-f0-9]{64}$/.test(digest)) return digest;
      warning(`Unexpected ${image} index metadata: no sha256 digest`);
    } catch (err) {
      warning(`Failed to parse ${image} index metadata: ${getErrorMessage(err)}`);
    }
  } else {
    warning(`Could not inspect ${image}: ${result.output}`);
  }

  return null;
}

async function getFloatingMajorTagInfo(version: string): Promise<FloatingMajorTagInfo | null> {
  const major = version.split(".")[0];
  if (!major) {
    warning(`Could not extract PostgreSQL major version from ${version}`);
    return null;
  }

  const image = `postgres:${major}-trixie`;
  info(`Fetching floating major tag metadata: ${image}`);

  const result = await dockerRun([
    "buildx",
    "imagetools",
    "inspect",
    image,
    "--format",
    "{{json .}}",
  ]);

  if (!result.success) {
    warning(`Could not inspect ${image}: ${result.output}`);
    return null;
  }

  return parseFloatingMajorTagInfo(result.output, image);
}

function parseFloatingMajorTagInfo(output: string, image: string): FloatingMajorTagInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (err) {
    warning(`Could not parse ${image} metadata JSON: ${getErrorMessage(err)}`);
    return null;
  }

  if (!isRecord(parsed)) {
    warning(`Unexpected ${image} metadata shape: top-level value is not an object`);
    return null;
  }

  const manifest = getRecord(parsed, "manifest");
  if (!manifest) {
    warning(`Unexpected ${image} metadata shape: missing manifest object`);
    return null;
  }

  const digest = getString(manifest, "digest");
  if (!digest) {
    warning(`Unexpected ${image} metadata shape: missing manifest digest`);
    return null;
  }

  const version = extractVersionFromManifestList(manifest);
  if (!version) {
    warning(`Unexpected ${image} metadata shape: missing runnable descriptor version annotation`);
    return null;
  }

  return { version, digest };
}

function extractVersionFromManifestList(manifest: Record<string, unknown>): string | null {
  const descriptors = manifest.manifests;
  if (!Array.isArray(descriptors)) return null;

  const versions = new Set<string>();
  for (const descriptor of descriptors) {
    if (!isRecord(descriptor)) continue;
    const platform = getRecord(descriptor, "platform");
    const annotations = getRecord(descriptor, "annotations");
    if (!platform || !annotations) continue;
    if (getString(platform, "os") !== "linux") continue;

    const architecture = getString(platform, "architecture");
    if (!architecture || architecture === "unknown") continue;

    const version = getString(annotations, "org.opencontainers.image.version");
    if (version) versions.add(version);
  }

  return versions.size === 1 ? [...versions][0]! : null;
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
      `The base image may have been updated. Update MANIFEST_METADATA.baseImageSha and regenerate.`
    );
    warning(`To update, run:`);
    warning(`  docker buildx imagetools inspect ${image} --format '{{json .Manifest.Digest}}'`);
    warning(``);
    return false;
  }
}

function compareFloatingMajorTag(
  current: BaseImageInfo,
  floating: FloatingMajorTagInfo | null,
  requireLatestMinor: boolean
): boolean {
  if (!floating) {
    warning("Could not determine floating major tag version");
    return !requireLatestMinor;
  }

  if (current.version === floating.version && current.sha === floating.digest) {
    success(`Pinned base image matches postgres:${current.version.split(".")[0]}-trixie`);
    return true;
  }

  warning(`Pinned PostgreSQL base image is behind the floating major tag`);
  warning(`  Current: postgres:${current.version}-trixie@${current.sha}`);
  warning(`  Latest:  postgres:${floating.version}-trixie@${floating.digest}`);

  return false;
}

/**
 * Main validation function
 */
async function validate(options: ValidationOptions): Promise<void> {
  const startTime = Date.now();
  const allowStale = options.checkMode || Bun.env.ALLOW_STALE_BASE_IMAGE === "1";

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
  info(`Manifest PG Version: ${MANIFEST_METADATA.pgVersion}`);
  console.log("");

  if (imageInfo.version !== MANIFEST_METADATA.pgVersion) {
    error(
      `Dockerfile version (${imageInfo.version}) does not match manifest (${MANIFEST_METADATA.pgVersion})`
    );
    throw new Error("Dockerfile/manifest PostgreSQL version mismatch");
  }

  // Verify SHA exists
  const shaValidation = await verifyShaExists(imageInfo.image, imageInfo.sha);
  console.log("");

  if (!shaValidation.exists) {
    if (shaValidation.rateLimited && allowStale) {
      warning(
        "Skipping base image SHA existence check due to Docker Hub rate limit in check/warn mode"
      );
      success("Validation completed with rate-limit fallback");
      return;
    }

    error("SHA validation FAILED: the pinned digest could not be fetched from Docker Hub");
    error("Either the digest was removed or the lookup itself failed (see the output above)");
    error("");
    error("Action required:");
    error(
      `  1. Read the current digest: docker buildx imagetools inspect ${imageInfo.image} --format '{{json .Manifest.Digest}}'`
    );
    error("  2. Update MANIFEST_METADATA.baseImageSha and run: bun run generate");
    throw new Error("Invalid base image SHA");
  }

  // Check if SHA is latest (staleness check)
  const latestSha = await getLatestSha(imageInfo.image);
  const isCurrent = compareShas(imageInfo.sha, latestSha, imageInfo.image);
  console.log("");

  const floatingMajor = await getFloatingMajorTagInfo(imageInfo.version);
  const isLatestMinor = compareFloatingMajorTag(
    imageInfo,
    floatingMajor,
    options.requireLatestMinor
  );
  console.log("");

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

  if (!isLatestMinor) {
    if (allowStale && !options.requireLatestMinor) {
      warning("Latest-minor drift detected but validation passing in check mode");
    } else {
      error("Pinned base image is not the current PostgreSQL minor for this major");
      throw new Error("Stale PostgreSQL minor version");
    }
  }

  // Summary
  const duration = Date.now() - startTime;
  success(`Validation completed in ${(duration / 1000).toFixed(2)}s`);

  if ((!isCurrent || !isLatestMinor) && allowStale) {
    console.log("");
    warning("Note: Base image pin is stale - consider updating for latest security patches");
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
  --check                  Check mode: Exit 0 even if same-tag SHA is stale (warn only)
  --require-latest-minor   Fail unless postgres:<major>-trixie matches the pinned minor and digest
  --help                   Show this help message

EXAMPLES:
  # Fail if SHA is stale or invalid
  bun scripts/validate-base-image-sha.ts

  # Warn if stale but don't fail
  bun scripts/validate-base-image-sha.ts --check

  # Release gate: require the latest PostgreSQL minor for this major
  bun scripts/validate-base-image-sha.ts --require-latest-minor

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
const requireLatestMinor = args.has("--require-latest-minor");

// Run validation
try {
  await validate({ checkMode, requireLatestMinor });
} catch (err) {
  error(`Validation failed: ${getErrorMessage(err)}`);
  process.exit(1);
}
