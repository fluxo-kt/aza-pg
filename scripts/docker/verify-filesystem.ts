#!/usr/bin/env bun
/**
 * Filesystem Verification Script
 *
 * Manifest-driven verification of Docker image filesystem:
 * - Verifies disabled PGDG extensions' files are NOT present
 * - Verifies enabled PGDG extensions' files ARE present
 * - Verifies extension control files and SQL files
 *
 * Usage:
 *   bun scripts/docker/verify-filesystem.ts <image-tag>
 *   bun scripts/docker/verify-filesystem.ts ghcr.io/fluxo-kt/aza-pg:pg18
 *
 * Options:
 *   --no-cleanup   - Keep container running after verification
 */

import { join } from "node:path";
import { getErrorMessage } from "../utils/errors.js";
import { checkDockerDaemon, dockerCleanup, dockerRun, dockerRunLive } from "../utils/docker.js";
import { error, info, section, success, testSummary, warning } from "../utils/logger.js";
import type { TestResult } from "../utils/logger.js";

const REPO_ROOT = join(import.meta.dir, "../..");
const MANIFEST_PATH = join(REPO_ROOT, "docker/postgres/extensions.manifest.json");
const CONTAINER_NAME = "aza-pg-verify-filesystem";

// Parse command line arguments
const args = Bun.argv.slice(2);
const imageTag = args.find((arg) => !arg.startsWith("--"));
const noCleanup = args.includes("--no-cleanup");

interface ManifestEntry {
  name: string;
  kind: "extension" | "tool" | "builtin";
  install_via?: string;
  enabled?: boolean;
  runtime?: {
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
 * Start container from image
 */
async function startContainer(image: string): Promise<boolean> {
  info(`Starting container: ${CONTAINER_NAME}`);
  info(`Image: ${image}`);

  // Clean up any existing container
  await dockerCleanup(CONTAINER_NAME);

  // Start container (no need to run postgres, just need filesystem access)
  const exitCode = await dockerRunLive([
    "run",
    "-d",
    "--name",
    CONTAINER_NAME,
    image,
    "tail",
    "-f",
    "/dev/null",
  ]);

  if (exitCode !== 0) {
    error("Failed to start container");
    return false;
  }

  success("Container started");
  return true;
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

/**
 * List files in directory
 */
async function listFiles(path: string): Promise<string[]> {
  const result = await execCommand(["sh", "-c", `ls -1 ${path} 2>/dev/null || true`]);
  if (!result.success || result.output.trim() === "") {
    return [];
  }
  return result.output.split("\n").filter((line) => line.trim() !== "");
}

/**
 * Test: Verify disabled PGDG extensions are not installed
 */
async function testDisabledPgdgExtensionsNotPresent(manifest: Manifest): Promise<TestResult> {
  const startTime = Date.now();

  try {
    // Get disabled PGDG extensions (excluding tools)
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

    info(`Verifying ${disabledPgdgExtensions.length} disabled PGDG extensions are not present...`);

    const unexpectedlyPresent: string[] = [];

    for (const ext of disabledPgdgExtensions) {
      // Skip preload-only modules (they don't have .control files)
      if (ext.runtime?.preloadOnly) {
        continue;
      }

      // Check for .control file (main indicator of extension presence)
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

/**
 * Test: Verify enabled PGDG extensions are installed
 */
async function testEnabledPgdgExtensionsPresent(manifest: Manifest): Promise<TestResult> {
  const startTime = Date.now();

  try {
    // Get enabled PGDG extensions (excluding tools and preload-only modules)
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

    info(`Verifying ${enabledPgdgExtensions.length} enabled PGDG extensions are present...`);

    const missing: string[] = [];

    for (const ext of enabledPgdgExtensions) {
      // Check for .control file (main indicator of extension presence)
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
 * Test: Verify manifest file is present in image
 */
async function testManifestPresent(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    info("Verifying manifest file is present...");

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
 * Test: Verify version info files are present
 */
async function testVersionInfoFilesPresent(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    info("Verifying version info files are present...");

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
 * Test: Verify extension directory exists and is readable
 */
async function testExtensionDirectoryStructure(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    info("Verifying extension directory structure...");

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

    // List files in extension directory for debugging
    const extensionFiles = await listFiles("/usr/share/postgresql/18/extension");
    info(`Found ${extensionFiles.length} files in /usr/share/postgresql/18/extension`);

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
 * Cleanup container
 */
async function cleanup(): Promise<void> {
  info("Cleaning up container...");
  await dockerCleanup(CONTAINER_NAME);
  success("Container removed");
}

/**
 * Main verification function
 */
async function main(): Promise<void> {
  section("Docker Image Filesystem Verification");

  // Validate arguments
  if (!imageTag) {
    error("Usage: bun scripts/docker/verify-filesystem.ts <image-tag>");
    error("Example: bun scripts/docker/verify-filesystem.ts ghcr.io/fluxo-kt/aza-pg:pg18");
    process.exit(1);
  }

  // Check Docker daemon
  info("Checking Docker daemon...");
  await checkDockerDaemon();
  success("Docker daemon is running");

  // Read manifest
  info("Reading manifest...");
  const manifest = await readManifest();
  success(`Manifest loaded: ${manifest.entries.length} total entries`);

  // Start container
  const started = await startContainer(imageTag);
  if (!started) {
    process.exit(1);
  }

  try {
    // Run all tests
    console.log("");
    section("Running Verification Tests");

    const results: TestResult[] = [];

    results.push(await testExtensionDirectoryStructure());
    results.push(await testManifestPresent());
    results.push(await testVersionInfoFilesPresent());
    results.push(await testEnabledPgdgExtensionsPresent(manifest));
    results.push(await testDisabledPgdgExtensionsNotPresent(manifest));

    // Print summary
    console.log("");
    testSummary(results);

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
    error(`Verification failed: ${getErrorMessage(err)}`);
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
    error(`Filesystem verification error: ${getErrorMessage(err)}`);
    if (!noCleanup) {
      await dockerCleanup(CONTAINER_NAME);
    }
    process.exit(1);
  }
}
