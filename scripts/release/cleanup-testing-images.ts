#!/usr/bin/env bun

import { appendFile } from "node:fs/promises";

/**
 * Unified cleanup script for GHCR testing images
 *
 * Consolidates cleanup-testing-tags.ts and cleanup-old-testing-tags.ts into
 * a single script with multiple selection modes. Fixes pagination bug and
 * provides consistent retry logic.
 *
 * Selection modes (mutually exclusive):
 *   --tags TAG1,TAG2      Delete specific tags by name
 *   --older-than N        Delete tags older than N days (0 = all)
 *   --keep-last N         Keep N newest tags, delete rest
 *
 * Common options:
 *   --repository REPO     Target repository (default: fluxo-kt/aza-pg-testing)
 *   --pattern PATTERN     Tag pattern for retention modes (default: *)
 *   --dry-run             Preview deletions without executing
 *   --continue-on-error   Don't stop on individual failures
 *   --list                Show all tags with creation dates
 *   --help                Show help
 *
 * Examples:
 *   # Delete specific tags (post-promotion cleanup)
 *   bun scripts/release/cleanup-testing-images.ts --tags testing-abc123
 *
 *   # Delete tags older than 2 days (scheduled cleanup)
 *   bun scripts/release/cleanup-testing-images.ts --older-than 2
 *
 *   # Delete ALL matching tags (recovery mode)
 *   bun scripts/release/cleanup-testing-images.ts --older-than 0
 *
 *   # Keep only last 10 tags
 *   bun scripts/release/cleanup-testing-images.ts --keep-last 10
 *
 *   # List all testing tags
 *   bun scripts/release/cleanup-testing-images.ts --list
 *
 * Exit codes:
 *   0 - Success (or dry run/list mode)
 *   1 - Any deletion failed (unless --continue-on-error)
 */

import { $ } from "bun";
import { error, success, info, warning } from "../utils/logger";
import { getErrorMessage } from "../utils/errors";

// ============================================================================
// Types
// ============================================================================

interface CleanupOptions {
  repository: string;
  // Selection mode (mutually exclusive)
  tags?: string[];
  olderThan?: number;
  keepLast?: number;
  // Filtering
  pattern: string;
  // Behavior
  dryRun: boolean;
  continueOnError: boolean;
  listOnly: boolean;
}

interface PackageVersion {
  id: number;
  name: string;
  created_at: string;
  metadata: {
    container: {
      tags: string[];
    };
  };
}

interface TagInfo {
  tag: string;
  versionId: number;
  createdAt: Date;
  ageDays: number;
}

// ============================================================================
// CLI Argument Parsing
// ============================================================================

function printHelp(): void {
  const help = `
Unified cleanup script for GHCR testing images

Usage:
  bun scripts/release/cleanup-testing-images.ts [OPTIONS]

Selection modes (mutually exclusive):
  --tags TAG1,TAG2      Delete specific tags by name
  --older-than N        Delete tags older than N days (0 = delete ALL)
  --keep-last N         Keep N newest tags, delete rest

Common options:
  --repository REPO     Target repository (default: fluxo-kt/aza-pg-testing)
  --pattern PATTERN     Tag pattern for retention modes (default: *)
  --dry-run             Preview deletions without executing
  --continue-on-error   Don't stop on individual failures
  --list                Show all tags with creation dates
  --help                Show this help

Examples:
  # Delete specific tags (post-promotion cleanup)
  bun scripts/release/cleanup-testing-images.ts --tags testing-abc123

  # Delete tags older than 2 days (scheduled cleanup)
  bun scripts/release/cleanup-testing-images.ts --older-than 2

  # Delete ALL matching tags (recovery mode)
  bun scripts/release/cleanup-testing-images.ts --older-than 0

  # Keep only last 10 tags
  bun scripts/release/cleanup-testing-images.ts --keep-last 10

  # List all testing tags
  bun scripts/release/cleanup-testing-images.ts --list

Exit codes:
  0 - Success (or dry run/list mode)
  1 - Any deletion failed (unless --continue-on-error)
`.trim();
  console.log(help);
}

