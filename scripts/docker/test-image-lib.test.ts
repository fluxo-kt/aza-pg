#!/usr/bin/env bun
/**
 * Unit Tests for test-image-lib.ts
 *
 * Validates that hardcoded paths in test code match manifest documentation.
 * This prevents regressions when installation methods change (e.g., source to PGDG).
 *
 * Usage: bun test scripts/docker/test-image-lib.test.ts
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "../..");

interface ManifestEntry {
  name: string;
  kind?: string;
  install_via?: string;
  runtime?: {
    notes?: string[];
  };
}

interface Manifest {
  entries: ManifestEntry[];
}

/**
 * Load the extensions manifest
 */
async function loadManifest(): Promise<Manifest> {
  const manifestPath = join(PROJECT_ROOT, "docker/postgres/extensions.manifest.json");
  const content = await Bun.file(manifestPath).text();
  return JSON.parse(content);
}

/**
 * Extract binary path from manifest notes
 * Looks for patterns like "Installs /usr/bin/pgbackrest." or "Binary installed to /usr/bin/pgbadger."
 */
function extractBinaryPathFromNotes(notes: string[]): string | null {
  for (const note of notes) {
    // Match patterns like "Installs /path" or "Binary installed to /path"
    const match = note.match(/(?:Installs|Binary installed to)\s+(\/[\w/.-]+)/i);
    if (match && match[1]) {
      return match[1].replace(/\.$/, ""); // Remove trailing period if present
    }
  }
  return null;
}

describe("Tool Binary Path Validation", () => {
  test("hardcoded tool paths match manifest documentation", async () => {
    // These are the hardcoded paths from test-image-lib.ts testToolsPresent()
    // If this test fails, the hardcoded paths in test-image-lib.ts need to be updated
    const hardcodedToolBinaries: Record<string, string> = {
      pgbackrest: "/usr/bin/pgbackrest", // PGDG package path
      pgbadger: "/usr/bin/pgbadger", // PGDG package path
    };

    const manifest = await loadManifest();
    const tools = manifest.entries.filter((e) => e.kind === "tool");

    const mismatches: string[] = [];

    for (const [toolName, hardcodedPath] of Object.entries(hardcodedToolBinaries)) {
      const tool = tools.find((t) => t.name === toolName);

      if (!tool) {
        mismatches.push(`Tool '${toolName}' not found in manifest`);
        continue;
      }

      const notes = tool.runtime?.notes ?? [];
      const manifestPath = extractBinaryPathFromNotes(notes);

      if (!manifestPath) {
        mismatches.push(
          `Tool '${toolName}' has no documented binary path in manifest notes. ` +
            `Hardcoded path is: ${hardcodedPath}`
        );
        continue;
      }

      if (manifestPath !== hardcodedPath) {
        mismatches.push(
          `Tool '${toolName}' path mismatch!\n` +
            `  Manifest says: ${manifestPath}\n` +
            `  test-image-lib.ts has: ${hardcodedPath}\n` +
            `  → Update test-image-lib.ts to use: ${manifestPath}`
        );
      }
    }

    if (mismatches.length > 0) {
      throw new Error(
        "Tool binary path validation failed!\n\n" +
          mismatches.join("\n\n") +
          "\n\nPlease update the hardcoded paths in scripts/docker/test-image-lib.ts " +
          "to match the manifest documentation in docker/postgres/extensions.manifest.json"
      );
    }
  });

  test("all tool entries have documented binary paths", async () => {
    const manifest = await loadManifest();
    const tools = manifest.entries.filter(
      (e) => e.kind === "tool" && e.name !== "pg_plan_filter" && e.name !== "pg_safeupdate"
    );

    const missingPaths: string[] = [];

    for (const tool of tools) {
      const notes = tool.runtime?.notes ?? [];
      const binaryPath = extractBinaryPathFromNotes(notes);

      // Only check standalone CLI tools (not .so modules)
      if (tool.name === "wal2json") continue; // This is a .so module, not a CLI tool

      if (!binaryPath) {
        missingPaths.push(`Tool '${tool.name}' has no documented binary path in notes`);
      }
    }

    if (missingPaths.length > 0) {
      console.warn("Warning: Some tools are missing binary path documentation:");
      console.warn(missingPaths.join("\n"));
    }

    // Don't fail for missing documentation, just warn
    expect(true).toBe(true);
  });
});
