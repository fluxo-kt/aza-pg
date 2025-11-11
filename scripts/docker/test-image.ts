#!/usr/bin/env bun
/**
 * Comprehensive Docker Image Test Harness
 *
 * Runs a full suite of tests against a Docker image:
 * - Filesystem verification (extensions, tools, manifest)
 * - Runtime verification (extension creation, preload, config)
 * - Extension functional tests
 * - Auto-configuration tests
 * - Disabled extensions tests
 * - Tools verification
 *
 * Usage:
 *   bun scripts/docker/test-image.ts [image-tag]
 *   bun scripts/docker/test-image.ts aza-pg:latest
 *   bun scripts/docker/test-image.ts ghcr.io/fluxo-kt/aza-pg:18.0-202511092330-single-node
 *
 * Options:
 *   --no-cleanup   - Keep container running after tests
 *   --fast         - Skip time-consuming functional tests
 */

import { join } from "node:path";
import { getErrorMessage } from "../utils/errors.js";
import { checkDockerDaemon, dockerCleanup, dockerRun, dockerRunLive } from "../utils/docker.js";
import {
  error,
  formatDuration,
  info,
  section,
  success,
  testSummary,
  warning,
} from "../utils/logger.js";
import type { TestResult } from "../utils/logger.js";

const REPO_ROOT = join(import.meta.dir, "../..");
const MANIFEST_PATH = join(REPO_ROOT, "docker/postgres/extensions.manifest.json");

// Parse command line arguments
const args = Bun.argv.slice(2);
const imageTag = args.find((arg) => !arg.startsWith("--")) || "aza-pg:latest";
const noCleanup = args.includes("--no-cleanup");
const fastMode = args.includes("--fast");

// Generate unique container name
const timestamp = Date.now();
const CONTAINER_NAME = `aza-pg-test-${timestamp}`;

