#!/usr/bin/env bun

/**
 * Tag local Docker image with multiple tags for multi-arch builds
 *
 * This script tags a local Docker image with one or more additional tags,
 * reducing workflow boilerplate by allowing multiple tags in a single command.
 * Replaces 6 duplicate `docker tag` blocks across build-postgres-image.yml
 * (lines 453-459, 466-472) and publish.yml (lines 241-258).
 *
 * Usage:
 *   bun scripts/docker/tag-local-image.ts --source REF --tags TAG1,TAG2,... [OPTIONS]
 *
 * Required options:
 *   --source REF          Source image reference (must exist locally)
 *   --tags CSV            Comma-separated list of target tags
 *
 * Optional options:
 *   --registry HOST       Registry host prefix (default: ghcr.io)
 *   --repository PATH     Repository path (default: fluxo-kt/aza-pg)
 *   --verify              Verify source image exists before tagging
 *   --help                Show this help message
 *
 * Examples:
 *   # Tag local buildx output with multiple tags
 *   bun scripts/docker/tag-local-image.ts \
 *     --source localhost:5000/aza-pg:cache \
 *     --tags 18-single-node,18.1-single-node,18.1-202511142330-single-node
 *
 *   # Tag with custom registry/repository
 *   bun scripts/docker/tag-local-image.ts \
 *     --source myimage:latest \
 *     --tags v1.0,v1 \
 *     --registry myregistry.io \
 *     --repository myorg/myapp
 *
 *   # Tag with verification enabled
 *   bun scripts/docker/tag-local-image.ts \
 *     --source postgres:18 \
 *     --tags local-pg,pg-dev \
 *     --verify
 *
 * Exit codes:
 *   0 - All tags succeeded
 *   1 - Any tag failed (fail fast on first error)
 */

import { $ } from "bun";
import { error, success, info } from "../utils/logger.js";
import { getErrorMessage } from "../utils/errors.js";

interface Options {
  source: string;
  tags: string[];
  registry: string;
  repository: string;
  verify: boolean;
}

function printHelp(): void {
  const helpText = `
Tag local Docker image with multiple tags for multi-arch builds

Usage:
  bun scripts/docker/tag-local-image.ts --source REF --tags TAG1,TAG2,... [OPTIONS]

Required options:
  --source REF          Source image reference (must exist locally)
  --tags CSV            Comma-separated list of target tags

Optional options:
  --registry HOST       Registry host prefix (default: ghcr.io)
  --repository PATH     Repository path (default: fluxo-kt/aza-pg)
  --verify              Verify source image exists before tagging
  --help                Show this help message

Examples:
  # Tag local buildx output with multiple tags
  bun scripts/docker/tag-local-image.ts \\
    --source localhost:5000/aza-pg:cache \\
    --tags 18-single-node,18.1-single-node,18.1-202511142330-single-node

  # Tag with custom registry/repository
  bun scripts/docker/tag-local-image.ts \\
    --source myimage:latest \\
    --tags v1.0,v1 \\
    --registry myregistry.io \\
    --repository myorg/myapp

  # Tag with verification enabled
  bun scripts/docker/tag-local-image.ts \\
    --source postgres:18 \\
    --tags local-pg,pg-dev \\
    --verify

Exit codes:
  0 - All tags succeeded
  1 - Any tag failed (fail fast on first error)
`;
  console.log(helpText.trim());
}

