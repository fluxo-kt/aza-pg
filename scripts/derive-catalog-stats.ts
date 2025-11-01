#!/usr/bin/env bun
/**
 * Derive Catalog Statistics
 *
 * Reads extensions.manifest.json and outputs key statistics.
 * Used by CI/CD workflows to make labels and metadata manifest-driven.
 *
 * Usage:
 *   bun scripts/derive-catalog-stats.ts [--format=shell|json]
 *
 * Output formats:
 *   shell: ENV_VAR=value format for GitHub Actions
 *   json:  JSON object for programmatic use
 */

import { join } from "path";

const PROJECT_ROOT = join(import.meta.dir, "..");
const MANIFEST_PATH = join(PROJECT_ROOT, "docker/postgres/extensions.manifest.json");

interface ManifestEntry {
  name: string;
  kind: "builtin" | "extension" | "tool";
  enabled?: boolean;
}

interface Manifest {
  entries: ManifestEntry[];
}

interface CatalogStats {
  total: number;
  enabled: number;
  disabled: number;
  builtins: number;
  extensions: number;
  tools: number;
  enabledBuiltins: number;
  enabledExtensions: number;
  enabledTools: number;
}

async function main() {
  const args = Bun.argv.slice(2);
  const format = args.find((arg) => arg.startsWith("--format="))?.split("=")[1] || "shell";

  // Read manifest
  const manifestFile = Bun.file(MANIFEST_PATH);
  if (!(await manifestFile.exists())) {
    console.error(`ERROR: Manifest not found at ${MANIFEST_PATH}`);
    process.exit(1);
  }

  const manifest: Manifest = await manifestFile.json();
  const entries = manifest.entries;

  // Calculate statistics
  const enabled = entries.filter((e) => e.enabled !== false);
  const disabled = entries.filter((e) => e.enabled === false);

  const stats: CatalogStats = {
    total: entries.length,
    enabled: enabled.length,
    disabled: disabled.length,
    builtins: entries.filter((e) => e.kind === "builtin").length,
    extensions: entries.filter((e) => e.kind === "extension").length,
    tools: entries.filter((e) => e.kind === "tool").length,
    enabledBuiltins: enabled.filter((e) => e.kind === "builtin").length,
    enabledExtensions: enabled.filter((e) => e.kind === "extension").length,
    enabledTools: enabled.filter((e) => e.kind === "tool").length,
  };

  // Output in requested format
  if (format === "json") {
    console.log(JSON.stringify(stats, null, 2));
  } else if (format === "shell") {
    console.log(`CATALOG_TOTAL=${stats.total}`);
    console.log(`CATALOG_ENABLED=${stats.enabled}`);
    console.log(`CATALOG_DISABLED=${stats.disabled}`);
    console.log(`CATALOG_BUILTINS=${stats.builtins}`);
    console.log(`CATALOG_EXTENSIONS=${stats.extensions}`);
    console.log(`CATALOG_TOOLS=${stats.tools}`);
    console.log(`CATALOG_ENABLED_BUILTINS=${stats.enabledBuiltins}`);
    console.log(`CATALOG_ENABLED_EXTENSIONS=${stats.enabledExtensions}`);
    console.log(`CATALOG_ENABLED_TOOLS=${stats.enabledTools}`);
  } else {
    console.error(`ERROR: Unknown format '${format}'. Use --format=shell or --format=json`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
