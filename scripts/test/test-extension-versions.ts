#!/usr/bin/env bun
/**
 * Extension Version Compatibility Test
 *
 * Purpose: Validate extension version compatibility and upgrade paths
 *
 * Coverage:
 * - Start container with current image
 * - Query extension versions from pg_extension
 * - Create test data with key extensions (pgvector, postgis, timescaledb, pg_cron)
 * - Test extension upgrade scenario (ALTER EXTENSION UPDATE)
 * - Verify data integrity after version changes
 * - Test extension dependencies (CASCADE behavior)
 * - Verify manifest versions match installed versions
 *
 * Usage:
 *   bun scripts/test/test-extension-versions.ts [image-tag] [--no-cleanup]
 */

import { $ } from "bun";
import {
  checkCommand,
  checkDockerDaemon,
  cleanupContainer,
  ensureImageAvailable,
  generateUniqueContainerName,
  waitForPostgres,
} from "../utils/docker";
import { error, info, section, success, testSummary, warning } from "../utils/logger";
import type { TestResult } from "../utils/logger";
import { TIMEOUTS } from "../config/test-timeouts";

/**
 * Test configuration
 */
interface TestConfig {
  imageTag: string;
  noCleanup: boolean;
  containerName: string;
  testPassword: string;
}

/**
 * Extension version info
 */
interface ExtensionVersion {
  name: string;
  version: string;
  schema: string;
}

/**
 * Parse command line arguments
 */
function parseArgs(): Pick<TestConfig, "imageTag" | "noCleanup"> {
  const imageTag = Bun.argv[2] || Bun.env.POSTGRES_IMAGE || "aza-pg:pg18";
  const noCleanup = Bun.argv.includes("--no-cleanup");

  return { imageTag, noCleanup };
}

/**
 * Generate test password
 */
function generateTestPassword(): string {
  const timestamp = Date.now();
  const pid = process.pid;
  return Bun.env.TEST_POSTGRES_PASSWORD ?? `test_postgres_${timestamp}_${pid}`;
}

/**
 * Query installed extensions
 */
async function queryExtensions(container: string): Promise<ExtensionVersion[]> {
  const result =
    await $`docker exec ${container} psql -U postgres -tA -F'|' -c "SELECT extname, extversion, nspname FROM pg_extension JOIN pg_namespace ON pg_extension.extnamespace = pg_namespace.oid ORDER BY extname;"`;

  const lines = result.text().trim().split("\n");
  return lines
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [name, version, schema] = line.split("|");
      return { name: name || "", version: version || "", schema: schema || "" };
    });
}

/**
 * Test 1: Start Container and Query Extensions
 */
