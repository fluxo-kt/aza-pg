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

import { MANIFEST_ENTRIES } from "./manifest-data";
import type { ManifestEntry } from "./manifest-data";

interface UpdateInfo {
  name: string;
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  source: string;
  sourceType: "git" | "git-ref";
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

interface ParsedTagVersion {
  prefix: string;
  segments: number[];
}

export function isPreReleaseTag(tag: string): boolean {
  return /(?:^|[^a-z])(alpha|beta|rc|preview|pre)(?:[^a-z]|$)/i.test(tag);
}

export function canUseCandidateTag(currentTag: string, candidateTag: string): boolean {
  if (isPreReleaseTag(currentTag)) {
    return true;
  }
  return !isPreReleaseTag(candidateTag);
}

function parseTagVersion(tag: string): ParsedTagVersion | null {
  const matches = Array.from(tag.matchAll(/(\d+(?:[._-]\d+)+|\d+)/g));
  if (matches.length === 0) {
    return null;
  }

  // Prefer version-like chunks with separators (e.g. 2.3.1, 2_6).
  // Fallback to the last numeric chunk when separators are unavailable.
  let selected = matches[matches.length - 1];
  if (!selected) {
    return null;
  }
  for (let i = matches.length - 1; i >= 0; i--) {
    const candidate = matches[i];
    if (!candidate) {
      continue;
    }

    const versionChunk = candidate[0];
    const index = candidate.index;
    if (!versionChunk || index === undefined) {
      continue;
    }

    const hasSeparator =
      versionChunk.includes(".") ||
      versionChunk.includes("_") ||
      (versionChunk.includes("-") && !versionChunk.startsWith("-"));
    const wholeTagNumeric = index === 0 && versionChunk.length === tag.length;
    if (hasSeparator || wholeTagNumeric) {
      selected = candidate;
      break;
    }
  }

  const versionChunk = selected[0];
  const index = selected.index;
  if (!versionChunk || index === undefined) {
    return null;
  }

  const segments = versionChunk
    .split(/[._-]/)
    .map((segment) => Number.parseInt(segment, 10))
    .filter((segment) => Number.isFinite(segment));

  if (segments.length === 0) {
    return null;
  }

  return {
    prefix: tag.slice(0, index),
    segments,
  };
}

function compareSegments(a: number[], b: number[]): number {
  const maxLength = Math.max(a.length, b.length);
  for (let i = 0; i < maxLength; i++) {
    const aValue = a[i] ?? 0;
    const bValue = b[i] ?? 0;
    if (aValue > bValue) {
      return 1;
    }
    if (aValue < bValue) {
      return -1;
    }
  }
  return 0;
}

/**
 * Compare tag versions using numeric segments with prefix-family matching.
 *
 * Returns:
 * - `1` when `candidateTag` is newer than `currentTag`
 * - `0` when equivalent
 * - `-1` when older
 * - `null` when tag families are not comparable
 */
export function compareTagVersions(currentTag: string, candidateTag: string): number | null {
  const currentParsed = parseTagVersion(currentTag);
  const candidateParsed = parseTagVersion(candidateTag);

  if (!currentParsed || !candidateParsed || currentParsed.prefix !== candidateParsed.prefix) {
    return null;
  }

  return compareSegments(candidateParsed.segments, currentParsed.segments);
}

async function checkGitHubRelease(
  repository: string,
  currentTag: string
): Promise<{
  latest: string | null;
  url: string | null;
  usedTagsFallback: boolean;
  fallbackSource: "tags-api" | "git-ls-remote" | null;
}> {
  const match = repository.match(/github\.com\/([^/]+\/[^/]+)/);
  if (!match || !match[1]) {
    return { latest: null, url: null, usedTagsFallback: false, fallbackSource: null };
  }

  const repoPath = match[1].replace(/\.git$/, "");
  const fallbackToTagsApi = async (): Promise<{ latest: string | null; url: string | null }> => {
    const tagsResponse = await fetch(`https://api.github.com/repos/${repoPath}/tags`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "aza-pg-version-checker",
      },
    });

    if (!tagsResponse.ok) {
      return { latest: null, url: null };
    }

    const tags = (await tagsResponse.json()) as GitHubTag[];
    const comparableTags = tags
      .map((tag) => tag.name)
      .filter((tag) => canUseCandidateTag(currentTag, tag))
      .filter((tag) => compareTagVersions(currentTag, tag) !== null);

    if (comparableTags.length === 0) {
      return { latest: null, url: null };
    }

    const latestComparable = comparableTags.reduce((best, candidate) => {
      const comparison = compareTagVersions(best, candidate);
      return comparison !== null && comparison > 0 ? candidate : best;
    });

