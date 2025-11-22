#!/usr/bin/env bun

/**
 * Clean up ephemeral testing tags from aza-pg-testing repository after promotion
 *
 * This script deletes testing tags from ghcr.io/fluxo-kt/aza-pg-testing repository
 * after successful promotion to production, reducing storage costs and clutter.
 * Replaces inline `gh api` DELETE calls from publish.yml (lines 364-387).
 *
 * Usage:
 *   bun scripts/release/cleanup-testing-tags.ts --repository REPO --tags TAG1,TAG2,... [OPTIONS]
 *
 * Required options:
 *   --repository REPO     Repository to clean up (e.g., "fluxo-kt/aza-pg-testing")
 *   --tags CSV            Comma-separated list of tags to delete
 *
 * Optional flags:
 *   --dry-run             Show tags to delete without executing
 *   --continue-on-error   Continue deleting remaining tags if one fails
 *   --help                Show this help message
 *
 * Environment variables:
 *   GITHUB_TOKEN          Required for API authentication (gh CLI uses this)
 *   GITHUB_ACTIONS        Set to "true" to enable GitHub Actions annotations
 *
 * Examples:
 *   # Dry run - preview deletions
 *   bun scripts/release/cleanup-testing-tags.ts \
 *     --repository fluxo-kt/aza-pg-testing \
 *     --tags testing-18.1-202511142330-single-node \
 *     --dry-run
 *
 *   # Delete single tag after promotion
 *   bun scripts/release/cleanup-testing-tags.ts \
 *     --repository fluxo-kt/aza-pg-testing \
 *     --tags testing-18.1-202511142330-single-node
 *
 *   # Delete multiple tags with error tolerance
 *   bun scripts/release/cleanup-testing-tags.ts \
 *     --repository fluxo-kt/aza-pg-testing \
 *     --tags testing-18.1-amd64,testing-18.1-arm64,testing-18.1-202511142330 \
 *     --continue-on-error
 *
 *   # Usage in publish.yml after promotion
 *   - name: Clean up testing tags
 *     run: |
 *       bun scripts/release/cleanup-testing-tags.ts \
 *         --repository fluxo-kt/aza-pg-testing \
 *         --tags ${{ env.TESTING_TAG }} \
 *         --continue-on-error
 *
 * Exit codes:
 *   0 - All tags deleted successfully (or dry run)
 *   1 - Any deletion failed (unless --continue-on-error)
 *
 * API Details:
 *   - List versions: GET /orgs/{org}/packages/container/{package}/versions
 *   - Delete version: DELETE /orgs/{org}/packages/container/{package}/versions/{versionId}
 *   - Tags matched via metadata.container.tags array
 */

import { $ } from "bun";
import { error, success, info, warning } from "../utils/logger";
import { getErrorMessage } from "../utils/errors";

/**
 * Validate that GITHUB_TOKEN has required permissions
 * @returns true if permissions are sufficient, false otherwise
 */
async function validatePermissions(): Promise<boolean> {
  try {
    info("Validating GitHub token permissions...");

    // Check if gh CLI is authenticated
    const authResult = await $`gh auth status`.nothrow().quiet();
    if (authResult.exitCode !== 0) {
      error("GitHub CLI not authenticated");
      error("Ensure GITHUB_TOKEN is set and valid");
      return false;
    }

    // Try to list packages (requires packages:read at minimum)
    const listResult = await $`gh api /user/packages?package_type=container --jq 'length'`
      .nothrow()
      .quiet();
    if (listResult.exitCode !== 0) {
      warning("Could not validate package permissions");
      warning("Continuing anyway - cleanup may fail if permissions insufficient");
      return true; // Don't block on permission check failure
    }

    info("✓ GitHub token has package access");
    return true;
  } catch (err) {
    warning(`Permission validation failed: ${getErrorMessage(err)}`);
    warning("Continuing anyway - cleanup will fail explicitly if permissions insufficient");
    return true; // Don't block on validation errors
  }
}

/**
 * Execute command with exponential backoff retry
 * @param fn - Async function to execute
 * @param maxRetries - Maximum retry attempts (default: 3)
 * @param initialDelay - Initial delay in ms (default: 1000)
 * @returns Function result
 */
async function executeWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelay: number = 1000
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLastAttempt = attempt === maxRetries;

      if (isLastAttempt) {
        throw err;
      }

      const backoff = initialDelay * Math.pow(2, attempt - 1);
      warning(`Retry ${attempt}/${maxRetries} after ${backoff}ms: ${getErrorMessage(err)}`);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }

  throw new Error("Retry loop completed without success"); // Should never reach
}

interface Options {
  repository: string;
  tags: string[];
  dryRun: boolean;
  continueOnError: boolean;
}

interface PackageVersion {
  id: number;
  name: string;
  metadata: {
    container: {
      tags: string[];
    };
  };
}

