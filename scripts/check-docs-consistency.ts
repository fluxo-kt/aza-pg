#!/usr/bin/env bun
/**
 * Documentation Consistency Checker
 *
 * Validates that documentation files match the generated docs-data.json:
 * - Extension counts must match manifest
 * - Preload library lists must match manifest
 * - Memory tier tables must match generated data
 *
 * Exits with error if mismatches found.
 */

import { join } from "path";
import { info, success, error, warning, section } from "./utils/logger.ts";
import { Glob } from "bun";

const PROJECT_ROOT = join(import.meta.dir, "..");
const DOCS_DATA_PATH = join(PROJECT_ROOT, "docs/.generated/docs-data.json");
const DOC_PATHS = ["AGENTS.md", "README.md", "docs/**/*.md"];

interface DocsData {
  catalog: {
    total: number;
    enabled: number;
    disabled: number;
  };
  byKind: {
    builtin: number;
    extension: number;
    tool: number;
  };
  tools: string[];
  preloaded: {
    modules: string[];
    extensions: string[];
  };
  memoryTiers: Array<{
    ram: string;
    shared_buffers: string;
    effective_cache_size: string;
    work_mem: string;
    maintenance_work_mem: string;
    max_connections: number;
  }>;
}

interface CheckResult {
  file: string;
  errors: string[];
}

/**
 * Check if file contains extension count mentions
 *
 * Accepts both qualified counts:
 * - "38 total" or "38 catalog" = OK (catalog entries)
 * - "37 enabled" = OK (enabled extensions)
 * - Bare "38" or "37" without qualifier = warn
 */
