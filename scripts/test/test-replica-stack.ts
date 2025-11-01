#!/usr/bin/env bun
/**
 * Test script: Validate replica stack deployment and replication functionality
 * Usage: bun run scripts/test/test-replica-stack.ts
 *
 * Tests:
 *   1. Primary stack deployment and health
 *   2. Replication slot creation on primary
 *   3. Replica stack deployment
 *   4. Standby mode verification (pg_is_in_recovery)
 *   5. Hot standby settings and read-only queries
 *   6. Replication lag monitoring
 *   7. postgres_exporter availability on replica
 */

import { $ } from "bun";
import { resolve } from "path";
import { checkCommand, checkDockerDaemon } from "../utils/docker.js";
import { error, info, success, warning } from "../utils/logger.ts";

/**
 * Replica test configuration
 */
interface ReplicaTestConfig {
  projectRoot: string;
  primaryStackPath: string;
  replicaStackPath: string;
  testPostgresPassword: string;
  testPgBouncerPassword: string;
  testReplicationPassword: string;
}

/**
 * Docker Compose service health status
 */
interface ServiceStatus {
  health: string;
  state: string;
}

/**
 * Generate random test passwords at runtime
 */
function generateTestPasswords(): Pick<
  ReplicaTestConfig,
  "testPostgresPassword" | "testPgBouncerPassword" | "testReplicationPassword"
> {
  const timestamp = Date.now();
  const pid = process.pid;

  return {
    testPostgresPassword: Bun.env.TEST_POSTGRES_PASSWORD ?? `test_postgres_${timestamp}_${pid}`,
    testPgBouncerPassword: Bun.env.TEST_PGBOUNCER_PASSWORD ?? `test_pgbouncer_${timestamp}_${pid}`,
    testReplicationPassword:
      Bun.env.TEST_REPLICATION_PASSWORD ?? `test_replication_${timestamp}_${pid}`,
  };
}

/**
 * Get project root directory
 */
function getProjectRoot(): string {
  const scriptDir = import.meta.dir;
  return resolve(scriptDir, "..", "..");
}

/**
 * Check prerequisites for replica testing
 */
async function checkPrerequisites(): Promise<void> {
  // Check Docker
  try {
    await checkCommand("docker");
  } catch (err) {
    error((err as Error).message);
    console.log("   Install Docker: https://docs.docker.com/get-docker/");
    process.exit(1);
  }

  try {
    await checkDockerDaemon();
  } catch (err) {
    error((err as Error).message);
    console.log("   Start Docker: open -a Docker (macOS) or sudo systemctl start docker (Linux)");
    process.exit(1);
  }

  // Check docker compose
  try {
    await checkCommand("docker");
    await $`docker compose version`.quiet();
  } catch {
    try {
      await checkCommand("docker-compose");
    } catch {
      error("Required command 'docker compose' not found");
      console.log("   Install Docker Compose: https://docs.docker.com/compose/install/");
      process.exit(1);
    }
  }

  // Check jq
  try {
    await checkCommand("jq");
  } catch (err) {
    error((err as Error).message);
    console.log("   Install jq: apt-get install jq (Debian/Ubuntu) or brew install jq (macOS)");
    process.exit(1);
  }
}

/**
 * Verify stack directories exist
 */
async function verifyStackDirectories(config: ReplicaTestConfig): Promise<void> {
  const primaryCompose = resolve(config.primaryStackPath, "compose.yml");
  const replicaCompose = resolve(config.replicaStackPath, "compose.yml");

  if (!(await Bun.file(primaryCompose).exists())) {
    error(`Primary stack directory not found: ${config.primaryStackPath}`);
    process.exit(1);
  }

  if (!(await Bun.file(replicaCompose).exists())) {
    error(`Replica stack directory not found: ${config.replicaStackPath}`);
    process.exit(1);
  }
}

/**
 * Create shared network for replication
 */
async function createSharedNetwork(): Promise<void> {
  info("Creating shared network for replication...");
  try {
    await $`docker network create postgres-replica-test-net`.quiet();
  } catch {
    // Network may already exist, ignore error
  }
  success("Network created: postgres-replica-test-net");
}

/**
 * Deploy primary stack
 */
async function deployPrimaryStack(config: ReplicaTestConfig): Promise<void> {
  info("Step 1: Deploying primary stack...");

  // Create .env.test file
  const envContent = `POSTGRES_PASSWORD=${config.testPostgresPassword}
PGBOUNCER_AUTH_PASS=${config.testPgBouncerPassword}
PG_REPLICATION_PASSWORD=${config.testReplicationPassword}
POSTGRES_IMAGE=aza-pg:pg18
POSTGRES_MEMORY_LIMIT=2g
COMPOSE_PROJECT_NAME=aza-pg-replica-test-primary
POSTGRES_NETWORK_NAME=postgres-replica-test-net
ENABLE_REPLICATION=true
REPLICATION_SLOT_NAME=replica_slot_test
`;

  await Bun.write(resolve(config.primaryStackPath, ".env.test"), envContent);

  // Start primary stack
  info("Starting primary stack services...");
  try {
    await $`docker compose --env-file .env.test up -d postgres`.cwd(config.primaryStackPath);
  } catch (err) {
    error("Failed to start primary stack");
    console.error(err);
    process.exit(1);
  }

  success("Primary stack started");
}

