#!/usr/bin/env bun
/**
 * Documentation Data Generator
 *
 * Reads extensions.manifest.json and generates derived data for documentation:
 * - Catalog totals (total, enabled, disabled)
 * - Extension counts by kind (builtin, extension, tool)
 * - Separate arrays for builtins, extensions, tools
 * - Disabled entries tracking
 * - Preloaded modules vs extensions distinction
 * - Auto-created extensions list
 * - Category groupings
 * - Memory tier allocation tables
 *
 * Output: docs/.generated/docs-data.json
 */

import { join } from "node:path";
import { info, success, error } from "./utils/logger.ts";

// Derive project root from current file location (scripts/generate-docs-data.ts)
const PROJECT_ROOT = join(import.meta.dir, "..");
const MANIFEST_PATH = join(PROJECT_ROOT, "docker/postgres/extensions.manifest.json");
const OUTPUT_PATH = join(PROJECT_ROOT, "docs/.generated/docs-data.json");

interface ManifestEntry {
  name: string;
  kind: "builtin" | "extension" | "tool";
  category: string;
  install_via?: "pgdg" | string;
  runtime: {
    sharedPreload: boolean;
    defaultEnable: boolean;
    preloadOnly?: boolean;
  };
  enabled?: boolean; // Optional, defaults to true
}

interface Manifest {
  generatedAt: string;
  entries: ManifestEntry[];
}

interface MemoryTier {
  ram: string;
  shared_buffers: string;
  effective_cache_size: string;
  work_mem: string;
  maintenance_work_mem: string;
  max_connections: number;
}

interface DocsData {
  generatedAt: string;
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
  builtins: string[];
  extensions: string[];
  tools: string[];
  disabled: {
    extensions: string[];
    tools: string[];
  };
  preloaded: {
    modules: string[];
    extensions: string[];
  };
  autoCreated: string[];
  byCategory: {
    [category: string]: string[];
  };
  memoryTiers: MemoryTier[];
}

/**
 * Calculate memory tiers based on total RAM
 */
function calculateMemoryTiers(): MemoryTier[] {
  return [
    {
      ram: "2GB",
      shared_buffers: "512MB",
      effective_cache_size: "1536MB",
      work_mem: "4MB",
      maintenance_work_mem: "64MB",
      max_connections: 120,
    },
    {
      ram: "4GB",
      shared_buffers: "1024MB",
      effective_cache_size: "3072MB",
      work_mem: "5MB",
      maintenance_work_mem: "128MB",
      max_connections: 200,
    },
    {
      ram: "8GB",
      shared_buffers: "2048MB",
      effective_cache_size: "6144MB",
      work_mem: "10MB",
      maintenance_work_mem: "256MB",
      max_connections: 200,
    },
    {
      ram: "16GB",
      shared_buffers: "4096MB",
      effective_cache_size: "12288MB",
      work_mem: "20MB",
      maintenance_work_mem: "512MB",
      max_connections: 200,
    },
    {
      ram: "32GB",
      shared_buffers: "6553MB",
      effective_cache_size: "24576MB",
      work_mem: "32MB",
      maintenance_work_mem: "1024MB",
      max_connections: 200,
    },
  ];
}