function parseArgs(): CleanupOptions {
  const args = Bun.argv.slice(2);

  const options: CleanupOptions = {
    repository: "fluxo-kt/aza-pg-testing",
    pattern: "*",
    dryRun: false,
    continueOnError: false,
    listOnly: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;

      case "--repository": {
        const value = args[++i];
        if (!value) {
          error("--repository requires an argument");
          process.exit(1);
        }
        options.repository = value;
        break;
      }

      case "--tags": {
        const value = args[++i];
        if (!value) {
          error("--tags requires comma-separated tag names");
          process.exit(1);
        }
        options.tags = value
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        break;
      }

      case "--older-than": {
        const value = args[++i];
        if (!value) {
          error("--older-than requires a number (days)");
          process.exit(1);
        }
        const days = parseFloat(value);
        if (isNaN(days) || days < 0) {
          error(`Invalid --older-than value: ${value} (must be >= 0)`);
          process.exit(1);
        }
        options.olderThan = days;
        break;
      }

      case "--keep-last": {
        const value = args[++i];
        if (!value) {
          error("--keep-last requires a number");
          process.exit(1);
        }
        const count = parseInt(value, 10);
        if (isNaN(count) || count < 0) {
          error(`Invalid --keep-last value: ${value} (must be >= 0)`);
          process.exit(1);
        }
        options.keepLast = count;
        break;
      }

      case "--pattern": {
        const value = args[++i];
        if (!value) {
          error("--pattern requires a glob pattern");
          process.exit(1);
        }
        options.pattern = value;
        break;
      }

      case "--dry-run":
        options.dryRun = true;
        break;

      case "--continue-on-error":
        options.continueOnError = true;
        break;

      case "--list":
        options.listOnly = true;
        break;

      default:
        error(`Unknown option: ${arg}`);
        printHelp();
        process.exit(1);
    }
  }

  // Validate mutual exclusivity
  const modeCount = [options.tags, options.olderThan, options.keepLast].filter(
    (x) => x !== undefined
  ).length;

  if (modeCount > 1) {
    error("--tags, --older-than, and --keep-last are mutually exclusive");
    process.exit(1);
  }

  // Require a mode unless listing
  if (!options.listOnly && modeCount === 0) {
    error("Specify a selection mode: --tags, --older-than, or --keep-last");
    printHelp();
    process.exit(1);
  }

  return options;
}

// ============================================================================
// GitHub API Utilities
// ============================================================================

function parseRepository(repo: string): { org: string; packageName: string } {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    error(`Invalid repository format: ${repo} (expected "owner/repo")`);
    process.exit(1);
  }
  return { org: parts[0], packageName: parts[1] };
}

async function checkGhCli(): Promise<void> {
  const result = await $`gh --version`.nothrow().quiet();
  if (result.exitCode !== 0) {
    error("GitHub CLI (gh) is not available");
    process.exit(1);
  }

  const authResult = await $`gh auth status`.nothrow().quiet();
  if (authResult.exitCode !== 0) {
    error("GitHub CLI is not authenticated. Set GITHUB_TOKEN or run 'gh auth login'");
    process.exit(1);
  }
}

/**
 * Execute function with exponential backoff retry
 */
async function executeWithRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; initialDelayMs?: number; operation?: string } = {}
): Promise<T> {
  const { maxRetries = 3, initialDelayMs = 1000, operation = "operation" } = options;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const errMsg = getErrorMessage(err);

      // Check for rate limit (HTTP 429) - use longer backoff
      const isRateLimit = errMsg.includes("429") || errMsg.includes("rate limit");
      const delay = isRateLimit ? 60000 : initialDelayMs * Math.pow(2, attempt - 1);

      if (attempt < maxRetries) {
        warning(
          `${operation} failed (attempt ${attempt}/${maxRetries}): ${errMsg}. Retrying in ${delay}ms...`
        );
        await Bun.sleep(delay);
      }
    }
  }

  throw lastError ?? new Error(`${operation} failed after ${maxRetries} attempts`);
}

