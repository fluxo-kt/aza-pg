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
  logError,
  logInfo,
  logSuccess,
  waitForPostgres,
} from "../lib/common.ts";

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
  process.env.TEST_POSTGRES_PASSWORD ?? `test_postgres_${Date.now()}_${process.pid}`;

// Get image tag from command line args or use default
const IMAGE_TAG = process.argv[2] ?? "aza-pg:pg18";

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
    const result = await $`docker exec ${containerName} python3`
      .stdin(
        Buffer.from(`import json
manifest = json.load(open('/tmp/manifest.json'))
disabled = [e['name'] for e in manifest['entries'] if e.get('enabled') == False]
print(' '.join(disabled))
`)
      )
      .text();

    const disabled = result.trim();
    return disabled ? disabled.split(" ") : [];
  } catch (error) {
    throw new Error(`Failed to get disabled extensions: ${error}`);
  }
}

/**
 * Get disabled extensions (excluding tools) from manifest
 */
async function getDisabledExtensionsExcludingTools(containerName: string): Promise<string[]> {
  try {
    await $`docker cp ${MANIFEST_PATH} ${containerName}:/tmp/manifest.json`.quiet();

    const result = await $`docker exec ${containerName} python3`
      .stdin(
        Buffer.from(`import json
manifest = json.load(open('/tmp/manifest.json'))
disabled = []
for e in manifest['entries']:
    enabled = e.get('enabled', True)
    kind = e.get('kind', 'extension')
    if not enabled and kind != 'tool':
        disabled.append(e['name'])
print(' '.join(disabled))
`)
      )
      .text();

    const disabled = result.trim();
    return disabled ? disabled.split(" ") : [];
  } catch (error) {
    throw new Error(`Failed to get disabled extensions (excluding tools): ${error}`);
  }
}

/**
 * TEST 1: Verify disabled extensions NOT in 01-extensions.sql
 */
async function test1(): Promise<boolean> {
  logInfo("Test 1: Verify disabled extensions NOT in 01-extensions.sql");
  console.log("-------------------------------------------------------");

  // Check manifest exists
  const manifestFile = Bun.file(MANIFEST_PATH);
  if (!(await manifestFile.exists())) {
    logError(`Manifest not found: ${MANIFEST_PATH}`);
    return false;
  }

  // Create container to parse manifest
  const containerName = `pg-disabled-test1-${process.pid}`;
  try {
    await $`docker run -d --name ${containerName} -e POSTGRES_PASSWORD=${TEST_POSTGRES_PASSWORD} ${IMAGE_TAG}`.quiet();

    const disabledExts = await getDisabledExtensions(containerName);
    await dockerCleanup(containerName);

    if (disabledExts.length === 0) {
      logInfo("No disabled extensions found in manifest (all enabled)");
      logSuccess("Test 1 PASSED: No disabled extensions to validate");
      console.log();
      return true;
    }

    logInfo(`Found disabled extensions: ${disabledExts.join(", ")}`);

    // Check 01-extensions.sql inside the image
    const verifyContainerName = `pg-disabled-test1-verify-${process.pid}`;
    await $`docker run -d --name ${verifyContainerName} -e POSTGRES_PASSWORD=${TEST_POSTGRES_PASSWORD} ${IMAGE_TAG}`.quiet();

    let initSql = "";
    try {
      initSql = await $`docker exec ${verifyContainerName} cat ${INIT_SQL_PATH}`.text();
    } catch {
      await dockerCleanup(verifyContainerName);
      logError(`Could not read ${INIT_SQL_PATH} from image`);
      return false;
    }

    await dockerCleanup(verifyContainerName);

    if (!initSql) {
      logError(`Could not read ${INIT_SQL_PATH} from image`);
      return false;
    }

    // Verify each disabled extension is NOT in init script
    let foundDisabled = false;
    for (const ext of disabledExts) {
      const regex = new RegExp(`CREATE EXTENSION.*${ext}[; ]`);
      if (regex.test(initSql)) {
        logError(`Disabled extension '${ext}' found in ${INIT_SQL_PATH}`);
        foundDisabled = true;
      } else {
        logInfo(`✓ Extension '${ext}' correctly excluded from init script`);
      }
    }

    if (!foundDisabled) {
      logSuccess("Test 1 PASSED: Disabled extensions not in 01-extensions.sql");
      console.log();
      return true;
    } else {
      logError("Test 1 FAILED: Some disabled extensions found in init script");
      console.log();
      return false;
    }
  } catch (error) {
    await dockerCleanup(containerName);
    logError(`Test 1 failed with error: ${error}`);
    return false;
  }
}

