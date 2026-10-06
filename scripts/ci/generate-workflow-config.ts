#!/usr/bin/env bun
/**
 * Generate workflow configuration from manifest
 *
 * Creates .github/workflow-config.json with manifest-derived values
 * that can be read by GitHub Actions workflows.
 *
 * Run: bun scripts/ci/generate-workflow-config.ts
 */

import path from "path";
import { isAutoCreated, isPreloadedByDefault } from "../config-generator/manifest-loader";
import { MANIFEST_METADATA } from "../extensions/manifest-data";
import { success, info } from "../utils/logger";

interface ManifestEntry {
  name: string;
  kind: "extension" | "tool" | "builtin" | "module";
  enabled?: boolean;
  runtime?: {
    defaultEnable?: boolean;
    sharedPreload?: boolean;
  };
}

interface Manifest {
  entries: ManifestEntry[];
}

/**
 * Workflow configuration derived from manifest
 */
interface WorkflowConfig {
  // PostgreSQL version info
  pgVersion: string;
  pgMajorVersion: string;

  // Image repositories
  registry: string;
  organization: string;
  productionImageName: string;
  testingImageName: string;

  // Default tags
  defaultTag: string;
  defaultTestingTag: string;

  // Extension counts (derived)
  counts: {
    total: number;
    enabled: number;
    preloaded: number;
    autoCreated: number;
  };
}

async function loadManifest(): Promise<Manifest> {
  const manifestPath = path.resolve(
    import.meta.dir,
    "../../docker/postgres/extensions.manifest.json"
  );
  const file = Bun.file(manifestPath);

  if (!(await file.exists())) {
    throw new Error(`Manifest file not found: ${manifestPath}`);
  }

  return await file.json();
}

function deriveConfig(manifest: Manifest): WorkflowConfig {
  const { entries } = manifest;
  const pgMajorVersion = MANIFEST_METADATA.pgVersion.split(".")[0] ?? MANIFEST_METADATA.pgVersion;

  // Count extensions by type
  const total = entries.length;
  const enabled = entries.filter((e) => e.enabled !== false).length;

  const preloaded = entries.filter(isPreloadedByDefault).length;
  const autoCreated = entries.filter(isAutoCreated).length;

  return {
    pgVersion: MANIFEST_METADATA.pgVersion,
    pgMajorVersion,

    registry: "ghcr.io",
    organization: "fluxo-kt",
    productionImageName: "aza-pg",
    testingImageName: "aza-pg-testing",

    defaultTag: `${pgMajorVersion}-single-node`,
    defaultTestingTag: `testing-main`,

    counts: {
      total,
      enabled,
      preloaded,
      autoCreated,
    },
  };
}

async function main(): Promise<string> {
  info("Generating workflow configuration from manifest...");

  const manifest = await loadManifest();
  const config = deriveConfig(manifest);

  const outputPath = path.resolve(import.meta.dir, "../../.github/workflow-config.json");

  await Bun.write(outputPath, JSON.stringify(config, null, 2) + "\n");

  success(`Generated ${outputPath}`);
  console.log(`  - PG version: ${config.pgVersion} (major: ${config.pgMajorVersion})`);
  console.log(`  - Total extensions: ${config.counts.total}`);
  console.log(`  - Enabled: ${config.counts.enabled}`);
  console.log(`  - Preloaded: ${config.counts.preloaded}`);
  console.log(`  - Auto-created: ${config.counts.autoCreated}`);

  return outputPath;
}

// Export for use by generate-all.ts
export { main as generateWorkflowConfig };

// Run if executed directly
if (import.meta.main) {
  main().catch((err) => {
    console.error("Failed to generate workflow config:", err);
    process.exit(1);
  });
}
