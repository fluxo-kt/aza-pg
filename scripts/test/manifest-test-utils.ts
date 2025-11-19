/**
 * Shared test utilities for manifest-driven testing.
 *
 * This module provides type-safe access to the extension manifest for test scripts,
 * enabling tests to automatically adapt to configuration changes.
 *
 * Key Principles:
 * - Single source of truth: Read from manifest-data.ts (TypeScript import)
 * - Fail-safe defaults: Skip disabled extensions gracefully
 * - Type safety: No JSON parsing, use TypeScript types
 * - Reusability: Shared utilities prevent duplication
 */

import { MANIFEST_ENTRIES, type ManifestEntry } from "../extensions/manifest-data";

/**
 * Load manifest entries for tests.
 * Uses direct TypeScript import for type safety and guaranteed freshness.
 */
export function loadManifestForTests(): ManifestEntry[] {
  return MANIFEST_ENTRIES;
}

/**
 * Filter manifest entries to only those valid for testing.
 *
 * Inclusion criteria:
 * - enabled !== false (not explicitly disabled)
 * - kind === "extension" (not tools or builtins)
 * - NOT preloadOnly (can use CREATE EXTENSION)
 *
 * Exclusion criteria:
 * - disabled extensions (enabled: false)
 * - tools (kind: "tool")
 * - builtins (kind: "builtin")
 * - preloadOnly extensions (no .control file)
 */
export function getTestableExtensions(manifest?: ManifestEntry[]): ManifestEntry[] {
  const entries = manifest ?? loadManifestForTests();

  return entries.filter((entry) => {
    // Must be explicitly enabled (or not disabled)
    if (entry.enabled === false) {
      return false;
    }

    // Must be an extension (not tool or builtin)
    if (entry.kind !== "extension") {
      return false;
    }

    // Must support CREATE EXTENSION (not preloadOnly)
    if (entry.runtime?.preloadOnly === true) {
      return false;
    }

    return true;
  });
}

/**
 * Get extensions that require shared_preload_libraries.
 *
 * Returns extensions where runtime.sharedPreload === true.
 *
 * CRITICAL: Excludes tools (kind="tool") since they are NOT built into the Docker image
 * and cannot be loaded via shared_preload_libraries. Tools are binary utilities only.
 */
export function getPreloadExtensions(manifest?: ManifestEntry[]): ManifestEntry[] {
  const entries = manifest ?? loadManifestForTests();

  return entries.filter((entry) => {
    // Must be explicitly enabled (or not disabled)
    if (entry.enabled === false) {
      return false;
    }

    // Must require shared preload
    if (entry.runtime?.sharedPreload !== true) {
      return false;
    }

    // ⭐ CRITICAL FIX: Tools cannot be preloaded (not built into image)
    // Tools are binary utilities (pgbackrest, pgbadger, wal2json, pg_plan_filter, pg_safeupdate)
    // that don't have .so files in the PostgreSQL lib directory
    if (entry.kind === "tool") {
      return false;
    }

    return true;
  });
}

/**
 * Get extensions enabled by default.
 *
 * Returns extensions where runtime.defaultEnable === true.
 */
export function getDefaultEnabledExtensions(manifest?: ManifestEntry[]): ManifestEntry[] {
  const entries = manifest ?? loadManifestForTests();

  return entries.filter((entry) => {
    return entry.enabled !== false && entry.runtime?.defaultEnable === true;
  });
}

/**
 * Build shared_preload_libraries string from extension list.
 *
 * Generates comma-separated list of extension names suitable for PostgreSQL
 * shared_preload_libraries configuration parameter.
 */
export function buildPreloadLibraries(extensions: ManifestEntry[]): string {
  return extensions
    .filter((e) => e.runtime?.sharedPreload === true)
    .map((e) => e.name)
    .join(",");
}

/**
 * Resolve extension dependencies in topological order.
 *
 * Returns extensions sorted so that dependencies come before dependents.
 * Throws error if circular dependencies detected.
 *
 * @param extensions - Extensions to sort
 * @returns Extensions in dependency order (dependencies first)
 */
