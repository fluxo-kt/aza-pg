#!/usr/bin/env bun

// Bun-first: Helper to append to GitHub step summary using Bun APIs
async function appendToGitHubSummary(content: string): Promise<void> {
  const summaryPath = Bun.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const file = Bun.file(summaryPath);
  const existing = (await file.exists()) ? await file.text() : "";
  await Bun.write(summaryPath, existing + content);
}

/**
 * Unified cleanup script for GHCR testing images
 *
 * Consolidates cleanup functionality with proper handling of multi-arch orphans.
 *
 * Multi-arch builds create orphaned manifests (arch-specific images, SBOMs,
 * attestations) that have no tags. These accumulate when parent manifest lists
 * are deleted. This script properly cleans them up via age-based selection.
 *
 * Selection modes (mutually exclusive):
 *   --tags TAG1,TAG2      Delete specific tags by name
 *   --older-than N        Delete ALL versions older than N days (tagged + untagged)
 *   --keep-last N         Keep N newest tags + clean orphaned untagged
 *
 * Common options:
 *   --repository REPO     Target repository (default: fluxo-kt/aza-pg-testing)
 *   --pattern PATTERN     Tag pattern for --list mode only (default: *)
 *   --dry-run             Preview deletions without executing
 *   --continue-on-error   Don't stop on individual failures
 *   --list                Show all tags with creation dates (+ untagged count)
 *   --help                Show help
 *
 * Examples:
 *   # Delete specific tags (post-promotion cleanup)
 *   bun scripts/release/cleanup-testing-images.ts --tags testing-abc123
 *
 *   # Delete ALL versions older than 2 days (includes orphaned untagged)
 *   bun scripts/release/cleanup-testing-images.ts --older-than 2
 *
 *   # Delete ALL versions (full cleanup/recovery mode)
 *   bun scripts/release/cleanup-testing-images.ts --older-than 0
 *
 *   # Keep 10 newest tagged versions + clean orphaned untagged
 *   bun scripts/release/cleanup-testing-images.ts --keep-last 10
 *
 *   # List all tags (shows untagged count too)
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
  --older-than N        Delete ALL versions older than N days (0 = delete ALL)
                        Includes untagged orphans (arch manifests, SBOMs, attestations)
  --keep-last N         Keep N newest tags + their untagged dependencies

Common options:
  --repository REPO     Target repository (default: fluxo-kt/aza-pg-testing)
  --pattern PATTERN     Tag pattern for --list mode only (default: *)
  --dry-run             Preview deletions without executing
  --continue-on-error   Don't stop on individual failures
  --list                Show all tags with creation dates (+ untagged count)
  --help                Show this help

Multi-arch cleanup note:
  Multi-arch builds create untagged "orphan" versions (arch-specific manifests,
  SBOMs, attestations) that remain when parent tags are deleted. The --older-than
  and --keep-last modes now properly clean these up based on age.

Examples:
  # Delete specific tags (post-promotion cleanup)
  bun scripts/release/cleanup-testing-images.ts --tags testing-abc123

  # Delete ALL versions older than 2 days (includes orphaned untagged)
  bun scripts/release/cleanup-testing-images.ts --older-than 2

  # Delete ALL versions (full cleanup/recovery mode)
  bun scripts/release/cleanup-testing-images.ts --older-than 0

  # Keep 10 newest tagged versions + clean orphaned untagged
  bun scripts/release/cleanup-testing-images.ts --keep-last 10

  # List all tags (shows untagged count too)
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
        let skippedLines = 0;
        const lines = stdout.split("\n").filter((l) => l.trim());
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (Array.isArray(parsed)) {
              versions.push(...parsed);
            } else {
              versions.push(parsed);
            }
          } catch {
            skippedLines++;
          }
        }
        // Warn if significant parsing failures occurred
        if (skippedLines > 0 && versions.length === 0) {
          warning(`Failed to parse any of ${lines.length} pagination response lines`);
        } else if (skippedLines > 0) {
          warning(`Skipped ${skippedLines} malformed lines during pagination parsing`);
        }
        return versions;
      }
    },
    { operation: "Fetch package versions" }
  );
}

/**
 * Fetch package versions with retry logic for tag existence verification
 * Handles GitHub API eventual consistency when specific tags are requested
 */