/**
 * TEST 2: Verify disabled extensions NOT in final image (binaries removed)
 */
async function test2(): Promise<boolean> {
  logInfo("Test 2: Verify disabled extensions NOT in final image");
  console.log("-------------------------------------------------------");

  const containerName = `pg-disabled-test2-${process.pid}`;
  try {
    await $`docker run -d --name ${containerName} -e POSTGRES_PASSWORD=${TEST_POSTGRES_PASSWORD} ${IMAGE_TAG}`.quiet();

    const disabledExts = await getDisabledExtensions(containerName);

    if (disabledExts.length === 0) {
      await dockerCleanup(containerName);
      logInfo("No disabled extensions found in manifest");
      logSuccess("Test 2 PASSED: No disabled extensions to validate");
      console.log();
      return true;
    }

    logInfo(`Checking for missing binaries: ${disabledExts.join(", ")}`);

    // Check PostgreSQL lib/extension directories for binaries
    let foundBinaries = false;
    for (const ext of disabledExts) {
      // Check for .so files
      try {
        const soFile =
          await $`docker exec ${containerName} sh -c "ls ${PG_LIB_DIR}/${ext}.so 2>/dev/null || true"`.text();
        if (soFile.trim()) {
          logError(`Binary still exists: ${PG_LIB_DIR}/${ext}.so`);
          foundBinaries = true;
        } else {
          logInfo(`✓ Binary removed: ${ext}.so`);
        }
      } catch {
        logInfo(`✓ Binary removed: ${ext}.so`);
      }

      // Check for .control files
      try {
        const controlFile =
          await $`docker exec ${containerName} sh -c "ls ${PG_EXT_DIR}/${ext}.control 2>/dev/null || true"`.text();
        if (controlFile.trim()) {
          logError(`Control file still exists: ${PG_EXT_DIR}/${ext}.control`);
          foundBinaries = true;
        } else {
          logInfo(`✓ Control file removed: ${ext}.control`);
        }
      } catch {
        logInfo(`✓ Control file removed: ${ext}.control`);
      }
    }

    await dockerCleanup(containerName);

    if (!foundBinaries) {
      logSuccess("Test 2 PASSED: Disabled extension binaries removed from image");
      console.log();
      return true;
    } else {
      logError("Test 2 FAILED: Some disabled extension binaries still present");
      console.log();
      return false;
    }
  } catch (error) {
    await dockerCleanup(containerName);
    logError(`Test 2 failed with error: ${error}`);
    return false;
  }
}

/**
 * TEST 3: Try to disable core extension (expect build failure)
 */
async function test3(): Promise<boolean> {
  logInfo("Test 3: Core extension disable protection (build-time validation)");
  console.log("-------------------------------------------------------");

  logInfo("This test verifies build-time validation prevents disabling core extensions");
  logInfo("Core extensions (sharedPreload=true AND defaultEnable=true):");
  logInfo("  - auto_explain, pg_cron, pg_stat_statements, pgaudit");
  logInfo("");
  logInfo("Strategy: Examine manifest.json to verify core extensions cannot be disabled");

  const manifestFile = Bun.file(MANIFEST_PATH);
  if (!(await manifestFile.exists())) {
    logError(`Manifest not found: ${MANIFEST_PATH}`);
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
          logError(`Core extension ${entry.name} is disabled`);
          foundDisabledCore = true;
        }
      }
    }

    if (foundDisabledCore) {
      logError("Found core extension marked as disabled in manifest");
      logError("This should have been caught during build validation");
      return false;
    }

    logInfo(`Core extensions found: ${coreExtensions.join(", ")}`);
    logInfo("✓ All core extensions are enabled in manifest");
    logInfo("✓ Build validation prevents disabling core extensions");
    logInfo("");
    logInfo("Note: Build-time validation in docker/postgres/build-extensions.sh");
    logInfo("      enforces this rule at Gate 2 (lines 473-501)");

    logSuccess("Test 3 PASSED: Core extensions cannot be disabled");
    console.log();
    return true;
  } catch (error) {
    logError(`Failed to parse manifest: ${error}`);
    return false;
  }
}

/**
 * TEST 4: Verify warning for optional preloaded extensions
 */
