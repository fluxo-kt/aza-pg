#!/usr/bin/env bun

/**
 * Document existing tags that will be overwritten (for rollback reference)
 *
 * Usage:
 *   bun scripts/release/document-tag-overwrites.ts \
 *     --registry=ghcr.io \
 *     --repository=fluxo-kt/aza-pg \
 *     --tags=18.1-single-node,18-single-node,18.1,18 \
 *     [--github-summary]
 *
 * Documents the digests of existing tags before they are overwritten,
 * enabling rollback if needed.
 */

import { $ } from "bun";
import { appendFile } from "node:fs/promises";

interface TagInfo {
  tag: string;
  previousDigest: string | null;
  isNew: boolean;
}

async function getTagDigest(fullImageRef: string): Promise<string | null> {
  try {
    const result =
      await $`docker manifest inspect ${fullImageRef} 2>/dev/null | jq -r '.manifests[0].digest // .digest' 2>/dev/null`.quiet();
    const digest = result.text().trim();
    return digest && digest !== "null" ? digest : null;
  } catch {
    return null;
  }
}

async function documentTags(
  registry: string,
  repository: string,
  tags: string[]
): Promise<TagInfo[]> {
  const results: TagInfo[] = [];

  for (const tag of tags) {
    const fullRef = `${registry}/${repository}:${tag}`;
    const digest = await getTagDigest(fullRef);

    results.push({
      tag,
      previousDigest: digest,
      isNew: digest === null,
    });

    if (digest) {
      console.log(`Previous ${tag}: ${digest}`);
    } else {
      console.log(`${tag}: New tag`);
    }
  }

  return results;
}

async function writeGitHubSummary(results: TagInfo[]): Promise<void> {
  const summaryFile = Bun.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) {
    console.error("Warning: GITHUB_STEP_SUMMARY not set, skipping summary output");
    return;
  }

  const lines: string[] = [
    "### Tag Overwrite Reference",
    "",
    "The following tags will be updated. Previous digests recorded for rollback reference:",
    "",
  ];

  for (const { tag, previousDigest, isNew } of results) {
    if (isNew) {
      lines.push(`- **${tag}**: New tag (no previous version)`);
    } else {
      lines.push(`- **${tag}**: Previous digest \`${previousDigest}\``);
    }
  }

  lines.push("");

  await appendFile(summaryFile, lines.join("\n"));
  console.log("Tag overwrite reference written to GitHub Summary");
}

// Parse CLI arguments
const args = Bun.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Document existing tags that will be overwritten (for rollback reference)

Usage:
  bun scripts/release/document-tag-overwrites.ts \\
    --registry=ghcr.io \\
    --repository=fluxo-kt/aza-pg \\
    --tags=18.1-single-node,18-single-node,18.1,18 \\
    [--github-summary]

Arguments:
  --registry       Container registry (required)
  --repository     Image repository without registry (required)
  --tags           Comma-separated list of tags to document (required)
  --github-summary Write to GITHUB_STEP_SUMMARY
  --help, -h       Show this help message

Examples:
  bun scripts/release/document-tag-overwrites.ts \\
    --registry=ghcr.io \\
    --repository=fluxo-kt/aza-pg \\
    --tags=18.1-single-node,18-single-node,18.1,18 \\
    --github-summary
`);
  process.exit(0);
}

const registry = args.find((arg) => arg.startsWith("--registry="))?.split("=")[1];
const repository = args.find((arg) => arg.startsWith("--repository="))?.split("=")[1];
const tagsArg = args.find((arg) => arg.startsWith("--tags="))?.split("=")[1];
const githubSummary = args.includes("--github-summary");

if (!registry) {
  console.error("Error: --registry argument is required");
  process.exit(1);
}

if (!repository) {
  console.error("Error: --repository argument is required");
  process.exit(1);
}

if (!tagsArg) {
  console.error("Error: --tags argument is required");
  process.exit(1);
}

const tags = tagsArg.split(",").map((t) => t.trim());

console.log(`Documenting ${tags.length} tags for ${registry}/${repository}...`);

const results = await documentTags(registry, repository, tags);

if (githubSummary) {
  await writeGitHubSummary(results);
}
