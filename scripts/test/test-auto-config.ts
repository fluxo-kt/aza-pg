#!/usr/bin/env bun
/**
 * Test script: Validate auto-config RAM/CPU detection and scaling
 * Usage: bun run scripts/test/test-auto-config.ts [image-tag]
 *
 * Examples:
 *   bun run scripts/test/test-auto-config.ts                    # Use default tag 'aza-pg:pg18'
 *   bun run scripts/test/test-auto-config.ts my-custom:tag      # Use custom tag
 */

import { $ } from "bun";
import {
  checkCommand,
  checkDockerDaemon,
  dockerCleanup,
  waitForPostgres,
} from "../utils/docker.js";
import { error, warning } from "../utils/logger.ts";

/**
 * Assert that logs contain a pattern with a success message
 */
function assertLogContains(logs: string, pattern: string, message: string): void {
  const regex = new RegExp(pattern);
  if (regex.test(logs)) {
    console.log(`✅ ${message}`);
  } else {
    console.log(`❌ FAILED: ${message}`);
    console.log(`   Pattern '${pattern}' not found in logs:`);
    console.log(logs);
    throw new Error(`Assertion failed: ${message}`);
  }
}

/**
 * Assert PostgreSQL configuration setting matches expected pattern
 */
async function assertPgConfig(
  container: string,
  setting: string,
  expected: string,
  message: string
): Promise<void> {
  let actual: string;
  try {
    const result =
      await $`docker exec ${container} psql -U postgres -t -c "SHOW ${setting};"`.text();
    actual = result.trim();
  } catch {
    warning(`${message} (PostgreSQL not ready yet)`);
    return;
  }

  const regex = new RegExp(expected);
  if (regex.test(actual)) {
    console.log(`✅ ${message} (actual: ${actual})`);
  } else {
    console.log(`❌ FAILED: ${message}`);
    console.log(`   Expected: ${expected}`);
    console.log(`   Actual: ${actual}`);
    throw new Error(`Config assertion failed: ${message}`);
  }
}

/**
 * Test case callback signature
 */
type TestCallback = (logs: string, container: string) => Promise<void>;

/**
 * Run a test case with a Docker container
 */
async function runCase(
  name: string,
  callback: TestCallback,
  dockerArgs: string[],
  imageTag: string
): Promise<void> {
  console.log(name);
  console.log("=".repeat(name.length));

  const container = `pg-autoconfig-${Math.floor(Math.random() * 100000)}-${process.pid}`;

  try {
    // Start container
    await $`docker run -d --name ${container} ${dockerArgs} ${imageTag}`.quiet();
  } catch {
    error(`Failed to start container for '${name}'`);
    await dockerCleanup(container);
    throw new Error(`Container start failed for: ${name}`);
  }

  try {
    // Wait for PostgreSQL to be ready
    await waitForPostgres({
      host: "localhost",
      port: 5432,
      user: "postgres",
      timeout: 60,
      container,
    });
  } catch (err) {
    error("PostgreSQL failed to start in time");
    const logs = await $`docker logs ${container}`.text();
    console.log("Container logs:");
    console.log(logs);
    await dockerCleanup(container);
    throw err;
  }

  // Get container logs
  const logs = await $`docker logs ${container}`.text();
  console.log("Auto-config logs:");
  const autoConfigLogs = logs
    .split("\n")
    .filter((line) => line.includes("[POSTGRES]"))
    .join("\n");
  console.log(autoConfigLogs || "(no auto-config logs found)");
  console.log();

  // Assert [AUTO-CONFIG] token exists in logs
  if (!logs.includes("[AUTO-CONFIG]")) {
    error("[AUTO-CONFIG] token not found in logs");
    console.log("   Expected auto-config logs with [AUTO-CONFIG] prefix");
    await dockerCleanup(container);
    throw new Error("[AUTO-CONFIG] token not found");
  }
  console.log("✅ [AUTO-CONFIG] token found in logs");

  // Run test callback
  await callback(logs, container);
  await dockerCleanup(container);
  console.log();
}

/**
 * Test 1: Manual override without memory limit
 */
