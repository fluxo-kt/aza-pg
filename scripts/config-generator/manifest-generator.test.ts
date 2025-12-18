#!/usr/bin/env bun
/**
 * Unit Test Suite for Manifest Generator
 * Tests manifest loading, filtering, and data extraction functions
 *
 * Coverage:
 * - Manifest loading and parsing
 * - Default enabled extensions filtering
 * - Shared preload libraries extraction
 * - Extension categorization
 *
 * Usage: bun test scripts/config-generator/manifest-generator.test.ts
 */

import { describe, test, expect } from "bun:test";
import {
  getDefaultEnabledExtensions,
  getDefaultSharedPreloadLibraries,
  type Manifest,
} from "./manifest-loader";
import { MANIFEST_ENTRIES } from "../extensions/manifest-data";

describe("Manifest Data Exports", () => {
  test("MANIFEST_ENTRIES is an array", () => {
    expect(Array.isArray(MANIFEST_ENTRIES)).toBe(true);
  });

  test("MANIFEST_ENTRIES contains valid entries", () => {
    expect(MANIFEST_ENTRIES.length).toBeGreaterThan(0);

    // Check first entry has required fields
    const firstEntry = MANIFEST_ENTRIES[0];
    expect(firstEntry).toBeDefined();
    expect(firstEntry?.name).toBeDefined();
    expect(firstEntry?.kind).toBeDefined();
    expect(firstEntry?.category).toBeDefined();
    expect(firstEntry?.description).toBeDefined();
    expect(firstEntry?.source).toBeDefined();
  });

  test("All entries have unique names", () => {
    const names = MANIFEST_ENTRIES.map((e) => e.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  test("Entry kinds are valid", () => {
    const validKinds = ["extension", "tool", "builtin"];
    for (const entry of MANIFEST_ENTRIES) {
      expect(validKinds).toContain(entry.kind);
    }
  });

  test("Source types are valid", () => {
    const validSourceTypes = ["builtin", "git", "git-ref"];
    for (const entry of MANIFEST_ENTRIES) {
      expect(validSourceTypes).toContain(entry.source.type);
    }
  });

  test("Git sources have repository and tag/ref", () => {
    for (const entry of MANIFEST_ENTRIES) {
      if (entry.source.type === "git") {
        expect(entry.source.repository).toBeDefined();
        expect(entry.source.tag).toBeDefined();
      } else if (entry.source.type === "git-ref") {
        expect(entry.source.repository).toBeDefined();
        expect(entry.source.ref).toBeDefined();
      }
    }
  });
});

describe("Extension Categorization", () => {
  test("Extensions are categorized by kind", () => {
    const byKind = {
      builtin: MANIFEST_ENTRIES.filter((e) => e.kind === "builtin"),
      extension: MANIFEST_ENTRIES.filter((e) => e.kind === "extension"),
      tool: MANIFEST_ENTRIES.filter((e) => e.kind === "tool"),
    };

    expect(byKind.builtin.length).toBeGreaterThan(0);
    expect(byKind.extension.length).toBeGreaterThan(0);
    expect(byKind.tool.length).toBeGreaterThan(0);

    // Total should match MANIFEST_ENTRIES length
    expect(byKind.builtin.length + byKind.extension.length + byKind.tool.length).toBe(
      MANIFEST_ENTRIES.length
    );
  });

  test("Disabled extensions are identified correctly", () => {
    const disabled = MANIFEST_ENTRIES.filter((e) => e.enabled === false);
    expect(disabled.length).toBeGreaterThan(0);

    // Check that disabled entries have disabledReason
    for (const entry of disabled) {
      expect(entry.disabledReason).toBeDefined();
      expect(typeof entry.disabledReason).toBe("string");
      expect(entry.disabledReason!.length).toBeGreaterThan(0);
    }
  });

  test("Enabled extensions (default true or explicit true)", () => {
    const enabled = MANIFEST_ENTRIES.filter((e) => e.enabled !== false);
    expect(enabled.length).toBeGreaterThan(0);

    // Most entries should be enabled
    expect(enabled.length).toBeGreaterThan(MANIFEST_ENTRIES.length / 2);
  });
});

describe("Preload Libraries Detection", () => {
  test("Identifies shared preload extensions", () => {
    const preloadExtensions = MANIFEST_ENTRIES.filter((e) => e.runtime?.sharedPreload === true);
    expect(preloadExtensions.length).toBeGreaterThan(0);

    // All preload extensions should have runtime spec
    for (const entry of preloadExtensions) {
      expect(entry.runtime).toBeDefined();
      expect(entry.runtime!.sharedPreload).toBe(true);
    }
  });

  test("Identifies default-enabled preload extensions", () => {
    const defaultPreload = MANIFEST_ENTRIES.filter(
      (e) => e.runtime?.sharedPreload === true && e.runtime?.defaultEnable === true
    );
    expect(defaultPreload.length).toBeGreaterThan(0);
  });

  test("Identifies optional preload extensions", () => {
    const optionalPreload = MANIFEST_ENTRIES.filter(
      (e) => e.runtime?.sharedPreload === true && e.runtime?.defaultEnable === false
    );
    expect(optionalPreload.length).toBeGreaterThan(0);

    // Should include pg_partman, set_user (pgsodium is now default-enabled for pgflow)
    const optionalNames = optionalPreload.map((e) => e.name);
    expect(optionalNames).toContain("pg_partman");
    expect(optionalNames).toContain("set_user");
  });

  test("Identifies preload-only extensions", () => {
    const preloadOnly = MANIFEST_ENTRIES.filter((e) => e.runtime?.preloadOnly === true);
    expect(preloadOnly.length).toBeGreaterThan(0);

    // auto_explain should be preload-only
    const autoExplain = preloadOnly.find((e) => e.name === "auto_explain");
    expect(autoExplain).toBeDefined();
  });

  test("Custom preload library names are handled", () => {
    const customPreloadName = MANIFEST_ENTRIES.filter((e) => e.runtime?.preloadLibraryName);
    expect(customPreloadName.length).toBeGreaterThan(0);

    // pg_safeupdate uses 'safeupdate' as library name
    const safeupdate = MANIFEST_ENTRIES.find((e) => e.name === "pg_safeupdate");
    expect(safeupdate?.runtime?.preloadLibraryName).toBe("safeupdate");

    // pg_partman uses 'pg_partman_bgw' as library name
    const partman = MANIFEST_ENTRIES.find((e) => e.name === "pg_partman");
    expect(partman?.runtime?.preloadLibraryName).toBe("pg_partman_bgw");
  });
});

describe("Default Enabled Extensions Filter", () => {
  const mockManifest: Manifest = {
    generatedAt: "2025-01-01T00:00:00Z",
    entries: [
      {
        name: "test_enabled_ext",
        kind: "extension",
        category: "test",
        description: "Enabled test extension",
        source: { type: "builtin" },
        runtime: { sharedPreload: false, defaultEnable: true },
        enabled: true,
      },
      {
        name: "test_disabled_ext",
        kind: "extension",
        category: "test",
        description: "Disabled test extension",
        source: { type: "builtin" },
        runtime: { sharedPreload: false, defaultEnable: true },
        enabled: false,
      },
      {
        name: "test_tool",
        kind: "tool",
        category: "test",
        description: "Test tool",
        source: { type: "builtin" },
        runtime: { sharedPreload: false, defaultEnable: true },
        enabled: true,
      },
      {
        name: "test_preload_only",
        kind: "extension",
        category: "test",
        description: "Preload-only extension",
        source: { type: "builtin" },
        runtime: { sharedPreload: true, defaultEnable: true, preloadOnly: true },
        enabled: true,
      },
      {
        name: "test_optional_ext",
        kind: "extension",
        category: "test",
        description: "Optional test extension",
        source: { type: "builtin" },
        runtime: { sharedPreload: false, defaultEnable: false },
        enabled: true,
      },
    ],
  };

  test("Filters extensions correctly", () => {
    const result = getDefaultEnabledExtensions(mockManifest);

    // Should only include test_enabled_ext
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("test_enabled_ext");
  });

  test("Excludes disabled extensions", () => {
    const result = getDefaultEnabledExtensions(mockManifest);
    const names = result.map((e) => e.name);
    expect(names).not.toContain("test_disabled_ext");
  });

  test("Excludes tools", () => {
    const result = getDefaultEnabledExtensions(mockManifest);
    const names = result.map((e) => e.name);
    expect(names).not.toContain("test_tool");
  });

  test("Excludes preload-only extensions", () => {
    const result = getDefaultEnabledExtensions(mockManifest);
    const names = result.map((e) => e.name);
    expect(names).not.toContain("test_preload_only");
  });

  test("Excludes extensions with defaultEnable=false", () => {
    const result = getDefaultEnabledExtensions(mockManifest);
    const names = result.map((e) => e.name);
    expect(names).not.toContain("test_optional_ext");
  });

  test("Handles missing enabled field (defaults to true)", () => {
    const manifest: Manifest = {
      generatedAt: "2025-01-01T00:00:00Z",
      entries: [
        {
          name: "test_no_enabled_field",
          kind: "extension",
          category: "test",
          description: "Extension without enabled field",
          source: { type: "builtin" },
          runtime: { sharedPreload: false, defaultEnable: true },
          // enabled field omitted
        },
      ],
    };

    const result = getDefaultEnabledExtensions(manifest);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("test_no_enabled_field");
  });

  test("Handles missing runtime field", () => {
    const manifest: Manifest = {
      generatedAt: "2025-01-01T00:00:00Z",
      entries: [
        {
          name: "test_no_runtime",
          kind: "extension",
          category: "test",
          description: "Extension without runtime",
          source: { type: "builtin" },
          enabled: true,
          // runtime field omitted
        },
      ],
    };

    const result = getDefaultEnabledExtensions(manifest);
    // Should be excluded (defaultEnable defaults to false)
    expect(result).toHaveLength(0);
  });
});

describe("Shared Preload Libraries Extraction", () => {
  const mockManifest: Manifest = {
    generatedAt: "2025-01-01T00:00:00Z",
    entries: [
      {
        name: "test_preload_1",
        kind: "extension",
        category: "test",
        description: "Preload extension 1",
        source: { type: "builtin" },
        runtime: { sharedPreload: true, defaultEnable: true },
        enabled: true,
      },
      {
        name: "test_preload_2",
        kind: "extension",
        category: "test",
        description: "Preload extension 2",
        source: { type: "builtin" },
        runtime: { sharedPreload: true, defaultEnable: true },
        enabled: true,
      },
      {
        name: "test_optional_preload",
        kind: "extension",
        category: "test",
        description: "Optional preload",
        source: { type: "builtin" },
        runtime: { sharedPreload: true, defaultEnable: false },
        enabled: true,
      },
      {
        name: "test_disabled_preload",
        kind: "extension",
        category: "test",
        description: "Disabled preload",
        source: { type: "builtin" },
        runtime: { sharedPreload: true, defaultEnable: true },
        enabled: false,
      },
      {
        name: "test_no_preload",
        kind: "extension",
        category: "test",
        description: "No preload",
        source: { type: "builtin" },
        runtime: { sharedPreload: false, defaultEnable: true },
        enabled: true,
      },
    ],
  };

  test("Returns comma-separated list of preload libraries", () => {
    const result = getDefaultSharedPreloadLibraries(mockManifest);
    expect(typeof result).toBe("string");
    expect(result).toContain(",");
  });

  test("Includes only enabled default preload extensions", () => {
    const result = getDefaultSharedPreloadLibraries(mockManifest);
    expect(result).toContain("test_preload_1");
    expect(result).toContain("test_preload_2");
  });

  test("Excludes optional preload extensions", () => {
    const result = getDefaultSharedPreloadLibraries(mockManifest);
    expect(result).not.toContain("test_optional_preload");
  });

  test("Excludes disabled preload extensions", () => {
    const result = getDefaultSharedPreloadLibraries(mockManifest);
    expect(result).not.toContain("test_disabled_preload");
  });

  test("Excludes non-preload extensions", () => {
    const result = getDefaultSharedPreloadLibraries(mockManifest);
    expect(result).not.toContain("test_no_preload");
  });

  test("Returns alphabetically sorted list", () => {
    const result = getDefaultSharedPreloadLibraries(mockManifest);
    const libs = result.split(",");
    const sorted = [...libs].sort();
    expect(libs).toEqual(sorted);
  });

  test("Returns empty string for no preload libraries", () => {
    const manifest: Manifest = {
      generatedAt: "2025-01-01T00:00:00Z",
      entries: [
        {
          name: "test_ext",
          kind: "extension",
          category: "test",
          description: "No preload",
          source: { type: "builtin" },
          runtime: { sharedPreload: false, defaultEnable: true },
          enabled: true,
        },
      ],
    };

    const result = getDefaultSharedPreloadLibraries(manifest);
    expect(result).toBe("");
  });

  test("Handles missing runtime spec", () => {
    const manifest: Manifest = {
      generatedAt: "2025-01-01T00:00:00Z",
      entries: [
        {
          name: "test_no_runtime",
          kind: "extension",
          category: "test",
          description: "No runtime",
          source: { type: "builtin" },
          enabled: true,
        },
      ],
    };

    const result = getDefaultSharedPreloadLibraries(manifest);
    expect(result).toBe("");
  });
});

describe("Real Manifest Data Validation", () => {
  test("pgvector is enabled and default-enabled", () => {
    const pgvector = MANIFEST_ENTRIES.find((e) => e.name === "vector");
    expect(pgvector).toBeDefined();
    expect(pgvector?.enabled).not.toBe(false);
    expect(pgvector?.runtime?.defaultEnable).toBe(true);
    expect(pgvector?.kind).toBe("extension");
  });

  test("pg_cron is preloaded and default-enabled", () => {
    const pgCron = MANIFEST_ENTRIES.find((e) => e.name === "pg_cron");
    expect(pgCron).toBeDefined();
    expect(pgCron?.runtime?.sharedPreload).toBe(true);
    expect(pgCron?.runtime?.defaultEnable).toBe(true);
  });

  test("auto_explain is preload-only", () => {
    const autoExplain = MANIFEST_ENTRIES.find((e) => e.name === "auto_explain");
    expect(autoExplain).toBeDefined();
    expect(autoExplain?.kind).toBe("builtin");
    expect(autoExplain?.runtime?.sharedPreload).toBe(true);
    expect(autoExplain?.runtime?.preloadOnly).toBe(true);
  });

  test("pg_safeupdate is a tool with custom preload library name, default-enabled", () => {
    const safeupdate = MANIFEST_ENTRIES.find((e) => e.name === "pg_safeupdate");
    expect(safeupdate).toBeDefined();
    expect(safeupdate?.kind).toBe("tool");
    expect(safeupdate?.runtime?.sharedPreload).toBe(true);
    expect(safeupdate?.runtime?.defaultEnable).toBe(true);
    expect(safeupdate?.runtime?.preloadLibraryName).toBe("safeupdate");
  });

  test("pgbackrest is a tool without preload", () => {
    const pgbackrest = MANIFEST_ENTRIES.find((e) => e.name === "pgbackrest");
    expect(pgbackrest).toBeDefined();
    expect(pgbackrest?.kind).toBe("tool");
    expect(pgbackrest?.runtime?.sharedPreload).not.toBe(true);
  });

  test("timescaledb is preloaded and default-enabled", () => {
    const timescaledb = MANIFEST_ENTRIES.find((e) => e.name === "timescaledb");
    expect(timescaledb).toBeDefined();
    expect(timescaledb?.runtime?.sharedPreload).toBe(true);
    expect(timescaledb?.runtime?.defaultEnable).toBe(true);
    expect(timescaledb?.kind).toBe("extension");
  });

  test("postgis is disabled with reason", () => {
    const postgis = MANIFEST_ENTRIES.find((e) => e.name === "postgis");
    expect(postgis).toBeDefined();
    expect(postgis?.enabled).toBe(false);
    expect(postgis?.disabledReason).toBeDefined();
    expect(postgis?.enabledInComprehensiveTest).toBe(true);
  });

  test("All enabled extensions with source dependencies are valid", () => {
    // Build Map for O(1) lookups instead of O(n) .find() per dependency
    const entryMap = new Map(MANIFEST_ENTRIES.map((e) => [e.name, e]));

    for (const entry of MANIFEST_ENTRIES) {
      if (entry.enabled === false) continue;
      if (!entry.dependencies) continue;

      // Check that dependencies exist in manifest
      for (const dep of entry.dependencies) {
        const depEntry = entryMap.get(dep);
        expect(depEntry).toBeDefined();
      }
    }
  });
});

describe("Manifest Counts and Statistics", () => {
  test("Total entries count matches", () => {
    expect(MANIFEST_ENTRIES.length).toBeGreaterThan(30); // Should be around 39+
  });

  test("Builtin extensions count", () => {
    const builtins = MANIFEST_ENTRIES.filter((e) => e.kind === "builtin");
    expect(builtins.length).toBeGreaterThan(5);
  });

  test("Extension count", () => {
    const extensions = MANIFEST_ENTRIES.filter((e) => e.kind === "extension");
    expect(extensions.length).toBeGreaterThan(20);
  });

  test("Tool count", () => {
    const tools = MANIFEST_ENTRIES.filter((e) => e.kind === "tool");
    expect(tools.length).toBeGreaterThan(3);
  });

  test("Preload libraries count", () => {
    const preload = MANIFEST_ENTRIES.filter((e) => e.runtime?.sharedPreload === true);
    expect(preload.length).toBeGreaterThan(5);
  });

  test("Default-enabled count", () => {
    const defaultEnabled = MANIFEST_ENTRIES.filter(
      (e) => e.enabled !== false && e.runtime?.defaultEnable === true && e.kind === "extension"
    );
    expect(defaultEnabled.length).toBeGreaterThan(5);
  });

  test("Disabled extensions count", () => {
    const disabled = MANIFEST_ENTRIES.filter((e) => e.enabled === false);
    expect(disabled.length).toBeGreaterThan(0);
    expect(disabled.length).toBeLessThan(10);
  });
});

describe("Extension Build Configuration", () => {
  test("Cargo-pgrx extensions have required configuration", () => {
    const cargoPgrx = MANIFEST_ENTRIES.filter((e) => e.build?.type === "cargo-pgrx");
    expect(cargoPgrx.length).toBeGreaterThan(0);

    // wrappers should use cargo-pgrx
    const wrappers = MANIFEST_ENTRIES.find((e) => e.name === "wrappers");
    expect(wrappers?.build?.type).toBe("cargo-pgrx");
    expect(wrappers?.build?.features).toContain("pg18");
  });

  test("PGXS extensions are identified", () => {
    const pgxs = MANIFEST_ENTRIES.filter((e) => e.build?.type === "pgxs");
    expect(pgxs.length).toBeGreaterThan(10);
  });

  test("Extensions with apt packages", () => {
    const withApt = MANIFEST_ENTRIES.filter((e) => e.aptPackages && e.aptPackages.length > 0);
    expect(withApt.length).toBeGreaterThan(5);

    // postgis should have many apt packages
    const postgis = MANIFEST_ENTRIES.find((e) => e.name === "postgis");
    expect(postgis?.aptPackages).toBeDefined();
    expect(postgis?.aptPackages!.length).toBeGreaterThan(5);
  });

  test("Builtin extensions have no build configuration", () => {
    const builtins = MANIFEST_ENTRIES.filter((e) => e.kind === "builtin");
    for (const builtin of builtins) {
      expect(builtin.build).toBeUndefined();
      expect(builtin.source.type).toBe("builtin");
    }
  });
});

describe("Integration Test - Manifest Consistency", () => {
  test("Preload-only extensions (except SQL-only schemas) are in preload list", () => {
    const preloadOnly = MANIFEST_ENTRIES.filter((e) => e.runtime?.preloadOnly === true);
    for (const entry of preloadOnly) {
      // pgflow is preloadOnly but not sharedPreload (SQL-only schema, no .so)
      if (entry.name === "pgflow") {
        expect(entry.runtime?.sharedPreload).not.toBe(true);
      } else {
        expect(entry.runtime?.sharedPreload).toBe(true);
      }
    }
  });

  test("No tool kind has CREATE EXTENSION flow", () => {
    const tools = MANIFEST_ENTRIES.filter((e) => e.kind === "tool");
    for (const tool of tools) {
      // Tools with defaultEnable must load via preload (preloadOnly or sharedPreload), not CREATE EXTENSION
      if (tool.runtime?.defaultEnable === true) {
        const loadsViaPreload =
          tool.runtime?.preloadOnly === true || tool.runtime?.sharedPreload === true;
        expect(loadsViaPreload).toBe(true);
      }
    }
  });

  test("Extensions with dependencies have dependencies enabled or conditional", () => {
    // Build Map for O(1) lookups instead of O(n) .find() per dependency
    const entryMap = new Map(MANIFEST_ENTRIES.map((e) => [e.name, e]));

    for (const entry of MANIFEST_ENTRIES) {
      if (!entry.dependencies) continue;
      if (entry.enabled === false) continue;

      for (const depName of entry.dependencies) {
        const dep = entryMap.get(depName);
        expect(dep).toBeDefined();

        // If the extension is enabled, dependency should be enabled or be a builtin
        if (entry.enabled === true) {
          expect(dep?.enabled !== false || dep?.kind === "builtin").toBe(true);
        }
      }
    }
  });

  test("All git sources have repository URLs", () => {
    const gitSources = MANIFEST_ENTRIES.filter(
      (e) => e.source.type === "git" || e.source.type === "git-ref"
    );
    for (const entry of gitSources) {
      if (entry.source.type === "git" || entry.source.type === "git-ref") {
        expect(entry.source.repository).toBeDefined();
        expect(entry.source.repository.startsWith("http")).toBe(true);
      }
    }
  });
});
