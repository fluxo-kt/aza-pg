#!/usr/bin/env bun
/**
 * Documentation Data Generator
 *
 * Reads extensions.manifest.json and generates derived data for documentation:
 * - Extension counts by kind, install_via
 * - Tools vs Extensions classification
 * - Preload libraries list
 * - Memory tier allocation tables
 *
 * Output: docs/.generated/docs-data.json
 */

import { join } from "path";
import { info, success, error } from "./utils/logger.ts";

// Derive project root from current file location (scripts/generate-docs-data.ts)
const PROJECT_ROOT = join(import.meta.dir, "..");
const MANIFEST_PATH = join(PROJECT_ROOT, "docker/postgres/extensions.manifest.json");
const OUTPUT_PATH = join(PROJECT_ROOT, "docs/.generated/docs-data.json");

interface ManifestEntry {
  name: string;
  kind: "builtin" | "extension" | "tool";
  install_via?: "pgdg" | string;
  runtime: {
    sharedPreload: boolean;
    defaultEnable: boolean;
  };
  enabled: boolean;
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
  extensions: {
    total: number;
    byKind: {
      builtin: number;
      extension: number;
      tool: number;
    };
    byInstallVia: {
      pgdg: number;
      compiled: number;
    };
    tools: string[];
    extensions: string[];
    preloadLibraries: string[];
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

  // Calculate counts
  const enabledEntries = entries.filter((e) => e.enabled);
  const byKind = {
    builtin: enabledEntries.filter((e) => e.kind === "builtin").length,
    extension: enabledEntries.filter((e) => e.kind === "extension").length,
    tool: enabledEntries.filter((e) => e.kind === "tool").length,
  };

  const byInstallVia = {
    pgdg: enabledEntries.filter((e) => e.install_via === "pgdg").length,
    compiled: enabledEntries.filter((e) => e.install_via !== "pgdg" && e.kind !== "builtin").length,
  };

  // Tools: kind=tool (no CREATE EXTENSION needed)
  const tools = enabledEntries
    .filter((e) => e.kind === "tool")
    .map((e) => e.name)
    .toSorted();

  // Extensions: kind=extension or kind=builtin (need CREATE EXTENSION, except plpgsql)
  const extensions = enabledEntries
    .filter((e) => (e.kind === "extension" || e.kind === "builtin") && e.name !== "plpgsql")
    .map((e) => e.name)
    .toSorted();

  // Preload libraries: sharedPreload=true AND defaultEnable=true
  const preloadLibraries = enabledEntries
    .filter((e) => e.runtime.sharedPreload && e.runtime.defaultEnable)
    .map((e) => e.name)
    .toSorted();

  // Generate data
  const docsData: DocsData = {
    generatedAt: new Date().toISOString(),
    extensions: {
      total: enabledEntries.length,
      byKind,
      byInstallVia,
      tools,
      extensions,
      preloadLibraries,
    },
    memoryTiers: calculateMemoryTiers(),
  };

  // Ensure output directory exists
  const outputDir = OUTPUT_PATH.substring(0, OUTPUT_PATH.lastIndexOf("/"));
  await Bun.write(Bun.file(outputDir + "/.gitkeep"), "");

  // Write output
  await Bun.write(OUTPUT_PATH, JSON.stringify(docsData, null, 2) + "\n");

  success(`Generated docs data: ${OUTPUT_PATH}`);
  info(`Total extensions: ${docsData.extensions.total}`);
  info(`  - Builtin: ${byKind.builtin}`);
  info(`  - Extensions: ${byKind.extension}`);
  info(`  - Tools: ${byKind.tool}`);
  info(`Preload libraries: ${preloadLibraries.length} (${preloadLibraries.join(", ")})`);
}

main().catch((err) => {
  error(`Failed to generate docs data: ${err.message}`);
  process.exit(1);
});
