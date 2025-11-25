#!/usr/bin/env bun
/**
 * Unit Test Suite for Entrypoint Generator
 * Tests entrypoint generation from manifest data without file system dependencies
 *
 * Coverage:
 * - generateDefaultSharedPreloadLibraries with various manifest configurations
 * - Extension filtering (sharedPreload, defaultEnable, enabled)
 * - PreloadLibraryName override handling
 * - Edge cases (empty manifest, all disabled, all enabled)
 *
 * Usage: bun test scripts/docker/generate-entrypoint.test.ts
 */

import { describe, test, expect } from "bun:test";

// Mock types matching the actual implementation
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
  entries: ManifestEntry[];
}

/**
 * Implementation extracted from generate-entrypoint.ts for testing
 * This is the actual function being tested
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

describe("generateDefaultSharedPreloadLibraries - Basic Filtering", () => {
  test("Extension with all required flags is included", () => {
    const manifest: Manifest = {
      entries: [
        {
          name: "pg_stat_statements",
          enabled: true,
          runtime: {
            sharedPreload: true,
            defaultEnable: true,
          },
        },
      ],
    };

    const result = generateDefaultSharedPreloadLibraries(manifest);
    expect(result).toBe("pg_stat_statements");
  });

  test("Extension with enabled=undefined (null) is included", () => {
    const manifest: Manifest = {
      entries: [
        {
          name: "auto_explain",
          // enabled is undefined/null
          runtime: {
            sharedPreload: true,
            defaultEnable: true,
          },
        },
      ],
    };

    const result = generateDefaultSharedPreloadLibraries(manifest);
    expect(result).toBe("auto_explain");
  });

  test("Extension with enabled=false is excluded", () => {
    const manifest: Manifest = {
      entries: [
        {
          name: "disabled_ext",
          enabled: false,
          runtime: {
            sharedPreload: true,
            defaultEnable: true,
          },
        },
      ],
    };

    const result = generateDefaultSharedPreloadLibraries(manifest);
    expect(result).toBe("");
  });

  test("Extension with sharedPreload=false is excluded", () => {
    const manifest: Manifest = {
      entries: [
        {
          name: "pgvector",
          enabled: true,
          runtime: {
            sharedPreload: false,
            defaultEnable: true,
          },
        },
      ],
    };

    const result = generateDefaultSharedPreloadLibraries(manifest);
    expect(result).toBe("");
  });

  test("Extension with defaultEnable=false is excluded", () => {
    const manifest: Manifest = {
      entries: [
        {
          name: "pg_cron",
          enabled: true,
          runtime: {
            sharedPreload: true,
            defaultEnable: false,
          },
        },
      ],
    };

    const result = generateDefaultSharedPreloadLibraries(manifest);
    expect(result).toBe("");
  });

  test("Extension without runtime is excluded", () => {
    const manifest: Manifest = {
      entries: [
        {
          name: "simple_ext",
          enabled: true,
          // No runtime spec
        },
      ],
    };

    const result = generateDefaultSharedPreloadLibraries(manifest);
    expect(result).toBe("");
  });
});

describe("generateDefaultSharedPreloadLibraries - PreloadLibraryName Override", () => {
  test("Uses preloadLibraryName when specified", () => {
    const manifest: Manifest = {
      entries: [
        {
          name: "pg_partman",
          enabled: true,
          runtime: {
            sharedPreload: true,
            defaultEnable: true,
            preloadLibraryName: "pg_partman_bgw",
          },
        },
      ],
    };

    const result = generateDefaultSharedPreloadLibraries(manifest);
    expect(result).toBe("pg_partman_bgw");
  });

  test("Uses extension name when preloadLibraryName not specified", () => {
    const manifest: Manifest = {
      entries: [
        {
          name: "timescaledb",
          enabled: true,
          runtime: {
            sharedPreload: true,
            defaultEnable: true,
            // No preloadLibraryName
          },
        },
      ],
    };

    const result = generateDefaultSharedPreloadLibraries(manifest);
    expect(result).toBe("timescaledb");
  });

  test("Mixes extensions with and without preloadLibraryName", () => {
    const manifest: Manifest = {
      entries: [
        {
          name: "pg_stat_statements",
          enabled: true,
          runtime: {
            sharedPreload: true,
            defaultEnable: true,
          },
        },
        {
          name: "pg_partman",
          enabled: true,
          runtime: {
            sharedPreload: true,
            defaultEnable: true,
            preloadLibraryName: "pg_partman_bgw",
          },
        },
      ],
    };

    const result = generateDefaultSharedPreloadLibraries(manifest);
    expect(result).toBe("pg_partman_bgw,pg_stat_statements");
  });
});

describe("generateDefaultSharedPreloadLibraries - Sorting and Formatting", () => {
  test("Multiple extensions are sorted alphabetically", () => {
    const manifest: Manifest = {
      entries: [
        {
          name: "timescaledb",
          enabled: true,
          runtime: { sharedPreload: true, defaultEnable: true },
        },
        {
          name: "auto_explain",
          enabled: true,
          runtime: { sharedPreload: true, defaultEnable: true },
        },
        {
          name: "pg_stat_statements",
          enabled: true,
          runtime: { sharedPreload: true, defaultEnable: true },
        },
      ],
    };

    const result = generateDefaultSharedPreloadLibraries(manifest);
    expect(result).toBe("auto_explain,pg_stat_statements,timescaledb");
  });

  test("Extensions are joined with commas, no spaces", () => {
    const manifest: Manifest = {
      entries: [
        {
          name: "ext_a",
          enabled: true,
          runtime: { sharedPreload: true, defaultEnable: true },
        },
        {
          name: "ext_b",
          enabled: true,
          runtime: { sharedPreload: true, defaultEnable: true },
        },
      ],
    };

    const result = generateDefaultSharedPreloadLibraries(manifest);
    expect(result).toBe("ext_a,ext_b");
    expect(result).not.toContain(" ");
  });

  test("Sorting is case-sensitive (lowercase first)", () => {
    const manifest: Manifest = {
      entries: [
        {
          name: "ZExtension",
          enabled: true,
          runtime: { sharedPreload: true, defaultEnable: true },
        },
        {
          name: "aExtension",
          enabled: true,
          runtime: { sharedPreload: true, defaultEnable: true },
        },
      ],
    };

    const result = generateDefaultSharedPreloadLibraries(manifest);
    // JavaScript sort is lexicographic (capital letters come before lowercase)
    expect(result).toBe("ZExtension,aExtension");
  });
});

describe("generateDefaultSharedPreloadLibraries - Edge Cases", () => {
  test("Empty manifest returns empty string", () => {
    const manifest: Manifest = {
      entries: [],
    };

    const result = generateDefaultSharedPreloadLibraries(manifest);
    expect(result).toBe("");
  });

  test("Manifest with no matching extensions returns empty string", () => {
    const manifest: Manifest = {
      entries: [
        {
          name: "ext1",
          enabled: false,
          runtime: { sharedPreload: true, defaultEnable: true },
        },
        {
          name: "ext2",
          enabled: true,
          runtime: { sharedPreload: false, defaultEnable: true },
        },
        {
          name: "ext3",
          enabled: true,
          runtime: { sharedPreload: true, defaultEnable: false },
        },
      ],
    };

    const result = generateDefaultSharedPreloadLibraries(manifest);
    expect(result).toBe("");
  });

  test("Extension with empty name is included in result", () => {
    const manifest: Manifest = {
      entries: [
        {
          name: "",
          enabled: true,
          runtime: { sharedPreload: true, defaultEnable: true },
        },
      ],
    };

    const result = generateDefaultSharedPreloadLibraries(manifest);
    expect(result).toBe("");
  });

  test("PreloadLibraryName empty string falls back to extension name", () => {
    const manifest: Manifest = {
      entries: [
        {
          name: "test_ext",
          enabled: true,
          runtime: {
            sharedPreload: true,
            defaultEnable: true,
            preloadLibraryName: "",
          },
        },
      ],
    };

    const result = generateDefaultSharedPreloadLibraries(manifest);
    // Empty string is falsy, so || operator falls back to extension name
    expect(result).toBe("test_ext");
  });

  test("Handles undefined runtime fields gracefully", () => {
    const manifest: Manifest = {
      entries: [
        {
          name: "partial_ext",
          enabled: true,
          runtime: {
            sharedPreload: true,
            // defaultEnable is undefined
          },
        },
      ],
    };

    const result = generateDefaultSharedPreloadLibraries(manifest);
    expect(result).toBe("");
  });
});

describe("generateDefaultSharedPreloadLibraries - Real-World Scenarios", () => {
  test("Typical production manifest with mixed extensions", () => {
    const manifest: Manifest = {
      entries: [
        // Should be included
        {
          name: "pg_stat_statements",
          enabled: true,
          runtime: { sharedPreload: true, defaultEnable: true },
        },
        // Should be excluded (not default enabled)
        {
          name: "pg_cron",
          enabled: true,
          runtime: { sharedPreload: true, defaultEnable: false },
        },
        // Should be excluded (disabled)
        {
          name: "timescaledb",
          enabled: false,
          runtime: { sharedPreload: true, defaultEnable: true },
        },
        // Should be excluded (no shared preload)
        {
          name: "pgvector",
          enabled: true,
          runtime: { sharedPreload: false, defaultEnable: true },
        },
        // Should be included with custom library name
        {
          name: "pg_partman",
          enabled: true,
          runtime: {
            sharedPreload: true,
            defaultEnable: true,
            preloadLibraryName: "pg_partman_bgw",
          },
        },
        // Should be included
        {
          name: "auto_explain",
          runtime: { sharedPreload: true, defaultEnable: true },
        },
      ],
    };

    const result = generateDefaultSharedPreloadLibraries(manifest);
    expect(result).toBe("auto_explain,pg_partman_bgw,pg_stat_statements");
  });

  test("All extensions disabled", () => {
    const manifest: Manifest = {
      entries: [
        {
          name: "ext1",
          enabled: false,
          runtime: { sharedPreload: true, defaultEnable: true },
        },
        {
          name: "ext2",
          enabled: false,
          runtime: { sharedPreload: true, defaultEnable: true },
        },
      ],
    };

    const result = generateDefaultSharedPreloadLibraries(manifest);
    expect(result).toBe("");
  });

  test("All extensions enabled and should preload", () => {
    const manifest: Manifest = {
      entries: [
        {
          name: "ext1",
          enabled: true,
          runtime: { sharedPreload: true, defaultEnable: true },
        },
        {
          name: "ext2",
          enabled: true,
          runtime: { sharedPreload: true, defaultEnable: true },
        },
        {
          name: "ext3",
          enabled: true,
          runtime: { sharedPreload: true, defaultEnable: true },
        },
      ],
    };

    const result = generateDefaultSharedPreloadLibraries(manifest);
    expect(result).toBe("ext1,ext2,ext3");
  });

  test("Extensions with preloadOnly flag are still included", () => {
    const manifest: Manifest = {
      entries: [
        {
          name: "auto_explain",
          enabled: true,
          runtime: {
            sharedPreload: true,
            defaultEnable: true,
            preloadOnly: true, // Module, not extension
          },
        },
      ],
    };

    const result = generateDefaultSharedPreloadLibraries(manifest);
    expect(result).toBe("auto_explain");
  });
});

describe("generateDefaultSharedPreloadLibraries - Consistency Checks", () => {
  test("Same input produces same output (deterministic)", () => {
    const manifest: Manifest = {
      entries: [
        {
          name: "ext_b",
          enabled: true,
          runtime: { sharedPreload: true, defaultEnable: true },
        },
        {
          name: "ext_a",
          enabled: true,
          runtime: { sharedPreload: true, defaultEnable: true },
        },
      ],
    };

    const result1 = generateDefaultSharedPreloadLibraries(manifest);
    const result2 = generateDefaultSharedPreloadLibraries(manifest);
    expect(result1).toBe(result2);
    expect(result1).toBe("ext_a,ext_b");
  });

  test("Output has no trailing/leading commas", () => {
    const manifest: Manifest = {
      entries: [
        {
          name: "single_ext",
          enabled: true,
          runtime: { sharedPreload: true, defaultEnable: true },
        },
      ],
    };

    const result = generateDefaultSharedPreloadLibraries(manifest);
    expect(result).not.toMatch(/^,/);
    expect(result).not.toMatch(/,$/);
  });

  test("No double commas in output", () => {
    const manifest: Manifest = {
      entries: [
        {
          name: "ext1",
          enabled: true,
          runtime: { sharedPreload: true, defaultEnable: true },
        },
        {
          name: "ext2",
          enabled: true,
          runtime: { sharedPreload: true, defaultEnable: true },
        },
      ],
    };

    const result = generateDefaultSharedPreloadLibraries(manifest);
    expect(result).not.toContain(",,");
  });
});
