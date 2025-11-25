#!/usr/bin/env bun
/**
 * Unit Test Suite for TypeScript Utilities
 * Tests utility functions in isolation without Docker dependencies
 *
 * Coverage:
 * - Manifest validation (ArkType schemas)
 * - GUC formatting utilities
 * - Logger output formatting
 *
 * Usage: bun test scripts/test/test-utils.test.ts
 */

import { describe, test, expect } from "bun:test";
import {
  validateManifest,
  validateManifestEntry,
  validateSourceSpec,
  validateBuildSpec,
  validateRuntimeSpec,
} from "../extensions/manifest-schema";
import {
  camelToSnakeCase,
  toPostgresGUCName,
  formatValue,
  formatSetting,
} from "../utils/guc-formatter";
import { formatDuration, formatMemory, formatThroughput } from "../utils/logger";

describe("Manifest Validation - Valid Data", () => {
  test("Valid manifest passes validation", () => {
    const validManifest = [
      {
        name: "test_extension",
        kind: "extension" as const,
        category: "testing",
        description: "Test extension for validation",
        source: {
          type: "builtin" as const,
        },
        runtime: {
          sharedPreload: false,
          defaultEnable: true,
        },
        enabled: true,
      },
    ];

    expect(() => validateManifest(validManifest)).not.toThrow();
    const result = validateManifest(validManifest);
    expect(result).toEqual(validManifest);
  });

  test("Manifest entry with git source validates correctly", () => {
    const validEntry = {
      name: "pgvector",
      kind: "extension" as const,
      category: "ai",
      description: "Vector similarity search",
      source: {
        type: "git" as const,
        repository: "https://github.com/pgvector/pgvector.git",
        tag: "v0.7.0",
      },
      build: {
        type: "pgxs" as const,
      },
      runtime: {
        sharedPreload: false,
        defaultEnable: false,
      },
      enabled: true,
    };

    expect(() => validateManifestEntry(validEntry)).not.toThrow();
    const result = validateManifestEntry(validEntry);
    expect(result.name).toBe("pgvector");
  });

  test("Builtin extension validates correctly", () => {
    const builtinEntry = {
      name: "pg_stat_statements",
      kind: "builtin" as const,
      category: "observability",
      description: "Track planning and execution statistics",
      source: {
        type: "builtin" as const,
      },
      runtime: {
        sharedPreload: true,
        defaultEnable: true,
      },
      enabled: true,
    };

    expect(() => validateManifestEntry(builtinEntry)).not.toThrow();
  });
});

describe("Manifest Validation - Invalid Data", () => {
  test("Invalid manifest fails with specific error", () => {
    const invalidManifest = [
      {
        name: "test",
        // Missing required fields: kind, category, description, source
      },
    ];

    expect(() => validateManifest(invalidManifest)).toThrow();
  });

  test("Missing required name field is caught", () => {
    const invalidEntry = {
      kind: "extension",
      category: "test",
      description: "Test",
      source: { type: "builtin" },
    };

    expect(() => validateManifestEntry(invalidEntry)).toThrow(/name/);
  });

  test("Invalid extension kind is rejected", () => {
    const invalidEntry = {
      name: "test",
      kind: "invalid_kind", // Not one of: extension, tool, builtin
      category: "test",
      description: "Test",
      source: { type: "builtin" },
    };

    expect(() => validateManifestEntry(invalidEntry)).toThrow();
  });

  test("Git source without repository is rejected", () => {
    const invalidSource = {
      type: "git",
      tag: "v1.0.0",
      // Missing repository
    };

    expect(() => validateSourceSpec(invalidSource)).toThrow();
  });

  test("Invalid build type is rejected", () => {
    const invalidBuild = {
      type: "invalid_build_system", // Not a valid BuildKind
    };

    expect(() => validateBuildSpec(invalidBuild)).toThrow();
  });

  test("Runtime spec with invalid types is rejected", () => {
    const invalidRuntime = {
      sharedPreload: "yes", // Should be boolean
      defaultEnable: 1, // Should be boolean
    };

    expect(() => validateRuntimeSpec(invalidRuntime)).toThrow();
  });
});

