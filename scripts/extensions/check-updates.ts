#!/usr/bin/env bun
/**
 * Check Extension Updates
 *
 * Queries upstream sources for all extensions to detect available updates.
 * - Checks GitHub Releases API for git-tag extensions
 * - Notes git-ref extensions (commit-based) for manual review
 * - Outputs JSON report of available updates
 *
 * Usage:
 *   bun scripts/extensions/check-updates.ts [--format=json|table]
 *
 * Exit codes:
 *   0 - No updates available (or all disabled)
 *   1 - Updates available
 *   2 - Error occurred
 */

import { MANIFEST_ENTRIES, type ManifestEntry } from "./manifest-data.ts";

interface UpdateInfo {
  name: string;
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  source: string;
  releaseUrl: string | null;
  notes: string;
  enabled: boolean;
}

// ANSI colors
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function parseArgs() {
  const format = Bun.argv.find((arg) => arg.startsWith("--format="))?.split("=")[1] || "table";
  return { format };
}

interface GitHubRelease {
  tag_name: string;
  html_url: string;
}

interface GitHubTag {
  name: string;
}

async function checkGitHubRelease(
  repository: string,
  _currentTag: string
): Promise<{ latest: string | null; url: string | null }> {
  const match = repository.match(/github\.com\/([^/]+\/[^/]+)/);
  if (!match || !match[1]) {
    return { latest: null, url: null };
  }

  const repoPath = match[1].replace(/\.git$/, "");

  try {
    const response = await fetch(`https://api.github.com/repos/${repoPath}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "aza-pg-version-checker",
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        // No releases published, try tags
        const tagsResponse = await fetch(`https://api.github.com/repos/${repoPath}/tags`, {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "aza-pg-version-checker",
          },
        });

        if (tagsResponse.ok) {
          const tags = (await tagsResponse.json()) as GitHubTag[];
          const firstTag = tags[0];
          if (firstTag) {
            return {
              latest: firstTag.name,
              url: `https://github.com/${repoPath}/releases/tag/${firstTag.name}`,
            };
          }
        }
      }
      return { latest: null, url: null };
    }

    const data = (await response.json()) as GitHubRelease;
    return {
      latest: data.tag_name,
      url: data.html_url,
    };
  } catch (err) {
    console.error(`${colors.red}Error fetching ${repoPath}:${colors.reset}`, err);
    return { latest: null, url: null };
  }
}

async function checkExtensionUpdates(entry: ManifestEntry): Promise<UpdateInfo | null> {
  const { name, source, enabled = true } = entry;

  // Skip built-in extensions
  if (source.type === "builtin") {
    return null;
  }

  // Handle git-ref (commit-based) extensions
  if (source.type === "git-ref") {
    return {
      name,
      current: source.ref.substring(0, 8),
      latest: null,
      updateAvailable: false,
      source: source.repository,
      releaseUrl: null,
      notes: "Uses git-ref (commit SHA) - check upstream manually",
      enabled,
    };
  }

  // Handle git-tag extensions
  if (source.type === "git") {
    const { latest, url } = await checkGitHubRelease(source.repository, source.tag);

    if (latest === null) {
      return {
        name,
        current: source.tag,
        latest: null,
        updateAvailable: false,
        source: source.repository,
        releaseUrl: null,
        notes: "Could not fetch latest release from GitHub",
        enabled,
      };
    }

    const updateAvailable = latest !== source.tag;

    return {
      name,
      current: source.tag,
      latest,
      updateAvailable,
      source: source.repository,
      releaseUrl: url,
      notes: updateAvailable ? "Update available!" : "Up to date",
      enabled,
    };
  }

  return null;
}

function printTable(updates: UpdateInfo[]) {
  console.log("");
  console.log("============================================================");
  console.log("  Extension Update Check Results");
  console.log("============================================================");
  console.log("");

  // Group by update status
  const withUpdates = updates.filter((u) => u.updateAvailable && u.enabled);
  const gitRefs = updates.filter((u) => u.current.length === 8 && !u.latest);
  const upToDate = updates.filter((u) => !u.updateAvailable && u.latest !== null && u.enabled);
  const disabled = updates.filter((u) => !u.enabled);
  const errors = updates.filter((u) => u.latest === null && u.current.length > 8);

  if (withUpdates.length > 0) {
    console.log(`${colors.yellow}📦 Updates Available (${withUpdates.length}):${colors.reset}`);
    console.log("");
    for (const update of withUpdates) {
      console.log(`  ${colors.cyan}${update.name.padEnd(25)}${colors.reset}`);
      console.log(
        `    Current:  ${colors.gray}${update.current}${colors.reset}   →   Latest: ${colors.green}${update.latest}${colors.reset}`
      );
      if (update.releaseUrl) {
        console.log(`    Release:  ${colors.blue}${update.releaseUrl}${colors.reset}`);
      }
      console.log("");
    }
  }

  if (gitRefs.length > 0) {
    console.log(`${colors.blue}ℹ️  Commit-Based Extensions (${gitRefs.length}):${colors.reset}`);
    console.log("");
    for (const ref of gitRefs) {
      console.log(`  ${colors.cyan}${ref.name.padEnd(25)}${colors.reset}`);
      console.log(`    Commit:   ${colors.gray}${ref.current}${colors.reset}`);
      console.log(`    ${colors.gray}${ref.notes}${colors.reset}`);
      console.log("");
    }
  }

  if (upToDate.length > 0) {
    console.log(`${colors.green}✅ Up to Date (${upToDate.length}):${colors.reset}`);
    console.log(
      "  " +
        upToDate
          .map((u) => u.name)
          .join(", ")
          .match(/.{1,70}(\s|$)/g)
          ?.join("\n  ")
    );
    console.log("");
  }

  if (disabled.length > 0) {
    console.log(`${colors.gray}⏸️  Disabled (${disabled.length}):${colors.reset}`);
    console.log(
      "  " +
        disabled
          .map((u) => u.name)
          .join(", ")
          .match(/.{1,70}(\s|$)/g)
          ?.join("\n  ")
    );
    console.log("");
  }

  if (errors.length > 0) {
    console.log(`${colors.red}❌ Could Not Check (${errors.length}):${colors.reset}`);
    for (const err of errors) {
      console.log(`  ${colors.cyan}${err.name.padEnd(25)}${colors.reset} - ${err.notes}`);
    }
    console.log("");
  }

  console.log("============================================================");
  console.log("");

  if (withUpdates.length > 0) {
    console.log(`${colors.yellow}Action Required:${colors.reset}`);
    console.log(`  1. Review available updates above`);
    console.log(`  2. Update versions in scripts/extensions/manifest-data.ts`);
    console.log(`  3. Run: bun run generate`);
    console.log(`  4. Test and commit changes`);
    console.log("");
  } else {
    console.log(`${colors.green}All extensions are up to date!${colors.reset}`);
    console.log("");
  }
}

async function main() {
  const args = parseArgs();

  console.log(
    `${colors.blue}ℹ️  Checking ${MANIFEST_ENTRIES.length} extensions for updates...${colors.reset}`
  );
  console.log("");

  const results: UpdateInfo[] = [];

  for (const entry of MANIFEST_ENTRIES) {
    const update = await checkExtensionUpdates(entry);
    if (update) {
      results.push(update);
    }
  }

  if (args.format === "json") {
    console.log(JSON.stringify(results, null, 2));
  } else {
    printTable(results);
  }

  // Exit with 1 if any enabled extensions have updates
  const hasUpdates = results.some((r) => r.updateAvailable && r.enabled);
  process.exit(hasUpdates ? 1 : 0);
}

main();