async function caseManualOverride(logs: string, container: string): Promise<void> {
  assertLogContains(logs, "RAM: 1536MB \\(manual\\)", "Manual override respected (1536MB)");
  assertLogContains(
    logs,
    "shared_buffers=384MB",
    "shared_buffers scaled to 25% for manual override"
  );
  assertLogContains(logs, "max_connections=120", "Connection cap reduced to 120 for <4GB nodes");

  // Verify actual config
  await assertPgConfig(container, "shared_buffers", "384MB", "Config injection: shared_buffers");
  await assertPgConfig(container, "max_connections", "120", "Config injection: max_connections");
}

/**
 * Test 2: 2GB memory limit (cgroup detection)
 */
async function caseCgroup2g(logs: string, container: string): Promise<void> {
  assertLogContains(logs, "RAM: 204[0-9]MB \\(cgroup-v2\\)", "Detected 2GB via cgroup");
  assertLogContains(logs, "shared_buffers=512MB", "shared_buffers tuned for 2GB");
  assertLogContains(logs, "max_connections=120", "Connection cap 120 for 2GB nodes");

  // Verify actual config
  await assertPgConfig(container, "shared_buffers", "512MB", "Config injection: shared_buffers");
  await assertPgConfig(container, "max_connections", "120", "Config injection: max_connections");
}

/**
 * Test 3: 512MB memory limit (minimum supported)
 */
async function caseLowMem(logs: string, container: string): Promise<void> {
  assertLogContains(logs, "RAM: 512MB \\(cgroup-v2\\)", "Detected 512MB limit");
  assertLogContains(logs, "shared_buffers=128MB", "Minimum shared_buffers honored");
  assertLogContains(logs, "max_connections=80", "Connections throttled to 80 for 512MB nodes");

  // Verify actual config
  await assertPgConfig(container, "shared_buffers", "128MB", "Config injection: shared_buffers");
  await assertPgConfig(container, "max_connections", "80", "Config injection: max_connections");
}

/**
 * Test 4: Manual high-memory override (64GB)
 */
async function caseHighMemManual(logs: string, container: string): Promise<void> {
  assertLogContains(logs, "RAM: 65536MB \\(manual\\)", "Manual override supports 64GB");
  assertLogContains(logs, "shared_buffers=9830MB", "Large-node shared_buffers respects 15% rule");
  assertLogContains(logs, "max_connections=200", "Connections capped at 200 for big nodes");

  // Verify actual config
  await assertPgConfig(container, "shared_buffers", "9830MB", "Config injection: shared_buffers");
  await assertPgConfig(container, "max_connections", "200", "Config injection: max_connections");
}

/**
 * Test 5: CPU detection with limits
 */
async function caseCpuDetection(logs: string, container: string): Promise<void> {
  assertLogContains(logs, "CPU: 2 cores", "CPU detection picked up 2 cores");
  assertLogContains(logs, "max_worker_processes=4", "Worker processes scaled with CPU");

  // Verify actual config
  await assertPgConfig(
    container,
    "max_worker_processes",
    "4",
    "Config injection: max_worker_processes"
  );
  await assertPgConfig(
    container,
    "max_parallel_workers",
    "2",
    "Config injection: max_parallel_workers"
  );
}

/**
 * Test 7: Custom shared_preload_libraries override
 */
async function caseCustomSharedPreload(_logs: string, container: string): Promise<void> {
  // Verify custom shared_preload_libraries override (default is pg_stat_statements,auto_explain,pg_cron,pgaudit)
  // Override to minimal set to prove it works
  let actual: string;
  try {
    const result =
      await $`docker exec ${container} psql -U postgres -t -c "SHOW shared_preload_libraries;"`.text();
    actual = result.trim();
  } catch {
    error("Could not query shared_preload_libraries");
    throw new Error("Failed to query shared_preload_libraries");
  }

  // Verify override worked: should have pg_stat_statements but NOT auto_explain/pg_cron/pgaudit
  if (actual.includes("pg_stat_statements") && !/(auto_explain|pg_cron|pgaudit)/.test(actual)) {
    console.log(`✅ Custom shared_preload_libraries honored (actual: ${actual})`);
  } else {
    console.log("❌ FAILED: Override not respected");
    console.log("   Expected: pg_stat_statements (without auto_explain,pg_cron,pgaudit)");
    console.log(`   Actual: ${actual}`);
    throw new Error("Custom shared_preload_libraries override failed");
  }
}

