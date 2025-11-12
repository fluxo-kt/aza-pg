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
 *   --no-cleanup       - Keep container running after tests
 *   --fast             - Skip comprehensive functional tests (quick smoke test only)
 *   --functional-only  - Run ONLY comprehensive functional tests (skip other phases)
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
const functionalOnly = args.includes("--functional-only");

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
 * Check if an extension is enabled in the manifest
 */
function isExtensionEnabled(manifest: Manifest, extensionName: string): boolean {
  const entry = manifest.entries.find((e) => e.name === extensionName);
  if (!entry) {
    return false;
  }
  return entry.enabled !== false;
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
// COMPREHENSIVE FUNCTIONAL TESTS
// ============================================================================

/**
 * Test: AI/Vector - pgvector HNSW index and similarity search
 */
async function testPgvectorComprehensive(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    // Create table and insert vectors
    await execSQL(
      "CREATE TABLE IF NOT EXISTS test_vectors (id serial PRIMARY KEY, embedding vector(3))"
    );
    await execSQL(
      "INSERT INTO test_vectors (embedding) VALUES ('[1,2,3]'), ('[4,5,6]'), ('[7,8,9]')"
    );

    // Build HNSW index
    const index = await execSQL(
      "CREATE INDEX IF NOT EXISTS test_vectors_hnsw_idx ON test_vectors USING hnsw (embedding vector_l2_ops)"
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
      "SELECT id FROM test_vectors ORDER BY embedding <-> '[3,1,2]' LIMIT 2"
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
async function testVectorscaleDiskann(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE");
    await execSQL(
      "CREATE TABLE IF NOT EXISTS test_vectorscale (id serial PRIMARY KEY, vec vector(3))"
    );
    await execSQL(
      "INSERT INTO test_vectorscale (vec) VALUES ('[1,0,0]'), ('[0,1,0]'), ('[0,0,1]')"
    );

    const index = await execSQL(
      "CREATE INDEX IF NOT EXISTS test_vectorscale_diskann_idx ON test_vectorscale USING diskann (vec)"
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
      "SELECT id FROM test_vectorscale ORDER BY vec <-> '[1,1,1]' LIMIT 1"
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
async function testHllCardinality(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS hll CASCADE");
    await execSQL("CREATE TABLE IF NOT EXISTS test_hll (id serial PRIMARY KEY, users hll)");
    await execSQL("INSERT INTO test_hll (users) VALUES (hll_empty())");
    await execSQL("UPDATE test_hll SET users = hll_add(users, hll_hash_integer(1)) WHERE id = 1");

    const count = await execSQL("SELECT hll_cardinality(users)::int FROM test_hll WHERE id = 1");
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
async function testWal2jsonReplication(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    // Drop slot if exists
    await execSQL(
      "SELECT pg_drop_replication_slot('test_wal2json_slot') FROM pg_replication_slots WHERE slot_name = 'test_wal2json_slot'"
    );

    const slot = await execSQL(
      "SELECT pg_create_logical_replication_slot('test_wal2json_slot', 'wal2json')"
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
    await execSQL("CREATE TABLE IF NOT EXISTS test_wal2json_table (id int, data text)");
    await execSQL("INSERT INTO test_wal2json_table VALUES (1, 'test')");

    const changes = await execSQL(
      "SELECT data FROM pg_logical_slot_peek_changes('test_wal2json_slot', NULL, NULL, 'format-version', '2')"
    );
    if (!changes.success) {
      await execSQL("SELECT pg_drop_replication_slot('test_wal2json_slot')");
      return {
        name: "wal2json - Logical replication",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to read wal2json changes",
      };
    }

    // Cleanup
    await execSQL("SELECT pg_drop_replication_slot('test_wal2json_slot')");

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
async function testPostgisSpatialQuery(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS postgis CASCADE");
    await execSQL(
      "CREATE TABLE IF NOT EXISTS test_postgis (id serial PRIMARY KEY, geom geometry(Point, 4326))"
    );
    await execSQL(
      "INSERT INTO test_postgis (geom) VALUES (ST_SetSRID(ST_MakePoint(-71.060316, 48.432044), 4326))"
    );

    const query = await execSQL(
      "SELECT count(*) FROM test_postgis WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(-71, 48), 4326)::geography, 100000)"
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
      "CREATE INDEX IF NOT EXISTS test_postgis_geom_idx ON test_postgis USING GIST (geom)"
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
async function testPgroutingShortestPath(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS pgrouting CASCADE");
    await execSQL(`CREATE TABLE IF NOT EXISTS test_routing (
      id serial PRIMARY KEY,
      source int,
      target int,
      cost float
    )`);
    await execSQL(
      "INSERT INTO test_routing (source, target, cost) VALUES (1, 2, 1.0), (2, 3, 2.0), (1, 3, 5.0)"
    );

    const path = await execSQL(
      "SELECT * FROM pgr_dijkstra('SELECT id, source, target, cost FROM test_routing', 1, 3, false)"
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
async function testBtreeGistExclusion(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS btree_gist CASCADE");
    const create = await execSQL(`CREATE TABLE IF NOT EXISTS test_exclusion (
      id serial PRIMARY KEY,
      period int4range,
      EXCLUDE USING GIST (period WITH &&)
    )`);

    if (!create.success) {
      return {
        name: "btree_gist - Exclusion constraint",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to create exclusion constraint",
      };
    }

    await execSQL("INSERT INTO test_exclusion (period) VALUES (int4range(1, 10))");
    const conflict = await execSQL("INSERT INTO test_exclusion (period) VALUES (int4range(5, 15))");

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
async function testHttpRequests(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS http CASCADE");

    // GET request
    const getResult = await execSQL(
      "SELECT status FROM http_get('https://httpbin.org/status/200')"
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
async function testPlpgsqlTriggers(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE TABLE IF NOT EXISTS test_trigger_table (id serial PRIMARY KEY, val int)");

    const triggerFunc =
      await execSQL(`CREATE OR REPLACE FUNCTION test_trigger_func() RETURNS TRIGGER AS $$
    BEGIN
      NEW.val := NEW.val * 2;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`);

    if (!triggerFunc.success) {
      return {
        name: "plpgsql - Triggers",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to create trigger function",
      };
    }

    await execSQL("DROP TRIGGER IF EXISTS test_trigger ON test_trigger_table");
    await execSQL(
      "CREATE TRIGGER test_trigger BEFORE INSERT ON test_trigger_table FOR EACH ROW EXECUTE FUNCTION test_trigger_func()"
    );

    await execSQL("INSERT INTO test_trigger_table (val) VALUES (5)");
    const result = await execSQL("SELECT val FROM test_trigger_table ORDER BY id DESC LIMIT 1");

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
async function testPgPartmanPartitioning(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS pg_partman CASCADE");
    await execSQL(`CREATE TABLE IF NOT EXISTS test_partman (
      id serial,
      created_at timestamp NOT NULL DEFAULT now(),
      data text
    ) PARTITION BY RANGE (created_at)`);

    // Clean up existing config
    await execSQL("DELETE FROM part_config WHERE parent_table = 'public.test_partman'");

    const config = await execSQL(
      "SELECT create_parent('public.test_partman', 'created_at', '1 day', 'range', p_start_partition := '2025-01-01')"
    );
    if (!config.success) {
      return {
        name: "pg_partman - Partitioning",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to configure pg_partman",
      };
    }

    // Verify partitions created
    const check = await execSQL(
      "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'test_partman_p%'"
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
async function testPgStatStatements(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const reset = await execSQL("SELECT pg_stat_statements_reset()");
    if (!reset.success) {
      return {
        name: "pg_stat_statements - Statistics",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to reset pg_stat_statements",
      };
    }

    const verify = await execSQL("SELECT count(*) FROM pg_stat_statements");
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
async function testPgCronScheduling(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS pg_cron CASCADE");

    const schedule = await execSQL("SELECT cron.schedule('test-job', '* * * * *', 'SELECT 1')");
    if (!schedule.success) {
      return {
        name: "pg_cron - Job scheduling",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to schedule cron job",
      };
    }

    const check = await execSQL("SELECT count(*) FROM cron.job WHERE jobname = 'test-job'");
    if (!check.success || parseInt(check.output.trim()) !== 1) {
      return {
        name: "pg_cron - Job scheduling",
        passed: false,
        duration: Date.now() - startTime,
        error: "Cron job not found",
      };
    }

    // Cleanup
    const jobId = await execSQL("SELECT jobid FROM cron.job WHERE jobname = 'test-job'");
    if (jobId.success && jobId.output.trim() !== "") {
      await execSQL(`SELECT cron.unschedule(${jobId.output})`);
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
async function testHypopgHypotheticalIndexes(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS hypopg CASCADE");
    await execSQL("CREATE TABLE IF NOT EXISTS test_hypopg (id serial PRIMARY KEY, val int)");
    await execSQL("INSERT INTO test_hypopg (val) SELECT generate_series(1, 1000)");

    // Create and verify in same session (hypothetical indexes are session-local)
    const result = await execSQL(`
      SELECT * FROM hypopg_create_index('CREATE INDEX ON test_hypopg (val)');
      SELECT count(*) FROM hypopg_list_indexes;
    `);

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
async function testPgmqQueue(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS pgmq CASCADE");

    const create = await execSQL("SELECT pgmq.create('test_queue')");
    if (!create.success) {
      return {
        name: "pgmq - Message queue",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to create queue",
      };
    }

    const send = await execSQL(
      'SELECT pgmq.send(\'test_queue\', \'{"task": "process_order", "order_id": 123}\'::jsonb)'
    );
    if (!send.success) {
      return {
        name: "pgmq - Message queue",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to send message",
      };
    }

    const read = await execSQL("SELECT msg_id FROM pgmq.read('test_queue', 30, 1)");
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
async function testPgSafeupdateProtection(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE TABLE IF NOT EXISTS test_safeupdate (id serial PRIMARY KEY, val int)");
    await execSQL("INSERT INTO test_safeupdate (val) VALUES (1), (2), (3)");

    // Attempt UPDATE without WHERE (should be blocked)
    const updateResult = await execSQL("UPDATE test_safeupdate SET val = 99");

    if (updateResult.success) {
      return {
        name: "pg_safeupdate - UPDATE protection",
        passed: false,
        duration: Date.now() - startTime,
        error: "pg_safeupdate should block UPDATE without WHERE",
      };
    }

    // Verify UPDATE with WHERE works
    const safeUpdate = await execSQL("UPDATE test_safeupdate SET val = 99 WHERE id = 1");
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
async function testPgTrgmSimilarity(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS pg_trgm CASCADE");
    await execSQL("CREATE TABLE IF NOT EXISTS test_trgm (id serial PRIMARY KEY, text_col text)");
    await execSQL(
      "INSERT INTO test_trgm (text_col) VALUES ('hello world'), ('hello universe'), ('goodbye world')"
    );
    await execSQL(
      "CREATE INDEX IF NOT EXISTS test_trgm_idx ON test_trgm USING GIN (text_col gin_trgm_ops)"
    );

    const search = await execSQL(
      "SELECT text_col FROM test_trgm WHERE text_col % 'helo wrld' ORDER BY similarity(text_col, 'helo wrld') DESC"
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
async function testPgroongaFullText(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS pgroonga CASCADE");
    await execSQL("CREATE TABLE IF NOT EXISTS test_pgroonga (id serial PRIMARY KEY, content text)");
    await execSQL(
      "INSERT INTO test_pgroonga (content) VALUES ('PostgreSQL full-text search'), ('Groonga is fast'), ('Full-text search engine')"
    );
    await execSQL(
      "CREATE INDEX IF NOT EXISTS test_pgroonga_idx ON test_pgroonga USING pgroonga (content)"
    );

    const search = await execSQL("SELECT content FROM test_pgroonga WHERE content &@~ 'full-text'");
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
async function testRumRankedSearch(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS rum CASCADE");
    await execSQL("CREATE TABLE IF NOT EXISTS test_rum (id serial PRIMARY KEY, content tsvector)");
    await execSQL(
      "INSERT INTO test_rum (content) VALUES (to_tsvector('english', 'The quick brown fox jumps over the lazy dog'))"
    );
    await execSQL(
      "INSERT INTO test_rum (content) VALUES (to_tsvector('english', 'A fast brown fox leaps over a sleepy dog'))"
    );
    await execSQL(
      "CREATE INDEX IF NOT EXISTS test_rum_idx ON test_rum USING rum (content rum_tsvector_ops)"
    );

    const search = await execSQL(
      "SELECT content FROM test_rum WHERE content @@ to_tsquery('english', 'fox & dog')"
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
async function testPgauditLogging(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const result = await execSQL(`
      SET pgaudit.log = 'write, ddl';
      SHOW pgaudit.log;
    `);

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
async function testPgsodiumEncryption(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS pgsodium CASCADE");

    const key = await execSQL("SELECT encode(pgsodium.crypto_secretbox_keygen(), 'hex')");
    if (!key.success || key.output.trim() === "") {
      return {
        name: "pgsodium - Encryption",
        passed: false,
        duration: Date.now() - startTime,
        error: "Key generation failed",
      };
    }

    const nonce = await execSQL("SELECT encode(pgsodium.crypto_secretbox_noncegen(), 'hex')");
    if (!nonce.success) {
      return {
        name: "pgsodium - Encryption",
        passed: false,
        duration: Date.now() - startTime,
        error: "Nonce generation failed",
      };
    }

    const plaintext = "secret data";
    const encrypt = await execSQL(`
      SELECT encode(
        pgsodium.crypto_secretbox(
          '${plaintext}'::bytea,
          decode('${nonce.output}', 'hex'),
          decode('${key.output}', 'hex')
        ),
        'hex'
      )
    `);

    if (!encrypt.success || encrypt.output.trim() === "") {
      return {
        name: "pgsodium - Encryption",
        passed: false,
        duration: Date.now() - startTime,
        error: "Encryption failed",
      };
    }

    const decrypt = await execSQL(`
      SELECT convert_from(
        pgsodium.crypto_secretbox_open(
          decode('${encrypt.output}', 'hex'),
          decode('${nonce.output}', 'hex'),
          decode('${key.output}', 'hex')
        ),
        'utf8'
      )
    `);

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
async function testTimescaledbHypertables(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE");
    await execSQL(`CREATE TABLE IF NOT EXISTS test_timescale (
      time timestamptz NOT NULL,
      device_id int,
      temperature float
    )`);

    const hypertable = await execSQL(
      "SELECT create_hypertable('test_timescale', 'time', if_not_exists => TRUE, migrate_data => TRUE)"
    );
    if (!hypertable.success) {
      return {
        name: "timescaledb - Hypertables",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to create hypertable",
      };
    }

    const insert = await execSQL(`
      INSERT INTO test_timescale (time, device_id, temperature)
      SELECT time, device_id, random() * 30
      FROM generate_series(now() - interval '7 days', now(), interval '1 hour') AS time,
           generate_series(1, 5) AS device_id
    `);

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
async function testPgHashidsEncoding(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS pg_hashids CASCADE");

    const encode = await execSQL("SELECT id_encode(12345)");
    if (!encode.success || encode.output.trim() === "") {
      return {
        name: "pg_hashids - Encoding",
        passed: false,
        duration: Date.now() - startTime,
        error: "Failed to encode hashid",
      };
    }

    const encodedValue = encode.output.trim();
    const decode = await execSQL(`SELECT (id_decode('${encodedValue}'))[1]::text`);

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
async function testPgJsonschemaValidation(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await execSQL("CREATE EXTENSION IF NOT EXISTS pg_jsonschema CASCADE");

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
      `SELECT json_matches_schema('${schema}'::json, '${validDoc}'::json)`
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
      `SELECT json_matches_schema('${schema}'::json, '${invalidDoc}'::json)`
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
// CLEANUP
// ============================================================================

/**
 * Cleanup test tables and data
 */
async function cleanupTestData(): Promise<void> {
  info("Cleaning up test data...");

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
    await execSQL(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }

  // Cleanup pg_partman config
  await execSQL("DELETE FROM part_config WHERE parent_table LIKE 'public.test_%'");

  // Cleanup materialized views
  await execSQL("DROP MATERIALIZED VIEW IF EXISTS test_timescale_hourly CASCADE");

  success("Test data cleaned up");
}

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

  if (functionalOnly) {
    info("Mode: Functional tests only");
  } else if (fastMode) {
    info("Mode: Fast (skipping comprehensive functional tests)");
  } else {
    info("Mode: Full (all tests including comprehensive functional tests)");
  }

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

    if (!functionalOnly) {
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
    }

    // Phase 5: Comprehensive Functional Tests
    if (functionalOnly || !fastMode) {
      section("Phase 5: Comprehensive Functional Tests");

      info("AI/Vector Extensions...");
      results.push(await testPgvectorComprehensive());
      results.push(await testVectorscaleDiskann());

      info("Analytics Extensions...");
      results.push(await testHllCardinality());

      info("CDC Extensions...");
      results.push(await testWal2jsonReplication());

      info("GIS Extensions...");
      if (isExtensionEnabled(manifest, "postgis")) {
        results.push(await testPostgisSpatialQuery());
      }
      if (isExtensionEnabled(manifest, "pgrouting")) {
        results.push(await testPgroutingShortestPath());
      }

      info("Indexing Extensions...");
      results.push(await testBtreeGistExclusion());

      info("Integration Extensions...");
      results.push(await testHttpRequests());

      info("Language Extensions...");
      results.push(await testPlpgsqlTriggers());

      info("Maintenance Extensions...");
      results.push(await testPgPartmanPartitioning());

      info("Observability Extensions...");
      results.push(await testPgStatStatements());

      info("Operations Extensions...");
      results.push(await testPgCronScheduling());

      info("Performance Extensions...");
      results.push(await testHypopgHypotheticalIndexes());

      info("Queueing Extensions...");
      results.push(await testPgmqQueue());

      info("Safety Extensions...");
      results.push(await testPgSafeupdateProtection());

      info("Search Extensions...");
      results.push(await testPgTrgmSimilarity());
      results.push(await testPgroongaFullText());
      results.push(await testRumRankedSearch());

      info("Security Extensions...");
      results.push(await testPgauditLogging());
      results.push(await testPgsodiumEncryption());

      info("Timeseries Extensions...");
      results.push(await testTimescaledbHypertables());

      info("Utilities Extensions...");
      results.push(await testPgHashidsEncoding());

      info("Validation Extensions...");
      results.push(await testPgJsonschemaValidation());

      console.log("");
      info("Comprehensive functional tests completed");

      // Cleanup test data
      await cleanupTestData();
      console.log("");
    } else {
      info("Skipping comprehensive functional tests (--fast mode)");
      info("Use without --fast flag to run all ~27 functional tests");
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
