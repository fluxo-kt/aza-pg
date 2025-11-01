#!/usr/bin/env bun

/**
 * Extract PostgreSQL version from base image reference
 *
 * Usage:
 *   bun scripts/build/extract-pg-version.ts --image "postgres:18.1-trixie@sha256:..." [--github-output]
 *
 * Arguments:
 *   --image         Full image reference (e.g., "postgres:18.1-trixie@sha256:abc...")
 *   --github-output Output to GITHUB_OUTPUT file (GitHub Actions)
 *
 * Output (GitHub Actions):
 *   major=18
 *   minor=1
 *   full=18.1
 *   base_image_name=postgres:18.1-trixie
 *   base_image_digest=sha256:abc...
 *
 * Output (Console):
 *   PostgreSQL Major: 18
 *   PostgreSQL Minor: 1
 *   PostgreSQL Full: 18.1
 *   Base Image: postgres:18.1-trixie
 *   Base Digest: sha256:abc...
 */

// Empty export makes this file a module (enables top-level await)
export {};

interface ParsedImage {
  major: string;
  minor: string;
  full: string;
  baseImageName: string;
  baseImageDigest: string;
}

function parseImageReference(image: string): ParsedImage {
  // Pattern: postgres:18.1-trixie@sha256:abc123...
  // or: postgres:18.1@sha256:abc123...
  // or: postgres:18-trixie@sha256:abc123...

  const digestMatch = image.match(/@(sha256:[a-f0-9]+)$/i);
  const baseImageDigest = digestMatch?.[1] ?? "";

  // Remove digest to get base image name
  const baseImageName = digestMatch ? image.slice(0, image.indexOf("@")) : image;

  // Extract version from tag (after : but before -)
  // Format: postgres:VERSION[-variant]@sha256:...
  const tagMatch = baseImageName.match(/:([0-9]+(?:\.[0-9]+)?)/);
  if (!tagMatch || !tagMatch[1]) {
    console.error(`Error: Could not parse PostgreSQL version from image: ${image}`);
    console.error("Expected format: postgres:18.1-trixie@sha256:... or postgres:18@sha256:...");
    process.exit(1);
  }

  const versionStr = tagMatch[1];
  const versionParts = versionStr.split(".");

  const major = versionParts[0];
  if (!major) {
    console.error(`Error: Could not parse major version from: ${versionStr}`);
    process.exit(1);
  }

  const minor = versionParts[1] ?? "0"; // Default to 0 if no minor version
  const full = `${major}.${minor}`;

  return {
    major,
    minor,
    full,
    baseImageName,
    baseImageDigest,
  };
}

async function writeGitHubOutput(parsed: ParsedImage): Promise<void> {
  const outputFile = Bun.env.GITHUB_OUTPUT;
  if (!outputFile) {
    console.error("Error: GITHUB_OUTPUT environment variable not set");
    console.error("This flag is intended for GitHub Actions only");
    process.exit(1);
  }

  const output = [
    `major=${parsed.major}`,
    `minor=${parsed.minor}`,
    `full=${parsed.full}`,
    `base_image_name=${parsed.baseImageName}`,
    `base_image_digest=${parsed.baseImageDigest}`,
  ].join("\n");

  const file = Bun.file(outputFile);
  const existing = (await file.exists()) ? await file.text() : "";
  await Bun.write(outputFile, existing + output + "\n");

  console.log(`PostgreSQL version extracted from image:`);
  console.log(`  Major: ${parsed.major}`);
  console.log(`  Minor: ${parsed.minor}`);
  console.log(`  Full: ${parsed.full}`);
  console.log(`  Base Image: ${parsed.baseImageName}`);
  console.log(`  Base Digest: ${parsed.baseImageDigest.slice(0, 20)}...`);
}

function printConsoleOutput(parsed: ParsedImage): void {
  console.log(`PostgreSQL Major: ${parsed.major}`);
  console.log(`PostgreSQL Minor: ${parsed.minor}`);
  console.log(`PostgreSQL Full: ${parsed.full}`);
  console.log(`Base Image: ${parsed.baseImageName}`);
  console.log(`Base Digest: ${parsed.baseImageDigest}`);
}

// Parse CLI arguments
const args = Bun.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Extract PostgreSQL version from base image reference

Usage:
  bun scripts/build/extract-pg-version.ts --image "postgres:18.1-trixie@sha256:..." [--github-output]

Arguments:
  --image         Full image reference (required)
  --github-output Output to GITHUB_OUTPUT file (GitHub Actions)
  --help, -h      Show this help message

Examples:
  bun scripts/build/extract-pg-version.ts --image "postgres:18.1-trixie@sha256:abc123"
  bun scripts/build/extract-pg-version.ts --image "postgres:18@sha256:def456" --github-output
`);
  process.exit(0);
}

const imageArg = args.find((arg) => arg.startsWith("--image="))?.split("=").slice(1).join("=");
const imageArgIndex = args.indexOf("--image");
const image = imageArg ?? (imageArgIndex >= 0 ? args[imageArgIndex + 1] : undefined);

if (!image) {
  console.error("Error: --image argument is required");
  console.error("Usage: bun scripts/build/extract-pg-version.ts --image <image-reference>");
  process.exit(1);
}

const githubOutput = args.includes("--github-output");

const parsed = parseImageReference(image);

if (githubOutput) {
  await writeGitHubOutput(parsed);
} else {
  printConsoleOutput(parsed);
}
