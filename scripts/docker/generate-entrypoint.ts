#!/usr/bin/env bun
/**
 * Generate docker-auto-config-entrypoint.sh from template using manifest data
 *
 * This script reads the entrypoint template and replaces placeholders with
 * actual values from the extensions manifest.
 *
 * Placeholders:
 * - {{DEFAULT_SHARED_PRELOAD_LIBRARIES}} - Comma-separated list of extensions
 *   where runtime.sharedPreload == true AND runtime.defaultEnable == true AND enabled != false
 *
 * Usage:
 *   bun scripts/docker/generate-entrypoint.ts
 */

import { join } from "node:path";
import { error, info, section, success } from "../utils/logger";

// Paths
const REPO_ROOT = join(import.meta.dir, "../..");
const TEMPLATE_PATH = join(REPO_ROOT, "docker/postgres/docker-auto-config-entrypoint.sh.template");
const OUTPUT_PATH = join(REPO_ROOT, "docker/postgres/docker-auto-config-entrypoint.sh");
const MANIFEST_PATH = join(REPO_ROOT, "docker/postgres/extensions.manifest.json");

interface RuntimeSpec {
  sharedPreload?: boolean;
  defaultEnable?: boolean;
  preloadOnly?: boolean;
  preloadLibraryName?: string;
  notes?: string[];
}

interface ManifestEntry {
  name: string;
  enabled?: boolean;
  runtime?: RuntimeSpec;
}

interface Manifest {
  generatedAt: string;
  entries: ManifestEntry[];
}

/**
 * Read and parse manifest
 */
async function readManifest(): Promise<Manifest> {
  if (!(await Bun.file(MANIFEST_PATH).exists())) {
    throw new Error(`Manifest not found: ${MANIFEST_PATH}`);
  }

  const content = Bun.file(MANIFEST_PATH);
  return (await content.json()) as Manifest;
}

/**
 * Generate comma-separated list of extensions to preload by default
 */
function generateDefaultSharedPreloadLibraries(manifest: Manifest): string {
  // Filter extensions where:
  // 1. runtime.sharedPreload == true
  // 2. runtime.defaultEnable == true
  // 3. enabled != false (i.e., enabled is null or true)
  const preloadExtensions = manifest.entries.filter((entry) => {
    const runtime = entry.runtime;
    if (!runtime) return false;

    const isSharedPreload = runtime.sharedPreload === true;
    const isDefaultEnable = runtime.defaultEnable === true;
    const isEnabled = entry.enabled !== false; // null or true

    return isSharedPreload && isDefaultEnable && isEnabled;
  });

  // Sort alphabetically for consistency
  // Use preloadLibraryName if specified, otherwise use extension name
  const extensionNames = preloadExtensions
    .map((e) => e.runtime?.preloadLibraryName || e.name)
    .sort();

  return extensionNames.join(",");
}

/**
 * Generate entrypoint from template
 */
async function generateEntrypoint(): Promise<void> {
  section("Entrypoint Generation");

  // Read manifest
  info("Reading manifest...");
  const manifest = await readManifest();
  info(`Manifest loaded: ${manifest.entries.length} total entries`);

  // Read template
  info("Reading template...");
  if (!(await Bun.file(TEMPLATE_PATH).exists())) {
    throw new Error(`Template not found: ${TEMPLATE_PATH}`);
  }

  const templateFile = Bun.file(TEMPLATE_PATH);
  let entrypoint = await templateFile.text();

  // Generate DEFAULT_SHARED_PRELOAD_LIBRARIES
  info("Generating DEFAULT_SHARED_PRELOAD_LIBRARIES...");
  const defaultPreloadLibs = generateDefaultSharedPreloadLibraries(manifest);
  info(`Extensions to preload by default: ${defaultPreloadLibs}`);

  // Replace placeholder
  info("Replacing placeholders...");
  entrypoint = entrypoint.replace("{{DEFAULT_SHARED_PRELOAD_LIBRARIES}}", defaultPreloadLibs);

  // Add generation header
  const now = new Date().toISOString();
  const header = `#!/bin/bash
# AUTO-GENERATED FILE - DO NOT EDIT
# Generated at: ${now}
# Generator: scripts/docker/generate-entrypoint.ts
# Template: docker/postgres/docker-auto-config-entrypoint.sh.template
# Manifest: docker/postgres/extensions.manifest.json
# To regenerate: bun run generate

`;

  // Replace the original shebang and add our header
  entrypoint = entrypoint.replace(/^#!\/bin\/bash\n/, header);

  // Write output
  info(`Writing entrypoint to ${OUTPUT_PATH}...`);
  await Bun.write(OUTPUT_PATH, entrypoint);

  success("Entrypoint generated successfully!");

  // Print stats
  const preloadCount = defaultPreloadLibs.split(",").filter((s) => s.length > 0).length;
  console.log("");
  info(`Default preload extensions: ${preloadCount}`);
  info(`Libraries: ${defaultPreloadLibs}`);
}

// Main execution
if (import.meta.main) {
  try {
    await generateEntrypoint();
  } catch (err) {
    error(`Failed to generate entrypoint: ${String(err)}`);
    process.exit(1);
  }
}
