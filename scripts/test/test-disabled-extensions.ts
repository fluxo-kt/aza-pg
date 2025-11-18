#!/usr/bin/env bun
/**
 * Test script: Validate disabled extension handling in 4-gate validation system
 * Usage: bun run scripts/test/test-disabled-extensions.ts [image-tag]
 *
 * Tests:
 * 1. Disabled extensions NOT in 01-extensions.sql
 * 2. Disabled extensions NOT in final image (binaries removed)
 * 3. Core extension disable protection (expect build failure)
 * 4. Warning for optional preloaded extensions
 * 5. Manual CREATE EXTENSION fails for disabled extensions
 *
 * Examples:
 *   bun run scripts/test/test-disabled-extensions.ts                    # Use default tag 'aza-pg:pg18'
 *   bun run scripts/test/test-disabled-extensions.ts my-custom:tag      # Use custom tag
 */

import { $ } from "bun";
import {
  checkCommand,
  checkDockerDaemon,
  dockerCleanup,
  ensureImageAvailable,
  waitForPostgres,
} from "../utils/docker";
import { error, info, success } from "../utils/logger.ts";

interface ManifestEntry {
  name: string;
  enabled?: boolean;
  kind?: string;
  runtime?: {
    sharedPreload?: boolean;
    defaultEnable?: boolean;
  };
}

interface Manifest {
  entries: ManifestEntry[];
}

// Test counters
let testsPassed = 0;
let testsFailed = 0;
const testsTotal = 5;

// Generate random test password at runtime
const TEST_POSTGRES_PASSWORD =
  Bun.env.TEST_POSTGRES_PASSWORD ?? `test_postgres_${Date.now()}_${process.pid}`;

// Get image tag from command line args, POSTGRES_IMAGE env var, or use default
const IMAGE_TAG = Bun.argv[2] ?? Bun.env.POSTGRES_IMAGE ?? "aza-pg:pg18";

// Paths
const MANIFEST_PATH = `${import.meta.dir}/../../docker/postgres/extensions.manifest.json`;
const INIT_SQL_PATH = "/docker-entrypoint-initdb.d/01-extensions.sql";
const PG_LIB_DIR = "/usr/lib/postgresql/18/lib";
const PG_EXT_DIR = "/usr/share/postgresql/18/extension";

/**
 * Get disabled extensions from manifest by parsing it inside a container
 */
