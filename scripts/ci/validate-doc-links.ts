#!/usr/bin/env bun
/**
 * Documentation link checker
 *
 * Validates all internal links in markdown files:
 * - File references (./path/to/file.md)
 * - Anchor links (#section)
 * - Mixed (./file.md#section)
 *
 * Ignores:
 * - External URLs (http://, https://)
 * - Image references
 */

import { Glob } from "bun";
import path from "path";
import { error, info, success, warning } from "../utils/logger";

interface BrokenLink {
  file: string;
  link: string;
  line: number;
  reason: string;
}

const ROOT_DIR = path.resolve(import.meta.dir, "../..");

/**
 * Extract markdown links from content
 * Returns array of {link, line} objects
 */
function extractLinks(content: string): Array<{ link: string; line: number }> {
  const links: Array<{ link: string; line: number }> = [];
  const lines = content.split("\n");

  // Match [text](link) pattern - exclude images ![alt](src)
  const linkRegex = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;

  lines.forEach((lineContent, index) => {
    let match;
    while ((match = linkRegex.exec(lineContent)) !== null) {
      const rawLink = match[2];
      if (!rawLink) continue;
      const link = rawLink.split(" ")[0]; // Remove title if present
      if (!link) continue;
      // Skip external URLs and anchors
      if (
        !link.startsWith("http://") &&
        !link.startsWith("https://") &&
        !link.startsWith("mailto:")
      ) {
        links.push({ link, line: index + 1 });
      }
    }
  });

  return links;
}

/**
 * Check if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    const file = Bun.file(filePath);
    return await file.exists();
  } catch {
    return false;
  }
}

/**
 * Extract heading anchors from markdown content
 */
function extractAnchors(content: string): Set<string> {
  const anchors = new Set<string>();
  const lines = content.split("\n");

  for (const line of lines) {
    // Match headings: # Heading, ## Heading, etc.
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch && headingMatch[1]) {
      // Convert heading to anchor format
      const anchor = headingMatch[1]
        .toLowerCase()
        .replace(/[^\w\s-]/g, "") // Remove special chars except hyphens
        .replace(/\s+/g, "-") // Replace spaces with hyphens
        .replace(/-+/g, "-") // Collapse multiple hyphens
        .replace(/^-|-$/g, ""); // Trim leading/trailing hyphens
      anchors.add(anchor);
    }
  }

  return anchors;
}

/**
 * Validate a single link
 */
async function validateLink(
  link: string,
  sourceFile: string,
  anchorCache: Map<string, Set<string>>
): Promise<string | null> {
  // Handle anchor-only links
  if (link.startsWith("#")) {
    const anchor = link.slice(1);
    const anchors = anchorCache.get(sourceFile);
    if (anchors && !anchors.has(anchor)) {
      return `Anchor '${anchor}' not found in file`;
    }
    return null;
  }

  // Split link into file and anchor parts
  const parts = link.split("#");
  const filePart = parts[0];
  const anchorPart = parts[1];

  // Handle empty file part (shouldn't happen with our filters, but be safe)
  if (!filePart) {
    return "Invalid link format";
  }

  // Resolve file path relative to source file
  const sourceDir = path.dirname(sourceFile);
  const targetPath = path.resolve(sourceDir, filePart);

  // Check file exists
  if (!(await fileExists(targetPath))) {
    return `File not found: ${filePart}`;
  }

  // If there's an anchor, validate it
  if (anchorPart) {
    let anchors = anchorCache.get(targetPath);
    if (!anchors) {
      // Load and cache anchors for target file
      const content = await Bun.file(targetPath).text();
      anchors = extractAnchors(content);
      anchorCache.set(targetPath, anchors);
    }
    if (!anchors.has(anchorPart)) {
      return `Anchor '${anchorPart}' not found in ${filePart}`;
    }
  }

  return null;
}

/**
 * Check all links in a markdown file
 */
async function checkFile(
  filePath: string,
  anchorCache: Map<string, Set<string>>
): Promise<BrokenLink[]> {
  const broken: BrokenLink[] = [];
  const content = await Bun.file(filePath).text();

  // Cache anchors for this file
  anchorCache.set(filePath, extractAnchors(content));

  const links = extractLinks(content);

  for (const { link, line } of links) {
    const reason = await validateLink(link, filePath, anchorCache);
    if (reason) {
      broken.push({
        file: path.relative(ROOT_DIR, filePath),
        link,
        line,
        reason,
      });
    }
  }

  return broken;
}

/**
 * Main function
 */
async function main(): Promise<void> {
  info("Checking documentation links...");

  const glob = new Glob("**/*.md");
  const anchorCache = new Map<string, Set<string>>();
  const allBroken: BrokenLink[] = [];
  let fileCount = 0;
  let linkCount = 0;

  // Check docs/ directory
  const docsDir = path.join(ROOT_DIR, "docs");
  for await (const file of glob.scan(docsDir)) {
    const filePath = path.join(docsDir, file);
    const content = await Bun.file(filePath).text();
    const links = extractLinks(content);
    linkCount += links.length;
    fileCount++;

    const broken = await checkFile(filePath, anchorCache);
    allBroken.push(...broken);
  }

  // Check root markdown files (README.md, CLAUDE.md, etc.)
  for (const rootFile of ["README.md", "CLAUDE.md", "AGENTS.md"]) {
    const filePath = path.join(ROOT_DIR, rootFile);
    if (await fileExists(filePath)) {
      const content = await Bun.file(filePath).text();
      const links = extractLinks(content);
      linkCount += links.length;
      fileCount++;

      const broken = await checkFile(filePath, anchorCache);
      allBroken.push(...broken);
    }
  }

  // Report results
  console.log();
  info(`Checked ${fileCount} files, ${linkCount} links`);

  if (allBroken.length === 0) {
    success("All documentation links are valid");
    process.exit(0);
  }

  // Group by file for cleaner output
  const byFile = new Map<string, BrokenLink[]>();
  for (const broken of allBroken) {
    const existing = byFile.get(broken.file) ?? [];
    existing.push(broken);
    byFile.set(broken.file, existing);
  }

  console.log();
  error(`Found ${allBroken.length} broken link(s):`);
  console.log();

  for (const [file, broken] of byFile) {
    warning(file);
    for (const { link, line, reason } of broken) {
      console.log(`  Line ${line}: ${link}`);
      console.log(`    → ${reason}`);
    }
    console.log();
  }

  process.exit(1);
}

main().catch((err) => {
  error("Link checker failed", err);
  process.exit(1);
});