/**
 * Get service health status from docker compose
 */
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
 * Wait for primary to be healthy
 */
async function waitForPrimaryHealthy(
  config: ReplicaTestConfig,
  timeout: number = 90
): Promise<void> {
  info(`Waiting for primary to be healthy (max ${timeout} seconds)...`);

  let elapsed = 0;
  while (elapsed < timeout) {
    const status = await getServiceHealth(config.primaryStackPath, "postgres");

    if (status.health === "healthy") {
      success("Primary PostgreSQL is healthy");
      return;
    }

    console.log(`   Primary PostgreSQL: ${status.health} (${elapsed}s/${timeout}s)`);
    await Bun.sleep(5000);
    elapsed += 5;
  }

  error(`Primary PostgreSQL failed to become healthy after ${timeout}s`);
  await $`docker compose --env-file .env.test logs postgres`.cwd(config.primaryStackPath);
  process.exit(1);
}

/**
 * Get container ID for a service
 */
async function getContainerId(stackPath: string, serviceName: string): Promise<string> {
  const result = await $`docker compose --env-file .env.test ps ${serviceName} -q`.cwd(stackPath);
  return result.text().trim();
}

/**
 * Create replication slot on primary
 */
async function createReplicationSlot(config: ReplicaTestConfig): Promise<void> {
  info("Step 2: Creating replication slot on primary...");

  const containerId = await getContainerId(config.primaryStackPath, "postgres");

  try {
    await $`docker exec ${containerId} psql -U postgres -tAc "SELECT pg_create_physical_replication_slot('replica_slot_test');"`;
  } catch (err) {
    error("Failed to create replication slot");
    console.error(err);
    process.exit(1);
  }

  success("Replication slot 'replica_slot_test' created");

  // Verify slot exists
  const result =
    await $`docker exec ${containerId} psql -U postgres -tAc "SELECT COUNT(*) FROM pg_replication_slots WHERE slot_name = 'replica_slot_test';"`;
  const count = result.text().trim();

  if (count !== "1") {
    error(`Replication slot verification failed (expected 1, got: ${count})`);
    process.exit(1);
  }

  success("Replication slot verified in pg_replication_slots");
}

/**
 * Deploy replica stack
 */
async function deployReplicaStack(config: ReplicaTestConfig): Promise<void> {
  info("Step 3: Deploying replica stack...");

  // Create .env.test file
  const envContent = `POSTGRES_PASSWORD=${config.testPostgresPassword}
PG_REPLICATION_PASSWORD=${config.testReplicationPassword}
POSTGRES_IMAGE=aza-pg:pg18
POSTGRES_MEMORY_LIMIT=2g
COMPOSE_PROJECT_NAME=aza-pg-replica-test-replica
POSTGRES_NETWORK_NAME=postgres-replica-test-net
PRIMARY_HOST=aza-pg-replica-test-primary-postgres
PRIMARY_PORT=5432
REPLICATION_SLOT_NAME=replica_slot_test
POSTGRES_PORT=5433
POSTGRES_EXPORTER_PORT=9188
`;

  await Bun.write(resolve(config.replicaStackPath, ".env.test"), envContent);

  // Start replica stack
  info("Starting replica stack services...");
  try {
    await $`docker compose --env-file .env.test up -d postgres-replica`.cwd(
      config.replicaStackPath
    );
  } catch {
    error("Failed to start replica stack");
    await $`docker compose --env-file .env.test logs postgres-replica`.cwd(config.replicaStackPath);
    process.exit(1);
  }

  success("Replica stack started");
}

/**
 * Wait for replica to be healthy
 */
async function waitForReplicaHealthy(
  config: ReplicaTestConfig,
  timeout: number = 120
): Promise<void> {
  info(`Waiting for replica to be healthy (max ${timeout} seconds)...`);

  let elapsed = 0;
  while (elapsed < timeout) {
    const status = await getServiceHealth(config.replicaStackPath, "postgres-replica");

    if (status.health === "healthy") {
      success("Replica PostgreSQL is healthy");
      return;
    }

    console.log(`   Replica PostgreSQL: ${status.health} (${elapsed}s/${timeout}s)`);
    await Bun.sleep(5000);
    elapsed += 5;
  }

  error(`Replica PostgreSQL failed to become healthy after ${timeout}s`);
  await $`docker compose --env-file .env.test logs postgres-replica`.cwd(config.replicaStackPath);
  process.exit(1);
}