/**
 * Fetch ALL package versions with pagination
 * Uses --paginate flag to get all pages automatically
 */
async function fetchAllPackageVersions(
  org: string,
  packageName: string
): Promise<PackageVersion[]> {
  const apiPath = `/orgs/${org}/packages/container/${packageName}/versions`;

  return executeWithRetry(
    async () => {
      // CRITICAL: Use --paginate to fetch ALL pages (fixes the 30-item limit bug)
      const result = await $`gh api --paginate -H "Accept: application/vnd.github+json" ${apiPath}`
        .nothrow()
        .quiet();

      if (result.exitCode !== 0) {
        const stderr = result.stderr.toString().trim();

        if (stderr.includes("429") || stderr.includes("rate limit")) {
          throw new Error("GitHub API rate limit exceeded");
        }
        if (stderr.includes("404") || stderr.includes("Not Found")) {
          throw new Error(`Package not found: ${org}/${packageName}`);
        }
        throw new Error(`GitHub API request failed: ${stderr}`);
      }

      // --paginate returns newline-separated JSON arrays, need to handle that
      const stdout = result.stdout.toString().trim();
      if (!stdout) {
        return [];
      }

      // Try parsing as single array first (small result)
      try {
        return JSON.parse(stdout) as PackageVersion[];
      } catch {
        // If that fails, it might be multiple JSON arrays from pagination
        // Concatenate them
        const versions: PackageVersion[] = [];
        for (const line of stdout.split("\n")) {
          if (line.trim()) {
            try {
              const parsed = JSON.parse(line);
              if (Array.isArray(parsed)) {
                versions.push(...parsed);
              } else {
                versions.push(parsed);
              }
            } catch {
              // Skip malformed lines
            }
          }
        }
        return versions;
      }
    },
    { operation: "Fetch package versions" }
  );
}

/**
 * Delete a package version by ID
 */
async function deletePackageVersion(
  org: string,
  packageName: string,
  versionId: number,
  tag: string,
  dryRun: boolean
): Promise<boolean> {
  if (dryRun) {
    info(`[DRY RUN] Would delete: ${tag} (version ID: ${versionId})`);
    return true;
  }

  return executeWithRetry(
    async () => {
      const apiPath = `/orgs/${org}/packages/container/${packageName}/versions/${versionId}`;
      const result = await $`gh api --method DELETE ${apiPath}`.nothrow().quiet();

      if (result.exitCode !== 0) {
        const stderr = result.stderr.toString().trim();

        if (stderr.includes("429") || stderr.includes("rate limit")) {
          throw new Error("GitHub API rate limit exceeded");
        }
        // 404 = already deleted, treat as success
        if (stderr.includes("404") || stderr.includes("Not Found")) {
          warning(`Tag already deleted: ${tag}`);
          return true;
        }
        // Check for "last version" error (misleading "5000 downloads" message)
        if (stderr.includes("5000 downloads") || stderr.includes("cannot be deleted")) {
          throw new Error("LAST_VERSION_PROTECTED");
        }
        throw new Error(`Failed to delete: ${stderr}`);
      }

      success(`Deleted: ${tag} (version ID: ${versionId})`);

      if (Bun.env.GITHUB_ACTIONS === "true") {
        console.log(`::notice::Deleted testing tag ${tag} from ${org}/${packageName}`);
      }

      return true;
    },
    { operation: `Delete ${tag}` }
  );
}

// ============================================================================
// Tag Selection Logic
// ============================================================================