function printHelp(): void {
  const helpText = `
Clean up ephemeral testing tags from aza-pg-testing repository

Usage:
  bun scripts/release/cleanup-testing-tags.ts --repository REPO --tags TAG1,TAG2,... [OPTIONS]

Required options:
  --repository REPO     Repository to clean up (e.g., "fluxo-kt/aza-pg-testing")
  --tags CSV            Comma-separated list of tags to delete

Optional flags:
  --dry-run             Show tags to delete without executing
  --continue-on-error   Continue deleting remaining tags if one fails
  --help                Show this help message

Environment:
  GITHUB_TOKEN          Required for API authentication
  GITHUB_ACTIONS        Set to "true" for GitHub Actions annotations

Examples:
  # Dry run - preview deletions
  bun scripts/release/cleanup-testing-tags.ts \\
    --repository fluxo-kt/aza-pg-testing \\
    --tags testing-18.1-202511142330-single-node \\
    --dry-run

  # Delete single tag after promotion
  bun scripts/release/cleanup-testing-tags.ts \\
    --repository fluxo-kt/aza-pg-testing \\
    --tags testing-18.1-202511142330-single-node

  # Delete multiple tags with error tolerance
  bun scripts/release/cleanup-testing-tags.ts \\
    --repository fluxo-kt/aza-pg-testing \\
    --tags testing-18.1-amd64,testing-18.1-arm64,testing-18.1-202511142330 \\
    --continue-on-error

  # Usage in publish.yml after promotion
  - name: Clean up testing tags
    run: |
      bun scripts/release/cleanup-testing-tags.ts \\
        --repository fluxo-kt/aza-pg-testing \\
        --tags \${{ env.TESTING_TAG }} \\
        --continue-on-error

Exit codes:
  0 - All tags deleted successfully (or dry run)
  1 - Any deletion failed (unless --continue-on-error)
`;
  console.log(helpText.trim());
}

function parseArgs(): Options {
  const args = Bun.argv.slice(2);

  const options: Options = {
    repository: "",
    tags: [],
    dryRun: false,
    continueOnError: false,
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
        {
          const value = args[i + 1];
          if (!value) {
            error("--repository requires an argument");
            process.exit(1);
          }
          options.repository = value;
        }
        i++;
        break;

      case "--tags":
        if (i + 1 >= args.length) {
          error("--tags requires a comma-separated list");
          process.exit(1);
        }
        {
          const value = args[i + 1];
          if (!value) {
            error("--tags requires a comma-separated list");
            process.exit(1);
          }
          // Parse comma-separated tags and filter out empty strings
          options.tags = value
            .split(",")
            .map((tag) => tag.trim())
            .filter((tag) => tag.length > 0);
        }
        i++;
        break;

      case "--dry-run":
        options.dryRun = true;
        break;

      case "--continue-on-error":
        options.continueOnError = true;
        break;

      default:
        error(`Unknown option: ${arg}`);
        printHelp();
        process.exit(1);
    }
  }

  // Validate required options
  if (!options.repository) {
    error("--repository is required");
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

function parseRepository(repo: string): { org: string; package: string } {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    error(`Invalid repository format: ${repo} (expected "owner/repo")`);
    process.exit(1);
  }
  return { org: parts[0], package: parts[1] };
}

async function checkGhCliAvailable(): Promise<void> {
  try {
    const result = await $`gh --version`.nothrow().quiet();
    if (result.exitCode !== 0) {
      error("GitHub CLI (gh) is not available");
      if (Bun.env.GITHUB_ACTIONS === "true") {
        console.log("::error::GitHub CLI (gh) is not available");
      }
      process.exit(1);
    }
  } catch (err) {
    error(`Failed to check gh CLI availability: ${getErrorMessage(err)}`);
    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.log(`::error::Failed to check gh CLI availability: ${getErrorMessage(err)}`);
    }
    process.exit(1);
  }
}

async function checkGhAuthentication(): Promise<void> {
  try {
    const result = await $`gh auth status`.nothrow().quiet();
    if (result.exitCode !== 0) {
      error("GitHub CLI is not authenticated. Run 'gh auth login' or set GITHUB_TOKEN");
      if (Bun.env.GITHUB_ACTIONS === "true") {
        console.log("::error::GitHub CLI is not authenticated");
      }
      process.exit(1);
    }
  } catch (err) {
    error(`Failed to check gh authentication: ${getErrorMessage(err)}`);
    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.log(`::error::Failed to check gh authentication: ${getErrorMessage(err)}`);
    }
    process.exit(1);
  }
}

async function fetchPackageVersions(org: string, packageName: string): Promise<PackageVersion[]> {
  return executeWithRetry(
    async () => {
      try {
        const apiPath = `/orgs/${org}/packages/container/${packageName}/versions`;
        const result = await $`gh api -H "Accept: application/vnd.github+json" ${apiPath}`
          .nothrow()
          .quiet();

        if (result.exitCode !== 0) {
          const stderr = result.stderr.toString().trim();

          // Handle rate limiting (HTTP 429)
          if (stderr.includes("429") || stderr.includes("rate limit")) {
            throw new Error("GitHub API rate limit exceeded. Try again later.");
          }

          // Handle not found (HTTP 404)
          if (stderr.includes("404") || stderr.includes("Not Found")) {
            throw new Error(`Package not found: ${org}/${packageName}`);
          }

          throw new Error(`GitHub API request failed: ${stderr}`);
        }

        const versions = JSON.parse(result.stdout.toString()) as PackageVersion[];
        return versions;
      } catch (err) {
        throw new Error(`Failed to fetch package versions: ${getErrorMessage(err)}`);
      }
    },
    3,
    2000
  ); // 3 retries, 2s initial delay
}

