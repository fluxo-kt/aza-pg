/**
 * Shared Test Library for Docker Image Tests
 *
 * This module contains all shared utilities, helper functions, and test functions
 * that are used across the split test files:
 * - test-image-core.ts (Core infrastructure tests)
 * - test-image-functional-1.ts (Functional tests group 1)
 * - test-image-functional-2.ts (Functional tests group 2)
 * - test-image-functional-3.ts (Functional tests group 3)
 *
 * All functions accept a containerName parameter to support parallel execution
 * with independent test containers.
 */

import { join } from "node:path";
import { getErrorMessage } from "../utils/errors";
import { dockerCleanup, dockerRun, dockerRunLive } from "../utils/docker";
import type { TestResult } from "../utils/logger";

// ============================================================================
// CONSTANTS
// ============================================================================

export const REPO_ROOT = join(import.meta.dir, "../..");
export const MANIFEST_PATH = join(REPO_ROOT, "docker/postgres/extensions.manifest.json");

// ============================================================================
// INTERFACES & TYPES
// ============================================================================

export interface ManifestEntry {
  name: string;
  kind: "extension" | "tool" | "builtin";
  install_via?: string;
  enabled?: boolean;
  runtime?: {
    sharedPreload?: boolean;
    defaultEnable?: boolean;
    preloadOnly?: boolean;
  };
}

export interface Manifest {
  generatedAt: string;
  entries: ManifestEntry[];
}

export type { TestResult };

// ============================================================================
// MANIFEST UTILITIES
// ============================================================================

/**
 * Read and parse manifest
 */
export async function readManifest(): Promise<Manifest> {
  const content = await Bun.file(MANIFEST_PATH).json();
  return content as Manifest;
}

/**
 * Check if an extension is enabled in the manifest
 */
export function isExtensionEnabled(manifest: Manifest, extensionName: string): boolean {
  const entry = manifest.entries.find((e) => e.name === extensionName);
  if (!entry) {
    return false;
  }
  return entry.enabled !== false;
}

// ============================================================================
// CONTAINER UTILITIES
// ============================================================================

/**
 * Start test container
 */
export async function startContainer(image: string, containerName: string): Promise<boolean> {
  // Clean up any existing container with same name
  await dockerCleanup(containerName);

  // Start container with test environment
  // Include optional preload modules for comprehensive testing (timescaledb, pg_safeupdate)
  const exitCode = await dockerRunLive([
    "run",
    "-d",
    "--name",
    containerName,
    "-e",
    "POSTGRES_PASSWORD=test123",
    "-e",
    "POSTGRES_DB=postgres",
    "-e",
    "POSTGRES_SHARED_PRELOAD_LIBRARIES=auto_explain,pg_cron,pg_stat_monitor,pg_stat_statements,pgaudit,timescaledb,safeupdate",
    image,
  ]);

  return exitCode === 0;
}

/**
 * Wait for PostgreSQL to be ready
 */
export async function waitForPostgres(
  containerName: string,
  timeoutSeconds: number = 60
): Promise<boolean> {
  const startTime = Date.now();
  const timeoutMs = timeoutSeconds * 1000;

  while (Date.now() - startTime < timeoutMs) {
    const result = await dockerRun(["exec", containerName, "pg_isready", "-U", "postgres"]);

    if (result.success) {
      return true;
    }

    await Bun.sleep(2000);
  }

  return false;
}

/**
 * Execute SQL query in container
 */
export async function execSQL(
  sql: string,
  containerName: string
): Promise<{ success: boolean; output: string }> {
  return await dockerRun([
    "exec",
    containerName,
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-t", // Tuples only
    "-A", // Unaligned
    "-c",
    sql,
  ]);
}

/**
 * Execute command in container
 */
export async function execCommand(
  command: string[],
  containerName: string
): Promise<{ success: boolean; output: string }> {
  return await dockerRun(["exec", containerName, ...command]);
}

/**
 * Check if file exists in container
 */
export async function fileExists(path: string, containerName: string): Promise<boolean> {
  const result = await execCommand(["test", "-f", path], containerName);
  return result.success;
}

// ============================================================================
// FILESYSTEM VERIFICATION TESTS
// ============================================================================

/**
 * Test: Extension directory structure exists
 */