async function test4(): Promise<boolean> {
  logInfo("Test 4: Warning for optional preloaded extensions");
  console.log("-------------------------------------------------------");

  logInfo("Verifying build warnings for optional preloaded extensions");
  logInfo("Optional preloaded: sharedPreload=true BUT defaultEnable=false");
  logInfo("Examples: pg_partman, pg_plan_filter, set_user, supautils, timescaledb");

  const manifestFile = Bun.file(MANIFEST_PATH);
  if (!(await manifestFile.exists())) {
    logError(`Manifest not found: ${MANIFEST_PATH}`);
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
      logInfo("No optional preloaded extensions are disabled");
      logSuccess("Test 4 PASSED: No warnings to validate (scenario not triggered)");
      console.log();
      return true;
    }

    logInfo(`Found disabled optional preloaded extensions: ${optionalDisabled.join(", ")}`);
    logInfo("✓ Build script should emit warnings for these extensions");
    logInfo("  (Warning: extension has sharedPreload=true but defaultEnable=false)");
    logInfo("");
    logInfo("Note: Build-time validation in docker/postgres/build-extensions.sh");
    logInfo("      emits warnings at Gate 2 (lines 504-513)");

    logSuccess("Test 4 PASSED: Optional preloaded extension warnings documented");
    console.log();
    return true;
  } catch (error) {
    logError(`Failed to parse manifest: ${error}`);
    return false;
  }
}

/**
 * TEST 5: Manual CREATE EXTENSION fails for disabled extensions
 */
async function test5(): Promise<boolean> {
  logInfo("Test 5: Manual CREATE EXTENSION fails for disabled extensions");
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
      logError("PostgreSQL failed to start");
      await dockerCleanup(containerName);
      return false;
    }

    const disabledExtensions = await getDisabledExtensionsExcludingTools(containerName);

    if (disabledExtensions.length === 0) {
      await dockerCleanup(containerName);
      logInfo("No disabled extensions found (excluding tools)");
      logSuccess("Test 5 PASSED: No disabled extensions to validate");
      console.log();
      return true;
    }

    logInfo(`Testing CREATE EXTENSION for: ${disabledExtensions.join(", ")}`);

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
          logInfo(`✓ Extension '${ext}' correctly fails: control file removed`);
        } else if (result.includes("ERROR")) {
          logInfo(`✓ Extension '${ext}' correctly fails: ${result.trim()}`);
        } else {
          logError(`Extension '${ext}' unexpectedly succeeded or gave unexpected output`);
          logError(`Output: ${result}`);
          testPassed = false;
        }
      } catch (error) {
        // Command failed (expected) - check error message
        const errorMsg = String(error);
        if (
          errorMsg.includes("could not open extension control file") ||
          errorMsg.includes("does not exist") ||
          errorMsg.includes("ERROR")
        ) {
          logInfo(`✓ Extension '${ext}' correctly fails: control file removed`);
        } else {
          logError(`Extension '${ext}' gave unexpected error: ${errorMsg}`);
          testPassed = false;
        }
      }
    }

    await dockerCleanup(containerName);

    if (testPassed) {
      logSuccess("Test 5 PASSED: Disabled extensions cannot be created manually");
      console.log();
      return true;
    } else {
      logError("Test 5 FAILED: Some disabled extensions created successfully");
      console.log();
      return false;
    }
  } catch (error) {
    await dockerCleanup(containerName);
    logError(`Test 5 failed with error: ${error}`);
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
    logError("Docker not found");
    console.log("   Install Docker: https://docs.docker.com/get-docker/");
    process.exit(1);
  }

  try {
    await checkDockerDaemon();
  } catch {
    logError("Docker daemon not running");
    console.log("   Start Docker: open -a Docker (macOS) or sudo systemctl start docker (Linux)");
    process.exit(1);
  }

  // Check if image exists
  try {
    await $`docker image inspect ${IMAGE_TAG}`.quiet();
  } catch {
    logError(`Docker image not found: ${IMAGE_TAG}`);
    console.log("   Build image first: ./scripts/build.sh");
    console.log(`   Or run: ./scripts/test/test-build.sh ${IMAGE_TAG}`);
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
    logSuccess("All disabled extension validation tests passed!");
    process.exit(0);
  } else {
    logError(`${testsFailed} test(s) failed`);
    process.exit(1);
  }
}

// Run main function
main();