async function fetchPackageVersionsWithTagRetry(
  org: string,
  packageName: string,
  requiredTags?: string[],
  maxRetries: number = 3
): Promise<PackageVersion[]> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const versions = await fetchAllPackageVersions(org, packageName);

    // If no specific tags required, return immediately
    if (!requiredTags || requiredTags.length === 0) {
      return versions;
    }

    // Check if all required tags are present
    const foundTags = new Set<string>();
    for (const version of versions) {
      if (version.metadata?.container?.tags) {
        for (const tag of version.metadata.container.tags) {
          foundTags.add(tag);
        }
      }
    }

    const missingTags = requiredTags.filter((tag) => !foundTags.has(tag));

    // All tags found, return immediately
    if (missingTags.length === 0) {
      return versions;
    }

    // Not last attempt - retry after exponential backoff
    if (attempt < maxRetries - 1) {
      const delaySec = 2 ** (attempt + 1);
      warning(
        `Tags not yet visible: ${missingTags.join(", ")} - retrying in ${delaySec}s (attempt ${attempt + 1}/${maxRetries}, API eventual consistency)`
      );
      await Bun.sleep(delaySec * 1000);
    } else {
      // Last attempt - return what we have and let caller handle missing tags
      warning(
        `Tags still not found after ${maxRetries} attempts: ${missingTags.join(", ")} (API eventual consistency delay)`
      );
      return versions;
    }
  }

  // Should never reach here, but TypeScript requires it
  return [];
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

/**
 * Find tags for deletion by exact name match (--tags mode only)
 * Note: --older-than and --keep-last are handled separately via filterVersionsByAge/filterVersionsForKeepLast
 */