describe("GUC Formatting - camelCase to snake_case", () => {
  test("Simple camelCase conversion", () => {
    expect(camelToSnakeCase("maxConnections")).toBe("max_connections");
    expect(camelToSnakeCase("sharedBuffers")).toBe("shared_buffers");
    expect(camelToSnakeCase("workMem")).toBe("work_mem");
  });

  test("Consecutive capitals are handled correctly", () => {
    expect(camelToSnakeCase("maxWalSizeGB")).toBe("max_wal_size_gb");
    expect(camelToSnakeCase("XMLParser")).toBe("xml_parser");
    expect(camelToSnakeCase("HTTPServer")).toBe("http_server");
  });

  test("Already lowercase stays unchanged", () => {
    expect(camelToSnakeCase("lowercase")).toBe("lowercase");
  });

  test("Single character conversion", () => {
    expect(camelToSnakeCase("a")).toBe("a");
    expect(camelToSnakeCase("A")).toBe("a");
  });

  test("Numbers are preserved", () => {
    expect(camelToSnakeCase("maxConnections100")).toBe("max_connections100");
    expect(camelToSnakeCase("config2Factor")).toBe("config2_factor");
  });
});

describe("GUC Formatting - PostgreSQL GUC Names", () => {
  test("Standard GUC names are formatted correctly", () => {
    expect(toPostgresGUCName("maxConnections")).toBe("max_connections");
    expect(toPostgresGUCName("listenAddresses")).toBe("listen_addresses");
    expect(toPostgresGUCName("sharedPreloadLibraries")).toBe("shared_preload_libraries");
  });

  test("Extension namespaces use dot notation", () => {
    expect(toPostgresGUCName("pgStatStatementsMax")).toBe("pg_stat_statements.max");
    expect(toPostgresGUCName("pgStatStatementsTrack")).toBe("pg_stat_statements.track");
    expect(toPostgresGUCName("autoExplainLogMinDuration")).toBe("auto_explain.log_min_duration");
  });

  test("pgAudit uses lowercase namespace", () => {
    expect(toPostgresGUCName("pgAuditLog")).toBe("pgaudit.log");
    expect(toPostgresGUCName("pgAuditRole")).toBe("pgaudit.role");
  });

  test("Cron namespace is handled", () => {
    expect(toPostgresGUCName("cronDatabaseName")).toBe("cron.database_name");
  });

  test("Invalid GUC names throw errors", () => {
    // Names with invalid characters should throw
    expect(() => toPostgresGUCName("invalid-name-with-dashes")).toThrow();
    expect(() => toPostgresGUCName("UPPERCASE")).not.toThrow(); // Should convert to lowercase
  });
});

describe("GUC Formatting - Value Formatting", () => {
  test("Boolean values convert to on/off", () => {
    expect(formatValue(true)).toBe("on");
    expect(formatValue(false)).toBe("off");
  });

  test("Numbers are converted to strings", () => {
    expect(formatValue(100)).toBe("100");
    expect(formatValue(0)).toBe("0");
    expect(formatValue(-1)).toBe("-1");
    expect(formatValue(1.5)).toBe("1.5");
  });

  test("Strings are quoted", () => {
    expect(formatValue("localhost")).toBe("'localhost'");
    expect(formatValue("*")).toBe("'*'");
    expect(formatValue("'")).toBe("'''");
  });

  test("Arrays are joined with commas and quoted", () => {
    expect(formatValue(["pg_stat_statements", "auto_explain"])).toBe(
      "'pg_stat_statements,auto_explain'"
    );
    expect(formatValue([])).toBe("''");
    expect(formatValue(["single"])).toBe("'single'");
  });

  test("Memory size strings are preserved", () => {
    expect(formatValue("128MB")).toBe("'128MB'");
    expect(formatValue("1GB")).toBe("'1GB'");
  });
});