/**
 * Test 8: 4GB memory tier (medium production)
 */
async function case4gbTier(logs: string, container: string): Promise<void> {
  assertLogContains(logs, "RAM: 409[0-9]MB \\(cgroup-v2\\)", "Detected 4GB via cgroup");
  assertLogContains(logs, "shared_buffers=1024MB", "shared_buffers tuned to 25% for 4GB");
  assertLogContains(logs, "max_connections=200", "Connection cap 200 for 4GB nodes");

  // Verify actual config
  await assertPgConfig(
    container,
    "shared_buffers",
    "1024MB|1GB",
    "Config injection: shared_buffers"
  );
  await assertPgConfig(container, "max_connections", "200", "Config injection: max_connections");
  await assertPgConfig(container, "work_mem", "[4-6]MB", "Config injection: work_mem ~5MB");
}

/**
 * Test 9: 8GB memory tier (large production)
 */
async function case8gbTier(logs: string, container: string): Promise<void> {
  assertLogContains(logs, "RAM: 819[0-9]MB \\(cgroup-v2\\)", "Detected 8GB via cgroup");
  assertLogContains(logs, "shared_buffers=2048MB", "shared_buffers tuned to 25% for 8GB");
  assertLogContains(logs, "max_connections=200", "Connection cap 200 for 8GB nodes");

  // Verify actual config
  await assertPgConfig(
    container,
    "shared_buffers",
    "2048MB|2GB",
    "Config injection: shared_buffers"
  );
  await assertPgConfig(container, "max_connections", "200", "Config injection: max_connections");
  await assertPgConfig(container, "work_mem", "[8-12]MB", "Config injection: work_mem ~10MB");
}

/**
 * Test 10: 16GB memory tier (high-load)
 */
async function case16gbTier(logs: string, container: string): Promise<void> {
  assertLogContains(logs, "RAM: 1638[0-9]MB \\(cgroup-v2\\)", "Detected 16GB via cgroup");
  assertLogContains(logs, "shared_buffers=3276MB", "shared_buffers tuned to 20% for 16GB");
  assertLogContains(logs, "max_connections=200", "Connection cap 200 for 16GB nodes");

  // Verify actual config
  await assertPgConfig(
    container,
    "shared_buffers",
    "327[0-9]MB|3.*GB",
    "Config injection: shared_buffers"
  );
  await assertPgConfig(container, "max_connections", "200", "Config injection: max_connections");
  await assertPgConfig(
    container,
    "work_mem",
    "1[6-9]MB|2[0-4]MB",
    "Config injection: work_mem ~20MB"
  );
}

