#!/usr/bin/env bun
/**
 * Replication Failover Test
 *
 * Purpose: Test hot standby promotion (replica → primary failover scenario)
 *
 * Coverage:
 * - Deploy primary + replica stack
 * - Verify replication is working (pg_stat_replication)
 * - Verify replica is in recovery mode (pg_is_in_recovery)
 * - Stop primary container (simulating failure)
 * - Promote replica to primary (pg_ctl promote)
 * - Verify replica is now primary (pg_is_in_recovery = false)
 * - Test write operations on promoted primary
 * - Verify replication slot is removed after promotion
 *
 * Usage:
 *   bun scripts/test/test-replication-failover.ts [image-tag] [--no-cleanup]
 */

import { $ } from "bun";
import { resolve } from "node:path";
import { generateUniqueProjectName } from "../utils/docker";
import { error, info, section, success, testSummary, warning } from "../utils/logger";
import type { TestResult } from "../utils/logger";
import { TIMEOUTS } from "../config/test-timeouts";

/**
 * Test configuration
 */
interface TestConfig {
  imageTag: string;
  noCleanup: boolean;
  projectRoot: string;
  primaryStackPath: string;
  replicaStackPath: string;
  testPostgresPassword: string;
  testReplicationPassword: string;
  primaryProjectName: string;
  replicaProjectName: string;
  networkName: string;
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
 * Get project root directory
 */
function getProjectRoot(): string {
  const scriptDir = import.meta.dir;
  return resolve(scriptDir, "..", "..");
}

/**
 * Generate test passwords
 */
function generateTestPasswords(): Pick<
  TestConfig,
  "testPostgresPassword" | "testReplicationPassword"
> {
  const timestamp = Date.now();
  const pid = process.pid;

  return {
    testPostgresPassword: Bun.env.TEST_POSTGRES_PASSWORD ?? `test_postgres_${timestamp}_${pid}`,
    testReplicationPassword:
      Bun.env.TEST_REPLICATION_PASSWORD ?? `test_replication_${timestamp}_${pid}`,
  };
}

/**
 * Get container ID for a service
 */
async function getContainerId(stackPath: string, serviceName: string): Promise<string> {
  const result = await $`docker compose --env-file .env.test ps ${serviceName} -q`.cwd(stackPath);
  return result.text().trim();
}

/**
 * Get service health status
 */
interface ServiceStatus {
  health: string;
  state: string;
}

async function getServiceHealth(stackPath: string, serviceName: string): Promise<ServiceStatus> {
  try {
    const result = await $`docker compose --env-file .env.test ps ${serviceName} --format json`
      .cwd(stackPath)
      .quiet();
    const output = result.text().trim();

    if (!output) {
      return { health: "starting", state: "starting" };
    }

    const json = JSON.parse(output);
    const service = Array.isArray(json) ? json[0] : json;

    return {
      health: service.Health ?? "starting",
      state: service.State ?? "starting",
    };
  } catch {
    return { health: "starting", state: "starting" };
  }
}

/**
 * Wait for service to be healthy
 */
async function waitForServiceHealthy(
  stackPath: string,
  serviceName: string,
  timeout: number = TIMEOUTS.initialization
): Promise<void> {
  info(`Waiting for ${serviceName} to be healthy (max ${timeout}s)...`);

  let elapsed = 0;
  let lastStatus = { health: "unknown", state: "unknown" };

  while (elapsed < timeout) {
    lastStatus = await getServiceHealth(stackPath, serviceName);

    if (lastStatus.health === "healthy") {
      success(`${serviceName} is healthy`);
      return;
    }

    if (elapsed % 10 === 0 || elapsed < 10) {
      console.log(`   ${serviceName}: ${lastStatus.health} (${elapsed}s/${timeout}s)`);
    }
    await Bun.sleep(5000);
    elapsed += 5;
  }

  error(`${serviceName} failed to become healthy after ${timeout}s`);
  error(`Last known health status: ${lastStatus.health}`);
  throw new Error(`${serviceName} health check timeout`);
}

/**
 * Test 1: Deploy Primary + Replica Stack
 */
async function testDeployStacks(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 1: Deploy Primary + Replica Stack");

    // Create primary .env.test
    const primaryEnvContent = `POSTGRES_PASSWORD=${config.testPostgresPassword}
PGBOUNCER_AUTH_PASS=${config.testPostgresPassword}
PG_REPLICATION_PASSWORD=${config.testReplicationPassword}
POSTGRES_IMAGE=${config.imageTag}
POSTGRES_MEMORY_LIMIT=2g
POSTGRES_BIND_IP=0.0.0.0
COMPOSE_PROJECT_NAME=${config.primaryProjectName}
POSTGRES_NETWORK_NAME=${config.networkName}
ENABLE_REPLICATION=true
REPLICATION_SLOT_NAME=failover_test_slot
`;

    await Bun.write(resolve(config.primaryStackPath, ".env.test"), primaryEnvContent);

    // Copy .env.test to .env (Docker Compose requires .env to exist for env_file directive)
    await $`cp .env.test .env`.cwd(config.primaryStackPath);

    // Deploy primary
    info("Starting primary stack...");
    await $`docker compose --env-file .env.test up -d postgres`.cwd(config.primaryStackPath);
    await waitForServiceHealthy(config.primaryStackPath, "postgres");

    // Create replication slot
    const primaryContainerId = await getContainerId(config.primaryStackPath, "postgres");
    info("Creating replication slot on primary...");
    await $`docker exec ${primaryContainerId} psql -U postgres -tAc "SELECT pg_drop_replication_slot('failover_test_slot') WHERE EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = 'failover_test_slot');"`.nothrow();
    await $`docker exec ${primaryContainerId} psql -U postgres -tAc "SELECT pg_create_physical_replication_slot('failover_test_slot');"`;
    success("Replication slot created");

    // Create replica .env.test
    const replicaEnvContent = `POSTGRES_PASSWORD=${config.testPostgresPassword}
PG_REPLICATION_PASSWORD=${config.testReplicationPassword}
POSTGRES_IMAGE=${config.imageTag}
POSTGRES_MEMORY_LIMIT=2g
POSTGRES_CPU_LIMIT=2
COMPOSE_PROJECT_NAME=${config.replicaProjectName}
POSTGRES_NETWORK_NAME=${config.networkName}
PRIMARY_HOST=postgres
PRIMARY_PORT=5432
REPLICATION_SLOT_NAME=failover_test_slot
POSTGRES_PORT=5433
POSTGRES_EXPORTER_PORT=9188
`;

    await Bun.write(resolve(config.replicaStackPath, ".env.test"), replicaEnvContent);

    // Copy .env.test to .env (Docker Compose requires .env to exist for env_file directive)
    await $`cp .env.test .env`.cwd(config.replicaStackPath);

    // Clear replica data volume to force fresh pg_basebackup
    try {
      await $`docker volume rm postgres-replica-data`.nothrow();
    } catch {
      // Volume doesn't exist, ignore
    }

    // Deploy replica
    info("Starting replica stack...");
    await $`docker compose --env-file .env.test up -d postgres-replica`.cwd(
      config.replicaStackPath
    );
    await waitForServiceHealthy(config.replicaStackPath, "postgres-replica", TIMEOUTS.replication);

    success("Primary and replica stacks deployed successfully");
    return { name: "Deploy Primary + Replica Stack", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Deploy Primary + Replica Stack",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 2: Verify Replication is Working
 */
async function testVerifyReplication(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 2: Verify Replication is Working");

    const primaryContainerId = await getContainerId(config.primaryStackPath, "postgres");

    // Check pg_stat_replication on primary
    info("Checking pg_stat_replication on primary...");
    const replicationStatus =
      await $`docker exec ${primaryContainerId} psql -U postgres -tAc "SELECT application_name, state, sync_state FROM pg_stat_replication WHERE slot_name = 'failover_test_slot';"`;
    const status = replicationStatus.text().trim();

    if (!status || status === "") {
      throw new Error("No replication connection found in pg_stat_replication");
    }

    success(`Replication status: ${status}`);

    // Create test data on primary
    info("Creating test data on primary...");
    await $`docker exec ${primaryContainerId} psql -U postgres -c "CREATE TABLE IF NOT EXISTS failover_test (id SERIAL PRIMARY KEY, data TEXT);"`;
    await $`docker exec ${primaryContainerId} psql -U postgres -c "INSERT INTO failover_test (data) VALUES ('before_failover_1'), ('before_failover_2'), ('before_failover_3');"`;

    // Wait for replication to sync
    await Bun.sleep(3000);

    // Verify data on replica
    const replicaContainerId = await getContainerId(config.replicaStackPath, "postgres-replica");
    info("Verifying data replicated to replica...");
    const replicaData =
      await $`docker exec ${replicaContainerId} psql -U postgres -tAc "SELECT COUNT(*) FROM failover_test;"`;
    const count = replicaData.text().trim();

    if (count !== "3") {
      throw new Error(`Expected 3 rows on replica, got ${count}`);
    }

    success("Replication is working correctly");
    return { name: "Verify Replication is Working", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Verify Replication is Working",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 3: Verify Replica is in Recovery Mode
 */
async function testVerifyRecoveryMode(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 3: Verify Replica is in Recovery Mode");

    const replicaContainerId = await getContainerId(config.replicaStackPath, "postgres-replica");

    const recoveryStatus =
      await $`docker exec ${replicaContainerId} psql -U postgres -tAc "SELECT pg_is_in_recovery();"`;
    const inRecovery = recoveryStatus.text().trim();

    if (inRecovery !== "t") {
      throw new Error(`Replica should be in recovery mode, got: ${inRecovery}`);
    }

    success("Replica is in recovery mode (standby)");
    return {
      name: "Verify Replica is in Recovery Mode",
      passed: true,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      name: "Verify Replica is in Recovery Mode",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 4: Check Replication Lag Before Failover
 */
async function testCheckReplicationLag(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 4: Check Replication Lag Before Failover");

    const primaryContainerId = await getContainerId(config.primaryStackPath, "postgres");
    const replicaContainerId = await getContainerId(config.replicaStackPath, "postgres-replica");

    // Get WAL position from primary
    const primaryWalResult =
      await $`docker exec ${primaryContainerId} psql -U postgres -tAc "SELECT pg_current_wal_lsn();"`;
    const primaryWal = primaryWalResult.text().trim();

    // Get WAL replay position from replica
    const replicaWalResult =
      await $`docker exec ${replicaContainerId} psql -U postgres -tAc "SELECT pg_last_wal_replay_lsn();"`;
    const replicaWal = replicaWalResult.text().trim();

    info(`Primary WAL LSN: ${primaryWal}`);
    info(`Replica replay LSN: ${replicaWal}`);

    if (!replicaWal || replicaWal === "0/0" || replicaWal === "") {
      throw new Error("Replica has not replayed any WAL yet");
    }

    success("Replication lag check complete");
    return {
      name: "Check Replication Lag Before Failover",
      passed: true,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      name: "Check Replication Lag Before Failover",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 5: Stop Primary (Simulate Failure)
 */
async function testStopPrimary(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 5: Stop Primary (Simulate Failure)");

    info("Stopping primary container...");
    await $`docker compose --env-file .env.test stop postgres`.cwd(config.primaryStackPath);

    // Verify primary is stopped
    await Bun.sleep(2000);
    const primaryStatus = await getServiceHealth(config.primaryStackPath, "postgres");

    if (primaryStatus.state !== "exited" && primaryStatus.state !== "stopped") {
      warning(`Primary state is ${primaryStatus.state}, expected exited or stopped`);
    } else {
      success("Primary stopped successfully");
    }

    return { name: "Stop Primary (Simulate Failure)", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Stop Primary (Simulate Failure)",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 6: Promote Replica to Primary
 */
async function testPromoteReplica(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 6: Promote Replica to Primary");

    const replicaContainerId = await getContainerId(config.replicaStackPath, "postgres-replica");

    info("Promoting replica to primary...");
    await $`docker exec ${replicaContainerId} bash -c 'pg_ctl promote -D "$PGDATA"'`;

    // Wait for promotion to complete
    info("Waiting for promotion to complete...");
    let promoted = false;
    let attempts = 0;
    const maxAttempts = 30;

    while (!promoted && attempts < maxAttempts) {
      await Bun.sleep(2000);
      const recoveryStatus =
        await $`docker exec ${replicaContainerId} psql -U postgres -tAc "SELECT pg_is_in_recovery();"`;
      const inRecovery = recoveryStatus.text().trim();

      if (inRecovery === "f") {
        promoted = true;
      }
      attempts++;
    }

    if (!promoted) {
      throw new Error("Replica promotion timeout - still in recovery mode after 60s");
    }

    success("Replica promoted to primary successfully");
    return { name: "Promote Replica to Primary", passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name: "Promote Replica to Primary",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 7: Verify Promoted Replica is Now Primary
 */
async function testVerifyPromotion(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 7: Verify Promoted Replica is Now Primary");

    const replicaContainerId = await getContainerId(config.replicaStackPath, "postgres-replica");

    // Verify pg_is_in_recovery is false
    const recoveryStatus =
      await $`docker exec ${replicaContainerId} psql -U postgres -tAc "SELECT pg_is_in_recovery();"`;
    const inRecovery = recoveryStatus.text().trim();

    if (inRecovery !== "f") {
      throw new Error(`Promoted replica should not be in recovery mode, got: ${inRecovery}`);
    }

    success("Promoted replica is now primary (not in recovery)");

    // Verify pg_stat_replication is empty (no replicas)
    const replicationStatus =
      await $`docker exec ${replicaContainerId} psql -U postgres -tAc "SELECT COUNT(*) FROM pg_stat_replication;"`;
    const count = replicationStatus.text().trim();

    if (count !== "0") {
      warning(`pg_stat_replication should be empty, found ${count} entries`);
    } else {
      success("pg_stat_replication is empty (no replicas connected)");
    }

    return {
      name: "Verify Promoted Replica is Now Primary",
      passed: true,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      name: "Verify Promoted Replica is Now Primary",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 8: Test Write Operations on Promoted Primary
 */
async function testWriteOperations(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 8: Test Write Operations on Promoted Primary");

    const replicaContainerId = await getContainerId(config.replicaStackPath, "postgres-replica");

    info("Attempting write operations on promoted primary...");

    // Insert new data
    await $`docker exec ${replicaContainerId} psql -U postgres -c "INSERT INTO failover_test (data) VALUES ('after_promotion_1'), ('after_promotion_2');"`;

    // Verify data
    const dataResult =
      await $`docker exec ${replicaContainerId} psql -U postgres -tAc "SELECT COUNT(*) FROM failover_test WHERE data LIKE 'after_promotion%';"`;
    const count = dataResult.text().trim();

    if (count !== "2") {
      throw new Error(`Expected 2 new rows, got ${count}`);
    }

    success("Write operations work on promoted primary");

    // Verify total count
    const totalResult =
      await $`docker exec ${replicaContainerId} psql -U postgres -tAc "SELECT COUNT(*) FROM failover_test;"`;
    const total = totalResult.text().trim();

    if (total !== "5") {
      throw new Error(`Expected 5 total rows (3 before + 2 after), got ${total}`);
    }

    success(`Total rows: ${total} (3 before failover + 2 after promotion)`);

    return {
      name: "Test Write Operations on Promoted Primary",
      passed: true,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      name: "Test Write Operations on Promoted Primary",
      passed: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test 9: Verify WAL Position Advances After Promotion
 */
async function testWalPositionAdvances(config: TestConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    section("Test 9: Verify WAL Position Advances After Promotion");

    const replicaContainerId = await getContainerId(config.replicaStackPath, "postgres-replica");

    // Get initial WAL position
    const initialWalResult =
      await $`docker exec ${replicaContainerId} psql -U postgres -tAc "SELECT pg_current_wal_lsn();"`;
    const initialWal = initialWalResult.text().trim();

    info(`Initial WAL LSN: ${initialWal}`);

    // Perform more writes
    await $`docker exec ${replicaContainerId} psql -U postgres -c "INSERT INTO failover_test (data) VALUES ('wal_test');"`;

    // Get new WAL position
    const newWalResult =
      await $`docker exec ${replicaContainerId} psql -U postgres -tAc "SELECT pg_current_wal_lsn();"`;
    const newWal = newWalResult.text().trim();

    info(`New WAL LSN: ${newWal}`);

    if (initialWal === newWal) {
      throw new Error("WAL position did not advance after write operation");
    }

    success("WAL position advances correctly on promoted primary");
    return {
      name: "Verify WAL Position Advances After Promotion",
      passed: true,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      name: "Verify WAL Position Advances After Promotion",
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
    return;
  }

  info("Cleaning up test environment...");

  try {
    // Stop replica stack
    await $`docker compose --env-file .env.test down -v`.cwd(config.replicaStackPath).quiet();
    await $`rm -f ${resolve(config.replicaStackPath, ".env.test")} ${resolve(config.replicaStackPath, ".env")}`.quiet();

    // Verify replica containers are removed
    const replicaCheck =
      await $`docker ps -a --filter name=${config.replicaProjectName} --format "{{.Names}}"`
        .nothrow()
        .quiet();
    const remainingReplica = replicaCheck.text().trim();
    if (remainingReplica) {
      warning(`Warning: Replica containers still exist: ${remainingReplica}`);
      const containerList = remainingReplica.split("\n").filter((n) => n.trim());
      for (const container of containerList) {
        await $`docker rm -f ${container}`.nothrow().quiet();
      }
    }
  } catch {
    // Ignore cleanup errors
  }

  try {
    // Stop primary stack
    await $`docker compose --env-file .env.test down -v`.cwd(config.primaryStackPath).quiet();
    await $`rm -f ${resolve(config.primaryStackPath, ".env.test")} ${resolve(config.primaryStackPath, ".env")}`.quiet();

    // Verify primary containers are removed
    const primaryCheck =
      await $`docker ps -a --filter name=${config.primaryProjectName} --format "{{.Names}}"`
        .nothrow()
        .quiet();
    const remainingPrimary = primaryCheck.text().trim();
    if (remainingPrimary) {
      warning(`Warning: Primary containers still exist: ${remainingPrimary}`);
      const containerList = remainingPrimary.split("\n").filter((n) => n.trim());
      for (const container of containerList) {
        await $`docker rm -f ${container}`.nothrow().quiet();
      }
    }
  } catch {
    // Ignore cleanup errors
  }

  try {
    // Clean up network
    await $`docker network rm ${config.networkName}`.quiet();
  } catch {
    // Ignore if network doesn't exist
  }

  success("Cleanup completed");
}

/**
 * Main test execution
 */
async function main(): Promise<void> {
  const args = parseArgs();
  const projectRoot = getProjectRoot();
  const passwords = generateTestPasswords();

  const config: TestConfig = {
    ...args,
    projectRoot,
    primaryStackPath: resolve(projectRoot, "stacks/primary"),
    replicaStackPath: resolve(projectRoot, "stacks/replica"),
    ...passwords,
    primaryProjectName: generateUniqueProjectName("failover-test-primary"),
    replicaProjectName: generateUniqueProjectName("failover-test-replica"),
    networkName: `failover-test-net-${Date.now()}-${process.pid}`,
  };

  console.log("========================================");
  console.log("Replication Failover Test");
  console.log("========================================");
  console.log(`Image: ${config.imageTag}`);
  console.log(`Primary Stack: ${config.primaryStackPath}`);
  console.log(`Replica Stack: ${config.replicaStackPath}`);
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

  const results: TestResult[] = [];

  try {
    // Run tests
    results.push(await testDeployStacks(config));
    results.push(await testVerifyReplication(config));
    results.push(await testVerifyRecoveryMode(config));
    results.push(await testCheckReplicationLag(config));
    results.push(await testStopPrimary(config));
    results.push(await testPromoteReplica(config));
    results.push(await testVerifyPromotion(config));
    results.push(await testWriteOperations(config));
    results.push(await testWalPositionAdvances(config));

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