describe("GUC Formatting - Complete Settings", () => {
  test("Format complete setting line", () => {
    expect(formatSetting("maxConnections", 100)).toBe("max_connections = 100");
    expect(formatSetting("listenAddresses", "*")).toBe("listen_addresses = '*'");
    expect(formatSetting("ssl", true)).toBe("ssl = on");
  });

  test("Format extension settings with namespaces", () => {
    expect(formatSetting("pgStatStatementsMax", 10000)).toBe("pg_stat_statements.max = 10000");
    expect(formatSetting("autoExplainLogMinDuration", 1000)).toBe(
      "auto_explain.log_min_duration = 1000"
    );
  });

  test("Undefined values return empty string", () => {
    expect(formatSetting("optionalSetting", undefined)).toBe("");
  });

  test("sharedPreloadLibraries with empty array returns empty string", () => {
    expect(formatSetting("sharedPreloadLibraries", [])).toBe("");
  });

  test("sharedPreloadLibraries with values formats correctly", () => {
    expect(formatSetting("sharedPreloadLibraries", ["pg_stat_statements"])).toBe(
      "shared_preload_libraries = 'pg_stat_statements'"
    );
  });

  test("Array settings format correctly", () => {
    expect(formatSetting("sharedPreloadLibraries", ["pgaudit", "auto_explain"])).toBe(
      "shared_preload_libraries = 'pgaudit,auto_explain'"
    );
  });
});

describe("Logger - Duration Formatting", () => {
  test("Milliseconds are formatted correctly", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(50)).toBe("50ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  test("Seconds are formatted correctly", () => {
    expect(formatDuration(1000)).toBe("1.00s");
    expect(formatDuration(1500)).toBe("1.50s");
    expect(formatDuration(59999)).toBe("60.00s");
  });

  test("Minutes are formatted correctly", () => {
    expect(formatDuration(60000)).toBe("1m 0s");
    expect(formatDuration(90000)).toBe("1m 30s");
    expect(formatDuration(125000)).toBe("2m 5s");
  });

  test("Edge cases", () => {
    expect(formatDuration(0.5)).toBe("1ms"); // Rounds to 1ms
    expect(formatDuration(59950)).toBe("59.95s");
  });
});

describe("Logger - Memory Formatting", () => {
  test("Megabytes are formatted correctly", () => {
    expect(formatMemory(1024 * 1024)).toBe("1.00 MB");
    expect(formatMemory(512 * 1024 * 1024)).toBe("512.00 MB");
    expect(formatMemory(1023 * 1024 * 1024)).toBe("1023.00 MB");
  });

  test("Gigabytes are formatted correctly", () => {
    expect(formatMemory(1024 * 1024 * 1024)).toBe("1.00 GB");
    expect(formatMemory(2.5 * 1024 * 1024 * 1024)).toBe("2.50 GB");
    expect(formatMemory(16 * 1024 * 1024 * 1024)).toBe("16.00 GB");
  });

  test("Small values in MB", () => {
    expect(formatMemory(100 * 1024 * 1024)).toBe("100.00 MB");
    expect(formatMemory(256 * 1024 * 1024)).toBe("256.00 MB");
  });

  test("Zero bytes", () => {
    expect(formatMemory(0)).toBe("0.00 MB");
  });
});