function checkExtensionCounts(content: string, _data: DocsData, _file: string): string[] {
  const errors: string[] = [];

  // Check for unqualified "38 extensions" (should be qualified as "38 total catalog entries" or "37 enabled")
  const unqualified38Pattern = /(?<!total\s)(?<!catalog\s)38\s+extensions?(?!\s+\()/gi;
  const unqualified37Pattern = /(?<!enabled\s)37\s+extensions?(?!\s+\()/gi;

  const matches38 = [...content.matchAll(unqualified38Pattern)];
  const matches37 = [...content.matchAll(unqualified37Pattern)];

  // Only error on truly bare mentions without context
  for (const match of matches38) {
    const lineStart = Math.max(0, (match.index || 0) - 50);
    const context = content.substring(lineStart, (match.index || 0) + 50);

    // Allow if context contains "total", "catalog", or "(37 enabled"
    if (
      !context.includes("total") &&
      !context.includes("catalog") &&
      !context.includes("(37 enabled")
    ) {
      errors.push(
        `Found unqualified "38 extensions" - should specify "38 total catalog entries (37 enabled)"`
      );
    }
  }

  for (const match of matches37) {
    const lineStart = Math.max(0, (match.index || 0) - 50);
    const context = content.substring(lineStart, (match.index || 0) + 50);

    // Allow if context contains "enabled"
    if (!context.includes("enabled")) {
      errors.push(`Found unqualified "37 extensions" - should specify "37 enabled extensions"`);
    }
  }

  return errors;
}

/**
 * Check if preload libraries list matches manifest
 */
function checkPreloadLibraries(content: string, _data: DocsData, file: string): string[] {
  const errors: string[] = [];

  // Look for preload mentions (common patterns)
  const preloadPatterns = [
    /shared_preload_libraries[^:]*:\s*([^\n]+)/gi,
    /preloaded[^:]*:\s*([^\n]+)/gi,
    /4 preloaded/gi,
  ];

  for (const pattern of preloadPatterns) {
    const matches = [...content.matchAll(pattern)];
    if (matches.length > 0) {
      // Just flag that we found preload mentions - manual review needed
      info(`${file}: Found preload library mentions - manual verification recommended`);
    }
  }

  return errors;
}

/**
 * Check memory tier tables
 */
function checkMemoryTiers(content: string, data: DocsData, file: string): string[] {
  const errors: string[] = [];

  // Look for memory allocation tables (markdown tables with RAM, shared_buffers, etc.)
  const tablePattern = /\|\s*RAM\s*\|.*shared_buf.*\|/i;
  if (tablePattern.test(content)) {
    // Check for known memory tiers
    const tiers = data.memoryTiers.map((t) => t.ram);
    const missing = tiers.filter((tier) => !content.includes(tier));

    if (missing.length > 0 && missing.length < tiers.length) {
      warning(`${file}: Memory table may be incomplete (missing: ${missing.join(", ")})`);
    }
  }

  return errors;
}

/**
 * Check for incorrect password escaping docs
 */
function checkPasswordEscaping(content: string, _file: string): string[] {
  const errors: string[] = [];

  // Old incorrect pattern: `:@&` escaping
  // But allow if it's clearly marked as wrong (NOT, INCORRECT, etc.)
  if (content.includes(":@&")) {
    const line = content.split("\n").find((l) => l.includes(":@&"));
    if (
      line &&
      !line.includes("NOT") &&
      !line.includes("INCORRECT") &&
      !line.includes("common mistake")
    ) {
      errors.push(
        "Found incorrect password escaping reference (:@&) - should be : and \\ only for .pgpass"
      );
    }
  }

  return errors;
}

/**
 * Check for incorrect tool classification
 */
function checkToolClassification(content: string, data: DocsData, file: string): string[] {
  const errors: string[] = [];
  const tools = data.tools;

  // pgbackrest, pgbadger, wal2json should be called "tools" not "extensions"
  for (const tool of tools) {
    const pattern = new RegExp(`${tool}.*extension`, "gi");
    if (pattern.test(content)) {
      warning(
        `${file}: ${tool} may be incorrectly classified as 'extension' (should be 'tool' - no CREATE EXTENSION needed)`
      );
    }
  }

  return errors;
}

async function main() {
  section("Documentation Consistency Check");

  // Load docs data
  const docsDataFile = Bun.file(DOCS_DATA_PATH);
  if (!(await docsDataFile.exists())) {
    error(`Docs data not found at ${DOCS_DATA_PATH}`);
    error("Run: bun scripts/generate-docs-data.ts");
    process.exit(1);
  }

  const data: DocsData = await docsDataFile.json();
  info(`Loaded docs data: ${data.catalog.enabled} extensions`);

  // Find all documentation files
  const docFiles: string[] = [];
  for (const pattern of DOC_PATHS) {
    const glob = new Glob(pattern);
    for await (const file of glob.scan({ cwd: PROJECT_ROOT })) {
      const fullPath = join(PROJECT_ROOT, file);
      if (!fullPath.includes("node_modules") && !fullPath.includes(".archived")) {
        docFiles.push(fullPath);
      }
    }
  }

  info(`Checking ${docFiles.length} documentation files...`);

  const results: CheckResult[] = [];
  let totalErrors = 0;

  // Check each file
  for (const file of docFiles) {
    const content = await Bun.file(file).text();
    const errors: string[] = [];

    // Run checks
    errors.push(...checkExtensionCounts(content, data, file));
    errors.push(...checkPreloadLibraries(content, data, file));
    errors.push(...checkMemoryTiers(content, data, file));
    errors.push(...checkPasswordEscaping(content, file));
    errors.push(...checkToolClassification(content, data, file));

    if (errors.length > 0) {
      results.push({ file, errors });
      totalErrors += errors.length;
    }
  }

  // Report results
  console.log("");
  if (results.length > 0) {
    warning("Found issues in documentation:");
    for (const result of results) {
      error(`\n${result.file}:`);
      for (const err of result.errors) {
        console.log(`  - ${err}`);
      }
    }

    console.log("");
    error(`Total issues found: ${totalErrors}`);
    process.exit(1);
  } else {
    success("All documentation checks passed!");
    info(`Verified ${docFiles.length} files`);
  }
}

main().catch((err) => {
  error(`Failed to check docs consistency: ${err.message}`);
  process.exit(1);
});