async function main() {
  info("Generating documentation data from manifest...");

  // Read manifest
  const manifestFile = Bun.file(MANIFEST_PATH);
  if (!(await manifestFile.exists())) {
    error(`Manifest not found at ${MANIFEST_PATH}`);
    process.exit(1);
  }

  const manifest: Manifest = await manifestFile.json();
  const entries = manifest.entries;

  // Separate enabled and disabled entries
  // By default, entries are enabled unless explicitly set to false
  const enabledEntries = entries.filter((e) => e.enabled !== false);
  const disabledEntries = entries.filter((e) => e.enabled === false);

  // Count by kind (enabled only)
  const byKind = {
    builtin: enabledEntries.filter((e) => e.kind === "builtin").length,
    extension: enabledEntries.filter((e) => e.kind === "extension").length,
    tool: enabledEntries.filter((e) => e.kind === "tool").length,
  };

  // Builtins: kind=builtin (enabled only)
  const builtins = enabledEntries
    .filter((e) => e.kind === "builtin")
    .map((e) => e.name)
    .toSorted();

  // Extensions: kind=extension (enabled only)
  const extensions = enabledEntries
    .filter((e) => e.kind === "extension")
    .map((e) => e.name)
    .toSorted();

  // Tools: kind=tool (enabled only)
  const tools = enabledEntries
    .filter((e) => e.kind === "tool")
    .map((e) => e.name)
    .toSorted();

  // Disabled entries by kind
  const disabledExtensions = disabledEntries
    .filter((e) => e.kind === "extension")
    .map((e) => e.name)
    .toSorted();

  const disabledTools = disabledEntries
    .filter((e) => e.kind === "tool")
    .map((e) => e.name)
    .toSorted();

  // Preloaded modules (preloadOnly=true, no CREATE EXTENSION)
  const preloadedModules = enabledEntries
    .filter((e) => e.runtime.sharedPreload && e.runtime.defaultEnable && e.runtime.preloadOnly)
    .map((e) => e.name)
    .toSorted();

  // Preloaded extensions (sharedPreload=true, defaultEnable=true, NOT preloadOnly)
  const preloadedExtensions = enabledEntries
    .filter((e) => e.runtime.sharedPreload && e.runtime.defaultEnable && !e.runtime.preloadOnly)
    .map((e) => e.name)
    .toSorted();

  // Auto-created extensions (from 01-extensions.sql)
  // Dynamically derived from manifest entries with defaultEnable=true (not preloadOnly)
  const autoCreated = enabledEntries
    .filter((e) => e.runtime?.defaultEnable && !e.runtime?.preloadOnly)
    .map((e) => e.name)
    .toSorted();

  // Group by category (enabled entries only)
  const byCategory: { [category: string]: string[] } = {};
  for (const entry of enabledEntries) {
    if (!byCategory[entry.category]) {
      byCategory[entry.category] = [];
    }
    byCategory[entry.category]!.push(entry.name);
  }
  // Sort each category's entries
  for (const category of Object.keys(byCategory)) {
    byCategory[category]!.sort();
  }

  // Generate data
  const docsData: DocsData = {
    generatedAt: new Date().toISOString(),
    catalog: {
      total: entries.length,
      enabled: enabledEntries.length,
      disabled: disabledEntries.length,
    },
    byKind,
    builtins,
    extensions,
    tools,
    disabled: {
      extensions: disabledExtensions,
      tools: disabledTools,
    },
    preloaded: {
      modules: preloadedModules,
      extensions: preloadedExtensions,
    },
    autoCreated,
    byCategory,
    memoryTiers: calculateMemoryTiers(),
  };

  // Ensure output directory exists
  const outputDir = OUTPUT_PATH.substring(0, OUTPUT_PATH.lastIndexOf("/"));
  await Bun.write(Bun.file(outputDir + "/.gitkeep"), "");

  // Write output
  await Bun.write(OUTPUT_PATH, JSON.stringify(docsData, null, 2) + "\n");

  // Format with Prettier for consistent output across platforms
  info("Formatting generated JSON with Prettier...");
  const prettierProcess = Bun.spawn(["prettier", "--write", OUTPUT_PATH], {
    cwd: PROJECT_ROOT,
  });

  const prettierExit = await prettierProcess.exited;
  if (prettierExit !== 0) {
    error(`Prettier formatting failed with exit code ${prettierExit}`);
    process.exit(1);
  }

  success(`Generated docs data: ${OUTPUT_PATH}`);
  info(
    `Catalog total: ${docsData.catalog.total} (enabled: ${docsData.catalog.enabled}, disabled: ${docsData.catalog.disabled})`
  );
  info(`  - Builtin: ${byKind.builtin}`);
  info(`  - Extensions: ${byKind.extension}`);
  info(`  - Tools: ${byKind.tool}`);
  info(`Preloaded modules: ${preloadedModules.length} (${preloadedModules.join(", ")})`);
  info(`Preloaded extensions: ${preloadedExtensions.length} (${preloadedExtensions.join(", ")})`);
  info(`Auto-created: ${autoCreated.length} (${autoCreated.join(", ")})`);
}

main().catch((err) => {
  error(`Failed to generate docs data: ${err.message}`);
  process.exit(1);
});
