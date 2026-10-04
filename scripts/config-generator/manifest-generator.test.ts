#!/usr/bin/env bun
/**
 * Manifest filters that decide what the image precreates and preloads (manifest-loader.ts), plus the
 * manifest invariants no other check enforces.
 *
 * Usage: bun test scripts/config-generator/manifest-generator.test.ts
 */

import { describe, test, expect } from "bun:test";
import {
  getDefaultEnabledExtensions,
  getDefaultSharedPreloadLibraries,
  type Manifest,
  type PreloadCandidate,
} from "./manifest-loader";
import { MANIFEST_ENTRIES, type ManifestEntry } from "../extensions/manifest-data";

function entry(name: string, fields: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    name,
    kind: "extension",
    category: "test",
    description: name,
    source: { type: "builtin" },
    ...fields,
  };
}

function manifest(entries: ManifestEntry[]): Manifest {
  return { generatedAt: "2025-01-01T00:00:00Z", entries };
}

describe("getDefaultEnabledExtensions", () => {
  test("keeps only enabled, defaultEnable, non-tool, non-preloadOnly entries", () => {
    const result = getDefaultEnabledExtensions(
      manifest([
        entry("kept", { runtime: { sharedPreload: false, defaultEnable: true }, enabled: true }),
        entry("disabled", {
          runtime: { sharedPreload: false, defaultEnable: true },
          enabled: false,
        }),
        entry("tool", { kind: "tool", runtime: { sharedPreload: false, defaultEnable: true } }),
        entry("preload_only", {
          runtime: { sharedPreload: true, defaultEnable: true, preloadOnly: true },
        }),
        entry("optional", { runtime: { sharedPreload: false, defaultEnable: false } }),
      ])
    );
    expect(result.map((e) => e.name)).toEqual(["kept"]);
  });

  test("an entry without `enabled` counts as enabled", () => {
    const result = getDefaultEnabledExtensions(
      manifest([
        entry("no_enabled_field", { runtime: { sharedPreload: false, defaultEnable: true } }),
      ])
    );
    expect(result.map((e) => e.name)).toEqual(["no_enabled_field"]);
  });

  test("an entry without `runtime` is not default-enabled", () => {
    expect(getDefaultEnabledExtensions(manifest([entry("no_runtime", { enabled: true })]))).toEqual(
      []
    );
  });
});

describe("getDefaultSharedPreloadLibraries", () => {
  const preload = (name: string, fields: Partial<PreloadCandidate> = {}): PreloadCandidate => ({
    name,
    runtime: { sharedPreload: true, defaultEnable: true },
    ...fields,
  });

  test("lists enabled sharedPreload+defaultEnable entries, sorted, comma-joined", () => {
    const result = getDefaultSharedPreloadLibraries({
      entries: [
        preload("timescaledb", { enabled: true }),
        preload("auto_explain"), // `enabled` absent counts as enabled
        preload("disabled", { enabled: false }),
        preload("not_shared", { runtime: { sharedPreload: false, defaultEnable: true } }),
        preload("optional", { runtime: { sharedPreload: true, defaultEnable: false } }),
        preload("default_unset", { runtime: { sharedPreload: true } }),
        { name: "no_runtime" },
      ],
    });
    expect(result).toBe("auto_explain,timescaledb");
  });

  test("uses preloadLibraryName and sorts by it", () => {
    // Sorted by entry name this would be "safeupdate,pg_stat_statements" (pg_safeupdate < pg_stat_statements).
    const result = getDefaultSharedPreloadLibraries({
      entries: [
        preload("pg_safeupdate", {
          runtime: { sharedPreload: true, defaultEnable: true, preloadLibraryName: "safeupdate" },
        }),
        preload("pg_stat_statements"),
      ],
    });
    expect(result).toBe("pg_stat_statements,safeupdate");
  });

  test("an empty preloadLibraryName is rejected, not guessed", () => {
    expect(() =>
      getDefaultSharedPreloadLibraries({
        entries: [
          preload("pg_x", {
            runtime: { sharedPreload: true, defaultEnable: true, preloadLibraryName: "" },
          }),
        ],
      })
    ).toThrow("pg_x: runtime.preloadLibraryName is empty");
  });

  test("no preload entries gives an empty list", () => {
    expect(getDefaultSharedPreloadLibraries({ entries: [] })).toBe("");
  });
});

describe("Manifest invariants", () => {
  test("entry names are unique", () => {
    const names = MANIFEST_ENTRIES.map((e) => e.name);
    expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
  });

  test("every disabled entry says why", () => {
    for (const e of MANIFEST_ENTRIES.filter((x) => x.enabled === false)) {
      expect({ name: e.name, reason: e.disabledReason?.trim() || undefined }).toEqual({
        name: e.name,
        reason: expect.any(String),
      });
    }
  });

  test("preload-only entries are shared-preloaded (except SQL-only pgflow)", () => {
    for (const e of MANIFEST_ENTRIES.filter((x) => x.runtime?.preloadOnly === true)) {
      expect({ name: e.name, sharedPreload: e.runtime?.sharedPreload === true }).toEqual({
        name: e.name,
        sharedPreload: e.name !== "pgflow",
      });
    }
  });

  test("default-enabled tools load via preload, never CREATE EXTENSION", () => {
    for (const tool of MANIFEST_ENTRIES.filter(
      (e) => e.kind === "tool" && e.runtime?.defaultEnable === true
    )) {
      const loadsViaPreload =
        tool.runtime?.preloadOnly === true || tool.runtime?.sharedPreload === true;
      expect({ name: tool.name, loadsViaPreload }).toEqual({
        name: tool.name,
        loadsViaPreload: true,
      });
    }
  });

  test("an enabled entry depends only on enabled or builtin entries", () => {
    const byName = new Map(MANIFEST_ENTRIES.map((e) => [e.name, e]));
    for (const e of MANIFEST_ENTRIES.filter((x) => x.enabled !== false)) {
      for (const depName of e.dependencies ?? []) {
        const dep = byName.get(depName);
        const usable = dep !== undefined && (dep.enabled !== false || dep.kind === "builtin");
        expect({ entry: e.name, dep: depName, usable }).toEqual({
          entry: e.name,
          dep: depName,
          usable: true,
        });
      }
    }
  });
});
