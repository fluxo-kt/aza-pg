#!/usr/bin/env bun

/**
 * Clean up old testing tags from aza-pg-testing repository based on age or count
 *
 * This script implements retention policies for ephemeral testing tags:
 * - Delete tags older than N days (time-based retention)
 * - Keep only N most recent tags (count-based retention)
 * - List all testing tags with creation dates
 *
 * Complements cleanup-testing-tags.ts which deletes specific tags after promotion.
 * This script handles historical cleanup via scheduled workflows.
 *
 * Usage:
 *   bun scripts/release/cleanup-old-testing-tags.ts [OPTIONS]
 *
 * Retention options (mutually exclusive):
 *   --days N              Delete tags older than N days (default: 14)
 *   --keep-last N         Keep N most recent tags, delete rest
 *
 * Action options:
 *   --dry-run             Preview deletions without executing
 *   --list                Show all testing tags with creation dates
 *
 * Configuration:
 *   --repository REPO     Target repository (default: fluxo-kt/aza-pg-testing)
 *   --pattern PATTERN     Tag pattern to match (default: testing-*)
 *   --continue-on-error   Continue deleting remaining tags if one fails
 *   --help                Show this help message
 *
 * Environment variables:
 *   GITHUB_TOKEN          Required for API authentication (gh CLI uses this)
 *   GITHUB_ACTIONS        Set to "true" to enable GitHub Actions annotations
 *
 * Examples:
 *   # List all testing tags with creation dates
 *   bun scripts/release/cleanup-old-testing-tags.ts --list
 *
 *   # Dry run - preview tags older than 14 days
 *   bun scripts/release/cleanup-old-testing-tags.ts --days 14 --dry-run
 *
 *   # Delete tags older than 30 days
 *   bun scripts/release/cleanup-old-testing-tags.ts --days 30
 *
 *   # Keep only last 10 tags, delete rest
 *   bun scripts/release/cleanup-old-testing-tags.ts --keep-last 10
 *
 *   # Weekly cleanup in GitHub Actions (scheduled workflow)
 *   - name: Cleanup old testing images
 *     run: |
 *       bun scripts/release/cleanup-old-testing-tags.ts \
 *         --repository fluxo-kt/aza-pg-testing \
 *         --days 14 \
 *         --continue-on-error
 *
 * Exit codes:
 *   0 - All tags deleted successfully (or dry run/list mode)
 *   1 - Any deletion failed (unless --continue-on-error)
 *
 * API Details:
 *   - List versions: GET /orgs/{org}/packages/container/{package}/versions
 *   - Delete version: DELETE /orgs/{org}/packages/container/{package}/versions/{versionId}
 *   - Tags matched via metadata.container.tags array
 *   - Created timestamp via created_at field (ISO 8601 format)
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

interface Options {
  repository: string;
  pattern: string;
  days: number | null;
  keepLast: number | null;
  dryRun: boolean;
  listMode: boolean;
  continueOnError: boolean;
}

interface PackageVersion {
  id: number;
  name: string;
  created_at: string; // ISO 8601 timestamp
  metadata: {
    container: {
      tags: string[];
    };
  };
}

interface TagWithVersion {
  tag: string;
  versionId: number;
  createdAt: Date;
  age: number; // Age in days
}

function printHelp(): void {
  const helpText = `
Clean up old testing tags from aza-pg-testing repository

Usage:
  bun scripts/release/cleanup-old-testing-tags.ts [OPTIONS]

Retention options (mutually exclusive):
  --days N              Delete tags older than N days (default: 14)
  --keep-last N         Keep N most recent tags, delete rest

Action options:
  --dry-run             Preview deletions without executing
  --list                Show all testing tags with creation dates

Configuration:
  --repository REPO     Target repository (default: fluxo-kt/aza-pg-testing)
  --pattern PATTERN     Tag pattern to match (default: testing-*)
  --continue-on-error   Continue deleting remaining tags if one fails
  --help                Show this help message

Environment:
  GITHUB_TOKEN          Required for API authentication
  GITHUB_ACTIONS        Set to "true" for GitHub Actions annotations

Examples:
  # List all testing tags with creation dates
  bun scripts/release/cleanup-old-testing-tags.ts --list

  # Dry run - preview tags older than 14 days
  bun scripts/release/cleanup-old-testing-tags.ts --days 14 --dry-run

  # Delete tags older than 30 days
  bun scripts/release/cleanup-old-testing-tags.ts --days 30

  # Keep only last 10 tags, delete rest
  bun scripts/release/cleanup-old-testing-tags.ts --keep-last 10

  # Weekly cleanup in GitHub Actions
  bun scripts/release/cleanup-old-testing-tags.ts \\
    --repository fluxo-kt/aza-pg-testing \\
    --days 14 \\
    --continue-on-error

Exit codes:
  0 - All tags deleted successfully (or dry run/list mode)
  1 - Any deletion failed (unless --continue-on-error)
`;
  console.log(helpText.trim());
}

function parseArgs(): Options {
  const args = Bun.argv.slice(2);

  const options: Options = {
    repository: "fluxo-kt/aza-pg-testing",
    pattern: "testing-*",
    days: null,
    keepLast: null,
    dryRun: false,
    listMode: false,
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

      case "--pattern":
        if (i + 1 >= args.length) {
          error("--pattern requires an argument");
          process.exit(1);
        }
        {
          const value = args[i + 1];
          if (!value) {
            error("--pattern requires an argument");
            process.exit(1);
          }
          options.pattern = value;
        }
        i++;
        break;

      case "--days":
        if (i + 1 >= args.length) {
          error("--days requires a number");
          process.exit(1);
        }
        {
          const value = args[i + 1];
          if (!value) {
            error("--days requires a number");
            process.exit(1);
          }
          const days = parseInt(value, 10);
          if (isNaN(days) || days < 0) {
            error(`Invalid days value: ${value} (must be a non-negative number)`);
            process.exit(1);
          }
          options.days = days;
        }
        i++;
        break;

      case "--keep-last":
        if (i + 1 >= args.length) {
          error("--keep-last requires a number");
          process.exit(1);
        }
        {
          const value = args[i + 1];
          if (!value) {
            error("--keep-last requires a number");
            process.exit(1);
          }
          const keepLast = parseInt(value, 10);
          if (isNaN(keepLast) || keepLast < 0) {
            error(`Invalid keep-last value: ${value} (must be a non-negative number)`);
            process.exit(1);
          }
          options.keepLast = keepLast;
        }
        i++;
        break;

      case "--dry-run":
        options.dryRun = true;
        break;

      case "--list":
        options.listMode = true;
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

  // Validate mutually exclusive options
  if (options.days !== null && options.keepLast !== null) {
    error("--days and --keep-last are mutually exclusive (choose one retention policy)");
    process.exit(1);
  }

  // Set default retention policy if none specified (and not in list mode)
  if (!options.listMode && options.days === null && options.keepLast === null) {
    options.days = 14;
    info("Using default retention: 14 days (use --days or --keep-last to customize)");
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
}

function matchesPattern(tag: string, pattern: string): boolean {
  // Simple wildcard matching (testing-* → /^testing-/)
  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/\*/g, ".*") // * → .*
    .replace(/\?/g, "."); // ? → .

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(tag);
}