interface ManifestEntry {
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

interface Manifest {
  generatedAt: string;
  entries: ManifestEntry[];
}

/**
 * Read and parse manifest
 */
async function readManifest(): Promise<Manifest> {
  const content = await Bun.file(MANIFEST_PATH).json();
  return content as Manifest;
}

/**
 * Start test container
 */
async function startContainer(image: string): Promise<boolean> {
  info(`Starting test container: ${CONTAINER_NAME}`);
  info(`Image: ${image}`);

  // Clean up any existing container with same name
  await dockerCleanup(CONTAINER_NAME);

  // Start container with test environment
  const exitCode = await dockerRunLive([
    "run",
    "-d",
    "--name",
    CONTAINER_NAME,
    "-e",
    "POSTGRES_PASSWORD=test123",
    "-e",
    "POSTGRES_DB=postgres",
    image,
  ]);

  if (exitCode !== 0) {
    error("Failed to start test container");
    return false;
  }

  success("Test container started");
  return true;
}

/**
 * Wait for PostgreSQL to be ready
 */
async function waitForPostgres(timeoutSeconds: number = 60): Promise<boolean> {
  info(`Waiting for PostgreSQL to be ready (timeout: ${timeoutSeconds}s)...`);

  const startTime = Date.now();
  const timeoutMs = timeoutSeconds * 1000;

  while (Date.now() - startTime < timeoutMs) {
    const result = await dockerRun(["exec", CONTAINER_NAME, "pg_isready", "-U", "postgres"]);

    if (result.success) {
      success(`PostgreSQL ready in ${formatDuration(Date.now() - startTime)}`);
      return true;
    }

    await Bun.sleep(2000);
  }

  error(`PostgreSQL not ready after ${timeoutSeconds}s`);
  return false;
}

/**
 * Execute SQL query in container
 */
async function execSQL(sql: string): Promise<{ success: boolean; output: string }> {
  return await dockerRun([
    "exec",
    CONTAINER_NAME,
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
async function execCommand(command: string[]): Promise<{ success: boolean; output: string }> {
  return await dockerRun(["exec", CONTAINER_NAME, ...command]);
}

/**
 * Check if file exists in container
 */
async function fileExists(path: string): Promise<boolean> {
  const result = await execCommand(["test", "-f", path]);
  return result.success;
}

// ============================================================================
// FILESYSTEM VERIFICATION TESTS
// ============================================================================

/**
 * Test: Extension directory structure exists
 */
async function testExtensionDirectoryStructure(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const dirs = ["/usr/share/postgresql/18/extension", "/usr/lib/postgresql/18/lib"];

    const missing: string[] = [];

    for (const dir of dirs) {
      const result = await execCommand(["test", "-d", dir]);
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
async function testManifestPresent(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const manifestPath = "/etc/postgresql/extensions.manifest.json";
    const exists = await fileExists(manifestPath);

    if (!exists) {
      return {
        name: "Manifest file present",
        passed: false,
        duration: Date.now() - startTime,
        error: `${manifestPath} not found in image`,
      };
    }

    // Try to read and parse it
    const result = await execCommand(["cat", manifestPath]);

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
async function testVersionInfoFilesPresent(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const files = ["/etc/postgresql/version-info.txt", "/etc/postgresql/version-info.json"];

    const missing: string[] = [];

    for (const file of files) {
      const exists = await fileExists(file);
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
async function testEnabledPgdgExtensionsPresent(manifest: Manifest): Promise<TestResult> {
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
      const exists = await fileExists(controlFile);

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
async function testDisabledPgdgExtensionsNotPresent(manifest: Manifest): Promise<TestResult> {
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
      const exists = await fileExists(controlFile);

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
async function testEnabledExtensions(manifest: Manifest): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const enabledExtensions = manifest.entries.filter((entry) => {
      const isEnabled = entry.enabled !== false;
      const isNotTool = entry.kind !== "tool";
      const isNotPreloadOnly = entry.runtime?.preloadOnly !== true;
      return isEnabled && isNotTool && isNotPreloadOnly;
    });

    const failed: string[] = [];

    for (const ext of enabledExtensions) {
      const result = await execSQL(`CREATE EXTENSION IF NOT EXISTS ${ext.name};`);

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
 * Test: Disabled extensions cannot be created
 */
async function testDisabledExtensions(manifest: Manifest): Promise<TestResult> {
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
      const result = await execSQL(`CREATE EXTENSION IF NOT EXISTS ${ext.name};`);

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
async function testPreloadedExtensions(manifest: Manifest): Promise<TestResult> {
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

    const result = await execSQL("SHOW shared_preload_libraries;");

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
async function testPostgresConfiguration(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const configs = [
      { name: "shared_buffers", check: (val: string) => val.length > 0 },
      { name: "max_connections", check: (val: string) => parseInt(val, 10) > 0 },
      { name: "work_mem", check: (val: string) => val.length > 0 },
    ];

    const errors: string[] = [];

    for (const config of configs) {
      const result = await execSQL(`SHOW ${config.name};`);

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
async function testVersionInfoTxt(manifest: Manifest): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const result = await execCommand(["cat", "/etc/postgresql/version-info.txt"]);

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
async function testVersionInfoJson(manifest: Manifest): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const result = await execCommand(["cat", "/etc/postgresql/version-info.json"]);

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
async function testToolsPresent(manifest: Manifest): Promise<TestResult> {
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
      pgbackrest: "/usr/local/bin/pgbackrest",
      pgbadger: "/usr/local/bin/pgbadger",
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

      const exists = await fileExists(binaryPath);
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
async function testPgBackRestFunctional(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const result = await execCommand(["pgbackrest", "version"]);

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
async function testPgBadgerFunctional(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const result = await execCommand(["pgbadger", "--version"]);

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
async function testAutoConfigApplied(): Promise<TestResult> {
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
      const result = await execSQL(`SHOW ${setting};`);

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
// FUNCTIONAL TESTS (SAMPLE)
// ============================================================================

/**
 * Test: Basic extension functionality (sample tests)
 */
async function testBasicExtensionFunctionality(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const errors: string[] = [];

    // Test pgvector (vector extension)
    const vectorTest = await execSQL(
      "SELECT '[1,2,3]'::vector(3) <-> '[4,5,6]'::vector(3) AS distance;"
    );
    if (!vectorTest.success) {
      errors.push("pgvector test failed");
    }

    // Test pg_trgm
    const trgmTest = await execSQL("SELECT similarity('hello', 'hallo');");
    if (!trgmTest.success) {
      errors.push("pg_trgm test failed");
    }

    // Test hstore (create extension first)
    await execSQL("CREATE EXTENSION IF NOT EXISTS hstore;");
    const hstoreTest = await execSQL("SELECT 'a=>1,b=>2'::hstore -> 'a';");
    if (!hstoreTest.success || hstoreTest.output !== "1") {
      errors.push("hstore test failed");
    }

    if (errors.length > 0) {
      return {
        name: "Basic extension functionality (sample)",
        passed: false,
        duration: Date.now() - startTime,
        error: errors.join(", "),
      };
    }

    return {
      name: "Basic extension functionality (sample)",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "Basic extension functionality (sample)",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

// ============================================================================
// CLEANUP
// ============================================================================

/**
 * Cleanup test container
 */
async function cleanup(): Promise<void> {
  info("Cleaning up test container...");
  await dockerCleanup(CONTAINER_NAME);
  success("Test container removed");
}

// ============================================================================
// MAIN TEST ORCHESTRATION
// ============================================================================

/**
 * Main test orchestration function
 */
async function main(): Promise<void> {
  const totalStartTime = Date.now();

  section("Comprehensive Docker Image Test Harness");
  info(`Image: ${imageTag}`);
  info(`Container: ${CONTAINER_NAME}`);
  info(`Fast Mode: ${fastMode ? "Enabled (skipping time-consuming tests)" : "Disabled"}`);

  // Check Docker daemon
  info("Checking Docker daemon...");
  await checkDockerDaemon();
  success("Docker daemon is running");

  // Read manifest
  info("Reading manifest...");
  const manifest = await readManifest();
  success(`Manifest loaded: ${manifest.entries.length} total entries`);

  // Start test container
  const started = await startContainer(imageTag);
  if (!started) {
    process.exit(1);
  }

  try {
    // Wait for PostgreSQL
    const ready = await waitForPostgres(60);
    if (!ready) {
      if (!noCleanup) {
        await cleanup();
      }
      process.exit(1);
    }

    console.log("");

    // Run all test phases
    const results: TestResult[] = [];

    // Phase 1: Filesystem Verification
    section("Phase 1: Filesystem Verification");
    results.push(await testExtensionDirectoryStructure());
    results.push(await testManifestPresent());
    results.push(await testVersionInfoFilesPresent());
    results.push(await testEnabledPgdgExtensionsPresent(manifest));
    results.push(await testDisabledPgdgExtensionsNotPresent(manifest));

    console.log("");

    // Phase 2: Runtime Verification
    section("Phase 2: Runtime Verification");
    results.push(await testVersionInfoTxt(manifest));
    results.push(await testVersionInfoJson(manifest));
    results.push(await testPreloadedExtensions(manifest));
    results.push(await testEnabledExtensions(manifest));
    results.push(await testDisabledExtensions(manifest));
    results.push(await testPostgresConfiguration());

    console.log("");

    // Phase 3: Tools Verification
    section("Phase 3: Tools Verification");
    results.push(await testToolsPresent(manifest));
    results.push(await testPgBackRestFunctional());
    results.push(await testPgBadgerFunctional());

    console.log("");

    // Phase 4: Auto-Configuration Tests
    section("Phase 4: Auto-Configuration Tests");
    results.push(await testAutoConfigApplied());

    console.log("");

    // Phase 5: Functional Tests (sample, can be expanded)
    if (!fastMode) {
      section("Phase 5: Functional Tests (Sample)");
      results.push(await testBasicExtensionFunctionality());
      console.log("");
    } else {
      info("Skipping functional tests (--fast mode)");
      console.log("");
    }

    // Print summary
    section("Test Summary");
    testSummary(results);

    const totalDuration = Date.now() - totalStartTime;
    console.log("");
    info(`Total test duration: ${formatDuration(totalDuration)}`);

    // Exit with error if any tests failed
    const failed = results.filter((r) => !r.passed);
    if (failed.length > 0) {
      if (!noCleanup) {
        await cleanup();
      } else {
        warning(`Container ${CONTAINER_NAME} kept running (--no-cleanup flag)`);
      }
      process.exit(1);
    }

    // Success
    if (!noCleanup) {
      await cleanup();
    } else {
      warning(`Container ${CONTAINER_NAME} kept running (--no-cleanup flag)`);
    }
  } catch (err) {
    error(`Test harness failed: ${getErrorMessage(err)}`);
    if (!noCleanup) {
      await cleanup();
    }
    process.exit(1);
  }
}

// Main execution
if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    error(`Fatal error: ${getErrorMessage(err)}`);
    if (!noCleanup) {
      await dockerCleanup(CONTAINER_NAME);
    }
    process.exit(1);
  }
}