export function resolveExtensionDependencies(extensions: ManifestEntry[]): ManifestEntry[] {
  const sorted: ManifestEntry[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const nameToEntry = new Map<string, ManifestEntry>();
  for (const ext of extensions) {
    nameToEntry.set(ext.name, ext);
  }

  function visit(entry: ManifestEntry): void {
    if (visited.has(entry.name)) {
      return;
    }

    if (visiting.has(entry.name)) {
      throw new Error(`Circular dependency detected: ${entry.name}`);
    }

    visiting.add(entry.name);

    // Visit dependencies first
    const deps = entry.dependencies ?? [];
    for (const depName of deps) {
      const depEntry = nameToEntry.get(depName);
      if (depEntry) {
        visit(depEntry);
      }
    }

    visiting.delete(entry.name);
    visited.add(entry.name);
    sorted.push(entry);
  }

  for (const ext of extensions) {
    visit(ext);
  }

  return sorted;
}

/**
 * Check if an extension should be skipped in tests.
 *
 * Centralized logic for determining when to skip extension tests,
 * with optional logging.
 *
 * @param entry - Manifest entry to check
 * @param reason - Optional additional skip reason
 * @param verbose - Whether to log skip reason (default: true)
 * @returns true if extension should be skipped, false otherwise
 */
export function shouldSkipExtension(
  entry: ManifestEntry | undefined,
  reason?: string,
  verbose = true
): boolean {
  if (!entry) {
    if (verbose) {
      console.log(`⏭️  Extension not found in manifest${reason ? `: ${reason}` : ""}`);
    }
    return true;
  }

  if (entry.enabled === false) {
    if (verbose) {
      const skipReason = entry.disabledReason ?? "disabled in manifest";
      console.log(`⏭️  Skipping ${entry.name}: ${skipReason}`);
    }
    return true;
  }

  if (entry.kind !== "extension") {
    if (verbose) {
      console.log(`⏭️  Skipping ${entry.name}: kind=${entry.kind} (not extension)`);
    }
    return true;
  }

  if (entry.runtime?.preloadOnly === true) {
    if (verbose) {
      console.log(`⏭️  Skipping ${entry.name}: preloadOnly (no CREATE EXTENSION support)`);
    }
    return true;
  }

  return false;
}

/**
 * Find manifest entry by extension name.
 *
 * Case-insensitive search for extension by name.
 */
export function findExtension(name: string, manifest?: ManifestEntry[]): ManifestEntry | undefined {
  const entries = manifest ?? loadManifestForTests();
  return entries.find((e) => e.name.toLowerCase() === name.toLowerCase());
}

/**
 * Get extensions by category.
 *
 * Returns all enabled extensions in the specified category.
 */
export function getExtensionsByCategory(
  category: string,
  manifest?: ManifestEntry[]
): ManifestEntry[] {
  const entries = manifest ?? loadManifestForTests();

  return entries.filter((entry) => {
    return entry.enabled !== false && entry.category === category && entry.kind === "extension";
  });
}

/**
 * Check if extension requires initialization.
 *
 * Returns true if extension has special initialization requirements
 * (e.g., pgsodium needs ENABLE_PGSODIUM_INIT=true).
 */
export function requiresInitialization(entry: ManifestEntry): boolean {
  // Known extensions requiring initialization
  const INIT_REQUIRED = ["pgsodium"];
  return INIT_REQUIRED.includes(entry.name);
}

/**
 * Get initialization environment variables for extension.
 *
 * Returns key-value pairs for environment variables needed to initialize
 * the extension properly.
 */
export function getInitializationEnv(entry: ManifestEntry): Record<string, string> {
  const env: Record<string, string> = {};

  if (entry.name === "pgsodium") {
    env.ENABLE_PGSODIUM_INIT = "true";
  }

  return env;
}

/**
 * Validate manifest consistency.
 *
 * Checks for common manifest issues:
 * - Disabled extensions should have disabledReason
 * - Dependencies should exist in manifest
 * - No circular dependencies
 *
 * Throws error if validation fails.
 */
export function validateManifest(manifest?: ManifestEntry[]): void {
  const entries = manifest ?? loadManifestForTests();
  const errors: string[] = [];

  const allNames = new Set(entries.map((e) => e.name));

  for (const entry of entries) {
    // Check disabled extensions have reason
    if (entry.enabled === false && !entry.disabledReason) {
      errors.push(`${entry.name}: disabled but missing disabledReason`);
    }

    // Check dependencies exist
    const deps = entry.dependencies ?? [];
    for (const dep of deps) {
      if (!allNames.has(dep)) {
        errors.push(`${entry.name}: dependency '${dep}' not found in manifest`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Manifest validation failed:\n  - ${errors.join("\n  - ")}`);
  }

  // Check for circular dependencies (will throw if detected)
  try {
    resolveExtensionDependencies(entries.filter((e) => e.kind === "extension"));
  } catch (err) {
    throw new Error(
      `Manifest validation failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Validate that a list of entries contains no tools.
 *
 * This is a defensive function to catch manifest filtering bugs that could
 * cause PostgreSQL container crashes. Tools (kind="tool") are binary utilities
 * that are NOT built into the Docker image and CANNOT be loaded via
 * shared_preload_libraries or CREATE EXTENSION.
 *
 * Tools include: pgbackrest, pgbadger, wal2json, pg_plan_filter, pg_safeupdate
 *
 * @param entries - List of manifest entries to validate
 * @param context - Description of where this list is being used (for error messages)
 * @throws Error if any tools found in the list
 */
export function validateNoTools(entries: ManifestEntry[], context: string): void {
  const tools = entries.filter((e) => e.kind === "tool");
  if (tools.length > 0) {
    const toolNames = tools.map((t) => t.name).join(", ");
    throw new Error(
      `${context}: Found tools in extension list: ${toolNames}. ` +
        `Tools cannot be loaded via shared_preload_libraries or CREATE EXTENSION. ` +
        `This indicates a bug in manifest filtering logic. ` +
        `Check getPreloadExtensions() and getTestableExtensions() filters.`
    );
  }
}

/**
 * Get required shared_preload_libraries for testing an extension or tool.
 *
 * Returns environment variable string for optional preload modules that require
 * explicit configuration via POSTGRES_SHARED_PRELOAD_LIBRARIES.
 *
 * @param extensionName - Name of the extension/tool to check
 * @returns Environment variable string to add, or null if no preload needed
 *
 * @example
 * ```typescript
 * const preloadEnv = getPreloadLibrariesForExtension("timescaledb");
 * // Returns: "POSTGRES_SHARED_PRELOAD_LIBRARIES=timescaledb"
 *
 * const preloadEnv2 = getPreloadLibrariesForExtension("pg_safeupdate");
 * // Returns: "POSTGRES_SHARED_PRELOAD_LIBRARIES=safeupdate"
 * ```
 */
export function getPreloadLibrariesForExtension(extensionName: string): string | null {
  const entries = loadManifestForTests();
  const entry = entries.find((e) => e.name === extensionName);

  if (!entry) return null;
  if (!entry.runtime?.sharedPreload) return null;
  if (entry.runtime?.defaultEnable === true) return null; // Already preloaded by default

  // Some extensions use different preload name (e.g., pg_safeupdate → safeupdate)
  const preloadName = extensionName === "pg_safeupdate" ? "safeupdate" : extensionName;

  return `POSTGRES_SHARED_PRELOAD_LIBRARIES=${preloadName}`;
}

/**
 * Get all optional preload modules (extensions + tools) that require explicit configuration.
 *
 * Returns list of entries where:
 * - runtime.sharedPreload === true
 * - runtime.defaultEnable === false (not preloaded by default)
 * - enabled !== false (not disabled in manifest)
 *
 * These are modules that CAN be preloaded but require explicit POSTGRES_SHARED_PRELOAD_LIBRARIES.
 *
 * @returns Array of manifest entries for optional preload modules
 */
export function getOptionalPreloadModules(manifest?: ManifestEntry[]): ManifestEntry[] {
  const entries = manifest ?? loadManifestForTests();

  return entries.filter((entry) => {
    // Must not be explicitly disabled
    if (entry.enabled === false) {
      return false;
    }

    // Must require shared preload
    if (entry.runtime?.sharedPreload !== true) {
      return false;
    }

    // Must NOT be enabled by default (those are already preloaded)
    if (entry.runtime?.defaultEnable === true) {
      return false;
    }

    return true;
  });
}

/**
 * Build POSTGRES_SHARED_PRELOAD_LIBRARIES value for optional preload modules.
 *
 * Combines default preload libraries with specified optional modules.
 * Handles special name mappings (e.g., pg_safeupdate → safeupdate).
 *
 * @param optionalModules - Array of module names to add to preload (e.g., ["timescaledb", "pg_safeupdate"])
 * @returns Comma-separated preload libraries string
 *
 * @example
 * ```typescript
 * const preloadLibs = buildOptionalPreloadLibraries(["timescaledb", "pg_safeupdate"]);
 * // Returns: "auto_explain,pg_cron,pg_stat_monitor,pg_stat_statements,pgaudit,timescaledb,safeupdate"
 * ```
 */
export function buildOptionalPreloadLibraries(optionalModules: string[]): string {
  // Get default preload libraries (defaultEnable: true)
  const defaultPreload = getDefaultEnabledExtensions()
    .filter((e) => e.runtime?.sharedPreload === true)
    .map((e) => e.name);

  // Map optional module names (handle special cases like pg_safeupdate → safeupdate)
  const optionalPreload = optionalModules.map((name) =>
    name === "pg_safeupdate" ? "safeupdate" : name
  );

  // Combine and deduplicate
  const allPreload = [...new Set([...defaultPreload, ...optionalPreload])];

  return allPreload.join(",");
}
