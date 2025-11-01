#!/usr/bin/env bun
/**
 * Derive catalog statistics from extension manifest.
 *
 * Dynamically calculates extension counts to eliminate hardcoded numbers in workflows.
 * Supports multiple output formats for different use cases.
 */

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { setGitHubOutput, isGitHubActions } from "./utils/github.ts";

interface ManifestEntry {
  name: string;
  kind: "extension" | "tool" | "builtin" | "module";
  enabled?: boolean;
  runtime?: {
    defaultEnable?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface Manifest {
  entries: ManifestEntry[];
  [key: string]: unknown;
}

interface CatalogStats {
  total: number;
  enabled: number;
  disabled: number;
  extensions: number;
  tools: number;
  builtins: number;
  modules: number;
  enabledExtensions: number;
  enabledTools: number;
  enabledBuiltins: number;
  enabledModules: number;
}

/**
 * Load manifest from JSON file.
 */
async function loadManifest(): Promise<Manifest> {
  const manifestPath = resolve(import.meta.dir, "../docker/postgres/extensions.manifest.json");
  const file = Bun.file(manifestPath);

  if (!(await file.exists())) {
    throw new Error(`Manifest file not found: ${manifestPath}`);
  }

  return await file.json();
}

/**
 * Calculate catalog statistics from manifest.
 */
function deriveCatalogStats(manifest: Manifest): CatalogStats {
  const { entries: extensions } = manifest;

  let enabled = 0;
  let disabled = 0;
  let extensionCount = 0;
  let toolCount = 0;
  let builtinCount = 0;
  let moduleCount = 0;
  let enabledExtensionCount = 0;
  let enabledToolCount = 0;
  let enabledBuiltinCount = 0;
  let enabledModuleCount = 0;

  for (const ext of extensions) {
    const isEnabled = ext.enabled !== false;

    // Count by enabled status
    if (isEnabled) {
      enabled++;
    } else {
      disabled++;
    }

    // Count by kind
    switch (ext.kind) {
      case "extension":
        extensionCount++;
        if (isEnabled) enabledExtensionCount++;
        break;
      case "tool":
        toolCount++;
        if (isEnabled) enabledToolCount++;
        break;
      case "builtin":
        builtinCount++;
        if (isEnabled) enabledBuiltinCount++;
        break;
      case "module":
        moduleCount++;
        if (isEnabled) enabledModuleCount++;
        break;
    }
  }

  return {
    total: extensions.length,
    enabled,
    disabled,
    extensions: extensionCount,
    tools: toolCount,
    builtins: builtinCount,
    modules: moduleCount,
    enabledExtensions: enabledExtensionCount,
    enabledTools: enabledToolCount,
    enabledBuiltins: enabledBuiltinCount,
    enabledModules: enabledModuleCount,
  };
}

/**
 * Format stats as shell variables for eval.
 */
function formatShell(stats: CatalogStats): string {
  return [
    `CATALOG_TOTAL=${stats.total}`,
    `CATALOG_ENABLED=${stats.enabled}`,
    `CATALOG_DISABLED=${stats.disabled}`,
    `CATALOG_EXTENSIONS=${stats.extensions}`,
    `CATALOG_TOOLS=${stats.tools}`,
    `CATALOG_BUILTINS=${stats.builtins}`,
    `CATALOG_MODULES=${stats.modules}`,
    `CATALOG_ENABLED_EXTENSIONS=${stats.enabledExtensions}`,
    `CATALOG_ENABLED_TOOLS=${stats.enabledTools}`,
    `CATALOG_ENABLED_BUILTINS=${stats.enabledBuiltins}`,
    `CATALOG_ENABLED_MODULES=${stats.enabledModules}`,
  ].join("\n");
}

/**
 * Format stats as JSON.
 */
function formatJSON(stats: CatalogStats): string {
  return JSON.stringify(stats, null, 2);
}

/**
 * Format stats as human-readable text.
 */
function formatText(stats: CatalogStats): string {
  return [
    `Catalog Statistics:`,
    `  Total entries: ${stats.total}`,
    `  Enabled: ${stats.enabled}`,
    `  Disabled: ${stats.disabled}`,
    ``,
    `Breakdown by kind:`,
    `  Extensions: ${stats.extensions} (${stats.enabledExtensions} enabled)`,
    `  Tools: ${stats.tools} (${stats.enabledTools} enabled)`,
    `  Builtins: ${stats.builtins} (${stats.enabledBuiltins} enabled)`,
    `  Modules: ${stats.modules} (${stats.enabledModules} enabled)`,
  ].join("\n");
}

async function main() {
  const { values } = parseArgs({
    options: {
      format: {
        type: "string",
        short: "f",
        default: "text",
      },
      help: {
        type: "boolean",
        short: "h",
      },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
Usage: bun scripts/ci/derive-catalog-stats.ts [options]

Derive catalog statistics from extension manifest.

Options:
  -f, --format <format>  Output format: text, json, shell (default: text)
  -h, --help            Show this help message

Output Formats:
  text   - Human-readable text (default)
  json   - JSON object
  shell  - Shell variables (for eval in workflows)

Examples:
  # Human-readable output
  bun scripts/ci/derive-catalog-stats.ts

  # JSON output
  bun scripts/ci/derive-catalog-stats.ts --format=json

  # Shell variables (for GitHub Actions)
  eval "$(bun scripts/ci/derive-catalog-stats.ts --format=shell)"
  echo "Total: $CATALOG_TOTAL, Enabled: $CATALOG_ENABLED"

  # Write to GitHub Actions outputs
  bun scripts/ci/derive-catalog-stats.ts --format=github-output
    `);
    process.exit(0);
  }

  // Load manifest and calculate stats
  const manifest = await loadManifest();
  const stats = deriveCatalogStats(manifest);
  const format = values.format as string;

  // Output based on format
  switch (format) {
    case "shell":
      console.log(formatShell(stats));
      break;

    case "json":
      console.log(formatJSON(stats));
      break;

    case "text":
      console.log(formatText(stats));
      break;

    case "github-output":
      // Write to GitHub Actions outputs
      if (!isGitHubActions()) {
        console.error("ERROR: github-output format requires GitHub Actions environment");
        process.exit(1);
      }
      await setGitHubOutput("catalog_total", stats.total);
      await setGitHubOutput("catalog_enabled", stats.enabled);
      await setGitHubOutput("catalog_disabled", stats.disabled);
      await setGitHubOutput("catalog_extensions", stats.extensions);
      await setGitHubOutput("catalog_tools", stats.tools);
      await setGitHubOutput("catalog_builtins", stats.builtins);
      await setGitHubOutput("catalog_modules", stats.modules);
      await setGitHubOutput("catalog_enabled_extensions", stats.enabledExtensions);
      await setGitHubOutput("catalog_enabled_tools", stats.enabledTools);
      await setGitHubOutput("catalog_enabled_builtins", stats.enabledBuiltins);
      await setGitHubOutput("catalog_enabled_modules", stats.enabledModules);
      console.log("✅ Catalog stats written to GitHub outputs");
      break;

    default:
      console.error(`ERROR: Unknown format "${format}". Use: text, json, shell, or github-output`);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error("ERROR:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