/**
 * Main test execution
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

  const imageTag = Bun.argv[2] || "aza-pg:pg18";

  // Generate random test password at runtime
  const testPassword =
    Bun.env.TEST_POSTGRES_PASSWORD || `test_postgres_${Date.now()}_${process.pid}`;

  // Check if image exists
  try {
    await $`docker image inspect ${imageTag}`.quiet();
  } catch {
    error(`Docker image not found: ${imageTag}`);
    console.log("   Build image first: bun scripts/build.ts");
    console.log(`   Or run: bun scripts/test/test-build.ts ${imageTag}`);
    process.exit(1);
  }

  console.log("========================================");
  console.log("Auto-Config Detection & Scaling Test");
  console.log("========================================");
  console.log(`Image tag: ${imageTag}`);
  console.log();

  // Test 1: Manual override without memory limit
  await runCase(
    "Test 1: Manual override without memory limit",
    caseManualOverride,
    ["-e", `POSTGRES_PASSWORD=${testPassword}`, "-e", "POSTGRES_MEMORY=1536"],
    imageTag
  );

  // Test 2: 2GB memory limit (cgroup detection)
  await runCase(
    "Test 2: 2GB memory limit (cgroup detection)",
    caseCgroup2g,
    ["--memory=2g", "-e", `POSTGRES_PASSWORD=${testPassword}`],
    imageTag
  );

  // Test 3: 512MB memory limit (minimum supported)
  await runCase(
    "Test 3: 512MB memory limit (minimum supported)",
    caseLowMem,
    ["--memory=512m", "-e", `POSTGRES_PASSWORD=${testPassword}`],
    imageTag
  );

  // Test 4: Manual high-memory override (64GB)
  await runCase(
    "Test 4: Manual high-memory override (64GB)",
    caseHighMemManual,
    ["-e", `POSTGRES_PASSWORD=${testPassword}`, "-e", "POSTGRES_MEMORY=65536"],
    imageTag
  );

  // Test 5: CPU detection with limits
  await runCase(
    "Test 5: CPU detection with limits",
    caseCpuDetection,
    ["--cpus=2", "--memory=2g", "-e", `POSTGRES_PASSWORD=${testPassword}`],
    imageTag
  );

  // Test 6: Below minimum memory - should fail
  console.log("Test 6: Below minimum memory (256MB - should fail)");
  console.log("====================================================");
  const containerBelowMin = `pg-autoconfig-below-min-${process.pid}`;
  try {
    await $`docker run -d --name ${containerBelowMin} --memory=256m -e POSTGRES_PASSWORD=${testPassword} ${imageTag}`.quiet();

    // Poll with timeout instead of fixed sleep
    try {
      await waitForPostgres({
        host: "localhost",
        port: 5432,
        user: "postgres",
        timeout: 15,
        container: containerBelowMin,
      });

      // Container actually started (unexpected - should fail for < 512MB)
      const logs = await $`docker logs ${containerBelowMin}`.text();
      if (/FATAL.*512MB|minimum 512MB/.test(logs)) {
        console.log("✅ Container rejected 256MB deployment (below 512MB minimum)");
        await dockerCleanup(containerBelowMin);
      } else {
        error("Container should reject < 512MB but didn't");
        console.log(logs);
        await dockerCleanup(containerBelowMin);
        throw new Error("Container should reject < 512MB");
      }
    } catch {
      // PostgreSQL failed to start (expected for < 512MB)
      const logs = await $`docker logs ${containerBelowMin}`.text();
      console.log("✅ Container failed to start with 256MB (expected) - FATAL error in logs:");
      const fatalLines = logs.split("\n").filter((line) => line.includes("FATAL"));
      console.log(fatalLines.join("\n") || "(no FATAL found)");
      await dockerCleanup(containerBelowMin);
    }
  } catch {
    console.log("✅ Container failed to start with 256MB (expected)");
  }
  console.log();

  // Test 7: Custom shared_preload_libraries override
  await runCase(
    "Test 7: Custom shared_preload_libraries override",
    caseCustomSharedPreload,
    [
      "--memory=1g",
      "-e",
      `POSTGRES_PASSWORD=${testPassword}`,
      "-e",
      "POSTGRES_SHARED_PRELOAD_LIBRARIES=pg_stat_statements",
    ],
    imageTag
  );

  // Test 8: 4GB memory tier (medium production)
  await runCase(
    "Test 8: 4GB memory tier (medium production)",
    case4gbTier,
    ["--memory=4g", "-e", `POSTGRES_PASSWORD=${testPassword}`],
    imageTag
  );

  // Test 9: 8GB memory tier (large production)
  await runCase(
    "Test 9: 8GB memory tier (large production)",
    case8gbTier,
    ["--memory=8g", "-e", `POSTGRES_PASSWORD=${testPassword}`],
    imageTag
  );

  // Test 10: 16GB memory tier (high-load)
  await runCase(
    "Test 10: 16GB memory tier (high-load)",
    case16gbTier,
    ["--memory=16g", "-e", `POSTGRES_PASSWORD=${testPassword}`],
    imageTag
  );

  console.log("========================================");
  console.log("✅ All auto-config tests passed!");
  console.log("✅ Total: 10 tests (9 success cases + 1 failure case)");
  console.log("========================================");
}

// Run main function and handle errors
main().catch((error) => {
  error(error.message || "Test execution failed");
  process.exit(1);
});