function selectTagsForDeletion(
  _allTags: TagInfo[], // Unused but kept for API compatibility
  versions: PackageVersion[],
  options: CleanupOptions
): TagInfo[] {
  if (!options.tags) {
    return [];
  }

  const requestedSet = new Set(options.tags);
  const found: TagInfo[] = [];

  // Find version IDs for requested tags (exact name match)
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

function printTagList(tags: TagInfo[], untaggedCount: number = 0): void {
  if (tags.length === 0) {
    info("No matching tags found");
    if (untaggedCount > 0) {
      info(
        `Note: ${untaggedCount} untagged version${untaggedCount !== 1 ? "s" : ""} exist (arch manifests, SBOMs, attestations)`
      );
    }
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
  if (untaggedCount > 0) {
    console.log(
      `Untagged: ${untaggedCount} version${untaggedCount !== 1 ? "s" : ""} (arch manifests, SBOMs, attestations)`
    );
  }
  console.log("=".repeat(90));
}

// ============================================================================
// Version-Based Deletion (handles both tagged and untagged versions)
// ============================================================================

/**
 * Delete a filtered set of package versions (generalized from deleteAllVersions)
 *
 * CRITICAL: Multi-arch builds create orphaned manifests that have no tags:
 * - Arch-specific images (amd64, arm64) are pushed by-digest (untagged)
 * - SBOMs and attestations are stored as separate untagged manifests
 * - When the tagged parent manifest list is deleted, children become orphans
 *
 * This function handles both tagged and untagged versions for proper cleanup.
 */
async function deleteVersions(
  org: string,
  packageName: string,
  versionsToDelete: PackageVersion[],
  options: CleanupOptions
): Promise<void> {
  let successCount = 0;
  let retainedCount = 0;
  let failureCount = 0;
  const failures: Array<{ name: string; error: string }> = [];

  for (const version of versionsToDelete) {
    // Use first tag as identifier, or digest/name for untagged versions
    const identifier = version.metadata?.container?.tags?.[0] || version.name;

    try {
      await deletePackageVersion(org, packageName, version.id, identifier, options.dryRun);
      successCount++;
    } catch (err) {
      const errMessage = getErrorMessage(err);

      // GHCR returns "LAST_VERSION_PROTECTED" error in two cases:
      // 1. Actual last-version protection (can't delete the only remaining version)
      // 2. Package has >5000 downloads (different GHCR limitation, same error string)
      // Detect case 1: this is the last version we're trying to delete AND all prior succeeded
      if (errMessage.includes("LAST_VERSION_PROTECTED")) {
        const processedCount = successCount + retainedCount + failureCount;
        const thisIsLastInList = versionsToDelete.length - processedCount === 1;
        const allPriorSucceeded = failureCount === 0;

        if (thisIsLastInList && allPriorSucceeded) {
          // All other deletions succeeded, only this last one failed → GHCR protection
          info(`Retained: ${identifier} (last version cannot be deleted - GHCR limitation)`);
          retainedCount++;
          continue;
        }

        // Either not the last version OR prior failures exist → likely >5000 downloads issue
        warning(
          `Version ${identifier} failed with "LAST_VERSION_PROTECTED" but is not the last version - likely >5000 downloads limit`
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

  if (options.dryRun) {
    success(
      `[DRY RUN] Would delete ${versionsToDelete.length} version${versionsToDelete.length !== 1 ? "s" : ""}`
    );
  } else if (failureCount === 0 && retainedCount > 0) {
    success(
      `Deleted ${successCount} version${successCount !== 1 ? "s" : ""} (${retainedCount} retained - GHCR limitation)`
    );
  } else if (failureCount === 0) {
    success(`Deleted ${successCount} version${successCount !== 1 ? "s" : ""}`);
  } else {
    success(`Deleted ${successCount} version${successCount !== 1 ? "s" : ""}`);
    error(`Failed to delete ${failureCount} version${failureCount !== 1 ? "s" : ""}:`);
    for (const f of failures) {
      error(`  - ${f.name}: ${f.error}`);
    }
  }

  // Write to GitHub Actions step summary
  if (Bun.env.GITHUB_ACTIONS === "true" && Bun.env.GITHUB_STEP_SUMMARY) {
    const summary: string[] = [];
    summary.push("### 🧹 Cleanup Results\n");
    summary.push(`| Metric | Count |`);
    summary.push(`|--------|-------|`);
    summary.push(`| Versions to delete | ${versionsToDelete.length} |`);
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
      await appendToGitHubSummary(summary.join("\n") + "\n");
    } catch {
      // Ignore summary write errors
    }
  }

  if (failureCount > 0 && !options.continueOnError) {
    process.exit(1);
  }
}

/**
 * Filter versions by age threshold (handles both tagged and untagged)
 */
function filterVersionsByAge(versions: PackageVersion[], olderThanDays: number): PackageVersion[] {
  const now = Date.now();
  return versions.filter((v) => {
    const createdAt = new Date(v.created_at).getTime();
    const ageDays = (now - createdAt) / (1000 * 60 * 60 * 24);
    return ageDays > olderThanDays;
  });
}

/**
 * Filter versions for --keep-last retention mode
 *
 * Handles 4 distinct scenarios:
 * 1. keepLast=0: Delete ALL versions (tagged + untagged)
 * 2. No tagged versions: All untagged are orphans, delete them all
 * 3. Fewer tags than keepLast: Keep all tagged, delete untagged older than oldest tag
 * 4. Normal case: Delete excess tags + untagged older than oldest KEPT tag
 *
 * Uses oldest KEPT tag as cutoff to avoid corrupting kept tags' dependencies.
 * Trade-off: may leave some orphans from post-cutoff deleted tags (use --older-than for those).
 */
function filterVersionsForKeepLast(versions: PackageVersion[], keepLast: number): PackageVersion[] {
  // Case 1: keepLast=0 means delete everything
  if (keepLast === 0) {
    return versions;
  }

  const taggedVersions = versions.filter((v) => v.metadata?.container?.tags?.length);
  const untaggedVersions = versions.filter((v) => !v.metadata?.container?.tags?.length);

  // Case 2: No tagged versions = all untagged are orphans
  if (taggedVersions.length === 0) {
    return untaggedVersions;
  }

  // Sort tagged versions by creation date (newest first)
  const taggedSorted = [...taggedVersions].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  // Case 3: Fewer tags than keepLast - keep all tagged, delete old untagged
  if (taggedSorted.length <= keepLast) {
    // Safe: taggedSorted.length >= 1 (Case 2 returned for length=0)
    const oldestTagged = taggedSorted[taggedSorted.length - 1]!;
    const cutoffDate = new Date(oldestTagged.created_at);
    return untaggedVersions.filter((v) => new Date(v.created_at) < cutoffDate);
  }

  // Case 4: Normal - delete excess tags + untagged older than cutoff
  // Safe: taggedSorted.length > keepLast >= 1, so index keepLast-1 is valid
  const oldestKept = taggedSorted[keepLast - 1]!;
  const cutoffDate = new Date(oldestKept.created_at);
  const taggedToDelete = taggedSorted.slice(keepLast);
  const untaggedToDelete = untaggedVersions.filter((v) => new Date(v.created_at) < cutoffDate);

  return [...taggedToDelete, ...untaggedToDelete];
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

  // Use retry logic when specific tags are requested (handles API eventual consistency)
  const versions = await fetchPackageVersionsWithTagRetry(org, packageName, options.tags);

  if (versions.length === 0) {
    warning(`No versions found for package ${org}/${packageName}`);
    return;
  }

  // Count tagged vs untagged for display
  const taggedCount = versions.filter((v) => v.metadata?.container?.tags?.length).length;
  const untaggedCount = versions.length - taggedCount;
  const countDetail =
    untaggedCount > 0 ? ` (${taggedCount} tagged, ${untaggedCount} untagged)` : "";

  info(`Found ${versions.length} package version${versions.length !== 1 ? "s" : ""}${countDetail}`);

  // Handle --older-than N (includes untagged versions for proper cleanup)
  // CRITICAL FIX: Previously only processed tagged versions, leaving orphans
  if (options.olderThan !== undefined) {
    if (options.olderThan === 0) {
      // Delete ALL versions
      info(
        `Deleting ALL ${versions.length} version${versions.length !== 1 ? "s" : ""} (--older-than 0)`
      );
      await deleteVersions(org, packageName, versions, options);
    } else {
      // Delete versions older than N days (tagged + untagged)
      const versionsToDelete = filterVersionsByAge(versions, options.olderThan);
      if (versionsToDelete.length === 0) {
        success(
          `No versions older than ${options.olderThan} day${options.olderThan !== 1 ? "s" : ""}`
        );
        return;
      }
      const taggedDelCount = versionsToDelete.filter(
        (v) => v.metadata?.container?.tags?.length
      ).length;
      const untaggedDelCount = versionsToDelete.length - taggedDelCount;
      const delDetail =
        untaggedDelCount > 0
          ? ` (${taggedDelCount} tagged, ${untaggedDelCount} untagged/orphaned)`
          : "";
      info(
        `Deleting ${versionsToDelete.length} version${versionsToDelete.length !== 1 ? "s" : ""} older than ${options.olderThan} day${options.olderThan !== 1 ? "s" : ""}${delDetail}`
      );
      await deleteVersions(org, packageName, versionsToDelete, options);
    }
    return;
  }

  // Handle --keep-last N (includes untagged versions for proper cleanup)
  // CRITICAL FIX: Previously only processed tagged versions, leaving orphans
  if (options.keepLast !== undefined) {
    const versionsToDelete = filterVersionsForKeepLast(versions, options.keepLast);
    if (versionsToDelete.length === 0) {
      const tagCount = versions.filter((v) => v.metadata?.container?.tags?.length).length;
      success(
        `All ${tagCount} tagged version${tagCount !== 1 ? "s" : ""} within keep-last ${options.keepLast} limit`
      );
      return;
    }
    const taggedDelCount = versionsToDelete.filter(
      (v) => v.metadata?.container?.tags?.length
    ).length;
    const untaggedDelCount = versionsToDelete.length - taggedDelCount;
    const delDetail =
      untaggedDelCount > 0
        ? ` (${taggedDelCount} tagged, ${untaggedDelCount} untagged/orphaned)`
        : "";
    info(
      `Deleting ${versionsToDelete.length} version${versionsToDelete.length !== 1 ? "s" : ""} (keeping ${options.keepLast} newest tagged)${delDetail}`
    );
    await deleteVersions(org, packageName, versionsToDelete, options);
    return;
  }

  // Extract tags matching pattern (for --tags and --list modes)
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
    printTagList(allTags, untaggedCount);
    return;
  }

  // Handle --tags mode (specific tag deletion)
  if (options.tags) {
    const toDelete = selectTagsForDeletion(allTags, versions, options);
    if (toDelete.length === 0) {
      success("No tags to delete");
      return;
    }
    info(`Deleting ${toDelete.length} specified tag${toDelete.length !== 1 ? "s" : ""}`);

    // Delete specified tags
    let successCount = 0;
    let failureCount = 0;
    const failures: Array<{ tag: string; error: string }> = [];

    for (const tagInfo of toDelete) {
      try {
        await deletePackageVersion(
          org,
          packageName,
          tagInfo.versionId,
          tagInfo.tag,
          options.dryRun
        );
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

    // Summary
    console.log("");

    if (options.dryRun) {
      success(`[DRY RUN] Would delete ${toDelete.length} tag${toDelete.length !== 1 ? "s" : ""}`);
    } else if (failureCount === 0) {
      success(`Deleted ${successCount} tag${successCount !== 1 ? "s" : ""}`);
    } else {
      success(
        `Deleted ${successCount} of ${toDelete.length} tag${toDelete.length !== 1 ? "s" : ""}`
      );
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
      summary.push(`| Tags deleted | ${successCount} |`);
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
        await appendToGitHubSummary(summary.join("\n") + "\n");
      } catch {
        // Ignore summary write errors
      }
    }

    if (failureCount > 0 && !options.continueOnError) {
      process.exit(1);
    }
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