function extractTagsWithMetadata(versions: PackageVersion[], pattern: string): TagWithVersion[] {
  const tagsWithMetadata: TagWithVersion[] = [];
  const now = new Date();

  for (const version of versions) {
    if (!version.metadata?.container?.tags) {
      continue;
    }

    const createdAt = new Date(version.created_at);
    const ageMs = now.getTime() - createdAt.getTime();
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

    for (const tag of version.metadata.container.tags) {
      if (matchesPattern(tag, pattern)) {
        tagsWithMetadata.push({
          tag,
          versionId: version.id,
          createdAt,
          age: ageDays,
        });
      }
    }
  }

  return tagsWithMetadata;
}

function formatAge(days: number): string {
  if (days === 0) {
    return "today";
  } else if (days === 1) {
    return "1 day ago";
  } else if (days < 7) {
    return `${days} days ago`;
  } else if (days < 30) {
    const weeks = Math.floor(days / 7);
    return `${weeks} week${weeks !== 1 ? "s" : ""} ago`;
  } else if (days < 365) {
    const months = Math.floor(days / 30);
    return `${months} month${months !== 1 ? "s" : ""} ago`;
  } else {
    const years = Math.floor(days / 365);
    return `${years} year${years !== 1 ? "s" : ""} ago`;
  }
}

function printTagList(tags: TagWithVersion[]): void {
  if (tags.length === 0) {
    info("No matching tags found");
    return;
  }

  // Sort by creation date (newest first)
  const sortedTags = [...tags].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  console.log("\nTesting Tags:");
  console.log("=".repeat(80));
  console.log(`${"Tag".padEnd(50)} ${"Created".padEnd(20)} ${"Age".padEnd(10)}`);
  console.log("-".repeat(80));

  for (const tagInfo of sortedTags) {
    const createdStr = tagInfo.createdAt
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "");
    const ageStr = formatAge(tagInfo.age);
    console.log(`${tagInfo.tag.padEnd(50)} ${createdStr.padEnd(20)} ${ageStr}`);
  }

  console.log("-".repeat(80));
  console.log(`Total: ${tags.length} tag${tags.length !== 1 ? "s" : ""}`);
  console.log("=".repeat(80));
}

