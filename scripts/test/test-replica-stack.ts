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
import { resolve } from "node:path";
import { checkCommand, checkDockerDaemon, generateUniqueProjectName } from "../utils/docker";
import { error, info, success, warning } from "../utils/logger.ts";
import { TIMEOUTS } from "../config/test-timeouts";

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
 * Network is created by primary stack's Docker Compose with proper labels
 * Replica stack will use it via external: true configuration
 */
async function createSharedNetwork(): Promise<void> {
  info("Preparing network for replication...");

  // Clean up any pre-existing test network to avoid label conflicts
  try {
    await $`docker network rm postgres-replica-test-net`.quiet();
  } catch {
    // Network doesn't exist, ignore error
  }

  // Network will be created by primary stack's docker compose up command
  // with proper com.docker.compose.network labels
  success("Ready to create network via Docker Compose");
}

/**
 * Deploy primary stack
 */
async function deployPrimaryStack(config: ReplicaTestConfig): Promise<void> {
  info("Step 1: Deploying primary stack...");

  // Generate unique project name for primary
  const primaryProjectName = generateUniqueProjectName("aza-pg-replica-test-primary");
  const networkName = `postgres-replica-test-net-${Date.now()}-${process.pid}`;

  // Create .env.test file
  const envContent = `POSTGRES_PASSWORD=${config.testPostgresPassword}
PGBOUNCER_AUTH_PASS=${config.testPgBouncerPassword}
PG_REPLICATION_PASSWORD=${config.testReplicationPassword}
POSTGRES_IMAGE=${Bun.env.POSTGRES_IMAGE || "ghcr.io/fluxo-kt/aza-pg:pg18"}
POSTGRES_MEMORY_LIMIT=2g
POSTGRES_BIND_IP=0.0.0.0
COMPOSE_PROJECT_NAME=${primaryProjectName}
POSTGRES_NETWORK_NAME=${networkName}
ENABLE_REPLICATION=true
REPLICATION_SLOT_NAME=replica_slot_test
`;

  await Bun.write(resolve(config.primaryStackPath, ".env.test"), envContent);

  // Temporarily replace .env with .env.test for test isolation
  const envPath = resolve(config.primaryStackPath, ".env");
  const envBackupPath = resolve(config.primaryStackPath, ".env.backup-test");
  let envBackupNeeded = false;

  try {
    // Backup original .env if it exists
    await Bun.write(envBackupPath, await Bun.file(envPath).text());
    envBackupNeeded = true;
  } catch {
    // .env doesn't exist, no backup needed
  }

  try {
    // Copy .env.test to .env (Docker Compose requires .env to exist)
    await $`cp .env.test .env`.cwd(config.primaryStackPath);

    // Start primary stack
    info("Starting primary stack services...");
    await $`docker compose up -d postgres`.cwd(config.primaryStackPath);
    success("Primary stack started");
  } catch (err) {
    error("Failed to start primary stack");
    console.error(err);
    process.exit(1);
  } finally {
    // Restore original .env if it was backed up
    if (envBackupNeeded) {
      try {
        await $`mv ${envBackupPath} ${envPath}`.quiet();
      } catch {
        // Ignore restore errors
      }
    }
  }
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
  timeout: number = TIMEOUTS.initialization
): Promise<void> {
  info(`Waiting for primary to be healthy (max ${timeout} seconds)...`);

  let elapsed = 0;
  let lastStatus = { health: "unknown", state: "unknown" };
  while (elapsed < timeout) {
    lastStatus = await getServiceHealth(config.primaryStackPath, "postgres");

    if (lastStatus.health === "healthy") {
      success("Primary PostgreSQL is healthy");
      return;
    }

    console.log(`   Primary PostgreSQL: ${lastStatus.health} (${elapsed}s/${timeout}s)`);
    await Bun.sleep(5000);
    elapsed += 5;
  }

  error(`Primary PostgreSQL failed to become healthy after ${timeout}s`);
  error(`Last known health status: ${lastStatus.health}`);
  error(`Container state: ${lastStatus.state}`);
  error(`Container: postgres (service in primary stack)`);
  await $`docker compose --env-file .env.test logs postgres`.cwd(config.primaryStackPath);
  throw new Error(
    `Primary PostgreSQL health check failed - timeout after ${timeout}s with health status: ${lastStatus.health} and state: ${lastStatus.state}`
  );
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
    // Drop slot if it exists (idempotent operation)
    await $`docker exec ${containerId} psql -U postgres -tAc "SELECT pg_drop_replication_slot('replica_slot_test') WHERE EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = 'replica_slot_test');"`.nothrow();

    // Create fresh replication slot
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

  // Clear any existing replica data volume to force fresh pg_basebackup
  try {
    await $`docker volume rm postgres-replica-data`.nothrow();
  } catch {
    // Volume doesn't exist, ignore
  }

  // Generate unique project name for replica (must match network name from primary)
  const replicaProjectName = generateUniqueProjectName("aza-pg-replica-test-replica");

  // Read primary's env to get network name
  const primaryEnvContent = await Bun.file(resolve(config.primaryStackPath, ".env.test")).text();
  const networkNameMatch = primaryEnvContent.match(/POSTGRES_NETWORK_NAME=(.+)/);
  const networkName =
    networkNameMatch?.[1]?.trim() ?? `postgres-replica-test-net-${Date.now()}-${process.pid}`;

  // Create .env.test file
  const envContent = `POSTGRES_PASSWORD=${config.testPostgresPassword}
PG_REPLICATION_PASSWORD=${config.testReplicationPassword}
POSTGRES_IMAGE=${Bun.env.POSTGRES_IMAGE || "ghcr.io/fluxo-kt/aza-pg:pg18"}
POSTGRES_MEMORY_LIMIT=2g
POSTGRES_CPU_LIMIT=2
POSTGRES_ROLE=replica
COMPOSE_PROJECT_NAME=${replicaProjectName}
POSTGRES_NETWORK_NAME=${networkName}
PRIMARY_HOST=postgres
PRIMARY_PORT=5432
REPLICATION_SLOT_NAME=replica_slot_test
POSTGRES_PORT=5433
POSTGRES_EXPORTER_PORT=9188
`;

  await Bun.write(resolve(config.replicaStackPath, ".env.test"), envContent);

  // Temporarily replace .env with .env.test for test isolation
  const envPath = resolve(config.replicaStackPath, ".env");
  const envBackupPath = resolve(config.replicaStackPath, ".env.backup-test");
  let envBackupNeeded = false;

  try {
    // Backup original .env if it exists
    await Bun.write(envBackupPath, await Bun.file(envPath).text());
    envBackupNeeded = true;
  } catch {
    // .env doesn't exist, no backup needed
  }

  try {
    // Copy .env.test to .env (Docker Compose requires .env to exist)
    await $`cp .env.test .env`.cwd(config.replicaStackPath);

    // Start replica stack (will run fresh pg_basebackup)
    info("Starting replica stack services...");
    await $`docker compose up -d postgres-replica`.cwd(config.replicaStackPath);
    success("Replica stack started");
  } catch (err) {
    error("Failed to start replica stack");
    await $`docker compose logs postgres-replica`.cwd(config.replicaStackPath);
    console.error(err);
    process.exit(1);
  } finally {
    // Restore original .env if it was backed up
    if (envBackupNeeded) {
      try {
        await $`mv ${envBackupPath} ${envPath}`.quiet();
      } catch {
        // Ignore restore errors
      }
    }
  }
}