function findVersionIdByTag(versions: PackageVersion[], tag: string): number | null {
  for (const version of versions) {
    if (version.metadata?.container?.tags?.includes(tag)) {
      return version.id;
    }
  }
  return null;
}

async function deletePackageVersion(
  org: string,
  packageName: string,
  versionId: number,
  tag: string,
  dryRun: boolean
): Promise<void> {
  if (dryRun) {
    info(`[DRY RUN] Would delete tag: ${tag} (version ID: ${versionId})`);
    return;
  }

  return executeWithRetry(
    async () => {
      try {
        const apiPath = `/orgs/${org}/packages/container/${packageName}/versions/${versionId}`;
        const result = await $`gh api --method DELETE ${apiPath}`.nothrow().quiet();

        if (result.exitCode !== 0) {
          const stderr = result.stderr.toString().trim();

          // Handle rate limiting
          if (stderr.includes("429") || stderr.includes("rate limit")) {
            throw new Error("GitHub API rate limit exceeded");
          }

          throw new Error(`Failed to delete version: ${stderr}`);
        }

        success(`Deleted tag: ${tag} (version ID: ${versionId})`);

        // GitHub Actions annotation
        if (Bun.env.GITHUB_ACTIONS === "true") {
          console.log(`::notice::Deleted testing tag ${tag} from ${org}/${packageName}`);
        }
      } catch (err) {
        throw new Error(`Failed to delete tag ${tag}: ${getErrorMessage(err)}`);
      }
    },
    3,
    2000
  ); // 3 retries, 2s initial delay
}

async function cleanupTestingTags(options: Options): Promise<void> {
  const { repository, tags, dryRun, continueOnError } = options;

  // Parse repository into org/package
  const { org, package: packageName } = parseRepository(repository);

  // Verify gh CLI is available and authenticated
  await checkGhCliAvailable();
  await checkGhAuthentication();

  if (dryRun) {
    info("Running in DRY RUN mode - no deletions will be performed");
  }

  info(`Fetching package versions for ${org}/${packageName}...`);

  // Fetch all package versions
  const versions = await fetchPackageVersions(org, packageName);

  if (versions.length === 0) {
    warning(`No versions found for package ${org}/${packageName}`);
    return;
  }

  info(`Found ${versions.length} package version${versions.length !== 1 ? "s" : ""}`);

  // Track deletion results
  let successCount = 0;
  let failureCount = 0;
  const failures: Array<{ tag: string; error: string }> = [];

  // Process each tag
  for (const tag of tags) {
    try {
      // Find version ID for this tag
      const versionId = findVersionIdByTag(versions, tag);

      if (versionId === null) {
        warning(`Tag not found: ${tag} (may have been already deleted)`);
        if (!continueOnError) {
          failureCount++;
          failures.push({ tag, error: "Tag not found" });
        }
        continue;
      }

      // Delete the version
      await deletePackageVersion(org, packageName, versionId, tag, dryRun);
      successCount++;
    } catch (err) {
      const errMessage = getErrorMessage(err);
      error(`Failed to delete tag ${tag}: ${errMessage}`);

      if (Bun.env.GITHUB_ACTIONS === "true") {
        console.log(`::error::Failed to delete tag ${tag}: ${errMessage}`);
      }

      failureCount++;
      failures.push({ tag, error: errMessage });

      if (!continueOnError) {
        // Fail fast - exit on first error
        process.exit(1);
      }
    }
  }

  // Summary
  console.log(""); // Empty line for readability
  if (dryRun) {
    success(`[DRY RUN] Would delete ${successCount} tag${successCount !== 1 ? "s" : ""}`);
  } else {
    success(
      `Deleted ${successCount} of ${tags.length} tag${tags.length !== 1 ? "s" : ""} successfully`
    );
  }

  if (failureCount > 0) {
    error(`Failed to delete ${failureCount} tag${failureCount !== 1 ? "s" : ""}:`);
    for (const failure of failures) {
      error(`  - ${failure.tag}: ${failure.error}`);
    }

    if (!continueOnError && !dryRun) {
      process.exit(1);
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs();

  // Validate permissions before attempting cleanup
  const hasPermissions = await validatePermissions();
  if (!hasPermissions && !options.dryRun) {
    error("Insufficient permissions for cleanup operation");
    error("Add 'packages: write' to workflow permissions");
    process.exit(1);
  }

  try {
    await cleanupTestingTags(options);
  } catch (err) {
    error(`Unexpected error: ${getErrorMessage(err)}`);
    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.log(`::error::Unexpected error: ${getErrorMessage(err)}`);
    }
    process.exit(1);
  }
}

main();