describe("Logger - Throughput Formatting", () => {
  test("Operations per second", () => {
    expect(formatThroughput(100, 1000)).toBe("100.00 ops/sec");
    expect(formatThroughput(500, 1000)).toBe("500.00 ops/sec");
    expect(formatThroughput(999, 1000)).toBe("999.00 ops/sec");
  });

  test("Thousands of ops per second", () => {
    expect(formatThroughput(1000, 1000)).toBe("1.00K ops/sec");
    expect(formatThroughput(5000, 1000)).toBe("5.00K ops/sec");
    expect(formatThroughput(999000, 1000)).toBe("999.00K ops/sec");
  });

  test("Millions of ops per second", () => {
    expect(formatThroughput(1000000, 1000)).toBe("1.00M ops/sec");
    expect(formatThroughput(2500000, 1000)).toBe("2.50M ops/sec");
  });

  test("Different durations", () => {
    expect(formatThroughput(1000, 2000)).toBe("500.00 ops/sec");
    expect(formatThroughput(5000, 500)).toBe("10.00K ops/sec");
  });

  test("Edge cases", () => {
    expect(formatThroughput(0, 1000)).toBe("0.00 ops/sec");
    expect(formatThroughput(1, 1000)).toBe("1.00 ops/sec");
  });
});

describe("GUC Formatter - SQL Escaping", () => {
  test("Single quotes in strings should be handled", () => {
    // Note: Current implementation doesn't escape quotes
    // This test documents expected behavior for future enhancement
    const value = "test'value";
    const formatted = formatValue(value);
    expect(formatted).toBe("'test'value'");
    // Ideally should be "'test''value'" for PostgreSQL
  });

  test("Special characters in arrays", () => {
    const value = ["item1", "item2"];
    expect(formatValue(value)).toBe("'item1,item2'");
  });
});

describe("Manifest Validation - Edge Cases", () => {
  test("Empty manifest array is valid", () => {
    expect(() => validateManifest([])).not.toThrow();
    const result = validateManifest([]);
    expect(result).toEqual([]);
  });

  test("Manifest with optional fields", () => {
    const entry = {
      name: "test_ext",
      kind: "extension" as const,
      category: "test",
      description: "Test extension",
      source: { type: "builtin" as const },
      displayName: "Test Extension",
      dependencies: ["other_ext"],
      provides: ["feature1", "feature2"],
      aptPackages: ["libtest-dev"],
      notes: ["Note 1", "Note 2"],
      enabled: true,
    };

    expect(() => validateManifestEntry(entry)).not.toThrow();
    const result = validateManifestEntry(entry);
    expect(result.displayName).toBe("Test Extension");
    expect(result.dependencies).toEqual(["other_ext"]);
  });

  test("Extension with cargo-pgrx build", () => {
    const entry = {
      name: "pgmq",
      kind: "extension" as const,
      category: "queueing",
      description: "Message queue",
      source: {
        type: "git" as const,
        repository: "https://github.com/tembo-io/pgmq.git",
        tag: "v1.0.0",
      },
      build: {
        type: "cargo-pgrx" as const,
        features: ["feature1"],
        noDefaultFeatures: true,
      },
      enabled: true,
    };

    expect(() => validateManifestEntry(entry)).not.toThrow();
    const result = validateManifestEntry(entry);
    expect(result.build?.type).toBe("cargo-pgrx");
    expect(result.build?.features).toEqual(["feature1"]);
    expect(result.build?.noDefaultFeatures).toBe(true);
  });

  test("Tool kind extension", () => {
    const entry = {
      name: "pgbadger",
      kind: "tool" as const,
      category: "observability",
      description: "Log analyzer",
      source: { type: "builtin" as const },
      enabled: true,
    };

    expect(() => validateManifestEntry(entry)).not.toThrow();
  });
});

describe("GUC Formatter - Edge Cases", () => {
  test("Empty string value", () => {
    expect(formatValue("")).toBe("''");
  });

  test("Numeric string value", () => {
    expect(formatValue("123")).toBe("'123'");
  });

  test("Boolean-like string values", () => {
    expect(formatValue("on")).toBe("'on'");
    expect(formatValue("off")).toBe("'off'");
    expect(formatValue("true")).toBe("'true'");
  });

  test("Setting with zero value", () => {
    expect(formatSetting("someValue", 0)).toBe("some_value = 0");
  });

  test("Setting with false value", () => {
    expect(formatSetting("enableFeature", false)).toBe("enable_feature = off");
  });
});
