#!/usr/bin/env bun

/**
 * Monitor GitHub Actions cache usage
 *
 * This script checks the current GitHub Actions cache usage via the GitHub API,
 * warns if approaching the 5GB limit, and optionally outputs to GitHub step summary.
 *
 * Usage:
 *   bun scripts/ci/monitor-cache-usage.ts [OPTIONS]
 *
 * Options:
 *   --repository REPO     Repository in format "owner/repo" (default: from GITHUB_REPOSITORY env)
 *   --platform PLATFORM   Platform name for step summary (e.g., "linux/amd64")
 *   --warning-threshold N Warn if usage exceeds N GB (default: 4)
 *   --github-summary      Output to GITHUB_STEP_SUMMARY (requires env var set)
 *   --quiet               Suppress informational output
 *   --help                Show this help message
 *
 * Environment variables:
 *   GITHUB_TOKEN          Required for API authentication
 *   GITHUB_REPOSITORY     Default repository (owner/repo format)
 *   GITHUB_STEP_SUMMARY   File path for GitHub Actions step summary output
 *
 * Examples:
 *   # Check cache usage (requires GITHUB_TOKEN)
 *   GITHUB_TOKEN=ghp_xxx bun scripts/ci/monitor-cache-usage.ts --repository fluxo-kt/aza-pg
 *
 *   # With GitHub summary output
 *   bun scripts/ci/monitor-cache-usage.ts --github-summary --platform "linux/amd64"
 *
 * Exit codes:
 *   0 - Success (regardless of cache usage level)
 *   1 - Error (missing token, API failure, invalid arguments)
 */

import { $ } from "bun";
import { error, success, warning, info } from "../utils/logger.js";
import { getErrorMessage } from "../utils/errors.js";

interface Options {
  repository: string;
  platform?: string;
  warningThreshold: number;
  githubSummary: boolean;
  quiet: boolean;
}

interface CacheUsageResponse {
  active_caches_count: number;
  active_caches_size_in_bytes: number;
}

function printHelp(): void {
  const helpText = `
Monitor GitHub Actions cache usage

Usage:
  bun scripts/ci/monitor-cache-usage.ts [OPTIONS]

Options:
  --repository REPO     Repository in format "owner/repo"
  --platform PLATFORM   Platform name for step summary
  --warning-threshold N Warn if usage exceeds N GB (default: 4)
  --github-summary      Output to GITHUB_STEP_SUMMARY
  --quiet               Suppress informational output
  --help                Show this help message

Environment:
  GITHUB_TOKEN          Required for API authentication
  GITHUB_REPOSITORY     Default repository
  GITHUB_STEP_SUMMARY   GitHub Actions summary file

Examples:
  GITHUB_TOKEN=xxx bun scripts/ci/monitor-cache-usage.ts --repository org/repo
  bun scripts/ci/monitor-cache-usage.ts --github-summary --platform "linux/amd64"
`;
  console.log(helpText.trim());
}

function parseArgs(): Options {
  const args = Bun.argv.slice(2);

  const options: Options = {
    repository: Bun.env.GITHUB_REPOSITORY || "",
    platform: undefined,
    warningThreshold: 4,
    githubSummary: false,
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

      case "--repository":
        if (i + 1 >= args.length) {
          error("--repository requires an argument");
          process.exit(1);
        }
        const repositoryValue = args[i + 1];
        if (!repositoryValue) {
          error("--repository requires an argument");
          process.exit(1);
        }
        options.repository = repositoryValue;
        i++;
        break;

      case "--platform":
        if (i + 1 >= args.length) {
          error("--platform requires an argument");
          process.exit(1);
        }
        const platformValue = args[i + 1];
        if (!platformValue) {
          error("--platform requires an argument");
          process.exit(1);
        }
        options.platform = platformValue;
        i++;
        break;

      case "--warning-threshold":
        if (i + 1 >= args.length) {
          error("--warning-threshold requires a number");
          process.exit(1);
        }
        const thresholdStr = args[i + 1];
        if (!thresholdStr) {
          error("--warning-threshold requires a number");
          process.exit(1);
        }
        const threshold = parseFloat(thresholdStr);
        if (isNaN(threshold) || threshold < 0) {
          error("--warning-threshold must be a non-negative number");
          process.exit(1);
        }
        options.warningThreshold = threshold;
        i++;
        break;

      case "--github-summary":
        options.githubSummary = true;
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
  if (!options.repository) {
    error("--repository is required (or set GITHUB_REPOSITORY environment variable)");
    process.exit(1);
  }

  return options;
}

async function fetchCacheUsage(repository: string): Promise<CacheUsageResponse> {
  // Check for GITHUB_TOKEN
  const token = Bun.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable not set. Required for GitHub API access.");
  }

  try {
    // Use gh CLI to access GitHub API (respects GITHUB_TOKEN env var)
    const result = await $`gh api repos/${repository}/actions/cache/usage`.nothrow();

    if (result.exitCode !== 0) {
      throw new Error(`GitHub API request failed: ${result.stderr.toString().trim()}`);
    }

    const response = JSON.parse(result.stdout.toString()) as CacheUsageResponse;
    return response;
  } catch (err) {
    throw new Error(`Failed to fetch cache usage: ${getErrorMessage(err)}`);
  }
}

function bytesToGB(bytes: number): string {
  return (bytes / 1073741824).toFixed(2);
}

async function main(): Promise<void> {
  const options = parseArgs();

  try {
    if (!options.quiet) {
      info("Checking GitHub Actions cache usage...");
    }

    const cacheData = await fetchCacheUsage(options.repository);
    const cacheBytes = cacheData.active_caches_size_in_bytes;
    const cacheGB = parseFloat(bytesToGB(cacheBytes));
    const cacheCount = cacheData.active_caches_count;

    if (!options.quiet) {
      console.log(`Current cache usage: ${cacheGB}GB (${cacheCount} active caches)`);
    }

    // Check if approaching limit (GitHub limit is 10GB total, but warn at configurable threshold)
    if (cacheGB > options.warningThreshold) {
      const warningMsg = `Cache usage (${cacheGB}GB) approaching GitHub limit (10GB)`;
      warning(warningMsg);

      // Output GitHub Actions warning annotation if in CI
      if (Bun.env.GITHUB_ACTIONS === "true") {
        console.log(`::warning::${warningMsg}`);
      }
    } else {
      if (!options.quiet) {
        success(`Cache usage is within healthy limits (${cacheGB}GB / 10GB)`);
      }
    }

    // Output to GitHub step summary if requested
    if (options.githubSummary) {
      const summaryFile = Bun.env.GITHUB_STEP_SUMMARY;
      if (!summaryFile) {
        error("GITHUB_STEP_SUMMARY environment variable not set. Running outside GitHub Actions?");
        process.exit(1);
      }

      const platformLabel = options.platform ? ` (${options.platform})` : "";
      const summaryLine = `### Cache Usage${platformLabel}: ${cacheGB}GB / 10GB\n`;

      // Read existing content if file exists, then append
      let existingContent = "";
      try {
        existingContent = await Bun.file(summaryFile).text();
      } catch {
        // File doesn't exist yet, that's okay
      }
      await Bun.write(summaryFile, existingContent + summaryLine);

      if (!options.quiet) {
        info("Cache usage written to GitHub step summary");
      }
    }
  } catch (err) {
    error(getErrorMessage(err));
    process.exit(1);
  }
}

main();
