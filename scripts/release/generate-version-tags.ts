#!/usr/bin/env bun

/**
 * Generate version tags for container image release
 *
 * Usage:
 *   bun scripts/release/generate-version-tags.ts --pg-version=18.1 --timestamp=202511221455 [--github-output]
 *
 * Arguments:
 *   --pg-version    Full PostgreSQL version (e.g., "18.1")
 *   --timestamp     Build timestamp in YYYYMMDDHHmm format
 *   --github-output Output to GITHUB_OUTPUT file (GitHub Actions)
 *
 * Output:
 *   version_tag=18.1-202511221455            (for releases, no type suffix)
 *   image_tag=18.1-202511221455-single-node  (for containers, with type suffix)
 *   convenience=18.1-single-node,18-single-node,18.1,18
 */

import { appendFile } from "node:fs/promises";

interface VersionTags {
  versionTag: string; // For releases: 18.1-202511221455
  imageTag: string; // For containers: 18.1-202511221455-single-node
  convenience: string[]; // Convenience tags array
}

function generateTags(pgVersion: string, timestamp: string): VersionTags {
  const parts = pgVersion.split(".");
  const pgMajor = parts[0] ?? pgVersion;

  // Separate version (for releases) from image tag (for containers)
  const versionTag = `${pgVersion}-${timestamp}`; // 18.1-202511221455
  const imageTag = `${pgVersion}-${timestamp}-single-node`; // 18.1-202511221455-single-node

  // Convenience tags
  const convenience: string[] = [
    `${pgVersion}-single-node`,
    `${pgMajor}-single-node`,
    pgVersion,
    pgMajor,
  ];

  return { versionTag, imageTag, convenience };
}

async function writeGitHubOutput(tags: VersionTags): Promise<void> {
  const outputFile = Bun.env.GITHUB_OUTPUT;
  if (!outputFile) {
    console.error("Error: GITHUB_OUTPUT environment variable not set");
    process.exit(1);
  }

  const output = [
    `version_tag=${tags.versionTag}`,
    `image_tag=${tags.imageTag}`,
    `convenience=${tags.convenience.join(",")}`,
  ].join("\n");

  await appendFile(outputFile, output + "\n");

  console.log("Generated version tags:");
  console.log(`  Version tag (for releases): ${tags.versionTag}`);
  console.log(`  Image tag (for containers): ${tags.imageTag}`);
  console.log(`  Convenience tags: ${tags.convenience.join(", ")}`);
}

function printConsoleOutput(tags: VersionTags): void {
  console.log(`version_tag=${tags.versionTag}`);
  console.log(`image_tag=${tags.imageTag}`);
  console.log(`convenience=${tags.convenience.join(",")}`);
}

// Parse CLI arguments
const args = Bun.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Generate version tags for container image release

Usage:
  bun scripts/release/generate-version-tags.ts --pg-version=18.1 --timestamp=202511221455 [--github-output]

Arguments:
  --pg-version    Full PostgreSQL version (required)
  --timestamp     Build timestamp YYYYMMDDHHmm (required)
  --github-output Output to GITHUB_OUTPUT file
  --help, -h      Show this help message

Examples:
  bun scripts/release/generate-version-tags.ts --pg-version=18.1 --timestamp=202511221455
  bun scripts/release/generate-version-tags.ts --pg-version=18.1 --timestamp=202511221455 --github-output
`);
  process.exit(0);
}

const pgVersion = args.find((arg) => arg.startsWith("--pg-version="))?.split("=")[1];
const timestamp = args.find((arg) => arg.startsWith("--timestamp="))?.split("=")[1];
const githubOutput = args.includes("--github-output");

if (!pgVersion) {
  console.error("Error: --pg-version argument is required");
  process.exit(1);
}

if (!timestamp) {
  console.error("Error: --timestamp argument is required");
  process.exit(1);
}

// Validate timestamp format
if (!/^\d{12}$/.test(timestamp)) {
  console.error("Error: --timestamp must be in YYYYMMDDHHmm format (12 digits)");
  process.exit(1);
}

const tags = generateTags(pgVersion, timestamp);

if (githubOutput) {
  await writeGitHubOutput(tags);
} else {
  printConsoleOutput(tags);
}