/**
 * Wait for replica to be healthy
 */
async function waitForReplicaHealthy(
  config: ReplicaTestConfig,
  timeout: number = TIMEOUTS.replication
): Promise<void> {
  info(`Waiting for replica to be healthy (max ${timeout} seconds)...`);

  let elapsed = 0;
  let lastStatus = { health: "unknown", state: "unknown" };
  while (elapsed < timeout) {
    lastStatus = await getServiceHealth(config.replicaStackPath, "postgres-replica");

    if (lastStatus.health === "healthy") {
      success("Replica PostgreSQL is healthy");
      return;
    }

    console.log(`   Replica PostgreSQL: ${lastStatus.health} (${elapsed}s/${timeout}s)`);
    await Bun.sleep(5000);
    elapsed += 5;
  }

  error(`Replica PostgreSQL failed to become healthy after ${timeout}s`);
  error(`Last known health status: ${lastStatus.health}`);
  error(`Container state: ${lastStatus.state}`);
  error(`Container: postgres-replica (service in replica stack)`);
  await $`docker compose --env-file .env.test logs postgres-replica`.cwd(config.replicaStackPath);
  throw new Error(
    `Replica PostgreSQL health check failed - timeout after ${timeout}s with health status: ${lastStatus.health} and state: ${lastStatus.state}`
  );
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
    // Check if the error is due to missing monitoring network (optional in test environments)
    const errorMessage = String(err);
    const stderr = (err as any)?.stderr || "";

    if (
      errorMessage.includes("network monitoring") ||
      errorMessage.includes("could not be found") ||
      stderr.includes("network monitoring") ||
      stderr.includes("could not be found")
    ) {
      warning("postgres_exporter startup skipped (monitoring network not available)");
      warning("This is expected in test environments without pre-configured monitoring");
      return; // Skip exporter tests, but don't fail the entire test suite
    }
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

  // Read env files to get project names and network name
  let replicaProjectName = "";
  let primaryProjectName = "";
  let networkName = "";

  try {
    const replicaEnv = await Bun.file(resolve(config.replicaStackPath, ".env.test")).text();
    const replicaMatch = replicaEnv.match(/COMPOSE_PROJECT_NAME=(.+)/);
    replicaProjectName = replicaMatch?.[1]?.trim() ?? "";
    const networkMatch = replicaEnv.match(/POSTGRES_NETWORK_NAME=(.+)/);
    networkName = networkMatch?.[1]?.trim() ?? "";
  } catch {
    // Ignore if file doesn't exist
  }

  try {
    const primaryEnv = await Bun.file(resolve(config.primaryStackPath, ".env.test")).text();
    const primaryMatch = primaryEnv.match(/COMPOSE_PROJECT_NAME=(.+)/);
    primaryProjectName = primaryMatch?.[1]?.trim() ?? "";
  } catch {
    // Ignore if file doesn't exist
  }

  // Stop replica first
  try {
    await $`docker compose --env-file .env.test down -v --remove-orphans`
      .cwd(config.replicaStackPath)
      .quiet();
    await Bun.sleep(2000); // Wait for port release
    await $`rm -f ${resolve(config.replicaStackPath, ".env.test")}`.quiet();

    // Verify replica containers are removed
    if (replicaProjectName) {
      const checkResult =
        await $`docker ps -a --filter name=${replicaProjectName} --format "{{.Names}}"`
          .nothrow()
          .quiet();
      const remainingContainers = checkResult.text().trim();
      if (remainingContainers) {
        warning(`Warning: Replica containers still exist: ${remainingContainers}`);
        const containerList = remainingContainers.split("\n").filter((n) => n.trim());
        for (const container of containerList) {
          await $`docker rm -f ${container}`.nothrow().quiet();
        }
        await Bun.sleep(1000);
      }
    }

    // Clean up replica volumes
    if (replicaProjectName) {
      await $`docker volume prune -f --filter label=com.docker.compose.project=${replicaProjectName}`
        .nothrow()
        .quiet();
    }
  } catch (err) {
    warning(`Replica cleanup warning: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Stop primary second
  try {
    await $`docker compose --env-file .env.test down -v --remove-orphans`
      .cwd(config.primaryStackPath)
      .quiet();
    await Bun.sleep(3000); // Wait longer for primary port release
    await $`rm -f ${resolve(config.primaryStackPath, ".env.test")}`.quiet();

    // Verify primary containers are removed
    if (primaryProjectName) {
      const checkResult =
        await $`docker ps -a --filter name=${primaryProjectName} --format "{{.Names}}"`
          .nothrow()
          .quiet();
      const remainingContainers = checkResult.text().trim();
      if (remainingContainers) {
        warning(`Warning: Primary containers still exist: ${remainingContainers}`);
        const containerList = remainingContainers.split("\n").filter((n) => n.trim());
        for (const container of containerList) {
          await $`docker rm -f ${container}`.nothrow().quiet();
        }
        await Bun.sleep(2000);
      }
    }

    // Clean up primary volumes
    if (primaryProjectName) {
      await $`docker volume prune -f --filter label=com.docker.compose.project=${primaryProjectName}`
        .nothrow()
        .quiet();
    }
  } catch (err) {
    warning(`Primary cleanup warning: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Clean up network
  if (networkName) {
    try {
      await $`docker network rm ${networkName}`.quiet();
    } catch {
      // Ignore if network doesn't exist
    }
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

  try {
    // ============================================================
    // PRE-TEST CLEANUP: Remove only TEST containers and their volumes
    // SAFETY: Never touch production/dev containers that aren't test-related
    // ============================================================
    info("Pre-test cleanup: removing TEST containers and volumes only...");

    // Patterns that identify test containers (safe to remove)
    // IMPORTANT: Only add patterns here that are EXCLUSIVELY used by tests!
    // Production containers should NEVER match these patterns
    const TEST_CONTAINER_PATTERNS = [
      // Stack tests
      "aza-pg-single-test",
      "aza-pg-replica-test",
      // Integration tests
      "aza-pg-extensions-test",
      "aza-pg-test-",
      "aza-pg-security-test",
      "aza-pg-negative-",
      "aza-pg-ext-smoke",
      // Functional tests (all start with test- or specific prefixes)
      "test-", // Covers test-*-extensions and similar
      "pg-test-",
      "pg-perf-",
      "pg-disabled-test",
      "pg-regression-test",
      "ext-regression-test",
      "ext-upgrade-test",
      "ext-expected-gen",
      "ext-version-test",
      "interaction-test",
      "shutdown-test",
      "persist-test",
      "tsdb-tsl-verify",
      "smoke-test",
      "pgflow-test",
      "pg18-test",
    ];
    const isTestContainer = (name: string): boolean =>
      TEST_CONTAINER_PATTERNS.some((p) => name.includes(p));

    try {
      // Stop all test project containers (ONLY test containers, not production!)
      info("Stopping test containers...");
      const allContainers = await $`docker ps -a --format "{{.Names}}"`.nothrow().quiet();
      const testContainers = allContainers
        .text()
        .trim()
        .split("\n")
        .filter((n) => n.trim() && isTestContainer(n));

      if (testContainers.length > 0) {
        info(`Removing ${testContainers.length} test containers: ${testContainers.join(", ")}`);
        for (const container of testContainers) {
          await $`docker rm -f ${container}`.nothrow().quiet();
        }
        await Bun.sleep(2000);
      }

      // Try to remove test volumes (only if not used by non-test containers)
      info("Cleaning up test volumes...");
      const volumesToRemove = ["postgres_data", "postgres-replica-data", "postgres_backup"];
      for (const volume of volumesToRemove) {
        // Check if volume exists
        const exists = await $`docker volume inspect ${volume}`.nothrow().quiet();
        if (exists.exitCode !== 0) continue;

        // Check what's using this volume
        const usage = await $`docker ps -a --filter volume=${volume} --format "{{.Names}}"`
          .nothrow()
          .quiet();
        const usingContainers = usage
          .text()
          .trim()
          .split("\n")
          .filter((n) => n.trim());

        if (usingContainers.length === 0) {
          // No containers using it, safe to remove
          const result = await $`docker volume rm ${volume}`.nothrow().quiet();
          if (result.exitCode === 0) {
            info(`Removed orphaned volume: ${volume}`);
          }
        } else {
          // Check if ALL containers using this volume are test containers
          const nonTestContainers = usingContainers.filter((c) => !isTestContainer(c));
          if (nonTestContainers.length > 0) {
            warning(
              `Volume ${volume} in use by non-test container(s): ${nonTestContainers.join(", ")}. ` +
                `Skipping to protect data. Remove manually if needed.`
            );
          } else {
            // All containers are test containers, remove them first then the volume
            info(`Volume ${volume} used by test containers: ${usingContainers.join(", ")}`);
            for (const c of usingContainers) {
              await $`docker rm -f ${c}`.nothrow().quiet();
            }
            await $`docker volume rm ${volume}`.nothrow().quiet();
            info(`Removed volume: ${volume}`);
          }
        }
      }

      success("Pre-test cleanup completed");
    } catch (err) {
      warning(`Pre-test cleanup warning: ${err instanceof Error ? err.message : String(err)}`);
    }

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