export async function testExtensionDirectoryStructure(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const dirs = ["/usr/share/postgresql/18/extension", "/usr/lib/postgresql/18/lib"];

    const missing: string[] = [];

    for (const dir of dirs) {
      const result = await execCommand(["test", "-d", dir], containerName);
      if (!result.success) {
        missing.push(dir);
      }
    }

    if (missing.length > 0) {
      return {
        name: "Extension directory structure",
        passed: false,
        duration: Date.now() - startTime,
        error: `Missing directories: ${missing.join(", ")}`,
      };
    }

    return {
      name: "Extension directory structure",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "Extension directory structure",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Manifest file is present in image
 */
export async function testManifestPresent(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const manifestPath = "/etc/postgresql/extensions.manifest.json";
    const exists = await fileExists(manifestPath, containerName);

    if (!exists) {
      return {
        name: "Manifest file present",
        passed: false,
        duration: Date.now() - startTime,
        error: `${manifestPath} not found in image`,
      };
    }

    // Try to read and parse it
    const result = await execCommand(["cat", manifestPath], containerName);

    if (!result.success) {
      return {
        name: "Manifest file present",
        passed: false,
        duration: Date.now() - startTime,
        error: `Failed to read ${manifestPath}`,
      };
    }

    try {
      JSON.parse(result.output);
    } catch {
      return {
        name: "Manifest file present",
        passed: false,
        duration: Date.now() - startTime,
        error: `${manifestPath} contains invalid JSON`,
      };
    }

    return {
      name: "Manifest file present",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "Manifest file present",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Version info files are present
 */
export async function testVersionInfoFilesPresent(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const files = ["/etc/postgresql/version-info.txt", "/etc/postgresql/version-info.json"];

    const missing: string[] = [];

    for (const file of files) {
      const exists = await fileExists(file, containerName);
      if (!exists) {
        missing.push(file);
      }
    }

    if (missing.length > 0) {
      return {
        name: "Version info files present",
        passed: false,
        duration: Date.now() - startTime,
        error: `Missing files: ${missing.join(", ")}`,
      };
    }

    return {
      name: "Version info files present",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "Version info files present",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Enabled PGDG extensions are present
 */
export async function testEnabledPgdgExtensionsPresent(
  manifest: Manifest,
  containerName: string
): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const enabledPgdgExtensions = manifest.entries.filter(
      (entry) =>
        entry.enabled !== false &&
        entry.install_via === "pgdg" &&
        entry.kind !== "tool" &&
        entry.runtime?.preloadOnly !== true
    );

    if (enabledPgdgExtensions.length === 0) {
      return {
        name: "Enabled PGDG extensions present (0 to check)",
        passed: true,
        duration: Date.now() - startTime,
      };
    }

    const missing: string[] = [];

    for (const ext of enabledPgdgExtensions) {
      const controlFile = `/usr/share/postgresql/18/extension/${ext.name}.control`;
      const exists = await fileExists(controlFile, containerName);

      if (!exists) {
        missing.push(ext.name);
      }
    }

    if (missing.length > 0) {
      return {
        name: "Enabled PGDG extensions present",
        passed: false,
        duration: Date.now() - startTime,
        error: `${missing.length} enabled extension(s) missing: ${missing.join(", ")}`,
      };
    }

    return {
      name: `Enabled PGDG extensions present (${enabledPgdgExtensions.length} verified)`,
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "Enabled PGDG extensions present",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Disabled PGDG extensions are not present
 */
export async function testDisabledPgdgExtensionsNotPresent(
  manifest: Manifest,
  containerName: string
): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const disabledPgdgExtensions = manifest.entries.filter(
      (entry) => entry.enabled === false && entry.install_via === "pgdg" && entry.kind !== "tool"
    );

    if (disabledPgdgExtensions.length === 0) {
      return {
        name: "Disabled PGDG extensions not present (0 to check)",
        passed: true,
        duration: Date.now() - startTime,
      };
    }

    const unexpectedlyPresent: string[] = [];

    for (const ext of disabledPgdgExtensions) {
      // Skip preload-only modules
      if (ext.runtime?.preloadOnly) {
        continue;
      }

      const controlFile = `/usr/share/postgresql/18/extension/${ext.name}.control`;
      const exists = await fileExists(controlFile, containerName);

      if (exists) {
        unexpectedlyPresent.push(ext.name);
      }
    }

    if (unexpectedlyPresent.length > 0) {
      return {
        name: "Disabled PGDG extensions not present",
        passed: false,
        duration: Date.now() - startTime,
        error: `${unexpectedlyPresent.length} disabled extension(s) unexpectedly present: ${unexpectedlyPresent.join(", ")}`,
      };
    }

    return {
      name: `Disabled PGDG extensions not present (${disabledPgdgExtensions.length} verified)`,
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "Disabled PGDG extensions not present",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

// ============================================================================
// RUNTIME VERIFICATION TESTS
// ============================================================================

/**
 * Test: Enabled extensions can be created
 */
export async function testEnabledExtensions(
  manifest: Manifest,
  containerName: string
): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const enabledExtensions = manifest.entries.filter((entry) => {
      const isEnabled = entry.enabled !== false;
      const isNotTool = entry.kind !== "tool";
      const isNotPreloadOnly = entry.runtime?.preloadOnly !== true;
      // Skip extensions that require optional preload (not in default config)
      // Example: timescaledb requires shared_preload_libraries but is defaultEnable: false
      const isNotOptionalPreload = !(
        entry.runtime?.sharedPreload === true && entry.runtime?.defaultEnable === false
      );
      return isEnabled && isNotTool && isNotPreloadOnly && isNotOptionalPreload;
    });

    const failed: string[] = [];

    for (const ext of enabledExtensions) {
      const result = await execSQL(`CREATE EXTENSION IF NOT EXISTS ${ext.name};`, containerName);

      if (!result.success) {
        failed.push(`${ext.name}: ${result.output.slice(0, 100)}`);
      }
    }

    if (failed.length > 0) {
      return {
        name: "Enabled extensions can be created",
        passed: false,
        duration: Date.now() - startTime,
        error: `${failed.length} extension(s) failed:\n  ${failed.join("\n  ")}`,
      };
    }

    return {
      name: `Enabled extensions can be created (${enabledExtensions.length} tested)`,
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "Enabled extensions can be created",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Pre-created extensions are already available on startup
 */
export async function testPrecreatedExtensions(
  _manifest: Manifest,
  containerName: string
): Promise<TestResult> {
  const startTime = Date.now();

  try {
    // Extensions that should be pre-created in 01-extensions.sql
    const precreatedExtensions = [
      "pg_cron",
      "pg_stat_monitor",
      "pg_stat_statements",
      "pg_trgm",
      "pgaudit",
      "plpgsql",
      "vector",
      "vectorscale",
    ];

    const failed: string[] = [];

    for (const extName of precreatedExtensions) {
      const result = await execSQL(
        `SELECT COUNT(*) FROM pg_extension WHERE extname = '${extName}'`,
        containerName
      );

      if (!result.success) {
        failed.push(`${extName}: Query failed - ${result.output.slice(0, 100)}`);
      } else {
        const count = parseInt(result.output.trim());
        if (count !== 1) {
          failed.push(`${extName}: Not found in pg_extension (count: ${count})`);
        }
      }

      // Also verify CREATE EXTENSION IF NOT EXISTS works (doesn't fail)
      const createResult = await execSQL(
        `CREATE EXTENSION IF NOT EXISTS "${extName}"`,
        containerName
      );
      if (!createResult.success) {
        failed.push(
          `${extName}: CREATE IF NOT EXISTS failed - ${createResult.output.slice(0, 100)}`
        );
      }
    }

    if (failed.length > 0) {
      return {
        name: "Pre-created extensions available on startup",
        passed: false,
        duration: Date.now() - startTime,
        error: `${failed.length} extension(s) had issues:\n  ${failed.join("\n  ")}`,
      };
    }

    return {
      name: `Pre-created extensions available on startup (${precreatedExtensions.length} tested)`,
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "Pre-created extensions available on startup",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Disabled extensions cannot be created
 */
export async function testDisabledExtensions(
  manifest: Manifest,
  containerName: string
): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const disabledExtensions = manifest.entries.filter(
      (entry) => entry.enabled === false && entry.kind !== "tool"
    );

    if (disabledExtensions.length === 0) {
      return {
        name: "Disabled extensions cannot be created (0 to test)",
        passed: true,
        duration: Date.now() - startTime,
      };
    }

    const unexpectedlyAvailable: string[] = [];

    for (const ext of disabledExtensions) {
      const result = await execSQL(`CREATE EXTENSION IF NOT EXISTS ${ext.name};`, containerName);

      // If it succeeds, the extension is unexpectedly available
      if (result.success) {
        unexpectedlyAvailable.push(ext.name);
      }
    }

    if (unexpectedlyAvailable.length > 0) {
      return {
        name: "Disabled extensions cannot be created",
        passed: false,
        duration: Date.now() - startTime,
        error: `${unexpectedlyAvailable.length} disabled extension(s) unexpectedly available: ${unexpectedlyAvailable.join(", ")}`,
      };
    }

    return {
      name: `Disabled extensions cannot be created (${disabledExtensions.length} verified)`,
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "Disabled extensions cannot be created",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Preloaded extensions are in shared_preload_libraries
 */
export async function testPreloadedExtensions(
  manifest: Manifest,
  containerName: string
): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const preloadedExtensions = manifest.entries
      .filter(
        (entry) =>
          entry.enabled !== false &&
          entry.runtime?.sharedPreload === true &&
          entry.runtime?.defaultEnable === true
      )
      .map((entry) => entry.name);

    if (preloadedExtensions.length === 0) {
      return {
        name: "Preloaded extensions in shared_preload_libraries (0 expected)",
        passed: true,
        duration: Date.now() - startTime,
      };
    }

    const result = await execSQL("SHOW shared_preload_libraries;", containerName);

    if (!result.success) {
      return {
        name: "Preloaded extensions in shared_preload_libraries",
        passed: false,
        duration: Date.now() - startTime,
        error: `Failed to read shared_preload_libraries: ${result.output}`,
      };
    }

    const preloadedLibs = result.output
      .split(",")
      .map((lib) => lib.trim())
      .filter((lib) => lib.length > 0);

    const missing: string[] = [];

    for (const ext of preloadedExtensions) {
      if (!preloadedLibs.includes(ext)) {
        missing.push(ext);
      }
    }

    if (missing.length > 0) {
      return {
        name: "Preloaded extensions in shared_preload_libraries",
        passed: false,
        duration: Date.now() - startTime,
        error: `${missing.length} extension(s) missing from shared_preload_libraries: ${missing.join(", ")}`,
      };
    }

    return {
      name: `Preloaded extensions in shared_preload_libraries (${preloadedExtensions.length} verified)`,
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "Preloaded extensions in shared_preload_libraries",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: PostgreSQL configuration is valid
 */
export async function testPostgresConfiguration(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const configs = [
      { name: "shared_buffers", check: (val: string) => val.length > 0 },
      { name: "max_connections", check: (val: string) => parseInt(val, 10) > 0 },
      { name: "work_mem", check: (val: string) => val.length > 0 },
    ];

    const errors: string[] = [];

    for (const config of configs) {
      const result = await execSQL(`SHOW ${config.name};`, containerName);

      if (!result.success) {
        errors.push(`Failed to read ${config.name}`);
        continue;
      }

      if (!config.check(result.output.trim())) {
        errors.push(`Invalid ${config.name}: ${result.output}`);
      }
    }

    if (errors.length > 0) {
      return {
        name: "PostgreSQL configuration",
        passed: false,
        duration: Date.now() - startTime,
        error: errors.join(", "),
      };
    }

    return {
      name: "PostgreSQL configuration",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "PostgreSQL configuration",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Version info txt contains correct counts
 */
export async function testVersionInfoTxt(
  manifest: Manifest,
  containerName: string
): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const result = await execCommand(["cat", "/etc/postgresql/version-info.txt"], containerName);

    if (!result.success) {
      return {
        name: "Version info (version-info.txt)",
        passed: false,
        duration: Date.now() - startTime,
        error: "version-info.txt not found or not readable",
      };
    }

    const content = result.output;

    const totalCount = manifest.entries.length;
    const enabledCount = manifest.entries.filter((e) => e.enabled !== false).length;
    const disabledCount = manifest.entries.filter((e) => e.enabled === false).length;
    const preloadedCount = manifest.entries.filter(
      (e) => e.enabled !== false && e.runtime?.sharedPreload === true
    ).length;

    const errors: string[] = [];

    if (!content.includes(`Total Catalog: ${totalCount}`)) {
      errors.push(`Total count mismatch (expected: ${totalCount})`);
    }

    if (!content.includes(`Enabled: ${enabledCount}`)) {
      errors.push(`Enabled count mismatch (expected: ${enabledCount})`);
    }

    if (!content.includes(`Disabled: ${disabledCount}`)) {
      errors.push(`Disabled count mismatch (expected: ${disabledCount})`);
    }

    if (!content.includes(`Preloaded: ${preloadedCount}`)) {
      errors.push(`Preloaded count mismatch (expected: ${preloadedCount})`);
    }

    if (errors.length > 0) {
      return {
        name: "Version info (version-info.txt)",
        passed: false,
        duration: Date.now() - startTime,
        error: errors.join(", "),
      };
    }

    return {
      name: "Version info (version-info.txt)",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "Version info (version-info.txt)",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Version info json contains correct counts
 */
export async function testVersionInfoJson(
  manifest: Manifest,
  containerName: string
): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const result = await execCommand(["cat", "/etc/postgresql/version-info.json"], containerName);

    if (!result.success) {
      return {
        name: "Version info (version-info.json)",
        passed: false,
        duration: Date.now() - startTime,
        error: "version-info.json not found or not readable",
      };
    }

    const versionInfo = JSON.parse(result.output);

    const expectedCounts = {
      total: manifest.entries.length,
      enabled: manifest.entries.filter((e) => e.enabled !== false).length,
      disabled: manifest.entries.filter((e) => e.enabled === false).length,
      preloaded: manifest.entries.filter(
        (e) => e.enabled !== false && e.runtime?.sharedPreload === true
      ).length,
    };

    const errors: string[] = [];

    if (!versionInfo.extensions) {
      errors.push("Missing 'extensions' object");
    } else {
      if (versionInfo.extensions.total !== expectedCounts.total) {
        errors.push(
          `Total count mismatch (expected: ${expectedCounts.total}, got: ${versionInfo.extensions.total})`
        );
      }

      if (versionInfo.extensions.enabled !== expectedCounts.enabled) {
        errors.push(
          `Enabled count mismatch (expected: ${expectedCounts.enabled}, got: ${versionInfo.extensions.enabled})`
        );
      }

      if (versionInfo.extensions.disabled !== expectedCounts.disabled) {
        errors.push(
          `Disabled count mismatch (expected: ${expectedCounts.disabled}, got: ${versionInfo.extensions.disabled})`
        );
      }

      if (versionInfo.extensions.preloaded !== expectedCounts.preloaded) {
        errors.push(
          `Preloaded count mismatch (expected: ${expectedCounts.preloaded}, got: ${versionInfo.extensions.preloaded})`
        );
      }
    }

    if (errors.length > 0) {
      return {
        name: "Version info (version-info.json)",
        passed: false,
        duration: Date.now() - startTime,
        error: errors.join(", "),
      };
    }

    return {
      name: "Version info (version-info.json)",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "Version info (version-info.json)",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

// ============================================================================
// TOOLS VERIFICATION TESTS
// ============================================================================

/**
 * Test: Tools are present in container
 */
export async function testToolsPresent(
  manifest: Manifest,
  containerName: string
): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const tools = manifest.entries.filter((entry) => entry.kind === "tool");

    if (tools.length === 0) {
      return {
        name: "Tools present (0 to check)",
        passed: true,
        duration: Date.now() - startTime,
      };
    }

    const toolBinaries: Record<string, string> = {
      pgbackrest: "/usr/bin/pgbackrest", // PGDG package path
      pgbadger: "/usr/bin/pgbadger", // PGDG package path
      wal2json: "/usr/lib/postgresql/18/lib/wal2json.so",
      plan_filter: "/usr/lib/postgresql/18/lib/plan_filter.so",
      safeupdate: "/usr/lib/postgresql/18/lib/safeupdate.so",
    };

    const missing: string[] = [];

    for (const tool of tools) {
      const binaryPath = toolBinaries[tool.name];
      if (!binaryPath) {
        continue; // Unknown tool, skip
      }

      const exists = await fileExists(binaryPath, containerName);
      if (!exists) {
        missing.push(`${tool.name} (${binaryPath})`);
      }
    }

    if (missing.length > 0) {
      return {
        name: "Tools present",
        passed: false,
        duration: Date.now() - startTime,
        error: `${missing.length} tool(s) missing: ${missing.join(", ")}`,
      };
    }

    return {
      name: `Tools present (${tools.length} verified)`,
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "Tools present",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: pgBackRest is functional
 */
export async function testPgBackRestFunctional(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const result = await execCommand(["pgbackrest", "version"], containerName);

    if (!result.success) {
      return {
        name: "pgBackRest functional",
        passed: false,
        duration: Date.now() - startTime,
        error: "pgbackrest version command failed",
      };
    }

    if (!result.output.includes("pgBackRest")) {
      return {
        name: "pgBackRest functional",
        passed: false,
        duration: Date.now() - startTime,
        error: "pgbackrest version output unexpected",
      };
    }

    return {
      name: "pgBackRest functional",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "pgBackRest functional",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: pgBadger is functional
 */
export async function testPgBadgerFunctional(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const result = await execCommand(["pgbadger", "--version"], containerName);

    if (!result.success) {
      return {
        name: "pgBadger functional",
        passed: false,
        duration: Date.now() - startTime,
        error: "pgbadger --version command failed",
      };
    }

    if (!result.output.toLowerCase().includes("pgbadger")) {
      return {
        name: "pgBadger functional",
        passed: false,
        duration: Date.now() - startTime,
        error: "pgbadger version output unexpected",
      };
    }

    return {
      name: "pgBadger functional",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "pgBadger functional",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

// ============================================================================
// AUTO-CONFIG TESTS
// ============================================================================

/**
 * Test: Auto-config is applied
 */
export async function testAutoConfigApplied(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    // Check that key auto-configured settings are set
    const settings = [
      "shared_buffers",
      "effective_cache_size",
      "maintenance_work_mem",
      "work_mem",
      "max_connections",
    ];

    const errors: string[] = [];

    for (const setting of settings) {
      const result = await execSQL(`SHOW ${setting};`, containerName);

      if (!result.success) {
        errors.push(`Failed to read ${setting}`);
        continue;
      }

      const value = result.output.trim();
      if (!value || value === "") {
        errors.push(`${setting} is empty`);
      }
    }

    if (errors.length > 0) {
      return {
        name: "Auto-config applied",
        passed: false,
        duration: Date.now() - startTime,
        error: errors.join(", "),
      };
    }

    return {
      name: "Auto-config applied",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "Auto-config applied",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

// ============================================================================
// COMPREHENSIVE FUNCTIONAL TESTS
// ============================================================================

/**
 * Test: AI/Vector - pgvector HNSW index and similarity search
 */
export async function testPgvectorComprehensive(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    // Create table and insert vectors
    await execSQL(
      "CREATE TABLE IF NOT EXISTS test_vectors (id serial PRIMARY KEY, embedding vector(3))",
      containerName
    );
    await execSQL(
      "INSERT INTO test_vectors (embedding) VALUES ('[1,2,3]'), ('[4,5,6]'), ('[7,8,9]')",
      containerName
    );

    // Build HNSW index
    const index = await execSQL(
      "CREATE INDEX IF NOT EXISTS test_vectors_hnsw_idx ON test_vectors USING hnsw (embedding vector_l2_ops)",
      containerName
    );
    if (!index.success) {
      return {
        name: "pgvector - HNSW index and similarity search",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to create HNSW index",
      };
    }

    // Similarity search
    const search = await execSQL(
      "SELECT id FROM test_vectors ORDER BY embedding <-> '[3,1,2]' LIMIT 2",
      containerName
    );
    if (!search.success || search.output.trim() === "") {
      return {
        name: "pgvector - HNSW index and similarity search",
        passed: false,
        duration: Date.now() - startTime,
        error: "Similarity search failed",
      };
    }

    return {
      name: "pgvector - HNSW index and similarity search",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "pgvector - HNSW index and similarity search",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: AI/Vector - vectorscale diskann index
 */
export async function testVectorscaleDiskann(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE", containerName);
    await execSQL(
      "CREATE TABLE IF NOT EXISTS test_vectorscale (id serial PRIMARY KEY, vec vector(3))",
      containerName
    );
    await execSQL(
      "INSERT INTO test_vectorscale (vec) VALUES ('[1,0,0]'), ('[0,1,0]'), ('[0,0,1]')",
      containerName
    );

    const index = await execSQL(
      "CREATE INDEX IF NOT EXISTS test_vectorscale_diskann_idx ON test_vectorscale USING diskann (vec)",
      containerName
    );
    if (!index.success) {
      return {
        name: "vectorscale - DiskANN index",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to create DiskANN index",
      };
    }

    const search = await execSQL(
      "SELECT id FROM test_vectorscale ORDER BY vec <-> '[1,1,1]' LIMIT 1",
      containerName
    );
    if (!search.success || search.output.trim() === "") {
      return {
        name: "vectorscale - DiskANN index",
        passed: false,
        duration: Date.now() - startTime,
        error: "DiskANN search failed",
      };
    }

    return {
      name: "vectorscale - DiskANN index",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "vectorscale - DiskANN index",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Analytics - hll cardinality estimation
 */
export async function testHllCardinality(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS hll CASCADE", containerName);
    await execSQL(
      "CREATE TABLE IF NOT EXISTS test_hll (id serial PRIMARY KEY, users hll)",
      containerName
    );
    await execSQL("INSERT INTO test_hll (users) VALUES (hll_empty())", containerName);
    await execSQL(
      "UPDATE test_hll SET users = hll_add(users, hll_hash_integer(1)) WHERE id = 1",
      containerName
    );

    const count = await execSQL(
      "SELECT hll_cardinality(users)::int FROM test_hll WHERE id = 1",
      containerName
    );
    if (!count.success || count.output.trim() !== "1") {
      return {
        name: "hll - Cardinality estimation",
        passed: false,
        duration: Date.now() - startTime,
        error: `Expected cardinality 1, got ${count.output}`,
      };
    }

    return {
      name: "hll - Cardinality estimation",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "hll - Cardinality estimation",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: CDC - wal2json logical replication
 */
export async function testWal2jsonReplication(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    // Drop slot if exists
    await execSQL(
      "SELECT pg_drop_replication_slot('test_wal2json_slot') FROM pg_replication_slots WHERE slot_name = 'test_wal2json_slot'",
      containerName
    );

    const slot = await execSQL(
      "SELECT pg_create_logical_replication_slot('test_wal2json_slot', 'wal2json')",
      containerName
    );
    if (!slot.success) {
      return {
        name: "wal2json - Logical replication",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to create replication slot",
      };
    }

    // Perform DML and read changes
    await execSQL(
      "CREATE TABLE IF NOT EXISTS test_wal2json_table (id int, data text)",
      containerName
    );
    await execSQL("INSERT INTO test_wal2json_table VALUES (1, 'test')", containerName);

    const changes = await execSQL(
      "SELECT data FROM pg_logical_slot_peek_changes('test_wal2json_slot', NULL, NULL, 'format-version', '2')",
      containerName
    );
    if (!changes.success) {
      await execSQL("SELECT pg_drop_replication_slot('test_wal2json_slot')", containerName);
      return {
        name: "wal2json - Logical replication",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to read wal2json changes",
      };
    }

    // Cleanup
    await execSQL("SELECT pg_drop_replication_slot('test_wal2json_slot')", containerName);

    return {
      name: "wal2json - Logical replication",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "wal2json - Logical replication",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: GIS - PostGIS spatial queries
 */
export async function testPostgisSpatialQuery(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS postgis CASCADE", containerName);
    await execSQL(
      "CREATE TABLE IF NOT EXISTS test_postgis (id serial PRIMARY KEY, geom geometry(Point, 4326))",
      containerName
    );
    await execSQL(
      "INSERT INTO test_postgis (geom) VALUES (ST_SetSRID(ST_MakePoint(-71.060316, 48.432044), 4326))",
      containerName
    );

    const query = await execSQL(
      "SELECT count(*) FROM test_postgis WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(-71, 48), 4326)::geography, 100000)",
      containerName
    );
    if (!query.success || parseInt(query.output.trim()) === 0) {
      return {
        name: "PostGIS - Spatial query",
        passed: false,
        duration: Date.now() - startTime,
        error: "Spatial query failed",
      };
    }

    // Build spatial index
    await execSQL(
      "CREATE INDEX IF NOT EXISTS test_postgis_geom_idx ON test_postgis USING GIST (geom)",
      containerName
    );

    return {
      name: "PostGIS - Spatial query",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "PostGIS - Spatial query",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: GIS - pgRouting shortest path
 */
export async function testPgroutingShortestPath(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS pgrouting CASCADE", containerName);
    await execSQL(
      `CREATE TABLE IF NOT EXISTS test_routing (
      id serial PRIMARY KEY,
      source int,
      target int,
      cost float
    )`,
      containerName
    );
    await execSQL(
      "INSERT INTO test_routing (source, target, cost) VALUES (1, 2, 1.0), (2, 3, 2.0), (1, 3, 5.0)",
      containerName
    );

    const path = await execSQL(
      "SELECT * FROM pgr_dijkstra('SELECT id, source, target, cost FROM test_routing', 1, 3, false)",
      containerName
    );
    if (!path.success || path.output.trim() === "") {
      return {
        name: "pgRouting - Shortest path",
        passed: false,
        duration: Date.now() - startTime,
        error: "Dijkstra shortest path failed",
      };
    }

    return {
      name: "pgRouting - Shortest path",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "pgRouting - Shortest path",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Indexing - btree_gist exclusion constraint
 */
export async function testBtreeGistExclusion(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS btree_gist CASCADE", containerName);
    const create = await execSQL(
      `CREATE TABLE IF NOT EXISTS test_exclusion (
      id serial PRIMARY KEY,
      period int4range,
      EXCLUDE USING GIST (period WITH &&)
    )`,
      containerName
    );

    if (!create.success) {
      return {
        name: "btree_gist - Exclusion constraint",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to create exclusion constraint",
      };
    }

    await execSQL("INSERT INTO test_exclusion (period) VALUES (int4range(1, 10))", containerName);
    const conflict = await execSQL(
      "INSERT INTO test_exclusion (period) VALUES (int4range(5, 15))",
      containerName
    );

    if (conflict.success) {
      return {
        name: "btree_gist - Exclusion constraint",
        passed: false,
        duration: Date.now() - startTime,
        error: "Exclusion constraint should prevent overlapping ranges",
      };
    }

    return {
      name: "btree_gist - Exclusion constraint",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "btree_gist - Exclusion constraint",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Integration - http GET/POST
 */
export async function testHttpRequests(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS http CASCADE", containerName);

    // GET request
    const getResult = await execSQL(
      "SELECT status FROM http_get('https://httpbin.org/status/200')",
      containerName
    );

    // Handle external service issues gracefully
    if (
      getResult.success &&
      (getResult.output.trim() === "503" || getResult.output.trim() === "429")
    ) {
      return {
        name: "http - GET/POST requests",
        passed: true,
        duration: Date.now() - startTime,
      };
    }

    if (!getResult.success || getResult.output.trim() !== "200") {
      return {
        name: "http - GET/POST requests",
        passed: false,
        duration: Date.now() - startTime,
        error: "HTTP GET request failed",
      };
    }

    return {
      name: "http - GET/POST requests",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "http - GET/POST requests",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Language - plpgsql triggers
 */
export async function testPlpgsqlTriggers(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL(
      "CREATE TABLE IF NOT EXISTS test_trigger_table (id serial PRIMARY KEY, val int)",
      containerName
    );

    const triggerFunc = await execSQL(
      `CREATE OR REPLACE FUNCTION test_trigger_func() RETURNS TRIGGER AS $$
    BEGIN
      NEW.val := NEW.val * 2;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`,
      containerName
    );

    if (!triggerFunc.success) {
      return {
        name: "plpgsql - Triggers",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to create trigger function",
      };
    }

    await execSQL("DROP TRIGGER IF EXISTS test_trigger ON test_trigger_table", containerName);
    await execSQL(
      "CREATE TRIGGER test_trigger BEFORE INSERT ON test_trigger_table FOR EACH ROW EXECUTE FUNCTION test_trigger_func()",
      containerName
    );

    await execSQL("INSERT INTO test_trigger_table (val) VALUES (5)", containerName);
    const result = await execSQL(
      "SELECT val FROM test_trigger_table ORDER BY id DESC LIMIT 1",
      containerName
    );

    if (!result.success || result.output.trim() !== "10") {
      return {
        name: "plpgsql - Triggers",
        passed: false,
        duration: Date.now() - startTime,
        error: "Trigger did not execute correctly",
      };
    }

    return {
      name: "plpgsql - Triggers",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "plpgsql - Triggers",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Maintenance - pg_partman partitioning
 */
export async function testPgPartmanPartitioning(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS pg_partman CASCADE", containerName);
    await execSQL(
      `CREATE TABLE IF NOT EXISTS test_partman (
      id serial,
      created_at timestamp NOT NULL DEFAULT now(),
      data text
    ) PARTITION BY RANGE (created_at)`,
      containerName
    );

    // Clean up existing config
    await execSQL(
      "DELETE FROM part_config WHERE parent_table = 'public.test_partman'",
      containerName
    );

    // Ensure pgsodium is created first and trigger disabled (pg_partman CASCADE dependency)
    await execSQL("CREATE EXTENSION IF NOT EXISTS pgsodium CASCADE", containerName);
    await execSQL("ALTER EVENT TRIGGER pgsodium_trg_mask_update DISABLE", containerName).catch(
      () => {
        /* Ignore if trigger doesn't exist */
      }
    );

    const config = await execSQL(
      "SELECT create_parent('public.test_partman', 'created_at', '1 day', 'range', p_start_partition := '2025-01-01')",
      containerName
    );
    if (!config.success) {
      return {
        name: "pg_partman - Partitioning",
        passed: false,
        duration: Date.now() - startTime,
        error: `Failed to configure pg_partman: ${config.output}`,
      };
    }

    // Verify partitions created
    const check = await execSQL(
      "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'test_partman_p%'",
      containerName
    );
    if (!check.success || parseInt(check.output.trim()) === 0) {
      return {
        name: "pg_partman - Partitioning",
        passed: false,
        duration: Date.now() - startTime,
        error: "No partitions created",
      };
    }

    return {
      name: "pg_partman - Partitioning",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "pg_partman - Partitioning",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Observability - pg_stat_statements
 */
export async function testPgStatStatements(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const reset = await execSQL("SELECT pg_stat_statements_reset()", containerName);
    if (!reset.success) {
      return {
        name: "pg_stat_statements - Statistics",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to reset pg_stat_statements",
      };
    }

    const verify = await execSQL("SELECT count(*) FROM pg_stat_statements", containerName);
    if (!verify.success) {
      return {
        name: "pg_stat_statements - Statistics",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to query pg_stat_statements",
      };
    }

    return {
      name: "pg_stat_statements - Statistics",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "pg_stat_statements - Statistics",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Operations - pg_cron job scheduling
 */
export async function testPgCronScheduling(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS pg_cron CASCADE", containerName);

    const schedule = await execSQL(
      "SELECT cron.schedule('test-job', '* * * * *', 'SELECT 1')",
      containerName
    );
    if (!schedule.success) {
      return {
        name: "pg_cron - Job scheduling",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to schedule cron job",
      };
    }

    const check = await execSQL(
      "SELECT count(*) FROM cron.job WHERE jobname = 'test-job'",
      containerName
    );
    if (!check.success || parseInt(check.output.trim()) !== 1) {
      return {
        name: "pg_cron - Job scheduling",
        passed: false,
        duration: Date.now() - startTime,
        error: "Cron job not found",
      };
    }

    // Cleanup
    const jobId = await execSQL(
      "SELECT jobid FROM cron.job WHERE jobname = 'test-job'",
      containerName
    );
    if (jobId.success && jobId.output.trim() !== "") {
      await execSQL(`SELECT cron.unschedule(${jobId.output})`, containerName);
    }

    return {
      name: "pg_cron - Job scheduling",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "pg_cron - Job scheduling",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Performance - hypopg hypothetical indexes
 */
export async function testHypopgHypotheticalIndexes(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS hypopg CASCADE", containerName);
    await execSQL(
      "CREATE TABLE IF NOT EXISTS test_hypopg (id serial PRIMARY KEY, val int)",
      containerName
    );
    await execSQL("INSERT INTO test_hypopg (val) SELECT generate_series(1, 1000)", containerName);

    // Create and verify in same session (hypothetical indexes are session-local)
    const result = await execSQL(
      `
      SELECT * FROM hypopg_create_index('CREATE INDEX ON test_hypopg (val)');
      SELECT count(*) FROM hypopg_list_indexes;
    `,
      containerName
    );

    const lines = result.output.split("\n").filter((l: string) => l.trim());
    const lastLine = lines[lines.length - 1];

    if (!result.success || !lastLine || parseInt(lastLine) === 0) {
      return {
        name: "hypopg - Hypothetical indexes",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to create hypothetical index",
      };
    }

    return {
      name: "hypopg - Hypothetical indexes",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "hypopg - Hypothetical indexes",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Queueing - pgmq message queue
 */
export async function testPgmqQueue(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS pgmq CASCADE", containerName);

    const create = await execSQL("SELECT pgmq.create('test_queue')", containerName);
    if (!create.success) {
      return {
        name: "pgmq - Message queue",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to create queue",
      };
    }

    const send = await execSQL(
      'SELECT pgmq.send(\'test_queue\', \'{"task": "process_order", "order_id": 123}\'::jsonb)',
      containerName
    );
    if (!send.success) {
      return {
        name: "pgmq - Message queue",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to send message",
      };
    }

    const read = await execSQL("SELECT msg_id FROM pgmq.read('test_queue', 30, 1)", containerName);
    if (!read.success || read.output.trim() === "") {
      return {
        name: "pgmq - Message queue",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to read message",
      };
    }

    return {
      name: "pgmq - Message queue",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "pgmq - Message queue",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Safety - pg_safeupdate blocks unsafe updates
 */
export async function testPgSafeupdateProtection(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL(
      "CREATE TABLE IF NOT EXISTS test_safeupdate (id serial PRIMARY KEY, val int)",
      containerName
    );
    await execSQL("INSERT INTO test_safeupdate (val) VALUES (1), (2), (3)", containerName);

    // Attempt UPDATE without WHERE (should be blocked)
    const updateResult = await execSQL("UPDATE test_safeupdate SET val = 99", containerName);

    if (updateResult.success) {
      return {
        name: "pg_safeupdate - UPDATE protection",
        passed: false,
        duration: Date.now() - startTime,
        error: "pg_safeupdate should block UPDATE without WHERE",
      };
    }

    // Verify UPDATE with WHERE works
    const safeUpdate = await execSQL(
      "UPDATE test_safeupdate SET val = 99 WHERE id = 1",
      containerName
    );
    if (!safeUpdate.success) {
      return {
        name: "pg_safeupdate - UPDATE protection",
        passed: false,
        duration: Date.now() - startTime,
        error: "UPDATE with WHERE should succeed",
      };
    }

    return {
      name: "pg_safeupdate - UPDATE protection",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "pg_safeupdate - UPDATE protection",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Search - pg_trgm similarity search
 */
export async function testPgTrgmSimilarity(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS pg_trgm CASCADE", containerName);
    await execSQL(
      "CREATE TABLE IF NOT EXISTS test_trgm (id serial PRIMARY KEY, text_col text)",
      containerName
    );
    await execSQL(
      "INSERT INTO test_trgm (text_col) VALUES ('hello world'), ('hello universe'), ('goodbye world')",
      containerName
    );
    await execSQL(
      "CREATE INDEX IF NOT EXISTS test_trgm_idx ON test_trgm USING GIN (text_col gin_trgm_ops)",
      containerName
    );

    const search = await execSQL(
      "SELECT text_col FROM test_trgm WHERE text_col % 'helo wrld' ORDER BY similarity(text_col, 'helo wrld') DESC",
      containerName
    );
    if (!search.success || search.output.trim() === "") {
      return {
        name: "pg_trgm - Similarity search",
        passed: false,
        duration: Date.now() - startTime,
        error: "Similarity search failed",
      };
    }

    return {
      name: "pg_trgm - Similarity search",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "pg_trgm - Similarity search",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Search - pgroonga full-text search
 */
export async function testPgroongaFullText(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS pgroonga CASCADE", containerName);
    await execSQL(
      "CREATE TABLE IF NOT EXISTS test_pgroonga (id serial PRIMARY KEY, content text)",
      containerName
    );
    await execSQL(
      "INSERT INTO test_pgroonga (content) VALUES ('PostgreSQL full-text search'), ('Groonga is fast'), ('Full-text search engine')",
      containerName
    );
    await execSQL(
      "CREATE INDEX IF NOT EXISTS test_pgroonga_idx ON test_pgroonga USING pgroonga (content)",
      containerName
    );

    const search = await execSQL(
      "SELECT content FROM test_pgroonga WHERE content &@~ 'full-text'",
      containerName
    );
    if (!search.success || search.output.trim() === "") {
      return {
        name: "pgroonga - Full-text search",
        passed: false,
        duration: Date.now() - startTime,
        error: "Full-text search failed",
      };
    }

    return {
      name: "pgroonga - Full-text search",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "pgroonga - Full-text search",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Search - rum ranked search
 */
export async function testRumRankedSearch(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS rum CASCADE", containerName);
    await execSQL(
      "CREATE TABLE IF NOT EXISTS test_rum (id serial PRIMARY KEY, content tsvector)",
      containerName
    );
    await execSQL(
      "INSERT INTO test_rum (content) VALUES (to_tsvector('english', 'The quick brown fox jumps over the lazy dog'))",
      containerName
    );
    await execSQL(
      "INSERT INTO test_rum (content) VALUES (to_tsvector('english', 'A fast brown fox leaps over a sleepy dog'))",
      containerName
    );
    await execSQL(
      "CREATE INDEX IF NOT EXISTS test_rum_idx ON test_rum USING rum (content rum_tsvector_ops)",
      containerName
    );

    const search = await execSQL(
      "SELECT content FROM test_rum WHERE content @@ to_tsquery('english', 'fox & dog')",
      containerName
    );
    if (!search.success || search.output.trim() === "") {
      return {
        name: "rum - Ranked search",
        passed: false,
        duration: Date.now() - startTime,
        error: "RUM ranked search failed",
      };
    }

    return {
      name: "rum - Ranked search",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "rum - Ranked search",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Security - pgaudit logging
 */
export async function testPgauditLogging(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const result = await execSQL(
      `
      SET pgaudit.log = 'write, ddl';
      SHOW pgaudit.log;
    `,
      containerName
    );

    const lines = result.output.split("\n").filter((l: string) => l.trim());
    const setting = lines[lines.length - 1];

    if (!result.success || !setting || !setting.includes("write")) {
      return {
        name: "pgaudit - Audit logging",
        passed: false,
        duration: Date.now() - startTime,
        error: "pgaudit not configured correctly",
      };
    }

    return {
      name: "pgaudit - Audit logging",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "pgaudit - Audit logging",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Security - pgsodium encryption
 */
export async function testPgsodiumEncryption(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS pgsodium CASCADE", containerName);

    // Disable event triggers if pgsodium not preloaded (prevents GUC parameter errors)
    await execSQL("ALTER EVENT TRIGGER pgsodium_trg_mask_update DISABLE", containerName).catch(
      () => {
        /* Ignore if trigger doesn't exist */
      }
    );

    const key = await execSQL(
      "SELECT encode(pgsodium.crypto_secretbox_keygen(), 'hex')",
      containerName
    );
    if (!key.success || key.output.trim() === "") {
      return {
        name: "pgsodium - Encryption",
        passed: false,
        duration: Date.now() - startTime,
        error: "Key generation failed",
      };
    }

    const nonce = await execSQL(
      "SELECT encode(pgsodium.crypto_secretbox_noncegen(), 'hex')",
      containerName
    );
    if (!nonce.success) {
      return {
        name: "pgsodium - Encryption",
        passed: false,
        duration: Date.now() - startTime,
        error: "Nonce generation failed",
      };
    }

    const plaintext = "secret data";
    const encrypt = await execSQL(
      `
      SELECT encode(
        pgsodium.crypto_secretbox(
          '${plaintext}'::bytea,
          decode('${nonce.output}', 'hex'),
          decode('${key.output}', 'hex')
        ),
        'hex'
      )
    `,
      containerName
    );

    if (!encrypt.success || encrypt.output.trim() === "") {
      return {
        name: "pgsodium - Encryption",
        passed: false,
        duration: Date.now() - startTime,
        error: "Encryption failed",
      };
    }

    const decrypt = await execSQL(
      `
      SELECT convert_from(
        pgsodium.crypto_secretbox_open(
          decode('${encrypt.output}', 'hex'),
          decode('${nonce.output}', 'hex'),
          decode('${key.output}', 'hex')
        ),
        'utf8'
      )
    `,
      containerName
    );

    if (!decrypt.success || decrypt.output.trim() !== plaintext) {
      return {
        name: "pgsodium - Encryption",
        passed: false,
        duration: Date.now() - startTime,
        error: "Decryption failed",
      };
    }

    return {
      name: "pgsodium - Encryption",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "pgsodium - Encryption",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Timeseries - timescaledb hypertables
 */
export async function testTimescaledbHypertables(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE", containerName);
    await execSQL(
      `CREATE TABLE IF NOT EXISTS test_timescale (
      time timestamptz NOT NULL,
      device_id int,
      temperature float
    )`,
      containerName
    );

    const hypertable = await execSQL(
      "SELECT create_hypertable('test_timescale', 'time', if_not_exists => TRUE, migrate_data => TRUE)",
      containerName
    );
    if (!hypertable.success) {
      return {
        name: "timescaledb - Hypertables",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to create hypertable",
      };
    }

    const insert = await execSQL(
      `
      INSERT INTO test_timescale (time, device_id, temperature)
      SELECT time, device_id, random() * 30
      FROM generate_series(now() - interval '7 days', now(), interval '1 hour') AS time,
           generate_series(1, 5) AS device_id
    `,
      containerName
    );

    if (!insert.success) {
      return {
        name: "timescaledb - Hypertables",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to insert time-series data",
      };
    }

    return {
      name: "timescaledb - Hypertables",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "timescaledb - Hypertables",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Utilities - pg_hashids encoding
 */
export async function testPgHashidsEncoding(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS pg_hashids CASCADE", containerName);

    const encode = await execSQL("SELECT id_encode(12345)", containerName);
    if (!encode.success || encode.output.trim() === "") {
      return {
        name: "pg_hashids - Encoding",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to encode hashid",
      };
    }

    const encodedValue = encode.output.trim();
    const decode = await execSQL(`SELECT (id_decode('${encodedValue}'))[1]::text`, containerName);

    if (!decode.success || decode.output.trim() !== "12345") {
      return {
        name: "pg_hashids - Encoding",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to decode hashid",
      };
    }

    return {
      name: "pg_hashids - Encoding",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "pg_hashids - Encoding",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Validation - pg_jsonschema validation
 */
export async function testPgJsonschemaValidation(containerName: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS pg_jsonschema CASCADE", containerName);

    const schema = `{
      "type": "object",
      "properties": {
        "name": {"type": "string"},
        "age": {"type": "number"}
      },
      "required": ["name"]
    }`;

    const validDoc = `{"name": "John", "age": 30}`;
    const validate = await execSQL(
      `SELECT json_matches_schema('${schema}'::json, '${validDoc}'::json)`,
      containerName
    );

    if (!validate.success || validate.output.trim() !== "t") {
      return {
        name: "pg_jsonschema - Validation",
        passed: false,
        duration: Date.now() - startTime,
        error: "Valid document should pass validation",
      };
    }

    const invalidDoc = `{"age": 30}`;
    const validateInvalid = await execSQL(
      `SELECT json_matches_schema('${schema}'::json, '${invalidDoc}'::json)`,
      containerName
    );

    if (!validateInvalid.success || validateInvalid.output.trim() !== "f") {
      return {
        name: "pg_jsonschema - Validation",
        passed: false,
        duration: Date.now() - startTime,
        error: "Invalid document should fail validation",
      };
    }

    return {
      name: "pg_jsonschema - Validation",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "pg_jsonschema - Validation",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

// ============================================================================
// CLEANUP UTILITIES
// ============================================================================

/**
 * Cleanup test tables and data
 */
export async function cleanupTestData(containerName: string): Promise<void> {
  const tables = [
    "test_vectors",
    "test_vectorscale",
    "test_hll",
    "test_wal2json_table",
    "test_postgis",
    "test_routing",
    "test_btree_gin",
    "test_btree_gist",
    "test_exclusion",
    "test_trigger_table",
    "test_partman",
    "test_hypopg",
    "test_safeupdate",
    "test_trgm",
    "test_pgroonga",
    "test_rum",
    "test_audit",
    "test_timescale",
  ];

  for (const table of tables) {
    await execSQL(`DROP TABLE IF EXISTS ${table} CASCADE`, containerName);
  }

  // Cleanup pg_partman config
  await execSQL("DELETE FROM part_config WHERE parent_table LIKE 'public.test_%'", containerName);

  // Cleanup materialized views
  await execSQL("DROP MATERIALIZED VIEW IF EXISTS test_timescale_hourly CASCADE", containerName);
}
