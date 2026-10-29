#!/usr/bin/env bun
/**
 * Derive catalog statistics from extension manifest.
 *
 * Dynamically calculates extension counts to eliminate hardcoded numbers in workflows.
 * Supports multiple output formats for different use cases.
 */

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { loadManifest, type Manifest } from "./config-generator/manifest-loader";
import { setGitHubOutput, isGitHubActions } from "./utils/github";

interface CatalogStats {
  total: number;
  enabled: number;
  disabled: number;
  extensions: number;
  tools: number;
  builtins: number;
  enabledExtensions: number;
  enabledTools: number;
  enabledBuiltins: number;
}

/**
 * Load manifest from JSON file.
 */
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
  let enabledExtensionCount = 0;
  let enabledToolCount = 0;
  let enabledBuiltinCount = 0;

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
    }
  }

  return {
    total: extensions.length,
    enabled,
    disabled,
    extensions: extensionCount,
    tools: toolCount,
    builtins: builtinCount,
    enabledExtensions: enabledExtensionCount,
    enabledTools: enabledToolCount,
    enabledBuiltins: enabledBuiltinCount,
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
    `CATALOG_ENABLED_EXTENSIONS=${stats.enabledExtensions}`,
    `CATALOG_ENABLED_TOOLS=${stats.enabledTools}`,
    `CATALOG_ENABLED_BUILTINS=${stats.enabledBuiltins}`,
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
Usage: bun scripts/derive-catalog-stats.ts [options]

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
  bun scripts/derive-catalog-stats.ts

  # JSON output
  bun scripts/derive-catalog-stats.ts --format=json

  # Shell variables (for GitHub Actions)
  eval "$(bun scripts/derive-catalog-stats.ts --format=shell)"
  echo "Total: $CATALOG_TOTAL, Enabled: $CATALOG_ENABLED"

  # Write to GitHub Actions outputs
  bun scripts/derive-catalog-stats.ts --format=github-output
    `);
    process.exit(0);
  }

  // Load manifest and calculate stats
  const manifest = await loadManifest(resolve(import.meta.dir, ".."));
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
      await setGitHubOutput("catalog_enabled_extensions", stats.enabledExtensions);
      await setGitHubOutput("catalog_enabled_tools", stats.enabledTools);
      await setGitHubOutput("catalog_enabled_builtins", stats.enabledBuiltins);
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