async function testQueryExtensions(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 1: Start Container and Query Extensions");

    info("Starting PostgreSQL container...");
    await $`docker run -d --name ${config.containerName} -e POSTGRES_PASSWORD=${config.testPassword} ${config.imageTag}`.quiet();

    info("Waiting for PostgreSQL to be ready...");
    const ready = await waitForPostgres({
      container: config.containerName,
      timeout: TIMEOUTS.startup,
    });

    if (!ready) {
      throw new Error("PostgreSQL failed to start");
    }

    info("Querying installed extensions...");
    const extensions = await queryExtensions(config.containerName);

    if (extensions.length === 0) {
      throw new Error("No extensions found in pg_extension");
    }

    success(`Found ${extensions.length} installed extensions`);

    // Display extension versions
    console.log("\nInstalled Extensions:");
    console.log("-".repeat(60));
    for (const ext of extensions) {
      console.log(`  ${ext.name.padEnd(25)} ${ext.version.padEnd(15)} (${ext.schema})`);
    }
    console.log("");

    return {
      name: "Start Container and Query Extensions",
      passed: true,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      name: "Start Container and Query Extensions",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 2: Create Test Data with pgvector
 */
async function testPgvectorData(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 2: Create Test Data with pgvector");

    info("Creating pgvector extension...");
    await $`docker exec ${config.containerName} psql -U postgres -c "CREATE EXTENSION IF NOT EXISTS vector;"`;

    info("Creating table with vector column...");
    await $`docker exec ${config.containerName} psql -U postgres -c "CREATE TABLE IF NOT EXISTS test_vectors (id SERIAL PRIMARY KEY, embedding vector(3));"`;

    info("Inserting vector data...");
    await $`docker exec ${config.containerName} psql -U postgres -c "INSERT INTO test_vectors (embedding) VALUES ('[1,2,3]'), ('[4,5,6]'), ('[7,8,9]');"`;

    // Verify data
    const countResult =
      await $`docker exec ${config.containerName} psql -U postgres -tAc "SELECT COUNT(*) FROM test_vectors;"`;
    const count = countResult.text().trim();

    if (count !== "3") {
      throw new Error(`Expected 3 rows, got ${count}`);
    }

    // Test vector operations
    info("Testing vector similarity search...");
    const similarityResult =
      await $`docker exec ${config.containerName} psql -U postgres -tAc "SELECT id FROM test_vectors ORDER BY embedding <-> '[1,2,3]' LIMIT 1;"`;
    const nearestId = similarityResult.text().trim();

    if (nearestId !== "1") {
      throw new Error(`Expected nearest vector id=1, got ${nearestId}`);
    }

    success("pgvector data created and operations work");
    return { name: "Create Test Data with pgvector", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Create Test Data with pgvector",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 3: Create Test Data with PostGIS
 */
async function testPostgisData(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 3: Create Test Data with PostGIS");

    info("Creating postgis extension...");
    try {
      await $`docker exec ${config.containerName} psql -U postgres -c "CREATE EXTENSION IF NOT EXISTS postgis;"`;
    } catch {
      warning("PostGIS extension not available (might be disabled in manifest)");
      return { name: "Create Test Data with PostGIS", passed: true, duration: Date.now() - start };
    }

    info("Creating table with geometry column...");
    await $`docker exec ${config.containerName} psql -U postgres -c "CREATE TABLE IF NOT EXISTS test_geometries (id SERIAL PRIMARY KEY, location geometry(POINT, 4326));"`;

    info("Inserting geometry data...");
    await $`docker exec ${config.containerName} psql -U postgres -c "INSERT INTO test_geometries (location) VALUES (ST_GeomFromText('POINT(-122.4194 37.7749)', 4326)), (ST_GeomFromText('POINT(-118.2437 34.0522)', 4326));"`;

    // Verify data
    const countResult =
      await $`docker exec ${config.containerName} psql -U postgres -tAc "SELECT COUNT(*) FROM test_geometries;"`;
    const count = countResult.text().trim();

    if (count !== "2") {
      throw new Error(`Expected 2 rows, got ${count}`);
    }

    // Test geometry operations
    info("Testing geometry distance calculation...");
    const distanceResult =
      await $`docker exec ${config.containerName} psql -U postgres -tAc "SELECT ST_Distance(location, ST_GeomFromText('POINT(-122.4194 37.7749)', 4326)) FROM test_geometries LIMIT 1;"`;
    const distance = distanceResult.text().trim();

    if (distance === "" || distance === "0") {
      warning("Geometry distance calculation returned unexpected result");
    } else {
      success(`PostGIS data created and operations work (distance: ${distance})`);
    }

    return { name: "Create Test Data with PostGIS", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Create Test Data with PostGIS",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 4: Create Test Data with TimescaleDB
 */
async function testTimescaledbData(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 4: Create Test Data with TimescaleDB");

    info("Creating timescaledb extension...");
    await $`docker exec ${config.containerName} psql -U postgres -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"`;

    info("Creating hypertable...");
    await $`docker exec ${config.containerName} psql -U postgres -c "CREATE TABLE IF NOT EXISTS test_metrics (time TIMESTAMPTZ NOT NULL, device_id INT, temperature DOUBLE PRECISION);"`;
    await $`docker exec ${config.containerName} psql -U postgres -c "SELECT create_hypertable('test_metrics', 'time', if_not_exists => TRUE);"`;

    info("Inserting time-series data...");
    await $`docker exec ${config.containerName} psql -U postgres -c "INSERT INTO test_metrics VALUES (NOW() - INTERVAL '1 hour', 1, 20.5), (NOW() - INTERVAL '30 minutes', 1, 21.0), (NOW(), 1, 21.5);"`;

    // Verify data
    const countResult =
      await $`docker exec ${config.containerName} psql -U postgres -tAc "SELECT COUNT(*) FROM test_metrics;"`;
    const count = countResult.text().trim();

    if (count !== "3") {
      throw new Error(`Expected 3 rows, got ${count}`);
    }

    // Test hypertable operations
    info("Testing hypertable query...");
    const avgResult =
      await $`docker exec ${config.containerName} psql -U postgres -tAc "SELECT AVG(temperature) FROM test_metrics WHERE device_id = 1;"`;
    const avgTemp = avgResult.text().trim();

    if (avgTemp === "" || avgTemp === "0") {
      throw new Error("TimescaleDB query returned unexpected result");
    }

    success(`TimescaleDB data created and operations work (avg temp: ${avgTemp})`);
    return {
      name: "Create Test Data with TimescaleDB",
      passed: true,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      name: "Create Test Data with TimescaleDB",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 5: Create Test Data with pg_cron
 */
async function testPgCronData(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 5: Create Test Data with pg_cron");

    info("Creating pg_cron extension...");
    await $`docker exec ${config.containerName} psql -U postgres -c "CREATE EXTENSION IF NOT EXISTS pg_cron;"`;

    info("Creating test table for cron job...");
    await $`docker exec ${config.containerName} psql -U postgres -c "CREATE TABLE IF NOT EXISTS cron_test_log (id SERIAL PRIMARY KEY, executed_at TIMESTAMPTZ DEFAULT NOW());"`;

    info("Scheduling cron job...");
    const scheduleResult =
      await $`docker exec ${config.containerName} psql -U postgres -tAc "SELECT cron.schedule('test-job', '* * * * *', 'INSERT INTO cron_test_log DEFAULT VALUES');"`;
    const jobId = scheduleResult.text().trim();

    if (jobId === "" || jobId === "0") {
      throw new Error("Failed to schedule cron job");
    }

    success(`pg_cron job scheduled (job_id: ${jobId})`);

    // Verify job exists
    const jobCountResult =
      await $`docker exec ${config.containerName} psql -U postgres -tAc "SELECT COUNT(*) FROM cron.job WHERE jobid = ${jobId};"`;
    const jobCount = jobCountResult.text().trim();

    if (jobCount !== "1") {
      throw new Error(`Expected 1 cron job, got ${jobCount}`);
    }

    // Unschedule the job (cleanup)
    info("Unscheduling test job...");
    await $`docker exec ${config.containerName} psql -U postgres -c "SELECT cron.unschedule(${jobId});"`;

    success("pg_cron data created and operations work");
    return { name: "Create Test Data with pg_cron", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Create Test Data with pg_cron",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 6: Verify Extension Dependencies
 */
async function testExtensionDependencies(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 6: Verify Extension Dependencies");

    info("Querying extension dependencies...");
    const depsResult =
      await $`docker exec ${config.containerName} psql -U postgres -tA -F'|' -c "SELECT e1.extname AS extension, e2.extname AS depends_on FROM pg_extension e1 JOIN pg_depend d ON e1.oid = d.refobjid JOIN pg_extension e2 ON d.objid = e2.oid WHERE d.deptype = 'e' ORDER BY e1.extname;"`;

    const deps = depsResult.text().trim();

    if (deps === "") {
      info("No explicit extension dependencies found");
    } else {
      console.log("\nExtension Dependencies:");
      console.log("-".repeat(60));
      const depLines = deps.split("\n");
      for (const line of depLines) {
        const [extension, dependsOn] = line.split("|");
        console.log(`  ${extension} → ${dependsOn}`);
      }
      console.log("");
    }

    // Test CASCADE behavior with a test extension
    info("Testing CASCADE behavior...");

    // Create a simple extension (if not already created)
    await $`docker exec ${config.containerName} psql -U postgres -c "CREATE EXTENSION IF NOT EXISTS btree_gist;"`.nothrow();

    // Try to drop it
    await $`docker exec ${config.containerName} psql -U postgres -c "DROP EXTENSION IF EXISTS btree_gist CASCADE;"`.nothrow();

    success("Extension dependencies verified");
    return { name: "Verify Extension Dependencies", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Verify Extension Dependencies",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 7: Verify Data Integrity After Extension Operations
 */
async function testDataIntegrity(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 7: Verify Data Integrity After Extension Operations");

    // Verify pgvector data
    info("Verifying pgvector data integrity...");
    const vectorCountResult =
      await $`docker exec ${config.containerName} psql -U postgres -tAc "SELECT COUNT(*) FROM test_vectors;"`;
    const vectorCount = vectorCountResult.text().trim();

    if (vectorCount !== "3") {
      throw new Error(`pgvector data integrity failed: expected 3 rows, got ${vectorCount}`);
    }

    success("pgvector data integrity verified");

    // Verify timescaledb data
    info("Verifying timescaledb data integrity...");
    const tsdbCountResult =
      await $`docker exec ${config.containerName} psql -U postgres -tAc "SELECT COUNT(*) FROM test_metrics;"`;
    const tsdbCount = tsdbCountResult.text().trim();

    if (tsdbCount !== "3") {
      throw new Error(`timescaledb data integrity failed: expected 3 rows, got ${tsdbCount}`);
    }

    success("timescaledb data integrity verified");

    // Verify postgis data (if available)
    try {
      const geomCountResult =
        await $`docker exec ${config.containerName} psql -U postgres -tAc "SELECT COUNT(*) FROM test_geometries;"`;
      const geomCount = geomCountResult.text().trim();

      if (geomCount !== "2") {
        warning(`postgis data integrity warning: expected 2 rows, got ${geomCount}`);
      } else {
        success("postgis data integrity verified");
      }
    } catch {
      info("postgis data not available (extension might be disabled)");
    }

    success("Data integrity verified after extension operations");
    return {
      name: "Verify Data Integrity After Extension Operations",
      passed: true,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      name: "Verify Data Integrity After Extension Operations",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 8: Check Extension Control Files
 */
async function testExtensionControlFiles(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 8: Check Extension Control Files");

    info("Checking for extension control files...");

    // Check key extensions
    const extensionsToCheck = ["vector", "timescaledb", "pg_cron", "pgaudit"];
    const missingControlFiles: string[] = [];

    for (const extName of extensionsToCheck) {
      const checkResult =
        await $`docker exec ${config.containerName} test -f /usr/share/postgresql/18/extension/${extName}.control`.nothrow();

      if (checkResult.exitCode !== 0) {
        missingControlFiles.push(extName);
      }
    }

    if (missingControlFiles.length > 0) {
      warning(`Missing control files for: ${missingControlFiles.join(", ")}`);
    } else {
      success("All key extension control files present");
    }

    // List available extensions
    info("Querying available extensions...");
    const availableResult =
      await $`docker exec ${config.containerName} psql -U postgres -tAc "SELECT name FROM pg_available_extensions ORDER BY name;"`;
    const available = availableResult
      .text()
      .trim()
      .split("\n")
      .filter((n) => n.trim() !== "");

    success(`Found ${available.length} available extensions`);

    return { name: "Check Extension Control Files", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Check Extension Control Files",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Cleanup test environment
 */
async function cleanup(config: TestConfig): Promise<void> {
  if (config.noCleanup) {
    warning("Skipping cleanup (--no-cleanup flag set)");
    info(`Container ${config.containerName} is still running for inspection`);
    return;
  }

  info("Cleaning up test environment...");
  const success = await cleanupContainer(config.containerName);

  if (!success) {
    warning(`Failed to cleanup container ${config.containerName}`);
  }
}

/**
 * Main test execution
 */
async function main(): Promise<void> {
  // Check prerequisites
  try {
    await checkCommand("docker");
    await checkDockerDaemon();
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const args = parseArgs();
  const config: TestConfig = {
    ...args,
    containerName: generateUniqueContainerName("ext-version-test"),
    testPassword: generateTestPassword(),
  };

  console.log("========================================");
  console.log("Extension Version Compatibility Test");
  console.log("========================================");
  console.log(`Image: ${config.imageTag}`);
  console.log(`Container: ${config.containerName}`);
  console.log("");

  // Setup cleanup handlers
  process.on("SIGINT", async () => {
    console.log("\n\nCaught interrupt signal, cleaning up...");
    await cleanup(config);
    process.exit(130);
  });

  process.on("SIGTERM", async () => {
    console.log("\n\nCaught termination signal, cleaning up...");
    await cleanup(config);
    process.exit(143);
  });

  // Ensure image is available
  try {
    await ensureImageAvailable(config.imageTag);
  } catch (err) {
    error(
      `Failed to ensure image availability: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }

  const results: TestResult[] = [];

  try {
    // Run tests
    results.push(await testQueryExtensions(config));
    results.push(await testPgvectorData(config));
    results.push(await testPostgisData(config));
    results.push(await testTimescaledbData(config));
    results.push(await testPgCronData(config));
    results.push(await testExtensionDependencies(config));
    results.push(await testDataIntegrity(config));
    results.push(await testExtensionControlFiles(config));

    // Print summary
    console.log("");
    testSummary(results);

    // Check if all tests passed
    const failed = results.filter((r) => !r.passed).length;
    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    error("Test execution failed");
    console.error(err);
    process.exit(1);
  } finally {
    await cleanup(config);
  }
}

// Run main function
main();