function matchesPattern(tag: string, pattern: string): boolean {
  const regexPattern = pattern.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${regexPattern}$`).test(tag);
}

function extractTagsWithMetadata(versions: PackageVersion[], pattern: string): TagInfo[] {
  const now = new Date();
  const tags: TagInfo[] = [];

  for (const version of versions) {
    if (!version.metadata?.container?.tags) continue;

    const createdAt = new Date(version.created_at);
    const ageMs = now.getTime() - createdAt.getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24); // Decimal days for precision

    for (const tag of version.metadata.container.tags) {
      if (matchesPattern(tag, pattern)) {
        tags.push({ tag, versionId: version.id, createdAt, ageDays });
      }
    }
  }

  return tags;
}

function selectTagsForDeletion(
  allTags: TagInfo[],
  versions: PackageVersion[],
  options: CleanupOptions
): TagInfo[] {
  // Mode 1: Direct deletion by name
  if (options.tags) {
    const requestedSet = new Set(options.tags);
    const found: TagInfo[] = [];

    // Find version IDs for requested tags
    for (const version of versions) {
      if (!version.metadata?.container?.tags) continue;
      for (const tag of version.metadata.container.tags) {
        if (requestedSet.has(tag)) {
          found.push({
            tag,
            versionId: version.id,
            createdAt: new Date(version.created_at),
            ageDays: 0,
          });
        }
      }
    }

    // Warn about missing tags
    const foundSet = new Set(found.map((t) => t.tag));
    for (const requested of options.tags) {
      if (!foundSet.has(requested)) {
        warning(`Tag not found: ${requested}`);
      }
    }

    return found;
  }

  // Mode 2: Age-based retention
  if (options.olderThan !== undefined) {
    return allTags.filter((t) => t.ageDays > options.olderThan!);
  }

  // Mode 3: Count-based retention
  if (options.keepLast !== undefined) {
    // Sort by creation date (newest first)
    const sorted = [...allTags].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    // Delete everything after keepLast
    return sorted.slice(options.keepLast);
  }

  return [];
}

// ============================================================================
// Display Utilities
// ============================================================================

function formatAge(days: number): string {
  if (days < 0.042) return "just now"; // < 1 hour
  if (days < 1) return `${Math.round(days * 24)}h ago`;
  if (days < 7) return `${Math.floor(days)}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function printTagList(tags: TagInfo[]): void {
  if (tags.length === 0) {
    info("No matching tags found");
    return;
  }

  // Sort by creation date (newest first)
  const sorted = [...tags].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  console.log("\nTesting Tags:");
  console.log("=".repeat(90));
  console.log(`${"Tag".padEnd(55)} ${"Created".padEnd(22)} ${"Age".padEnd(10)}`);
  console.log("-".repeat(90));

  for (const t of sorted) {
    const created = t.createdAt.toISOString().replace("T", " ").slice(0, 19);
    console.log(`${t.tag.padEnd(55)} ${created.padEnd(22)} ${formatAge(t.ageDays)}`);
  }

  console.log("-".repeat(90));
  console.log(`Total: ${tags.length} tag${tags.length !== 1 ? "s" : ""}`);
  console.log("=".repeat(90));
}

// ============================================================================
// Delete All Versions (for --older-than 0)
// ============================================================================

async function deleteAllVersions(
  org: string,
  packageName: string,
  versions: PackageVersion[],
  options: CleanupOptions
): Promise<void> {
  let successCount = 0;
  let failureCount = 0;
  const failures: Array<{ name: string; error: string }> = [];
  let lastVersionProtectedCount = 0;

  for (const version of versions) {
    // Use first tag as identifier, or digest/name for untagged versions
    const identifier = version.metadata?.container?.tags?.[0] || version.name;

    try {
      await deletePackageVersion(org, packageName, version.id, identifier, options.dryRun);
      successCount++;
    } catch (err) {
      const errMessage = getErrorMessage(err);

      // Track "last version" errors separately (might be protection OR real error with >5000 downloads)
      if (errMessage.includes("LAST_VERSION_PROTECTED")) {
        lastVersionProtectedCount++;

        // If this is the first occurrence, treat as "last version" protection
        if (lastVersionProtectedCount === 1) {
          info(`Retained: ${identifier} (last version cannot be deleted - GHCR limitation)`);
          successCount++; // Count as success, not failure
          continue;
        }

        // Multiple occurrences = real error (package actually has >5000 downloads)
        warning(
          `Multiple versions failing with "5000 downloads" error - likely real download limit, not last-version protection`
        );
      }

      // Real errors (or second+ "last version" error)
      error(`Failed to delete ${identifier}: ${errMessage}`);

      if (Bun.env.GITHUB_ACTIONS === "true") {
        console.log(`::error::Failed to delete version ${identifier}: ${errMessage}`);
      }

      failureCount++;
      failures.push({ name: identifier, error: errMessage });

      if (!options.continueOnError) {
        process.exit(1);
      }
    }
  }

  // Summary
  console.log("");

  const retainedCount = versions.length - successCount - failureCount;

  if (options.dryRun) {
    success(`[DRY RUN] Would delete ${versions.length} version${versions.length !== 1 ? "s" : ""}`);
  } else if (failureCount === 0 && retainedCount === 1) {
    success(
      `Deleted ${successCount} version${successCount !== 1 ? "s" : ""} (1 retained - GHCR limitation)`
    );
  } else if (failureCount === 0) {
    success(`Deleted ${successCount} version${successCount !== 1 ? "s" : ""}`);
  } else {
    success(
      `Deleted ${successCount} of ${versions.length} version${versions.length !== 1 ? "s" : ""}`
    );
    error(`Failed to delete ${failureCount} version${failureCount !== 1 ? "s" : ""}:`);
    for (const f of failures) {
      error(`  - ${f.name}: ${f.error}`);
    }
  }

  // Write to GitHub Actions step summary
  if (Bun.env.GITHUB_ACTIONS === "true" && Bun.env.GITHUB_STEP_SUMMARY) {
    const summary: string[] = [];
    summary.push("### 🧹 Cleanup Results (Delete All)\n");
    summary.push(`| Metric | Count |`);
    summary.push(`|--------|-------|`);
    summary.push(`| Versions to delete | ${versions.length} |`);
    summary.push(`| Versions deleted | ${successCount} |`);
    if (retainedCount > 0) {
      summary.push(`| Retained (GHCR limit) | ${retainedCount} |`);
    }
    summary.push(`| Failed | ${failureCount} |`);
    if (options.dryRun) {
      summary.push(`\n**Mode**: Dry run (no actual deletions)`);
    }
    if (failureCount > 0) {
      summary.push(`\n**Failed versions**:`);
      for (const f of failures) {
        summary.push(`- \`${f.name}\`: ${f.error}`);
      }
    }
    summary.push("");

    try {
      await appendFile(Bun.env.GITHUB_STEP_SUMMARY, summary.join("\n") + "\n");
    } catch {
      // Ignore summary write errors
    }
  }

  if (failureCount > 0 && !options.continueOnError) {
    process.exit(1);
  }
}

// ============================================================================
// Main Cleanup Logic
// ============================================================================

async function cleanup(options: CleanupOptions): Promise<void> {
  const { org, packageName } = parseRepository(options.repository);

  await checkGhCli();

  if (options.dryRun && !options.listOnly) {
    info("Running in DRY RUN mode - no deletions will be performed");
  }

  info(`Fetching package versions for ${org}/${packageName}...`);

  const versions = await fetchAllPackageVersions(org, packageName);

  if (versions.length === 0) {
    warning(`No versions found for package ${org}/${packageName}`);
    return;
  }

  info(`Found ${versions.length} package version${versions.length !== 1 ? "s" : ""}`);

  // Special case: --older-than 0 means delete ALL versions (tagged + untagged)
  if (options.olderThan === 0) {
    info(
      `Deleting ALL ${versions.length} version${versions.length !== 1 ? "s" : ""} (--older-than 0)`
    );
    await deleteAllVersions(org, packageName, versions, options);
    return;
  }

  // Extract tags matching pattern
  const allTags = extractTagsWithMetadata(versions, options.pattern);

  if (allTags.length === 0) {
    info(`No tags matching pattern "${options.pattern}" found`);
    return;
  }

  info(
    `Found ${allTags.length} tag${allTags.length !== 1 ? "s" : ""} matching "${options.pattern}"`
  );

  // List mode - show all tags and exit
  if (options.listOnly) {
    printTagList(allTags);
    return;
  }

  // Select tags for deletion
  const toDelete = selectTagsForDeletion(allTags, versions, options);

  if (toDelete.length === 0) {
    if (options.olderThan !== undefined) {
      success(`No tags older than ${options.olderThan} day${options.olderThan !== 1 ? "s" : ""}`);
    } else if (options.keepLast !== undefined) {
      success(`All ${allTags.length} tags are within keep-last ${options.keepLast} limit`);
    } else {
      success("No tags to delete");
    }
    return;
  }

  // Show what will be deleted
  if (options.olderThan !== undefined) {
    info(
      `Deleting ${toDelete.length} tag${toDelete.length !== 1 ? "s" : ""} older than ${options.olderThan} day${options.olderThan !== 1 ? "s" : ""}`
    );
  } else if (options.keepLast !== undefined) {
    info(
      `Deleting ${toDelete.length} tag${toDelete.length !== 1 ? "s" : ""} (keeping last ${options.keepLast})`
    );
  } else if (options.tags) {
    info(`Deleting ${toDelete.length} specified tag${toDelete.length !== 1 ? "s" : ""}`);
  }

  // Delete tags (pattern * includes .sig tags, so no separate signature handling needed)
  let successCount = 0;
  let failureCount = 0;
  const failures: Array<{ tag: string; error: string }> = [];

  for (const tagInfo of toDelete) {
    try {
      await deletePackageVersion(org, packageName, tagInfo.versionId, tagInfo.tag, options.dryRun);
      successCount++;
    } catch (err) {
      const errMessage = getErrorMessage(err);
      error(`Failed to delete ${tagInfo.tag}: ${errMessage}`);

      if (Bun.env.GITHUB_ACTIONS === "true") {
        console.log(`::error::Failed to delete tag ${tagInfo.tag}: ${errMessage}`);
      }

      failureCount++;
      failures.push({ tag: tagInfo.tag, error: errMessage });

      if (!options.continueOnError) {
        process.exit(1);
      }
    }
  }

  // Summary (pattern * includes .sig tags, counted as regular tags)
  console.log("");

  const deletedCount = successCount;

  if (options.dryRun) {
    success(`[DRY RUN] Would delete ${toDelete.length} tag${toDelete.length !== 1 ? "s" : ""}`);
  } else if (failureCount === 0) {
    success(`Deleted ${deletedCount} tag${deletedCount !== 1 ? "s" : ""}`);
  } else {
    success(`Deleted ${deletedCount} of ${toDelete.length} tag${toDelete.length !== 1 ? "s" : ""}`);
    error(`Failed to delete ${failureCount} tag${failureCount !== 1 ? "s" : ""}:`);
    for (const f of failures) {
      error(`  - ${f.tag}: ${f.error}`);
    }
  }

  // Write to GitHub Actions step summary
  if (Bun.env.GITHUB_ACTIONS === "true" && Bun.env.GITHUB_STEP_SUMMARY) {
    const summary: string[] = [];
    summary.push("### 🧹 Cleanup Results\n");
    summary.push(`| Metric | Count |`);
    summary.push(`|--------|-------|`);
    summary.push(`| Tags to delete | ${toDelete.length} |`);
    summary.push(`| Tags deleted | ${deletedCount} |`);
    summary.push(`| Failed | ${failureCount} |`);
    if (options.dryRun) {
      summary.push(`\n**Mode**: Dry run (no actual deletions)`);
    }
    if (failureCount > 0) {
      summary.push(`\n**Failed tags**:`);
      for (const f of failures) {
        summary.push(`- \`${f.tag}\`: ${f.error}`);
      }
    }
    summary.push("");

    try {
      await appendFile(Bun.env.GITHUB_STEP_SUMMARY, summary.join("\n") + "\n");
    } catch {
      // Ignore summary write errors
    }
  }

  if (failureCount > 0 && !options.continueOnError) {
    process.exit(1);
  }
}

// ============================================================================
// Entry Point
// ============================================================================

async function main(): Promise<void> {
  const options = parseArgs();

  try {
    await cleanup(options);
  } catch (err) {
    error(`Unexpected error: ${getErrorMessage(err)}`);
    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.log(`::error::Unexpected error: ${getErrorMessage(err)}`);
    }
    process.exit(1);
  }
}

main();
