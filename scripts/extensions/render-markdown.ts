#!/usr/bin/env bun
/**
 * Render Markdown tables for docs/EXTENSIONS.md from the generated manifest.
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";

const MANIFEST_PATH = join("docker", "postgres", "extensions.manifest.json");
const DOC_PATH = join("docs", "EXTENSIONS.md");
const START_MARK = "<!-- extensions-table:start -->";
const END_MARK = "<!-- extensions-table:end -->";

type Manifest = {
  entries: Array<{
    name: string;
    displayName?: string;
    kind: string;
    category: string;
    description: string;
    source: { tag?: string; commit?: string; repository?: string };
    runtime?: { sharedPreload?: boolean; defaultEnable?: boolean };
    sourceUrl?: string;
    docsUrl?: string;
  }>;
};

const manifest: Manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));

const groups = new Map<string, Manifest["entries"]>();
for (const entry of manifest.entries) {
  if (entry.kind === "builtin") continue;
  const bucket = groups.get(entry.category) ?? [];
  bucket.push(entry);
  groups.set(entry.category, bucket);
}

const escape = (text: string) => text.replace(/\|/g, "\\|");

/**
 * Generate a clickable version link to the appropriate GitHub page.
 * For tags: links to releases/tag/{tag}
 * For commits: links to commit/{sha}
 */
function getVersionLink(entry: Manifest["entries"][0]): string {
  const version = entry.source.tag ?? entry.source.commit?.slice(0, 8) ?? "";
  if (!version) return "";

  const repo = entry.source.repository;
  if (!repo) return version;

  // Extract owner/repo from GitHub URL
  const match = repo.match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/);
  if (!match) return version;

  const ownerRepo = match[1];

  if (entry.source.tag) {
    return `[${version}](https://github.com/${ownerRepo}/releases/tag/${entry.source.tag})`;
  } else if (entry.source.commit) {
    return `[${version}](https://github.com/${ownerRepo}/commit/${entry.source.commit})`;
  }

  return version;
}

const tableBlocks: string[] = [];
const sortedCategories = Array.from(groups.keys()).toSorted((a, b) => a.localeCompare(b));

for (const category of sortedCategories) {
  // Safe to use non-null coalescing since we iterate over keys that exist in the map
  const rows = (groups.get(category) ?? []).toSorted((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = [];
  lines.push(`### ${category}`);
  lines.push("");
  lines.push(
    "| Extension | Version | Enabled by Default | Shared Preload | Documentation | Notes |"
  );
  lines.push(
    "|-----------|---------|--------------------|----------------|---------------|-------|"
  );
  for (const entry of rows) {
    const versionLink = getVersionLink(entry);
    const defaultEnable = entry.runtime?.defaultEnable ? "Yes" : "No";
    const sharedPreload = entry.runtime?.sharedPreload ? "Yes" : "No";
    const notes = escape(entry.description);

    // Create clickable extension name
    const displayText =
      entry.displayName && entry.displayName !== entry.name
        ? `${entry.name} (${escape(entry.displayName)})`
        : entry.name;
    const nameLink = entry.sourceUrl
      ? `[\`${escape(displayText)}\`](${entry.sourceUrl})`
      : `\`${escape(displayText)}\``;

    // Create documentation link
    const docsLink = entry.docsUrl
      ? `[Docs](${entry.docsUrl})`
      : entry.sourceUrl
        ? `[README](${entry.sourceUrl}#readme)`
        : "—";

    lines.push(
      `| ${nameLink} | ${versionLink} | ${defaultEnable} | ${sharedPreload} | ${docsLink} | ${notes} |`
    );
  }
  lines.push("");
  tableBlocks.push(lines.join("\n"));
}

const replacement = [START_MARK, "", ...tableBlocks, END_MARK].join("\n");

const docContent = await readFile(DOC_PATH, "utf8");
const startIdx = docContent.indexOf(START_MARK);
const endIdx = docContent.indexOf(END_MARK);
if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
  throw new Error("Marker comments not found in docs/EXTENSIONS.md");
}
const before = docContent.slice(0, startIdx);
const after = docContent.slice(endIdx + END_MARK.length);
const next = `${before}${replacement}${after}`;

await writeFile(DOC_PATH, next, "utf8");
console.log("Updated docs/EXTENSIONS.md tables.");
