#!/usr/bin/env bun

/**
 * Extract PostgreSQL Version from Docker Image
 *
 * Extracts the actual PostgreSQL version (MM.mm format) from a running container
 * or base image. RELEASE-CRITICAL: Used in publish.yml to generate version-tagged images.
 *
 * Usage:
 *   bun scripts/build/extract-pg-version.ts --image IMAGE [OPTIONS]
 *
 * Options:
 *   --image IMAGE         Docker image reference to extract version from (required)
 *   --output FORMAT       Output format: "major.minor" (default), "major", "minor", "full"
 *   --github-output       Write to $GITHUB_OUTPUT (key=value format)
 *   --help                Show this help message
 *
 * Examples:
 *   # Extract version from base image
 *   bun scripts/build/extract-pg-version.ts --image postgres:18-alpine
 *   # Output: 18.1
 *
 *   # Extract only major version
 *   bun scripts/build/extract-pg-version.ts --image postgres:18-alpine --output major
 *   # Output: 18
 *
 *   # GitHub Actions workflow integration
 *   bun scripts/build/extract-pg-version.ts --image aza-pg:latest --github-output
 *   # Appends to $GITHUB_OUTPUT: pg_version=18.1, pg_major=18, pg_minor=1
 *
 *   # Extract full version string
 *   bun scripts/build/extract-pg-version.ts --image postgres:18-alpine --output full
 *   # Output: 18.1.0
 *
 * Exit codes:
 *   0 - Success
 *   1 - Docker not available, image cannot be run, or version extraction failed
 */

import { $ } from "bun";
import { error, success, info } from "../utils/logger.js";
import { getErrorMessage } from "../utils/errors.js";

type OutputFormat = "major.minor" | "major" | "minor" | "full";

interface Options {
  image: string;
  outputFormat: OutputFormat;
  githubOutput: boolean;
}

interface ParsedVersion {
  major: string;
  minor: string;
  full: string;
  majorMinor: string;
}

function printHelp(): void {
  const helpText = `
Extract PostgreSQL Version from Docker Image

RELEASE-CRITICAL: Used in publish.yml to generate version-tagged images.
Extracts ACTUAL version from running PostgreSQL (not assumption based on base image tag).

Usage:
  bun scripts/build/extract-pg-version.ts --image IMAGE [OPTIONS]

Options:
  --image IMAGE         Docker image reference to extract version from (required)
  --output FORMAT       Output format (default: "major.minor")
                        Formats: "major.minor" (18.1), "major" (18),
                                "minor" (1), "full" (18.1.0)
  --github-output       Write to $GITHUB_OUTPUT (pg_version, pg_major, pg_minor)
  --help                Show this help message

Examples:
  # Extract version from base image
  bun scripts/build/extract-pg-version.ts --image postgres:18-alpine
  # Output: 18.1

  # Extract only major version
  bun scripts/build/extract-pg-version.ts --image postgres:18-alpine --output major
  # Output: 18

  # Extract only minor version
  bun scripts/build/extract-pg-version.ts --image postgres:18-alpine --output minor
  # Output: 1

  # Extract full version string (including patch)
  bun scripts/build/extract-pg-version.ts --image postgres:18-alpine --output full
  # Output: 18.1.0

  # GitHub Actions workflow integration
  bun scripts/build/extract-pg-version.ts --image aza-pg:latest --github-output
  # Appends to $GITHUB_OUTPUT:
  #   pg_version=18.1
  #   pg_major=18
  #   pg_minor=1

  # Extract from local build
  bun scripts/build/extract-pg-version.ts --image aza-pg:pg18

  # Extract from remote base image (must be pulled first)
  bun scripts/build/extract-pg-version.ts --image ghcr.io/fluxo-kt/aza-pg:18.1-202511142330-single-node

Exit codes:
  0 - Success
  1 - Docker not available, image cannot be run, or version extraction failed
`;
  console.log(helpText.trim());
}