function parseArgs(): Options {
  const args = Bun.argv.slice(2);

  const options: Options = {
    source: "",
    tags: [],
    registry: "ghcr.io",
    repository: "fluxo-kt/aza-pg",
    verify: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;

      case "--source":
        if (i + 1 >= args.length) {
          error("--source requires an argument");
          process.exit(1);
        }
        options.source = args[i + 1];
        i++;
        break;

      case "--tags":
        if (i + 1 >= args.length) {
          error("--tags requires a comma-separated list");
          process.exit(1);
        }
        // Parse comma-separated tags and filter out empty strings
        options.tags = args[i + 1]
          .split(",")
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0);
        i++;
        break;

      case "--registry":
        if (i + 1 >= args.length) {
          error("--registry requires an argument");
          process.exit(1);
        }
        options.registry = args[i + 1];
        i++;
        break;

      case "--repository":
        if (i + 1 >= args.length) {
          error("--repository requires an argument");
          process.exit(1);
        }
        options.repository = args[i + 1];
        i++;
        break;

      case "--verify":
        options.verify = true;
        break;

      default:
        error(`Unknown option: ${arg}`);
        printHelp();
        process.exit(1);
    }
  }

  // Validate required options
  if (!options.source) {
    error("--source is required");
    printHelp();
    process.exit(1);
  }

  if (options.tags.length === 0) {
    error("--tags is required and must contain at least one tag");
    printHelp();
    process.exit(1);
  }

  return options;
}

async function checkDockerAvailable(): Promise<void> {
  try {
    const result = await $`docker --version`.nothrow().quiet();
    if (result.exitCode !== 0) {
      error("Docker is not available or not running");
      if (Bun.env.GITHUB_ACTIONS === "true") {
        console.log("::error::Docker is not available or not running");
      }
      process.exit(1);
    }
  } catch (err) {
    error(`Failed to check Docker availability: ${getErrorMessage(err)}`);
    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.log(`::error::Failed to check Docker availability: ${getErrorMessage(err)}`);
    }
    process.exit(1);
  }
}

async function verifySourceExists(source: string): Promise<void> {
  try {
    info(`Verifying source image exists: ${source}`);
    const result = await $`docker image inspect ${source}`.nothrow().quiet();

    if (result.exitCode !== 0) {
      error(`Source image not found: ${source}`);
      if (Bun.env.GITHUB_ACTIONS === "true") {
        console.log(`::error::Source image not found: ${source}`);
      }
      process.exit(1);
    }

    success("Source image verified");
  } catch (err) {
    error(`Failed to verify source image: ${getErrorMessage(err)}`);
    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.log(`::error::Failed to verify source image: ${getErrorMessage(err)}`);
    }
    process.exit(1);
  }
}

async function tagImage(source: string, target: string): Promise<void> {
  try {
    info(`Tagging ${source} -> ${target}`);
    const result = await $`docker tag ${source} ${target}`.nothrow();

    if (result.exitCode !== 0) {
      error(`Failed to tag image: ${target}`);
      if (Bun.env.GITHUB_ACTIONS === "true") {
        console.log(`::error::Failed to tag image ${target}`);
      }
      // Fail fast on first error
      process.exit(1);
    }

    success(`Tagged: ${target}`);
  } catch (err) {
    error(`Failed to tag ${target}: ${getErrorMessage(err)}`);
    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.log(`::error::Failed to tag ${target}: ${getErrorMessage(err)}`);
    }
    process.exit(1);
  }
}

async function tagLocalImage(options: Options): Promise<void> {
  const { source, tags, registry, repository, verify } = options;

  // Check Docker availability
  await checkDockerAvailable();

  // Verify source image exists if requested
  if (verify) {
    await verifySourceExists(source);
  }

  // Tag each target sequentially (fail fast on first error)
  info(`Tagging ${tags.length} target tag${tags.length !== 1 ? "s" : ""} from source: ${source}`);

  for (const tag of tags) {
    // Build full image reference: ${registry}/${repository}:${tag}
    const targetRef = `${registry}/${repository}:${tag}`;
    await tagImage(source, targetRef);
  }

  success(`Successfully tagged all ${tags.length} target${tags.length !== 1 ? "s" : ""}`);
}

async function main(): Promise<void> {
  const options = parseArgs();

  try {
    await tagLocalImage(options);
  } catch (err) {
    error(`Unexpected error: ${getErrorMessage(err)}`);
    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.log(`::error::Unexpected error: ${getErrorMessage(err)}`);
    }
    process.exit(1);
  }
}

main();