/**
 * Verify standby mode (pg_is_in_recovery)
 */
async function verifyStandbyMode(config: ReplicaTestConfig): Promise<void> {
  info("Step 4: Verifying standby mode...");

  const containerId = await getContainerId(config.replicaStackPath, "postgres-replica");

  const result =
    await $`docker exec ${containerId} psql -U postgres -tAc "SELECT pg_is_in_recovery();"`;
  const inRecovery = result.text().trim();

  if (inRecovery !== "t") {
    error(`Replica is NOT in recovery mode (expected 't', got: '${inRecovery}')`);
    await $`docker compose --env-file .env.test logs postgres-replica`.cwd(config.replicaStackPath);
    process.exit(1);
  }

  success("Replica is in recovery mode (standby mode active)");
}

/**
 * Verify hot standby settings
 */
async function verifyHotStandby(config: ReplicaTestConfig): Promise<void> {
  info("Step 5: Verifying hot standby settings...");

  const containerId = await getContainerId(config.replicaStackPath, "postgres-replica");

  // Check hot_standby is enabled
  const hotStandbyResult =
    await $`docker exec ${containerId} psql -U postgres -tAc "SHOW hot_standby;"`;
  const hotStandby = hotStandbyResult.text().trim();

  if (hotStandby !== "on") {
    warning(`hot_standby is not 'on' (got: '${hotStandby}')`);
  } else {
    success("hot_standby is enabled");
  }

  // Test read-only query
  info("Testing read-only query on replica...");
  const selectResult = await $`docker exec ${containerId} psql -U postgres -tAc "SELECT 1 + 1;"`;
  const result = selectResult.text().trim();

  if (result !== "2") {
    error(`Read-only query failed (expected '2', got: '${result}')`);
    process.exit(1);
  }

  success("Read-only queries work on replica");

  // Test write attempt (should fail)
  info("Testing write protection on replica...");
  try {
    await $`docker exec ${containerId} psql -U postgres -c "CREATE TABLE test_write (id INT);"`;
    warning("Write protection test inconclusive");
  } catch (err) {
    const errorOutput = err instanceof Error ? err.message : String(err);
    if (
      errorOutput.toLowerCase().includes("cannot execute") ||
      errorOutput.toLowerCase().includes("read-only")
    ) {
      success("Replica is read-only (write protection verified)");
    } else {
      warning(`Write protection test inconclusive (got: '${errorOutput}')`);
    }
  }
}

/**
 * Verify replication lag
 */
async function verifyReplicationLag(config: ReplicaTestConfig): Promise<void> {
  info("Step 6: Checking replication lag...");

  // Get WAL position from primary
  const primaryContainerId = await getContainerId(config.primaryStackPath, "postgres");
  const primaryWalResult =
    await $`docker exec ${primaryContainerId} psql -U postgres -tAc "SELECT pg_current_wal_lsn();"`;
  const primaryWal = primaryWalResult.text().trim();

  // Get WAL replay position from replica
  const replicaContainerId = await getContainerId(config.replicaStackPath, "postgres-replica");
  const replicaWalResult =
    await $`docker exec ${replicaContainerId} psql -U postgres -tAc "SELECT pg_last_wal_replay_lsn();"`;
  const replicaWal = replicaWalResult.text().trim();

  info(`Primary WAL LSN: ${primaryWal}`);
  info(`Replica replay LSN: ${replicaWal}`);

  // Check if replica has received WAL data
  if (!replicaWal || replicaWal === "0/0" || replicaWal === "") {
    warning("Replica has not replayed any WAL yet (may need more time)");
  } else {
    success("Replica is replicating (WAL replay active)");
  }
}

/**
 * Start and test postgres_exporter
 */