function parseArgs(): Options {
  const args = Bun.argv.slice(2);

  const options: Options = {
    image: "",
    outputFormat: "major.minor",
    githubOutput: false,
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

      case "--output":
        if (i + 1 >= args.length) {
          error("--output requires an argument");
          process.exit(1);
        }
        const format = args[i + 1];
        if (!["major.minor", "major", "minor", "full"].includes(format)) {
          error(
            `Invalid output format: ${format}. Must be one of: major.minor, major, minor, full`
          );
          process.exit(1);
        }
        options.outputFormat = format as OutputFormat;
        i++;
        break;

      case "--github-output":
        options.githubOutput = true;
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
      const errorMsg = "Docker is not available or not running";
      error(errorMsg);

      // GitHub Actions annotation
      if (Bun.env.GITHUB_ACTIONS === "true") {
        console.log(`::error::${errorMsg}`);
      }

      process.exit(1);
    }
  } catch (err) {
    const errorMsg = `Failed to check Docker availability: ${getErrorMessage(err)}`;
    error(errorMsg);

    // GitHub Actions annotation
    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.log(`::error::${errorMsg}`);
    }

    process.exit(1);
  }
}

function parseVersionString(versionOutput: string): ParsedVersion {
  // PostgreSQL version output format examples:
  // - "psql (PostgreSQL) 18.1"
  // - "psql (PostgreSQL) 18.1.0"
  // - "psql (PostgreSQL) 17.2 (Debian 17.2-1.pgdg120+1)"

  // Extract version number using regex
  const versionMatch = versionOutput.match(/PostgreSQL\)\s+(\d+)\.(\d+)(?:\.(\d+))?/);

  if (!versionMatch) {
    throw new Error(
      `Failed to parse version from output: ${versionOutput.trim()}. Expected format: "psql (PostgreSQL) MM.mm[.pp]"`
    );
  }

  const major = versionMatch[1];
  const minor = versionMatch[2];
  const patch = versionMatch[3] || "0"; // Default to 0 if patch not present

  // Validate version components are numeric
  if (!/^\d+$/.test(major) || !/^\d+$/.test(minor) || !/^\d+$/.test(patch)) {
    throw new Error(
      `Invalid version components extracted: major=${major}, minor=${minor}, patch=${patch}`
    );
  }

  return {
    major,
    minor,
    full: `${major}.${minor}.${patch}`,
    majorMinor: `${major}.${minor}`,
  };
}

async function extractVersion(imageRef: string): Promise<ParsedVersion> {
  try {
    // Run docker run --rm <image> psql --version
    info(`Extracting PostgreSQL version from image: ${imageRef}`);

    const result = await $`docker run --rm ${imageRef} psql --version`.nothrow().text();

    if (!result) {
      throw new Error("No output from psql --version command");
    }

    // Parse version from output
    const parsed = parseVersionString(result);

    info(`Detected PostgreSQL version: ${parsed.majorMinor} (full: ${parsed.full})`);

    return parsed;
  } catch (err) {
    const errorMsg = `Failed to extract version from image ${imageRef}: ${getErrorMessage(err)}`;
    error(errorMsg);
  }
}

function formatOutput(version: ParsedVersion, format: OutputFormat): string {
  switch (format) {
    case "major":
      return version.major;
    case "minor":
      return version.minor;
    case "full":
      return version.full;
    case "major.minor":
    default:
      return version.majorMinor;
  }
}

async function writeGithubOutput(version: ParsedVersion): Promise<void> {
  const githubOutput = Bun.env.GITHUB_OUTPUT;
  if (!githubOutput) {
    error("GITHUB_OUTPUT environment variable not set. Running outside GitHub Actions?");
    process.exit(1);
  }

  // Write all version components for convenience (concatenate first, then write once)
  const outputLines = `pg_version=${version.majorMinor}\npg_major=${version.major}\npg_minor=${version.minor}\n`;

  await Bun.write(githubOutput, outputLines, { append: true });

  success(
    `PostgreSQL version written to GITHUB_OUTPUT: pg_version=${version.majorMinor}, pg_major=${version.major}, pg_minor=${version.minor}`
  );
}

async function main(): Promise<void> {
  const options = parseArgs();

  // Check Docker availability first
  await checkDockerAvailable();

  try {
    // Extract version from image
    const version = await extractVersion(options.image);

    if (options.githubOutput) {
      // GitHub Actions output format
      await writeGithubOutput(version);
    } else {
      // Direct output for local use
      const output = formatOutput(version, options.outputFormat);
      console.log(output);
    }

    process.exit(0);
  } catch (err) {
    // Error already logged in extractVersion
    process.exit(1);
  }
}

main();