    return {
      latest: latestComparable,
      url: `https://github.com/${repoPath}/releases/tag/${latestComparable}`,
    };
  };
  const fallbackToLsRemote = async (): Promise<{ latest: string | null; url: string | null }> => {
    const proc = Bun.spawn(["git", "ls-remote", "--tags", "--refs", repository], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      console.error(
        `${colors.red}Error reading tags via git ls-remote (${repoPath}):${colors.reset} ${stderr.trim()}`
      );
      return { latest: null, url: null };
    }

    const comparableTags = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[1] ?? "")
      .map((ref) => ref.replace("refs/tags/", ""))
      .filter((tag) => tag.length > 0)
      .filter((tag) => canUseCandidateTag(currentTag, tag))
      .filter((tag) => compareTagVersions(currentTag, tag) !== null);

    if (comparableTags.length === 0) {
      return { latest: null, url: null };
    }

    const latestComparable = comparableTags.reduce((best, candidate) => {
      const comparison = compareTagVersions(best, candidate);
      return comparison !== null && comparison > 0 ? candidate : best;
    });

    return {
      latest: latestComparable,
      url: `https://github.com/${repoPath}/releases/tag/${latestComparable}`,
    };
  };
  const fallbackToComparableTags = async (): Promise<{
    latest: string | null;
    url: string | null;
    fallbackSource: "tags-api" | "git-ls-remote" | null;
  }> => {
    const tagsApiResult = await fallbackToTagsApi();
    if (tagsApiResult.latest !== null) {
      return { ...tagsApiResult, fallbackSource: "tags-api" };
    }

    const lsRemoteResult = await fallbackToLsRemote();
    if (lsRemoteResult.latest !== null) {
      return { ...lsRemoteResult, fallbackSource: "git-ls-remote" };
    }

    return { latest: null, url: null, fallbackSource: null };
  };

  try {
    const response = await fetch(`https://api.github.com/repos/${repoPath}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "aza-pg-version-checker",
      },
    });

    if (!response.ok) {
      // No releases published or API unavailable/rate-limited: use comparable tags.
      const tagsFallback = await fallbackToComparableTags();
      return {
        latest: tagsFallback.latest,
        url: tagsFallback.url,
        usedTagsFallback: tagsFallback.latest !== null,
        fallbackSource: tagsFallback.fallbackSource,
      };
    }

    const data = (await response.json()) as GitHubRelease;
    // Some monorepos publish release tags for other packages. If tag family
    // differs, prefer a comparable git tag for this extension.
    if (compareTagVersions(currentTag, data.tag_name) === null) {
      const tagsFallback = await fallbackToComparableTags();
      if (tagsFallback.latest !== null) {
        return {
          latest: tagsFallback.latest,
          url: tagsFallback.url,
          usedTagsFallback: true,
          fallbackSource: tagsFallback.fallbackSource,
        };
      }
    }

    return {
      latest: data.tag_name,
      url: data.html_url,
      usedTagsFallback: false,
      fallbackSource: null,
    };
  } catch (err) {
    const tagsFallback = await fallbackToComparableTags();
    if (tagsFallback.latest !== null) {
      return {
        latest: tagsFallback.latest,
        url: tagsFallback.url,
        usedTagsFallback: true,
        fallbackSource: tagsFallback.fallbackSource,
      };
    }
    console.error(`${colors.red}Error fetching ${repoPath}:${colors.reset}`, err);
    return { latest: null, url: null, usedTagsFallback: false, fallbackSource: null };
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
      sourceType: "git-ref",
      releaseUrl: null,
      notes: "Uses git-ref (commit SHA) - check upstream manually",
      enabled,
    };
  }

  // Handle git-tag extensions
  if (source.type === "git") {
    const { latest, url, usedTagsFallback, fallbackSource } = await checkGitHubRelease(
      source.repository,
      source.tag
    );

    if (latest === null) {
      return {
        name,
        current: source.tag,
        latest: null,
        updateAvailable: false,
        source: source.repository,
        sourceType: "git",
        releaseUrl: null,
        notes: "Could not fetch latest release from GitHub",
        enabled,
      };
    }

    const comparison = compareTagVersions(source.tag, latest);
    const updateAvailable = comparison !== null ? comparison > 0 : latest !== source.tag;
    let notes = updateAvailable ? "Update available!" : "Up to date";

    if (!canUseCandidateTag(source.tag, latest) && latest !== source.tag) {
      notes = "Latest discovered tag is pre-release; current pin is stable";
    } else if (comparison !== null && comparison < 0) {
      notes = "Latest discovered tag is older than current pin";
    } else if (comparison === null && latest !== source.tag) {
      notes = "Latest tag family differs from current pin - manual review needed";
    } else if (comparison === 0 && latest !== source.tag) {
      notes = "Equivalent version via alternate tag format";
    }

    if (usedTagsFallback && !updateAvailable) {
      const fallbackLabel =
        fallbackSource === "git-ls-remote" ? "git ls-remote tags" : "GitHub tags API";
      notes = `${notes}; resolved using ${fallbackLabel}`;
    }

    return {
      name,
      current: source.tag,
      latest,
      updateAvailable,
      source: source.repository,
      sourceType: "git",
      releaseUrl: url,
      notes,
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
  const gitRefs = updates.filter((u) => u.sourceType === "git-ref");
  const upToDate = updates.filter((u) => !u.updateAvailable && u.latest !== null && u.enabled);
  const disabled = updates.filter((u) => !u.enabled);
  const errors = updates.filter((u) => u.sourceType === "git" && u.latest === null);

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

if (import.meta.main) {
  await main();
}
