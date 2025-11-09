#!/usr/bin/env bun

/**
 * Generate version-info.txt for container image
 * Self-documenting image contents: PostgreSQL version, extensions, tools
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

interface Manifest {
  generatedAt: string;
  entries: Array<{
    name: string;
    displayName?: string;
    kind: "extension" | "tool" | "builtin";
    category: string;
    description: string;
    enabled?: boolean;
    runtime?: {
      sharedPreload?: boolean;
      defaultEnable?: boolean;
      preloadOnly?: boolean;
    };
    source: {
      type: string;
      tag?: string;
      ref?: string;
    };
  }>;
}

// Support both local dev and Docker build contexts
// In Docker: manifest copied to /tmp/extensions.manifest.json (same dir as script)
// In local: manifest at ../docker/postgres/extensions.manifest.json
const dockerManifestPath = join(import.meta.dir, "extensions.manifest.json");
const localManifestPath = join(import.meta.dir, "..", "docker/postgres/extensions.manifest.json");
const manifestPath = existsSync(dockerManifestPath) ? dockerManifestPath : localManifestPath;

try {
  const manifestJson = readFileSync(manifestPath, "utf-8");
  const manifest: Manifest = JSON.parse(manifestJson);

  const lines: string[] = [];

  // Header
  lines.push("===============================================================================");
  lines.push("aza-pg - PostgreSQL 18 with Extensions");
  lines.push("===============================================================================");
  lines.push("");
  lines.push(`Build Date: ${new Date().toISOString().split("T")[0]}`);
  lines.push(`Manifest Generated: ${manifest.generatedAt}`);
  lines.push("");

  // PostgreSQL version
  lines.push("POSTGRESQL");
  lines.push("  PostgreSQL 18.0 (Debian 18.0-1.pgdg13+3)");
  lines.push("");

  // Preloaded modules
  const preloaded = manifest.entries.filter((e) => (e.enabled ?? true) && e.runtime?.sharedPreload);
  if (preloaded.length > 0) {
    lines.push("PRELOADED MODULES");
    for (const entry of preloaded.sort((a, b) => a.name.localeCompare(b.name))) {
      const display = entry.displayName ?? entry.name;
      const version =
        entry.source.tag?.replace(/^v/, "") ?? entry.source.ref?.slice(0, 7) ?? "builtin";
      const type = entry.runtime?.preloadOnly ? "module" : "extension";
      lines.push(`  ${display.padEnd(25)} ${version.padEnd(15)} (${type})`);
    }
    lines.push("");
  }

  // Auto-created extensions
  const autoCreated = manifest.entries.filter(
    (e) =>
      (e.enabled ?? true) &&
      e.runtime?.defaultEnable &&
      !e.runtime?.preloadOnly &&
      e.kind !== "tool"
  );
  if (autoCreated.length > 0) {
    lines.push("AUTO-CREATED EXTENSIONS");
    for (const entry of autoCreated.sort((a, b) => a.name.localeCompare(b.name))) {
      const display = entry.displayName ?? entry.name;
      const version =
        entry.source.tag?.replace(/^v/, "") ?? entry.source.ref?.slice(0, 7) ?? "builtin";
      lines.push(`  ${display.padEnd(25)} ${version}`);
    }
    lines.push("");
  }

  // Available extensions (not auto-created)
  const available = manifest.entries.filter(
    (e) =>
      (e.enabled ?? true) &&
      e.kind === "extension" &&
      !e.runtime?.defaultEnable &&
      !e.runtime?.preloadOnly
  );
  if (available.length > 0) {
    lines.push("AVAILABLE EXTENSIONS");
    for (const entry of available.sort((a, b) => a.name.localeCompare(b.name))) {
      const display = entry.displayName ?? entry.name;
      const version =
        entry.source.tag?.replace(/^v/, "") ?? entry.source.ref?.slice(0, 7) ?? "installed";
      lines.push(`  ${display.padEnd(25)} ${version}`);
    }
    lines.push("");
  }

  // Tools
  const tools = manifest.entries.filter((e) => (e.enabled ?? true) && e.kind === "tool");
  if (tools.length > 0) {
    lines.push("TOOLS");
    for (const entry of tools.sort((a, b) => a.name.localeCompare(b.name))) {
      const display = entry.displayName ?? entry.name;
      const version =
        entry.source.tag?.replace(/^v/, "") ?? entry.source.ref?.slice(0, 7) ?? "installed";
      lines.push(`  ${display.padEnd(25)} ${version}`);
    }
    lines.push("");
  }

  // Summary
  const totalEnabled = manifest.entries.filter((e) => e.enabled ?? true).length;
  const totalExtensions = manifest.entries.filter(
    (e) => (e.enabled ?? true) && e.kind === "extension"
  ).length;
  const totalTools = tools.length;

  lines.push("SUMMARY");
  lines.push(`  Total Enabled: ${totalEnabled}`);
  lines.push(`  Extensions: ${totalExtensions}`);
  lines.push(`  Tools: ${totalTools}`);
  lines.push(`  Preloaded: ${preloaded.length}`);
  lines.push(`  Auto-created: ${autoCreated.length}`);
  lines.push("");

  lines.push("===============================================================================");
  lines.push("Use CREATE EXTENSION <name>; to enable available extensions");
  lines.push("Documentation: https://github.com/fluxo-kt/aza-pg");
  lines.push("===============================================================================");

  console.log(lines.join("\n"));
} catch (error) {
  console.error("Failed to generate version-info.txt:", error);
  process.exit(1);
}
