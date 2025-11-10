#!/usr/bin/env bun

/**
 * Generate version-info.txt and version-info.json for container image
 *
 * Usage:
 *   bun generate-version-info.ts [txt|json|both] [--pg-version=MM.mm]
 *
 * Arguments:
 *   txt|json|both     Output format (default: txt)
 *   --pg-version      PostgreSQL version (default: 18.0)
 *
 * Human-readable (.txt): Self-documenting image contents for `cat /etc/postgresql/version-info.txt`
 * Machine-readable (.json): Structured metadata for automation and tooling
 */

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
    install_via?: "pgdg";
    disabledReason?: string;
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

// Parse command-line arguments
const args = Bun.argv.slice(2);
const outputMode = args.find((arg) => !arg.startsWith("--")) ?? "txt";
const pgVersionArg = args.find((arg) => arg.startsWith("--pg-version="))?.split("=")[1];
const pgVersion = pgVersionArg ?? "18.0";

// Support both local dev and Docker build contexts
// In Docker: manifest copied to /tmp/extensions.manifest.json (same dir as script)
// In local: manifest at ../docker/postgres/extensions.manifest.json
const dockerManifestPath = join(import.meta.dir, "extensions.manifest.json");
const localManifestPath = join(import.meta.dir, "..", "docker/postgres/extensions.manifest.json");

try {
  const dockerFile = Bun.file(dockerManifestPath);
  const localFile = Bun.file(localManifestPath);

  const manifestFile = (await dockerFile.exists()) ? dockerFile : localFile;
  const manifest: Manifest = await manifestFile.json();

  // Build timestamp (YYYYMMDDHHNN format)
  const now = new Date();
  const buildTimestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
  ].join("");

  // Calculate statistics
  const allEntries = manifest.entries;
  const enabledEntries = allEntries.filter((e) => e.enabled ?? true);
  const disabledEntries = allEntries.filter((e) => (e.enabled ?? true) === false);

  const preloaded = enabledEntries.filter((e) => e.runtime?.sharedPreload);
  const autoCreated = enabledEntries.filter(
    (e) => e.runtime?.defaultEnable && !e.runtime?.preloadOnly && e.kind !== "tool"
  );
  const available = enabledEntries.filter(
    (e) => e.kind === "extension" && !e.runtime?.defaultEnable && !e.runtime?.preloadOnly
  );
  const tools = enabledEntries.filter((e) => e.kind === "tool");
  const builtins = enabledEntries.filter((e) => e.kind === "builtin");
  const compiledFromSource = enabledEntries.filter(
    (e) => (e.kind === "extension" || e.kind === "tool") && !e.install_via
  );

  // Generate machine-readable JSON
  const versionInfo = {
    postgres_version: pgVersion,
    build_timestamp: buildTimestamp,
    build_type: "single-node",
    manifest_generated: manifest.generatedAt,
    extensions: {
      total: allEntries.length,
      enabled: enabledEntries.length,
      disabled: disabledEntries.length,
    },
    categories: {
      preloaded: preloaded.length,
      auto_created: autoCreated.length,
      builtin: builtins.length,
      pgdg: enabledEntries.filter((e) => e.install_via === "pgdg").length,
      compiled: compiledFromSource.length,
      tools: tools.length,
    },
    preloaded_modules: preloaded
      .map((e) => e.displayName ?? e.name)
      .toSorted((a, b) => a.localeCompare(b)),
    disabled_extensions: disabledEntries.map((e) => ({
      name: e.name,
      reason: e.disabledReason ?? "No reason provided",
    })),
  };

  // Generate human-readable text
  const lines: string[] = [];

  // Header
  const pgMajor = pgVersion.split(".")[0];
  lines.push("===============================================================================");
  lines.push(`aza-pg - PostgreSQL ${pgMajor} with Extensions`);
  lines.push("===============================================================================");
  lines.push("");
  lines.push(`Build Date: ${now.toISOString().split("T")[0]}`);
  lines.push(`Manifest Generated: ${manifest.generatedAt}`);
  lines.push("");

  // PostgreSQL version (note: actual package version determined at build time)
  lines.push("POSTGRESQL");
  lines.push(`  PostgreSQL ${pgVersion} (upstream tag version)`);
  lines.push("");

  // Preloaded modules
  if (preloaded.length > 0) {
    lines.push("PRELOADED MODULES");
    for (const entry of preloaded.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const display = entry.displayName ?? entry.name;
      const version =
        entry.source.tag?.replace(/^v/, "") ?? entry.source.ref?.slice(0, 7) ?? "builtin";
      const type = entry.runtime?.preloadOnly ? "module" : "extension";
      lines.push(`  ${display.padEnd(25)} ${version.padEnd(15)} (${type})`);
    }
    lines.push("");
  }

  // Auto-created extensions
  if (autoCreated.length > 0) {
    lines.push("AUTO-CREATED EXTENSIONS");
    for (const entry of autoCreated.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const display = entry.displayName ?? entry.name;
      const version =
        entry.source.tag?.replace(/^v/, "") ?? entry.source.ref?.slice(0, 7) ?? "builtin";
      lines.push(`  ${display.padEnd(25)} ${version}`);
    }
    lines.push("");
  }

  // Available extensions (not auto-created)
  if (available.length > 0) {
    lines.push("AVAILABLE EXTENSIONS");
    for (const entry of available.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const display = entry.displayName ?? entry.name;
      const version =
        entry.source.tag?.replace(/^v/, "") ?? entry.source.ref?.slice(0, 7) ?? "installed";
      lines.push(`  ${display.padEnd(25)} ${version}`);
    }
    lines.push("");
  }

  // Tools
  if (tools.length > 0) {
    lines.push("TOOLS");
    for (const entry of tools.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const display = entry.displayName ?? entry.name;
      const version =
        entry.source.tag?.replace(/^v/, "") ?? entry.source.ref?.slice(0, 7) ?? "installed";
      lines.push(`  ${display.padEnd(25)} ${version}`);
    }
    lines.push("");
  }

  // Summary
  const totalEnabled = enabledEntries.length;
  const totalExtensions = enabledEntries.filter((e) => e.kind === "extension").length;

  lines.push("SUMMARY");
  lines.push(`  Total Enabled: ${totalEnabled}`);
  lines.push(`  Extensions: ${totalExtensions}`);
  lines.push(`  Tools: ${tools.length}`);
  lines.push(`  Preloaded: ${preloaded.length}`);
  lines.push(`  Auto-created: ${autoCreated.length}`);
  lines.push("");

  lines.push("===============================================================================");
  lines.push("Use CREATE EXTENSION <name>; to enable available extensions");
  lines.push("Documentation: https://github.com/fluxo-kt/aza-pg");
  lines.push("===============================================================================");

  // Output based on mode
  if (outputMode === "json") {
    // JSON output only
    console.log(JSON.stringify(versionInfo, null, 2));
  } else if (outputMode === "txt") {
    // Text output only
    console.log(lines.join("\n"));
  } else if (outputMode === "both") {
    // Both outputs (for local testing)
    console.log("=== TEXT OUTPUT ===");
    console.log(lines.join("\n"));
    console.log("\n=== JSON OUTPUT ===");
    console.log(JSON.stringify(versionInfo, null, 2));
  } else {
    console.error(`Unknown output mode: ${outputMode}. Use 'txt', 'json', or 'both'.`);
    process.exit(1);
  }
} catch (error) {
  console.error("Failed to generate version-info:", error);
  process.exit(1);
}