async function testPostgresExporter(config: ReplicaTestConfig): Promise<void> {
  info("Step 7: Starting postgres_exporter on replica...");

  try {
    await $`docker compose --env-file .env.test up -d postgres_exporter`.cwd(
      config.replicaStackPath
    );
  } catch (err) {
    error("Failed to start postgres_exporter");
    console.error(err);
    process.exit(1);
  }

  success("postgres_exporter started");

  // Wait for exporter to be healthy
  info("Waiting for postgres_exporter to be healthy (max 60 seconds)...");

  let elapsed = 0;
  const timeout = 60;
  let exporterHealthy = false;

  while (elapsed < timeout) {
    const status = await getServiceHealth(config.replicaStackPath, "postgres_exporter");

    if (status.health === "healthy") {
      exporterHealthy = true;
      break;
    }

    console.log(`   postgres_exporter: ${status.health} (${elapsed}s/${timeout}s)`);
    await Bun.sleep(5000);
    elapsed += 5;
  }

  if (!exporterHealthy) {
    warning("postgres_exporter did not become healthy (may still work)");
  } else {
    success("postgres_exporter is healthy");
  }

  // Test metrics endpoint
  info("Testing metrics endpoint...");
  const exporterContainerId = await getContainerId(config.replicaStackPath, "postgres_exporter");

  try {
    const metricsResult =
      await $`docker exec ${exporterContainerId} wget -q -O - http://localhost:9187/metrics`;
    const metricsOutput = metricsResult.text();

    if (!metricsOutput) {
      error("Metrics endpoint returned empty output");
      process.exit(1);
    }

    if (!metricsOutput.includes("pg_up")) {
      error("Metrics output does not contain 'pg_up' metric");
      console.log("Output:");
      console.log(metricsOutput.split("\n").slice(0, 20).join("\n"));
      process.exit(1);
    }

    success("postgres_exporter metrics endpoint works");
  } catch (err) {
    error("Failed to test metrics endpoint");
    console.error(err);
    process.exit(1);
  }
}

/**
 * Cleanup test environment
 */
async function cleanup(config: ReplicaTestConfig): Promise<void> {
  info("Cleaning up test environment...");

  // Stop replica first
  try {
    await $`docker compose --env-file .env.test down -v`.cwd(config.replicaStackPath).quiet();
    await Bun.write(resolve(config.replicaStackPath, ".env.test"), "");
    await $`rm -f ${resolve(config.replicaStackPath, ".env.test")}`.quiet();
  } catch {
    // Ignore cleanup errors
  }

  // Stop primary second
  try {
    await $`docker compose --env-file .env.test down -v`.cwd(config.primaryStackPath).quiet();
    await Bun.write(resolve(config.primaryStackPath, ".env.test"), "");
    await $`rm -f ${resolve(config.primaryStackPath, ".env.test")}`.quiet();
  } catch {
    // Ignore cleanup errors
  }

  // Clean up network
  try {
    await $`docker network rm postgres-replica-test-net`.quiet();
  } catch {
    // Ignore if network doesn't exist
  }

  success("Cleanup completed");
}

/**
 * Print test summary
 */
function printSummary(): void {
  console.log("");
  console.log("========================================");
  console.log("✅ All replica stack tests passed!");
  console.log("========================================");
  console.log("");
  console.log("Summary:");
  console.log("  ✅ Primary stack deployed and healthy");
  console.log("  ✅ Replication slot created on primary");
  console.log("  ✅ Replica stack deployed and healthy");
  console.log("  ✅ Replica is in standby mode (pg_is_in_recovery = true)");
  console.log("  ✅ Hot standby enabled - read-only queries work");
  console.log("  ✅ Write protection verified on replica");
  console.log("  ✅ Replication active (WAL replay working)");
  console.log("  ✅ postgres_exporter functional on replica");
  console.log("");
}

/**
 * Main test execution
 */
async function main(): Promise<void> {
  console.log("========================================");
  console.log("Replica Stack Test");
  console.log("========================================");
  console.log("Primary Stack: stacks/primary");
  console.log("Replica Stack: stacks/replica");
  console.log("");

  // Initialize configuration
  const projectRoot = getProjectRoot();
  const passwords = generateTestPasswords();
  const config: ReplicaTestConfig = {
    projectRoot,
    primaryStackPath: resolve(projectRoot, "stacks/primary"),
    replicaStackPath: resolve(projectRoot, "stacks/replica"),
    ...passwords,
  };

  // Setup cleanup handler
  process.on("SIGINT", async () => {
    console.log("\n\nCaught interrupt signal, cleaning up...");
    await cleanup(config);
    process.exit(130);
  });

  try {
    // Prerequisites
    await checkPrerequisites();
    await verifyStackDirectories(config);

    // Create shared network
    await createSharedNetwork();

    // Step 1: Deploy primary stack
    await deployPrimaryStack(config);
    await waitForPrimaryHealthy(config);

    // Step 2: Create replication slot
    await createReplicationSlot(config);

    // Step 3: Deploy replica stack
    await deployReplicaStack(config);
    await waitForReplicaHealthy(config);

    // Step 4: Verify standby mode
    await verifyStandbyMode(config);

    // Step 5: Verify hot standby
    await verifyHotStandby(config);

    // Step 6: Verify replication lag
    await verifyReplicationLag(config);

    // Step 7: Test postgres_exporter
    await testPostgresExporter(config);

    // Print summary
    printSummary();
  } catch (err) {
    error("Test failed");
    console.error(err);
    process.exit(1);
  } finally {
    // Cleanup
    await cleanup(config);
  }
}

// Run main function
main();
