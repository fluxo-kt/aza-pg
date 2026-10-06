#!/usr/bin/env bun
/**
 * Generate IMAGE-CONTENTS.txt for Docker container
 *
 * Creates a human-readable file describing what's included in the container:
 * - PostgreSQL version
 * - Enabled extensions with versions
 * - Tools (pgbackrest, pgbadger, etc.)
 * - Preloaded modules
 *
 * Output is copied into the container at /IMAGE-CONTENTS.txt
 *
 * Run: bun scripts/docker/generate-image-contents.ts
 */

import {
  loadManifest,
  preloadLibraryName,
  type Manifest,
  type ResolvedEntry,
} from "../config-generator/manifest-loader";
import { join } from "node:path";
import { MANIFEST_METADATA } from "../extensions/manifest-data";

const REPO_ROOT = join(import.meta.dir, "../..");

/** Display version: `v<version>`, the pinned commit for an untagged git-ref source, or "builtin". */
function getVersion(entry: ResolvedEntry): string {
  // Priority: pgdgVersion > source tag > pinned commit > "builtin"
  if (entry.pgdgVersion) {
    // Extract version from PGDG format like "2.19-1.pgdg13+1"
    const match = entry.pgdgVersion.match(/^([\d.]+)/);
    return `v${match?.[1] ?? entry.pgdgVersion}`;
  }
  if (entry.source.type === "git") {
    // Strip a release prefix and reduce scoped monorepo tags to the package version.
    const cleaned = entry.source.tag.replace(/^v/, "");
    const scopedVersion = cleaned.split("@").pop();
    return `v${cleaned.includes("@") && scopedVersion ? scopedVersion : cleaned}`;
  }
  if (entry.source.type === "git-ref") return entry.source.commit.slice(0, 8);
  return "builtin";
}

function generateContents(manifest: Manifest): string {
  const lines: string[] = [];
  const pgVersion = MANIFEST_METADATA.pgVersion;

  // Header
  lines.push("╔═══════════════════════════════════════════════════════════════╗");
  lines.push(`║  aza-pg Single-Node PostgreSQL ${pgVersion}`.padEnd(64) + "║");
  lines.push("║  https://github.com/fluxo-kt/aza-pg".padEnd(64) + "║");
  lines.push("╚═══════════════════════════════════════════════════════════════╝");
  lines.push("");

  // Filter enabled entries
  const enabled = manifest.entries.filter((e) => e.enabled !== false);

  // Group by kind
  const extensions = enabled.filter((e) => e.kind === "extension" && !e.runtime?.preloadOnly);
  const sqlOnlySchemas = enabled.filter((e) => e.kind === "extension" && e.runtime?.preloadOnly);
  const builtins = enabled.filter((e) => e.kind === "builtin");
  const tools = enabled.filter((e) => e.kind === "tool");

  // Preloaded modules (default enabled + sharedPreload)
  const preloaded = enabled.filter(
    (e) => e.runtime?.sharedPreload === true && e.runtime?.defaultEnable === true
  );

  // Extensions section
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("EXTENSIONS (CREATE EXTENSION available)");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("");

  // Sort by name
  const sortedExtensions = [...extensions, ...builtins.filter((e) => !e.runtime?.preloadOnly)].sort(
    (a, b) => a.name.localeCompare(b.name)
  );

  for (const ext of sortedExtensions) {
    const versionStr = getVersion(ext);
    const line = `  ${ext.name.padEnd(28)} ${versionStr.padEnd(14)} ${ext.category ?? ""}`;
    lines.push(line.trimEnd());
  }
  lines.push("");
  lines.push(`Total: ${sortedExtensions.length} extensions`);
  lines.push("");

  if (sqlOnlySchemas.length > 0) {
    lines.push("═══════════════════════════════════════════════════════════════");
    lines.push("NON-CREATE-EXTENSION ENTRIES (preload or init managed)");
    lines.push("═══════════════════════════════════════════════════════════════");
    lines.push("");

    for (const schema of sqlOnlySchemas.sort((a, b) => a.name.localeCompare(b.name))) {
      const versionStr = getVersion(schema);
      lines.push(
        `  ${schema.name.padEnd(28)} ${versionStr.padEnd(14)} ${schema.category ?? ""}`.trimEnd()
      );
    }
    lines.push("");
  }

  // Tools section
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("TOOLS (command-line utilities)");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("");

  for (const tool of tools.sort((a, b) => a.name.localeCompare(b.name))) {
    const version = getVersion(tool);
    const versionStr = version === "builtin" ? "" : version;
    lines.push(`  ${tool.name.padEnd(28)} ${versionStr}`);
  }
  lines.push("");

  // Preloaded modules section
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("PRELOADED MODULES (shared_preload_libraries default)");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("");

  const preloadNames = preloaded
    .map((e) => preloadLibraryName(e))
    .sort()
    .join(", ");
  lines.push(`  ${preloadNames}`);
  lines.push("");
  lines.push(`  Configure via POSTGRES_SHARED_PRELOAD_LIBRARIES environment variable.`);
  lines.push("");

  // Footer
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("DOCUMENTATION");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("");
  lines.push("  Repository:     https://github.com/fluxo-kt/aza-pg");
  lines.push("  Extensions:     https://github.com/fluxo-kt/aza-pg/blob/main/docs/EXTENSIONS.md");
  lines.push("  Auto-config:    https://github.com/fluxo-kt/aza-pg/blob/main/docs/AUTO-CONFIG.md");
  lines.push("");

  return lines.join("\n");
}

async function main(): Promise<string> {
  const manifest = await loadManifest(REPO_ROOT);
  const contents = generateContents(manifest);

  const outputPath = join(REPO_ROOT, "docker/postgres/IMAGE-CONTENTS.txt");
  await Bun.write(outputPath, contents);

  console.log(`Generated: ${outputPath}`);
  return outputPath;
}

// Export for use by generate-all.ts
export { main as generateImageContents };

// Run if executed directly
if (import.meta.main) {
  main().catch((err) => {
    console.error("Failed to generate IMAGE-CONTENTS.txt:", err);
    process.exit(1);
  });
}