function selectTagsForDeletion(
  tags: TagWithVersion[],
  days: number | null,
  keepLast: number | null
): TagWithVersion[] {
  if (days !== null) {
    // Time-based retention: delete tags older than N days
    return tags.filter((tag) => tag.age > days);
  } else if (keepLast !== null) {
    // Count-based retention: keep N newest, delete rest
    // Sort by creation date (newest first)
    const sorted = [...tags].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return sorted.slice(keepLast); // Delete everything after keepLast
  }

  return [];
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

  try {
    const apiPath = `/orgs/${org}/packages/container/${packageName}/versions/${versionId}`;
    const result = await $`gh api --method DELETE ${apiPath}`.nothrow().quiet();

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim();

      // Handle rate limiting
      if (stderr.includes("429") || stderr.includes("rate limit")) {
        throw new Error("GitHub API rate limit exceeded");
      }

      // Handle 404 (version already deleted)
      if (stderr.includes("404") || stderr.includes("Not Found")) {
        warning(`Tag already deleted: ${tag} (version ID: ${versionId})`);
        return;
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
}

async function cleanupOldTestingTags(options: Options): Promise<void> {
  const { repository, pattern, days, keepLast, dryRun, listMode, continueOnError } = options;

  // Parse repository into org/package
  const { org, package: packageName } = parseRepository(repository);

  // Verify gh CLI is available and authenticated
  await checkGhCliAvailable();
  await checkGhAuthentication();

  if (dryRun && !listMode) {
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

  // Extract tags matching pattern with metadata
  const allTags = extractTagsWithMetadata(versions, pattern);

  if (allTags.length === 0) {
    info(`No tags matching pattern "${pattern}" found`);
    return;
  }

  info(
    `Found ${allTags.length} tag${allTags.length !== 1 ? "s" : ""} matching pattern "${pattern}"`
  );

  // List mode - show all tags and exit
  if (listMode) {
    printTagList(allTags);
    return;
  }

  // Select tags for deletion based on retention policy
  const tagsToDelete = selectTagsForDeletion(allTags, days, keepLast);

  if (tagsToDelete.length === 0) {
    let policyMsg = "";
    if (days !== null) {
      policyMsg = `older than ${days} day${days !== 1 ? "s" : ""}`;
    } else if (keepLast !== null) {
      policyMsg = `beyond the last ${keepLast} tag${keepLast !== 1 ? "s" : ""}`;
    }
    success(`No tags to delete ${policyMsg}`);
    return;
  }

  // Show retention policy
  if (days !== null) {
    info(`Retention policy: Delete tags older than ${days} day${days !== 1 ? "s" : ""}`);
  } else if (keepLast !== null) {
    info(`Retention policy: Keep last ${keepLast} tag${keepLast !== 1 ? "s" : ""}`);
  }

  info(
    `Found ${tagsToDelete.length} tag${tagsToDelete.length !== 1 ? "s" : ""} matching deletion criteria`
  );

  // Track deletion results
  let successCount = 0;
  let failureCount = 0;
  const failures: Array<{ tag: string; error: string }> = [];

  // Process each tag for deletion
  for (const tagInfo of tagsToDelete) {
    try {
      await deletePackageVersion(org, packageName, tagInfo.versionId, tagInfo.tag, dryRun);
      successCount++;

      // Also check for and delete associated signature artifact (.sig)
      const sigTag = `${tagInfo.tag}.sig`;
      const sigVersion = versions.find((v) => v.metadata?.container?.tags?.includes(sigTag));

      if (sigVersion) {
        try {
          await deletePackageVersion(org, packageName, sigVersion.id, sigTag, dryRun);
          successCount++;
        } catch (sigErr) {
          warning(`Failed to delete signature artifact ${sigTag}: ${getErrorMessage(sigErr)}`);
          // Don't fail the whole operation if signature deletion fails
        }
      }
    } catch (err) {
      const errMessage = getErrorMessage(err);
      error(`Failed to delete tag ${tagInfo.tag}: ${errMessage}`);

      if (Bun.env.GITHUB_ACTIONS === "true") {
        console.log(`::error::Failed to delete tag ${tagInfo.tag}: ${errMessage}`);
      }

      failureCount++;
      failures.push({ tag: tagInfo.tag, error: errMessage });

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
      `Deleted ${successCount} of ${tagsToDelete.length} tag${tagsToDelete.length !== 1 ? "s" : ""} successfully`
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
  if (!hasPermissions && !options.dryRun && !options.listMode) {
    error("Insufficient permissions for cleanup operation");
    error("Add 'packages: write' to workflow permissions");
    process.exit(1);
  }

  try {
    await cleanupOldTestingTags(options);
  } catch (err) {
    error(`Unexpected error: ${getErrorMessage(err)}`);
    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.log(`::error::Unexpected error: ${getErrorMessage(err)}`);
    }
    process.exit(1);
  }
}

main();