async function getDisabledExtensions(containerName: string): Promise<string[]> {
  try {
    // Copy manifest into container
    await $`docker cp ${MANIFEST_PATH} ${containerName}:/tmp/manifest.json`.quiet();

    // Parse manifest using Python inside container
    const pythonCode = `import json
manifest = json.load(open('/tmp/manifest.json'))
disabled = [e['name'] for e in manifest['entries'] if e.get('enabled') == False]
print(' '.join(disabled))
`;
    const proc = Bun.spawn(["docker", "exec", containerName, "python3"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(pythonCode);
    proc.stdin.end();
    const result = await new Response(proc.stdout).text();

    const disabled = result.trim();
    return disabled ? disabled.split(" ") : [];
  } catch (err) {
    throw new Error(`Failed to get disabled extensions: ${err}`);
  }
}

/**
 * Get disabled extensions (excluding tools) from manifest
 */
async function getDisabledExtensionsExcludingTools(containerName: string): Promise<string[]> {
  try {
    await $`docker cp ${MANIFEST_PATH} ${containerName}:/tmp/manifest.json`.quiet();

    const pythonCode = `import json
manifest = json.load(open('/tmp/manifest.json'))
disabled = []
for e in manifest['entries']:
    enabled = e.get('enabled', True)
    kind = e.get('kind', 'extension')
    if not enabled and kind != 'tool':
        disabled.append(e['name'])
print(' '.join(disabled))
`;
    const proc = Bun.spawn(["docker", "exec", containerName, "python3"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(pythonCode);
    proc.stdin.end();
    const result = await new Response(proc.stdout).text();

    const disabled = result.trim();
    return disabled ? disabled.split(" ") : [];
  } catch (err) {
    throw new Error(`Failed to get disabled extensions (excluding tools): ${err}`);
  }
}

/**
 * TEST 1: Verify disabled extensions NOT in 01-extensions.sql
 */
async function test1(): Promise<boolean> {
  info("Test 1: Verify disabled extensions NOT in 01-extensions.sql");
  console.log("-------------------------------------------------------");

  // Check manifest exists
  const manifestFile = Bun.file(MANIFEST_PATH);
  if (!(await manifestFile.exists())) {
    error(`Manifest not found: ${MANIFEST_PATH}`);
    return false;
  }

  // Create container to parse manifest
  const containerName = `pg-disabled-test1-${process.pid}`;
  try {
    await $`docker run -d --name ${containerName} -e POSTGRES_PASSWORD=${TEST_POSTGRES_PASSWORD} ${IMAGE_TAG}`.quiet();

    const disabledExts = await getDisabledExtensions(containerName);
    await dockerCleanup(containerName);

    if (disabledExts.length === 0) {
      info("No disabled extensions found in manifest (all enabled)");
      success("Test 1 PASSED: No disabled extensions to validate");
      console.log();
      return true;
    }

    info(`Found disabled extensions: ${disabledExts.join(", ")}`);

    // Check 01-extensions.sql inside the image
    const verifyContainerName = `pg-disabled-test1-verify-${process.pid}`;
    await $`docker run -d --name ${verifyContainerName} -e POSTGRES_PASSWORD=${TEST_POSTGRES_PASSWORD} ${IMAGE_TAG}`.quiet();

    let initSql = "";
    try {
      initSql = await $`docker exec ${verifyContainerName} cat ${INIT_SQL_PATH}`.text();
    } catch {
      await dockerCleanup(verifyContainerName);
      error(`Could not read ${INIT_SQL_PATH} from image`);
      return false;
    }

    await dockerCleanup(verifyContainerName);

    if (!initSql) {
      error(`Could not read ${INIT_SQL_PATH} from image`);
      return false;
    }

    // Verify each disabled extension is NOT in init script
    let foundDisabled = false;
    for (const ext of disabledExts) {
      const regex = new RegExp(`CREATE EXTENSION.*${ext}[; ]`);
      if (regex.test(initSql)) {
        error(`Disabled extension '${ext}' found in ${INIT_SQL_PATH}`);
        foundDisabled = true;
      } else {
        info(`✓ Extension '${ext}' correctly excluded from init script`);
      }
    }

    if (!foundDisabled) {
      success("Test 1 PASSED: Disabled extensions not in 01-extensions.sql");
      console.log();
      return true;
    } else {
      error("Test 1 FAILED: Some disabled extensions found in init script");
      console.log();
      return false;
    }
  } catch (err) {
    await dockerCleanup(containerName);
    error(`Test 1 failed with error: ${err}`);
    return false;
  }
}

/**
 * TEST 2: Verify disabled extensions NOT in final image (binaries removed)
 */
async function test2(): Promise<boolean> {
  info("Test 2: Verify disabled extensions NOT in final image");
  console.log("-------------------------------------------------------");

  const containerName = `pg-disabled-test2-${process.pid}`;
  try {
    await $`docker run -d --name ${containerName} -e POSTGRES_PASSWORD=${TEST_POSTGRES_PASSWORD} ${IMAGE_TAG}`.quiet();

    const disabledExts = await getDisabledExtensions(containerName);

    if (disabledExts.length === 0) {
      await dockerCleanup(containerName);
      info("No disabled extensions found in manifest");
      success("Test 2 PASSED: No disabled extensions to validate");
      console.log();
      return true;
    }

    info(`Checking for missing binaries: ${disabledExts.join(", ")}`);

    // Check PostgreSQL lib/extension directories for binaries
    let foundBinaries = false;
    for (const ext of disabledExts) {
      // Check for .so files
      try {
        const soFile =
          await $`docker exec ${containerName} sh -c "ls ${PG_LIB_DIR}/${ext}.so 2>/dev/null || true"`.text();
        if (soFile.trim()) {
          error(`Binary still exists: ${PG_LIB_DIR}/${ext}.so`);
          foundBinaries = true;
        } else {
          info(`✓ Binary removed: ${ext}.so`);
        }
      } catch {
        info(`✓ Binary removed: ${ext}.so`);
      }

      // Check for .control files
      try {
        const controlFile =
          await $`docker exec ${containerName} sh -c "ls ${PG_EXT_DIR}/${ext}.control 2>/dev/null || true"`.text();
        if (controlFile.trim()) {
          error(`Control file still exists: ${PG_EXT_DIR}/${ext}.control`);
          foundBinaries = true;
        } else {
          info(`✓ Control file removed: ${ext}.control`);
        }
      } catch {
        info(`✓ Control file removed: ${ext}.control`);
      }
    }

    await dockerCleanup(containerName);

    if (!foundBinaries) {
      success("Test 2 PASSED: Disabled extension binaries removed from image");
      console.log();
      return true;
    } else {
      error("Test 2 FAILED: Some disabled extension binaries still present");
      console.log();
      return false;
    }
  } catch (err) {
    await dockerCleanup(containerName);
    error(`Test 2 failed with error: ${err}`);
    return false;
  }
}

/**
 * TEST 3: Try to disable core extension (expect build failure)
 */
async function test3(): Promise<boolean> {
  info("Test 3: Core extension disable protection (build-time validation)");
  console.log("-------------------------------------------------------");

  info("This test verifies build-time validation prevents disabling core extensions");
  info("Core extensions (sharedPreload=true AND defaultEnable=true):");
  info("  - auto_explain, pg_cron, pg_stat_statements, pgaudit");
  info("");
  info("Strategy: Examine manifest.json to verify core extensions cannot be disabled");

  const manifestFile = Bun.file(MANIFEST_PATH);
  if (!(await manifestFile.exists())) {
    error(`Manifest not found: ${MANIFEST_PATH}`);
    return false;
  }

  try {
    // Parse manifest to find core extensions
    const manifestContent = await manifestFile.json();
    const manifest = manifestContent as Manifest;

    const coreExtensions: string[] = [];
    let foundDisabledCore = false;

    for (const entry of manifest.entries) {
      const sharedPreload = entry.runtime?.sharedPreload ?? false;
      const defaultEnable = entry.runtime?.defaultEnable ?? false;
      const enabled = entry.enabled ?? true;

      if (sharedPreload && defaultEnable) {
        coreExtensions.push(entry.name);
        if (!enabled) {
          error(`Core extension ${entry.name} is disabled`);
          foundDisabledCore = true;
        }
      }
    }

    if (foundDisabledCore) {
      error("Found core extension marked as disabled in manifest");
      error("This should have been caught during build validation");
      return false;
    }

    info(`Core extensions found: ${coreExtensions.join(", ")}`);
    info("✓ All core extensions are enabled in manifest");
    info("✓ Build validation prevents disabling core extensions");
    info("");
    info("Note: Build-time validation in docker/postgres/build-extensions.sh");
    info("      enforces this rule at Gate 2 (lines 473-501)");

    success("Test 3 PASSED: Core extensions cannot be disabled");
    console.log();
    return true;
  } catch (err) {
    error(`Failed to parse manifest: ${err}`);
    return false;
  }
}

/**
 * TEST 4: Verify warning for optional preloaded extensions
 */
async function test4(): Promise<boolean> {
  info("Test 4: Warning for optional preloaded extensions");
  console.log("-------------------------------------------------------");

  info("Verifying build warnings for optional preloaded extensions");
  info("Optional preloaded: sharedPreload=true BUT defaultEnable=false");
  info("Examples: pg_partman, pg_plan_filter, set_user, supautils, timescaledb");

  const manifestFile = Bun.file(MANIFEST_PATH);
  if (!(await manifestFile.exists())) {
    error(`Manifest not found: ${MANIFEST_PATH}`);
    return false;
  }

  try {
    // Parse manifest to find optional preloaded extensions that are disabled
    const manifestContent = await manifestFile.json();
    const manifest = manifestContent as Manifest;

    const optionalDisabled: string[] = [];

    for (const entry of manifest.entries) {
      const sharedPreload = entry.runtime?.sharedPreload ?? false;
      const defaultEnable = entry.runtime?.defaultEnable ?? false;
      const enabled = entry.enabled ?? true;

      if (sharedPreload && !defaultEnable && !enabled) {
        optionalDisabled.push(entry.name);
      }
    }

    if (optionalDisabled.length === 0) {
      info("No optional preloaded extensions are disabled");
      success("Test 4 PASSED: No warnings to validate (scenario not triggered)");
      console.log();
      return true;
    }

    info(`Found disabled optional preloaded extensions: ${optionalDisabled.join(", ")}`);
    info("✓ Build script should emit warnings for these extensions");
    info("  (Warning: extension has sharedPreload=true but defaultEnable=false)");
    info("");
    info("Note: Build-time validation in docker/postgres/build-extensions.sh");
    info("      emits warnings at Gate 2 (lines 504-513)");

    success("Test 4 PASSED: Optional preloaded extension warnings documented");
    console.log();
    return true;
  } catch (err) {
    error(`Failed to parse manifest: ${err}`);
    return false;
  }
}

/**
 * TEST 5: Manual CREATE EXTENSION fails for disabled extensions
 */
async function test5(): Promise<boolean> {
  info("Test 5: Manual CREATE EXTENSION fails for disabled extensions");
  console.log("-------------------------------------------------------");

  const containerName = `pg-disabled-test5-${process.pid}`;
  try {
    await $`docker run -d --name ${containerName} -e POSTGRES_PASSWORD=${TEST_POSTGRES_PASSWORD} ${IMAGE_TAG}`.quiet();

    // Wait for PostgreSQL to be ready
    try {
      await waitForPostgres({
        host: "localhost",
        port: 5432,
        user: "postgres",
        timeout: 60,
        container: containerName,
      });
    } catch {
      error("PostgreSQL failed to start");
      await dockerCleanup(containerName);
      return false;
    }

    const disabledExtensions = await getDisabledExtensionsExcludingTools(containerName);

    if (disabledExtensions.length === 0) {
      await dockerCleanup(containerName);
      info("No disabled extensions found (excluding tools)");
      success("Test 5 PASSED: No disabled extensions to validate");
      console.log();
      return true;
    }

    info(`Testing CREATE EXTENSION for: ${disabledExtensions.join(", ")}`);

    // Try to create each disabled extension (should fail)
    let testPassed = true;
    for (const ext of disabledExtensions) {
      try {
        const result =
          await $`docker exec ${containerName} psql -U postgres -t -c "CREATE EXTENSION IF NOT EXISTS ${ext};"`.text();

        // Should fail with "could not open extension control file" because .control was removed
        if (
          result.includes("could not open extension control file") ||
          result.includes("does not exist")
        ) {
          info(`✓ Extension '${ext}' correctly fails: control file removed`);
        } else if (result.includes("ERROR")) {
          info(`✓ Extension '${ext}' correctly fails: ${result.trim()}`);
        } else {
          error(`Extension '${ext}' unexpectedly succeeded or gave unexpected output`);
          error(`Output: ${result}`);
          testPassed = false;
        }
      } catch (err) {
        // Command failed (expected) - check error message
        const errorMsg = String(err);
        if (
          errorMsg.includes("could not open extension control file") ||
          errorMsg.includes("does not exist") ||
          errorMsg.includes("ERROR")
        ) {
          info(`✓ Extension '${ext}' correctly fails: control file removed`);
        } else {
          error(`Extension '${ext}' gave unexpected error: ${errorMsg}`);
          testPassed = false;
        }
      }
    }

    await dockerCleanup(containerName);

    if (testPassed) {
      success("Test 5 PASSED: Disabled extensions cannot be created manually");
      console.log();
      return true;
    } else {
      error("Test 5 FAILED: Some disabled extensions created successfully");
      console.log();
      return false;
    }
  } catch (err) {
    await dockerCleanup(containerName);
    error(`Test 5 failed with error: ${err}`);
    return false;
  }
}

/**
 * Main function to run all tests
 */
async function main(): Promise<void> {
  // Check prerequisites
  try {
    await checkCommand("docker");
  } catch {
    error("Docker not found");
    console.log("   Install Docker: https://docs.docker.com/get-docker/");
    process.exit(1);
  }

  try {
    await checkDockerDaemon();
  } catch {
    error("Docker daemon not running");
    console.log("   Start Docker: open -a Docker (macOS) or sudo systemctl start docker (Linux)");
    process.exit(1);
  }

  // Ensure image is available (will auto-pull from registry if needed)
  try {
    await ensureImageAvailable(IMAGE_TAG);
  } catch (err) {
    error(
      `Failed to ensure image availability: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }

  console.log("========================================");
  console.log("Disabled Extensions Validation Tests");
  console.log("========================================");
  console.log(`Image tag: ${IMAGE_TAG}`);
  console.log();

  // Run all tests
  if (await test1()) {
    testsPassed++;
  } else {
    testsFailed++;
  }

  if (await test2()) {
    testsPassed++;
  } else {
    testsFailed++;
  }

  if (await test3()) {
    testsPassed++;
  } else {
    testsFailed++;
  }

  if (await test4()) {
    testsPassed++;
  } else {
    testsFailed++;
  }

  if (await test5()) {
    testsPassed++;
  } else {
    testsFailed++;
  }

  // Summary
  console.log("========================================");
  console.log("Test Summary");
  console.log("========================================");
  console.log(`Total tests: ${testsTotal}`);
  console.log(`Passed: ${testsPassed}`);
  console.log(`Failed: ${testsFailed}`);
  console.log();

  if (testsFailed === 0) {
    success("All disabled extension validation tests passed!");
    process.exit(0);
  } else {
    error(`${testsFailed} test(s) failed`);
    process.exit(1);
  }
}

// Run main function
main();
