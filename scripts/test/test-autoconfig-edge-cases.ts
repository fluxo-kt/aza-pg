#!/usr/bin/env bun
/**
 * Auto-Config Edge Cases Test
 *
 * Purpose: Test auto-configuration with edge case resource values
 *
 * Coverage:
 * - Minimum RAM (512MB) - verify settings scale down appropriately
 * - Maximum RAM (128GB) - verify caps are applied
 * - Between-tier boundaries - test tier transitions (1.5GB, 3GB, 6GB)
 * - Workload type variations - test all 4 types (web, oltp, dw, mixed)
 * - Storage type variations - test all 3 types (ssd, hdd, san)
 *
 * Usage:
 *   bun scripts/test/test-autoconfig-edge-cases.ts [image-tag] [--no-cleanup]
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
  testPassword: string;
}

/**
 * Parse command line arguments
 */
function parseArgs(): Pick<TestConfig, "imageTag" | "noCleanup"> {
  const imageTag = Bun.argv[2] || Bun.env.POSTGRES_IMAGE || "ghcr.io/fluxo-kt/aza-pg:pg18";
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
 * Run a test case with specific docker args
 */
async function runTestCase(
  name: string,
  dockerArgs: string[],
  config: TestConfig,
  verifyFunc: (container: string) => Promise<void>
): Promise<TestResult> {
  const start = Date.now();
  const container = generateUniqueContainerName("autoconfig-edge");

  try {
    section(name);

    info("Starting container with specific configuration...");
    const envArgs = ["-e", `POSTGRES_PASSWORD=${config.testPassword}`];
    await $`docker run -d --name ${container} ${dockerArgs} ${envArgs} ${config.imageTag}`.quiet();

    info("Waiting for PostgreSQL to be ready...");
    const ready = await waitForPostgres({
      container,
      timeout: TIMEOUTS.startup,
    });

    if (!ready) {
      throw new Error("PostgreSQL failed to start");
    }

    // Run verification function
    await verifyFunc(container);

    success("Test case passed");
    return { name, passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name,
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (!config.noCleanup) {
      await cleanupContainer(container);
    }
  }
}

/**
 * Query PostgreSQL setting
 */
async function querySetting(container: string, setting: string): Promise<string> {
  const result = await $`docker exec ${container} psql -U postgres -tAc "SHOW ${setting};"`;
  return result.text().trim();
}

/**
 * Verify setting matches expected pattern
 */
async function verifySetting(
  container: string,
  setting: string,
  expectedPattern: string | RegExp,
  description: string
): Promise<void> {
  const actual = await querySetting(container, setting);
  const pattern =
    typeof expectedPattern === "string" ? new RegExp(expectedPattern) : expectedPattern;

  if (!pattern.test(actual)) {
    throw new Error(`${description} - Expected: ${expectedPattern}, Actual: ${actual}`);
  }

  info(`✓ ${description}: ${actual}`);
}

/**
 * Test 1: Minimum RAM (512MB)
 */
async function testMinimumRam(config: TestConfig): Promise<TestResult> {
  return runTestCase(
    "Test 1: Minimum RAM (512MB)",
    ["--memory=512m"],
    config,
    async (container) => {
      await verifySetting(container, "shared_buffers", /128MB/, "shared_buffers scaled to minimum");
      await verifySetting(
        container,
        "max_connections",
        /60/,
        "max_connections scaled down (mixed 120 × 50%)"
      );
      await verifySetting(container, "work_mem", /[1-2]MB/, "work_mem scaled appropriately");
    }
  );
}

/**
 * Test 2: Maximum RAM (128GB)
 */
async function testMaximumRam(config: TestConfig): Promise<TestResult> {
  return runTestCase(
    "Test 2: Maximum RAM (128GB)",
    ["-e", "POSTGRES_MEMORY=131072"],
    config,
    async (container) => {
      await verifySetting(
        container,
        "shared_buffers",
        /1966[0-9]MB|19.*GB/,
        "shared_buffers respects 15% cap for large RAM"
      );
      await verifySetting(
        container,
        "work_mem",
        /[2-3][0-9]MB/,
        "work_mem capped at reasonable value"
      );
      await verifySetting(
        container,
        "max_connections",
        /120/,
        "max_connections at default for mixed workload"
      );
    }
  );
}

/**
 * Test 3: Boundary - 1.5GB (between <2GB and 2-4GB tiers)
 */
async function testBoundary1_5GB(config: TestConfig): Promise<TestResult> {
  return runTestCase(
    "Test 3: Boundary - 1.5GB RAM",
    ["--memory=1536m"],
    config,
    async (container) => {
      await verifySetting(container, "shared_buffers", /384MB/, "shared_buffers scaled for 1.5GB");
      await verifySetting(
        container,
        "max_connections",
        /60/,
        "max_connections at 60 (50% tier for <2GB)"
      );
    }
  );
}

/**
 * Test 4: Boundary - 3GB (in 2-4GB tier)
 */
async function testBoundary3GB(config: TestConfig): Promise<TestResult> {
  return runTestCase("Test 4: Boundary - 3GB RAM", ["--memory=3g"], config, async (container) => {
    await verifySetting(container, "shared_buffers", /768MB/, "shared_buffers scaled for 3GB");
    await verifySetting(
      container,
      "max_connections",
      /84/,
      "max_connections at 84 (70% tier for 2-4GB)"
    );
  });
}

/**
 * Test 5: Boundary - 6GB (between 4-8GB tier)
 */
async function testBoundary6GB(config: TestConfig): Promise<TestResult> {
  return runTestCase("Test 5: Boundary - 6GB RAM", ["--memory=6g"], config, async (container) => {
    await verifySetting(
      container,
      "shared_buffers",
      /1536MB|1.5GB/,
      "shared_buffers scaled for 6GB"
    );
    await verifySetting(
      container,
      "max_connections",
      /102/,
      "max_connections at 102 (85% tier for 4-8GB)"
    );
  });
}

/**
 * Test 6: Workload Type - Web (8GB)
 */
async function testWorkloadWeb(config: TestConfig): Promise<TestResult> {
  return runTestCase(
    "Test 6: Workload Type - Web (8GB)",
    ["--memory=8g", "-e", "POSTGRES_WORKLOAD_TYPE=web"],
    config,
    async (container) => {
      await verifySetting(
        container,
        "max_connections",
        /200/,
        "max_connections at 200 for web workload"
      );
      await verifySetting(
        container,
        "default_statistics_target",
        /100/,
        "default_statistics_target at 100 for web"
      );
      await verifySetting(container, "min_wal_size", /1024MB|1GB/, "min_wal_size for web workload");
    }
  );
}

/**
 * Test 7: Workload Type - OLTP (8GB)
 */
async function testWorkloadOLTP(config: TestConfig): Promise<TestResult> {
  return runTestCase(
    "Test 7: Workload Type - OLTP (8GB)",
    ["--memory=8g", "-e", "POSTGRES_WORKLOAD_TYPE=oltp"],
    config,
    async (container) => {
      await verifySetting(
        container,
        "max_connections",
        /300/,
        "max_connections at 300 for OLTP workload"
      );
      await verifySetting(
        container,
        "min_wal_size",
        /2048MB|2GB/,
        "min_wal_size for OLTP workload"
      );
      await verifySetting(
        container,
        "max_wal_size",
        /8192MB|8GB/,
        "max_wal_size for OLTP workload"
      );
    }
  );
}

/**
 * Test 8: Workload Type - DW (8GB)
 */
async function testWorkloadDW(config: TestConfig): Promise<TestResult> {
  return runTestCase(
    "Test 8: Workload Type - DW (8GB)",
    ["--memory=8g", "-e", "POSTGRES_WORKLOAD_TYPE=dw"],
    config,
    async (container) => {
      await verifySetting(
        container,
        "max_connections",
        /100/,
        "max_connections at 100 for DW workload"
      );
      await verifySetting(
        container,
        "default_statistics_target",
        /500/,
        "default_statistics_target at 500 for DW"
      );
      await verifySetting(container, "min_wal_size", /4096MB|4GB/, "min_wal_size for DW workload");
    }
  );
}

/**
 * Test 9: Workload Type - Mixed (default, 8GB)
 */
async function testWorkloadMixed(config: TestConfig): Promise<TestResult> {
  return runTestCase(
    "Test 9: Workload Type - Mixed (default, 8GB)",
    ["--memory=8g"],
    config,
    async (container) => {
      await verifySetting(
        container,
        "max_connections",
        /120/,
        "max_connections at 120 for mixed workload"
      );
      await verifySetting(
        container,
        "min_wal_size",
        /1024MB|1GB/,
        "min_wal_size for mixed workload"
      );
    }
  );
}

/**
 * Test 10: Storage Type - SSD (default, 4GB)
 */
async function testStorageSSD(config: TestConfig): Promise<TestResult> {
  return runTestCase(
    "Test 10: Storage Type - SSD (default, 4GB)",
    ["--memory=4g"],
    config,
    async (container) => {
      await verifySetting(container, "random_page_cost", /1\.1/, "random_page_cost at 1.1 for SSD");
      await verifySetting(
        container,
        "maintenance_io_concurrency",
        /20/,
        "maintenance_io_concurrency at 20 for SSD"
      );
    }
  );
}

/**
 * Test 11: Storage Type - HDD (4GB)
 */
async function testStorageHDD(config: TestConfig): Promise<TestResult> {
  return runTestCase(
    "Test 11: Storage Type - HDD (4GB)",
    ["--memory=4g", "-e", "POSTGRES_STORAGE_TYPE=hdd"],
    config,
    async (container) => {
      await verifySetting(container, "random_page_cost", /4/, "random_page_cost at 4.0 for HDD");
      await verifySetting(
        container,
        "maintenance_io_concurrency",
        /10/,
        "maintenance_io_concurrency at 10 for HDD"
      );
    }
  );
}

/**
 * Test 12: Storage Type - SAN (4GB)
 */
async function testStorageSAN(config: TestConfig): Promise<TestResult> {
  return runTestCase(
    "Test 12: Storage Type - SAN (4GB)",
    ["--memory=4g", "-e", "POSTGRES_STORAGE_TYPE=san"],
    config,
    async (container) => {
      await verifySetting(container, "random_page_cost", /1\.1/, "random_page_cost at 1.1 for SAN");
      await verifySetting(
        container,
        "maintenance_io_concurrency",
        /20/,
        "maintenance_io_concurrency at 20 for SAN"
      );
    }
  );
}

/**
 * Test 13: CPU Limits - 1 vCPU (2GB)
 */
async function testCPU1Core(config: TestConfig): Promise<TestResult> {
  return runTestCase(
    "Test 13: CPU Limits - 1 vCPU (2GB)",
    ["--memory=2g", "--cpus=1"],
    config,
    async (container) => {
      await verifySetting(
        container,
        "max_worker_processes",
        /8/,
        "max_worker_processes at 8 (min floor)"
      );
      await verifySetting(
        container,
        "max_parallel_workers_per_gather",
        /0/,
        "max_parallel_workers_per_gather at 0 for <4 cores"
      );
    }
  );
}

/**
 * Test 14: CPU Limits - 4 vCPU (4GB)
 */
async function testCPU4Cores(config: TestConfig): Promise<TestResult> {
  return runTestCase(
    "Test 14: CPU Limits - 4 vCPU (4GB)",
    ["--memory=4g", "--cpus=4"],
    config,
    async (container) => {
      await verifySetting(
        container,
        "max_worker_processes",
        /8/,
        "max_worker_processes at 8 (min floor)"
      );
      await verifySetting(
        container,
        "max_parallel_workers",
        /4/,
        "max_parallel_workers at 4 for 4 cores"
      );
      await verifySetting(
        container,
        "max_parallel_workers_per_gather",
        /2/,
        "max_parallel_workers_per_gather at 2"
      );
    }
  );
}

/**
 * Test 15: Combined Edge Case (512MB + HDD + web)
 */
async function testCombinedEdgeCase1(config: TestConfig): Promise<TestResult> {
  return runTestCase(
    "Test 15: Combined - 512MB + HDD + web",
    ["--memory=512m", "-e", "POSTGRES_STORAGE_TYPE=hdd", "-e", "POSTGRES_WORKLOAD_TYPE=web"],
    config,
    async (container) => {
      await verifySetting(container, "shared_buffers", /128MB/, "shared_buffers at minimum");
      await verifySetting(container, "random_page_cost", /4/, "random_page_cost for HDD");
      await verifySetting(
        container,
        "max_connections",
        /100/,
        "max_connections scaled (web 200 × 50%)"
      );
    }
  );
}

/**
 * Test 16: Combined Edge Case (6GB + OLTP + SAN + 4 vCPU)
 */
async function testCombinedEdgeCase2(config: TestConfig): Promise<TestResult> {
  return runTestCase(
    "Test 16: Combined - 6GB + OLTP + SAN + 4 vCPU",
    [
      "--memory=6g",
      "--cpus=4",
      "-e",
      "POSTGRES_WORKLOAD_TYPE=oltp",
      "-e",
      "POSTGRES_STORAGE_TYPE=san",
    ],
    config,
    async (container) => {
      await verifySetting(container, "shared_buffers", /1536MB|1.5GB/, "shared_buffers for 6GB");
      await verifySetting(
        container,
        "max_connections",
        /255/,
        "max_connections scaled (OLTP 300 × 85%)"
      );
      await verifySetting(container, "random_page_cost", /1\.1/, "random_page_cost for SAN");
      await verifySetting(
        container,
        "max_parallel_workers",
        /4/,
        "max_parallel_workers for 4 cores"
      );
    }
  );
}

/**
 * Cleanup test environment (no-op for individual test cases)
 */
async function cleanup(config: TestConfig): Promise<void> {
  if (config.noCleanup) {
    warning("Cleanup skipped for all test cases (--no-cleanup flag)");
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
    testPassword: generateTestPassword(),
  };

  console.log("========================================");
  console.log("Auto-Config Edge Cases Test");
  console.log("========================================");
  console.log(`Image: ${config.imageTag}`);
  console.log("");

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
    // Run all tests
    results.push(await testMinimumRam(config));
    results.push(await testMaximumRam(config));
    results.push(await testBoundary1_5GB(config));
    results.push(await testBoundary3GB(config));
    results.push(await testBoundary6GB(config));
    results.push(await testWorkloadWeb(config));
    results.push(await testWorkloadOLTP(config));
    results.push(await testWorkloadDW(config));
    results.push(await testWorkloadMixed(config));
    results.push(await testStorageSSD(config));
    results.push(await testStorageHDD(config));
    results.push(await testStorageSAN(config));
    results.push(await testCPU1Core(config));
    results.push(await testCPU4Cores(config));
    results.push(await testCombinedEdgeCase1(config));
    results.push(await testCombinedEdgeCase2(config));

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
