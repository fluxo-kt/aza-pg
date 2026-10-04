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

import { join } from "node:path";
import { info, success, error, warning, section } from "./utils/logger";
import { Glob } from "bun";
import {
  getDefaultSharedPreloadLibraries,
  preloadLibraryName,
} from "./config-generator/manifest-loader";
import { MANIFEST_ENTRIES } from "./extensions/manifest-data";

const PROJECT_ROOT = join(import.meta.dir, "..");
const DOCS_DATA_PATH = join(PROJECT_ROOT, "docs/.generated/docs-data.json");
const DOC_PATHS = [
  "*.md",
  "docs/**/*.md",
  "stacks/**/*.conf",
  ".env.example",
  "stacks/*/.env.example",
];
// Release notes keep the values each release shipped with.
const SKIPPED_DOCS = new Set(["CHANGELOG.md"]);

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
 * NOTE: Disabled - all hardcoded extension counts have been removed from documentation.
 * Counts should be referenced from docs/.generated/docs-data.json or dynamically computed.
 */
function checkExtensionCounts(_content: string, _data: DocsData, _file: string): string[] {
  // Hardcoded count checks disabled - documentation now references generated data
  return [];
}

/**
 * A written-out preload list must include every library the image preloads by default. Docs and config
 * comments copy the default so operators can extend it in POSTGRES_SHARED_PRELOAD_LIBRARIES, which
 * replaces the default rather than adding to it: a stale copy that misses a library makes an operator
 * drop it, and the extension needing it breaks (an override example once dropped timescaledb).
 * A list is a run of preloadable library names separated only by commas, spaces, quotes, bullets or one
 * short parenthetical ("auto_explain (module), pg_cron"); runs cross line breaks because lists wrap,
 * while prose between names ends the run. A run naming at least four default libraries, in a paragraph
 * that (or whose three preceding lines) speaks of preloading, must name all of them; optional extras
 * (supautils, ...) are fine. The default comes from the same function that writes the entrypoint.
 */
const PRELOADABLE = new Set(
  MANIFEST_ENTRIES.filter((e) => e.runtime?.sharedPreload === true && e.enabled !== false).map(
    (e) => preloadLibraryName(e)
  )
);
const DEFAULT_PRELOAD = getDefaultSharedPreloadLibraries({ entries: MANIFEST_ENTRIES }).split(",");
const PRELOAD_CONTEXT = /preload/i;
const LIST_GAP = /^[\s,`'"*-]*(\([^()\n]{0,40}\))?[\s,`'"*-]*$/;

function preloadRuns(block: string): Array<{ names: Set<string>; offset: number }> {
  const runs: Array<{ names: Set<string>; offset: number }> = [];
  let current: { names: Set<string>; offset: number } | undefined;
  let end = 0;
  for (const m of block.matchAll(/[a-z_][a-z0-9_]*/g)) {
    if (!PRELOADABLE.has(m[0])) continue;
    if (current && LIST_GAP.test(block.slice(end, m.index))) {
      current.names.add(m[0]);
    } else {
      current = { names: new Set([m[0]]), offset: m.index };
      runs.push(current);
    }
    end = m.index + m[0].length;
  }
  return runs;
}

function checkPreloadLibraries(content: string, _data: DocsData, _file: string): string[] {
  const lines = content.split("\n");
  const errors: string[] = [];
  let start = 0;
  for (let i = 0; i <= lines.length; i++) {
    if (i < lines.length && lines[i]!.trim() !== "") continue;
    const block = lines.slice(start, i).join("\n");
    if (PRELOAD_CONTEXT.test(lines.slice(Math.max(0, start - 3), i).join("\n"))) {
      for (const run of preloadRuns(block)) {
        const missing = DEFAULT_PRELOAD.filter((lib) => !run.names.has(lib));
        if (DEFAULT_PRELOAD.length - missing.length >= 4 && missing.length > 0) {
          const line = start + 1 + (block.slice(0, run.offset).match(/\n/g)?.length ?? 0);
          errors.push(
            `line ${line}: preload list lacks ${missing.join(", ")}. The default is ` +
              `${DEFAULT_PRELOAD.join(",")} (manifest runtime.sharedPreload + defaultEnable); copy it ` +
              `whole and append any optional library.`
          );
        }
      }
    }
    start = i + 1;
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
    for await (const file of glob.scan({ cwd: PROJECT_ROOT, dot: true })) {
      if (SKIPPED_DOCS.has(file)) continue;
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
