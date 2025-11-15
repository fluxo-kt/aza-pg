#!/usr/bin/env bun

/**
 * Pull Docker image with retry and exponential backoff
 *
 * This script pulls a Docker image with configurable retry logic and exponential
 * backoff delays, matching the workflow pattern used across multiple workflows.
 *
 * Usage:
 *   bun scripts/docker/pull-with-retry.ts --image IMAGE [OPTIONS]
 *
 * Options:
 *   --image IMAGE         Docker image to pull (required)
 *   --max-retries N       Maximum retry attempts (default: 3)
 *   --initial-delay N     Initial delay in seconds (default: 5)
 *   --quiet               Suppress progress output
 *   --help                Show this help message
 *
 * Examples:
 *   # Pull with defaults (3 retries, 5s initial delay)
 *   bun scripts/docker/pull-with-retry.ts --image postgres:18
 *
 *   # Custom retry settings
 *   bun scripts/docker/pull-with-retry.ts --image ghcr.io/org/image:tag --max-retries 5 --initial-delay 10
 *
 * Exit codes:
 *   0 - Image pulled successfully
 *   1 - Failed to pull image after all retry attempts
 */

import { $ } from "bun";
import { error, success, warning, info } from "../utils/logger.js";
import { getErrorMessage } from "../utils/errors.js";

interface Options {
  image: string;
  maxRetries: number;
  initialDelay: number;
  quiet: boolean;
}

function printHelp(): void {
  const helpText = `
Pull Docker image with retry and exponential backoff

Usage:
  bun scripts/docker/pull-with-retry.ts --image IMAGE [OPTIONS]

Options:
  --image IMAGE         Docker image to pull (required)
  --max-retries N       Maximum retry attempts (default: 3)
  --initial-delay N     Initial delay in seconds (default: 5)
  --quiet               Suppress progress output
  --help                Show this help message

Examples:
  bun scripts/docker/pull-with-retry.ts --image postgres:18
  bun scripts/docker/pull-with-retry.ts --image ghcr.io/org/image:tag --max-retries 5
`;
  console.log(helpText.trim());
}

function parseArgs(): Options {
  const args = Bun.argv.slice(2);

  const options: Options = {
    image: "",
    maxRetries: 3,
    initialDelay: 5,
    quiet: false,
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

      case "--max-retries":
        if (i + 1 >= args.length) {
          error("--max-retries requires a number");
          process.exit(1);
        }
        const maxRetries = parseInt(args[i + 1], 10);
        if (isNaN(maxRetries) || maxRetries < 1) {
          error("--max-retries must be a positive number");
          process.exit(1);
        }
        options.maxRetries = maxRetries;
        i++;
        break;

      case "--initial-delay":
        if (i + 1 >= args.length) {
          error("--initial-delay requires a number");
          process.exit(1);
        }
        const initialDelay = parseInt(args[i + 1], 10);
        if (isNaN(initialDelay) || initialDelay < 0) {
          error("--initial-delay must be a non-negative number");
          process.exit(1);
        }
        options.initialDelay = initialDelay;
        i++;
        break;

      case "--quiet":
      case "-q":
        options.quiet = true;
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

async function pullWithRetry(options: Options): Promise<void> {
  const { image, maxRetries, initialDelay, quiet } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (!quiet) {
        if (attempt === 1) {
          info(`Pulling Docker image: ${image}`);
        } else {
          info(`Pull attempt ${attempt} of ${maxRetries}...`);
        }
      }

      // Use Bun.$ to execute docker pull
      // nothrow() prevents automatic error throwing on non-zero exit
      const result = await $`docker pull ${image}`.nothrow();

      if (result.exitCode === 0) {
        if (!quiet) {
          success("Image pulled successfully");
        }
        return; // Success!
      }

      // Pull failed
      if (attempt < maxRetries) {
        // Calculate backoff delay (exponential: attempt * initialDelay)
        const delaySeconds = attempt * initialDelay;
        if (!quiet) {
          warning(`Pull attempt ${attempt} failed, retrying in ${delaySeconds} seconds...`);
        }

        // Sleep before retry
        await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
      } else {
        // Final attempt failed
        error(`Failed to pull image after ${maxRetries} attempts`);
        process.exit(1);
      }
    } catch (err) {
      // Unexpected error (e.g., docker command not found)
      error(`Unexpected error during pull: ${getErrorMessage(err)}`);
      process.exit(1);
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs();

  try {
    await pullWithRetry(options);
  } catch (err) {
    error(getErrorMessage(err));
    process.exit(1);
  }
}

main();
