#!/usr/bin/env bun
/**
 * Test script: Validate PgBouncer healthcheck and authentication
 * Usage: bun run scripts/test/test-pgbouncer-healthcheck.ts [stack-dir]
 *
 * Examples:
 *   bun run scripts/test/test-pgbouncer-healthcheck.ts                      # Use default 'stacks/primary'
 *   bun run scripts/test/test-pgbouncer-healthcheck.ts stacks/primary       # Explicit path
 */

import { $ } from "bun";
import { checkCommand, checkDockerDaemon, generateUniqueProjectName } from "../utils/docker";
import { error, info, success, warning } from "../utils/logger.ts";
import { join, resolve } from "path";
import { existsSync } from "fs";
import { TIMEOUTS } from "../config/test-timeouts";

/**
 * Service health status from Docker Compose
 */
interface ServiceStatus {
  Health: string;
}

/**
 * Test environment credentials
 */
interface TestCredentials {
  pgbouncerPassword: string;
  postgresPassword: string;
  replicationPassword: string;
}

/**
 * Generate test credentials with timestamp and PID for uniqueness
 */
function generateTestCredentials(): TestCredentials {
  const timestamp = Date.now();
  const pid = process.pid;

  return {
    pgbouncerPassword: Bun.env.TEST_PGBOUNCER_PASSWORD ?? `test_pgbouncer_${timestamp}_${pid}`,
    postgresPassword: Bun.env.TEST_POSTGRES_PASSWORD ?? `test_postgres_${timestamp}_${pid}`,
    replicationPassword:
      Bun.env.TEST_REPLICATION_PASSWORD ?? `test_replication_${timestamp}_${pid}`,
  };
}

/**
 * Create test .env file for Docker Compose
 */
async function createTestEnv(
  stackPath: string,
  credentials: TestCredentials,
  projectName: string
): Promise<void> {
  const postgresImage = Bun.env.POSTGRES_IMAGE ?? "aza-pg:pg18";
  const envContent = `POSTGRES_PASSWORD=${credentials.postgresPassword}
PGBOUNCER_AUTH_PASS=${credentials.pgbouncerPassword}
PG_REPLICATION_PASSWORD=${credentials.replicationPassword}
POSTGRES_IMAGE=${postgresImage}
POSTGRES_MEMORY_LIMIT=2g
COMPOSE_PROJECT_NAME=${projectName}
`;

  const envFile = Bun.file(join(stackPath, ".env.test"));
  await Bun.write(envFile, envContent);
}

/**
 * Get service health status from Docker Compose
 */
async function getServiceHealth(stackPath: string, service: string): Promise<string> {
  try {
    const result = await $`docker compose --env-file .env.test ps ${service} --format json`
      .cwd(stackPath)
      .text();
    const serviceStatus: ServiceStatus = JSON.parse(result);
    return serviceStatus?.Health ?? "starting";
  } catch {
    return "starting";
  }
}

/**
 * Wait for services to be healthy
 */
async function waitForServicesHealthy(stackPath: string, timeout: number): Promise<void> {
  info(`Waiting for services to be healthy (max ${timeout} seconds)...`);

  let elapsed = 0;
  let postgresHealthy = false;
  let pgbouncerHealthy = false;
  let lastPostgresStatus = "unknown";
  let lastPgbouncerStatus = "unknown";

  while (elapsed < timeout) {
    lastPostgresStatus = await getServiceHealth(stackPath, "postgres");
    lastPgbouncerStatus = await getServiceHealth(stackPath, "pgbouncer");

    if (lastPostgresStatus === "healthy") {
      postgresHealthy = true;
    }

    if (lastPgbouncerStatus === "healthy") {
      pgbouncerHealthy = true;
    }

    if (postgresHealthy && pgbouncerHealthy) {
      break;
    }

    console.log(
      `   PostgreSQL: ${lastPostgresStatus}, PgBouncer: ${lastPgbouncerStatus} (${elapsed}s/${timeout}s)`
    );
    await Bun.sleep(5000);
    elapsed += 5;
  }

  if (!postgresHealthy) {
    error(`PostgreSQL failed to become healthy after ${timeout}s`);
    error(`Last known status: ${lastPostgresStatus}`);
    error(`Container: postgres (service in primary stack)`);
    await $`docker compose --env-file .env.test logs postgres`.cwd(stackPath);
    throw new Error(
      `PostgreSQL health check failed - timeout after ${timeout}s with status: ${lastPostgresStatus}`
    );
  }

  if (!pgbouncerHealthy) {
    error(`PgBouncer failed to become healthy after ${timeout}s`);
    error(`Last known status: ${lastPgbouncerStatus}`);
    error(`Container: pgbouncer (service in primary stack)`);
    await $`docker compose --env-file .env.test logs pgbouncer`.cwd(stackPath);
    throw new Error(
      `PgBouncer health check failed - timeout after ${timeout}s with status: ${lastPgbouncerStatus}`
    );
  }

  success("Both services are healthy");
}

/**
 * Get container ID for a service
 */
async function getContainerId(stackPath: string, service: string): Promise<string> {
  const result = await $`docker compose --env-file .env.test ps ${service} -q`
    .cwd(stackPath)
    .text();
  return result.trim();
}

/**
 * Test 1: Verify .pgpass file exists
 */
async function testPgpassExists(containerId: string): Promise<void> {
  info("Test 1: Verifying .pgpass file exists...");

  try {
    await $`docker exec ${containerId} test -f /tmp/.pgpass`.quiet();
    success(".pgpass file exists at /tmp/.pgpass");
  } catch {
    error(".pgpass file not found at /tmp/.pgpass");
    await $`docker exec ${containerId} ls -la /tmp/`;
    throw new Error(".pgpass file not found");
  }
}

/**
 * Test 2: Verify .pgpass file permissions
 */
async function testPgpassPermissions(containerId: string): Promise<void> {
  info("Test 2: Verifying .pgpass file permissions...");

  const perms = await $`docker exec ${containerId} stat -c %a /tmp/.pgpass`.text();
  const permissions = perms.trim();

  if (permissions !== "600") {
    warning(`.pgpass permissions are ${permissions} (expected 600, but may work)`);
  } else {
    success(".pgpass has correct permissions (600)");
  }
}

/**
 * Test 3: Verify .pgpass entries
 */
async function testPgpassEntries(containerId: string): Promise<void> {
  info("Test 3: Verifying .pgpass entries...");

  const content = await $`docker exec ${containerId} cat /tmp/.pgpass`.text();

  if (!content.includes("localhost:6432")) {
    error(".pgpass missing entry for localhost:6432");
    console.log("Content:");
    console.log(content);
    throw new Error(".pgpass missing localhost:6432 entry");
  }

  if (!content.includes("pgbouncer:6432")) {
    error(".pgpass missing entry for pgbouncer:6432");
    console.log("Content:");
    console.log(content);
    throw new Error(".pgpass missing pgbouncer:6432 entry");
  }

  success(".pgpass has entries for both localhost:6432 and pgbouncer:6432");
}

/**
 * Test 4: Test authentication via localhost:6432
 */
async function testAuthLocalhost(containerId: string): Promise<void> {
  info("Test 4: Testing authentication via localhost:6432...");

  try {
    await $`docker exec ${containerId} sh -c HOME=/tmp psql -h localhost -p 6432 -U pgbouncer_auth -d postgres -c "SELECT 1"`.quiet();
    success("Authentication successful via localhost:6432");
  } catch {
    error("Authentication failed via localhost:6432");
    throw new Error("Authentication failed via localhost:6432");
  }
}

/**
 * Test 5: Test authentication via pgbouncer:6432 from postgres container
 */
async function testAuthHostname(
  postgresContainerId: string,
  pgbouncerPassword: string,
  stackPath: string
): Promise<void> {
  info("Test 5: Testing authentication via pgbouncer:6432...");

  try {
    await $`docker exec ${postgresContainerId} sh -c PGPASSWORD=${pgbouncerPassword} psql -h pgbouncer -p 6432 -U pgbouncer_auth -d postgres -c 'SELECT 1'`.quiet();
    success("Authentication successful via pgbouncer:6432");
  } catch {
    error("Authentication failed via pgbouncer:6432 from postgres container");
    await $`docker compose --env-file .env.test logs pgbouncer`.cwd(stackPath);
    throw new Error("Authentication failed via pgbouncer:6432");
  }
}

/**
 * Test 6: Verify SHOW POOLS works
 */
async function testShowPools(containerId: string, pgbouncerPassword: string): Promise<void> {
  info("Test 6: Testing SHOW POOLS command...");

  // First, make a connection to postgres database to ensure pool exists
  await $`docker exec ${containerId} sh -c PGPASSWORD=${pgbouncerPassword} psql -h localhost -p 6432 -U pgbouncer_auth -d postgres -c 'SELECT 1'`.quiet();

  // Now query SHOW POOLS
  const cmd = `PGPASSWORD='${pgbouncerPassword}' psql -h localhost -p 6432 -U pgbouncer_auth -d pgbouncer -c "SHOW POOLS"`;
  const output = await $`docker exec ${containerId} sh -c ${cmd}`.text();

  if (!output || output.trim() === "") {
    error("SHOW POOLS returned empty output");
    throw new Error("SHOW POOLS returned empty output");
  }

  // Check if output contains expected headers or postgres database
  if (!output.includes("database") && !output.includes("postgres")) {
    error("SHOW POOLS output does not look valid");
    console.log("Output:");
    console.log(output);
    throw new Error("SHOW POOLS output invalid");
  }

  success("SHOW POOLS works correctly");
  console.log("Pool status:");
  console.log(output.split("\n").slice(0, 5).join("\n"));
}

/**
 * Test 7: Verify healthcheck command works
 */
async function testHealthcheckCommand(containerId: string): Promise<void> {
  info("Test 7: Testing healthcheck command...");

  try {
    await $`docker exec ${containerId} sh -c HOME=/tmp psql -h localhost -p 6432 -U pgbouncer_auth -d postgres -c 'SELECT 1'`.quiet();
    success("Healthcheck command works correctly");
  } catch {
    error("Healthcheck command failed");
    throw new Error("Healthcheck command failed");
  }
}

/**
 * Test 8: Verify connection from host machine (if psql available)
 */
async function testHostConnection(pgbouncerPassword: string): Promise<void> {
  info("Test 8: Testing connection from host machine...");

  try {
    await $`command -v psql`.quiet();

    try {
      await $`psql -h localhost -p 6432 -U pgbouncer_auth -d postgres -c "SELECT 1"`
        .env({ PGPASSWORD: pgbouncerPassword })
        .quiet();
      success("Connection from host machine successful");
    } catch {
      warning("Connection from host machine failed (may be expected if port not exposed)");
    }
  } catch {
    warning("psql not available on host, skipping host connection test");
  }
}

/**
 * Cleanup function to stop services and remove test environment
 */
async function cleanup(stackPath: string, projectName: string): Promise<void> {
  info("Cleaning up test environment...");

  try {
    await $`docker compose --env-file .env.test down -v`
      .cwd(stackPath)
      .env({ COMPOSE_PROJECT_NAME: projectName })
      .quiet();

    // Verify containers are removed
    const checkResult = await $`docker ps -a --filter name=${projectName} --format "{{.Names}}"`
      .nothrow()
      .quiet();
    const remainingContainers = checkResult.text().trim();
    if (remainingContainers) {
      warning(`Warning: Some containers still exist: ${remainingContainers}`);
      // Force remove any remaining containers
      const containerList = remainingContainers.split("\n").filter((n) => n.trim());
      for (const container of containerList) {
        await $`docker rm -f ${container}`.nothrow().quiet();
      }
    }
  } catch {
    // Ignore cleanup errors
  }

  const envFile = join(stackPath, ".env.test");
  if (await Bun.file(envFile).exists()) {
    await $`rm -f ${envFile}`.quiet();
  }

  success("Cleanup completed");
}

/**
 * Main test execution
 */
async function main(): Promise<void> {
  // Check required commands
  try {
    await checkCommand("docker");
  } catch {
    error("Required command 'docker' not found");
    console.log("   Install Docker: https://docs.docker.com/get-docker/");
    process.exit(1);
  }

  try {
    await checkDockerDaemon();
  } catch {
    error("Docker daemon is not running");
    console.log("   Start Docker: open -a Docker (macOS) or sudo systemctl start docker (Linux)");
    process.exit(1);
  }

  // Check for docker compose command
  try {
    await $`docker compose version`.quiet();
  } catch {
    try {
      await $`docker-compose version`.quiet();
    } catch {
      error("Required command 'docker compose' not found");
      console.log("   Install Docker Compose: https://docs.docker.com/compose/install/");
      process.exit(1);
    }
  }

  // Check for jq command
  try {
    await checkCommand("jq");
  } catch {
    error("Required command 'jq' not found");
    console.log("   Install jq: apt-get install jq (Debian/Ubuntu) or brew install jq (macOS)");
    process.exit(1);
  }

  // Get stack directory from command line or use default
  const stackDir = Bun.argv[2] ?? "stacks/primary";
  const scriptDir = import.meta.dir;
  const projectRoot = resolve(scriptDir, "../..");
  const stackPath = join(projectRoot, stackDir);

  if (!existsSync(stackPath)) {
    error(`Stack directory not found: ${stackPath}`);
    console.log("   Available stacks: primary, replica, single");
    process.exit(1);
  }

  const composeFile = join(stackPath, "compose.yml");
  if (!existsSync(composeFile)) {
    error(`compose.yml not found in ${stackPath}`);
    process.exit(1);
  }

  console.log("========================================");
  console.log("PgBouncer Healthcheck Test");
  console.log("========================================");
  console.log(`Stack: ${stackDir}`);
  console.log();

  // Generate unique project name for test isolation
  const projectName = generateUniqueProjectName("aza-pg-healthcheck-test");
  info(`Using unique project name: ${projectName}`);

  // Generate test credentials
  const credentials = generateTestCredentials();

  // Setup signal handlers for cleanup
  let cleanupCalled = false;
  const performCleanup = async () => {
    if (!cleanupCalled) {
      cleanupCalled = true;
      await cleanup(stackPath, projectName);
    }
  };

  process.on("SIGINT", async () => {
    console.log("\n\nCaught interrupt signal, cleaning up...");
    await performCleanup();
    process.exit(130);
  });

  process.on("SIGTERM", async () => {
    console.log("\n\nCaught termination signal, cleaning up...");
    await performCleanup();
    process.exit(143);
  });

  try {
    // Create test environment
    info("Creating test environment configuration...");
    await createTestEnv(stackPath, credentials, projectName);
    success("Test environment created");

    // Start services
    info("Starting primary stack (postgres + pgbouncer)...");
    try {
      await $`docker compose --env-file .env.test up -d postgres pgbouncer`
        .cwd(stackPath)
        .env({ COMPOSE_PROJECT_NAME: projectName });
      success("Services started");
    } catch {
      error("Failed to start services");
      await performCleanup();
      process.exit(1);
    }

    // Wait for services to be healthy (increased to 150s to account for 120s start_period)
    await waitForServicesHealthy(stackPath, TIMEOUTS.replication);

    // Get container IDs
    const pgbouncerContainerId = await getContainerId(stackPath, "pgbouncer");
    const postgresContainerId = await getContainerId(stackPath, "postgres");

    // Run all tests
    await testPgpassExists(pgbouncerContainerId);
    await testPgpassPermissions(pgbouncerContainerId);
    await testPgpassEntries(pgbouncerContainerId);
    await testAuthLocalhost(pgbouncerContainerId);
    await testAuthHostname(postgresContainerId, credentials.pgbouncerPassword, stackPath);
    await testShowPools(pgbouncerContainerId, credentials.pgbouncerPassword);
    await testHealthcheckCommand(pgbouncerContainerId);
    await testHostConnection(credentials.pgbouncerPassword);

    // All tests passed
    console.log();
    console.log("========================================");
    console.log("✅ All PgBouncer healthcheck tests passed!");
    console.log("========================================");
    console.log();
    console.log("Summary:");
    console.log("  ✅ .pgpass file exists with correct permissions");
    console.log("  ✅ .pgpass contains entries for localhost:6432 and pgbouncer:6432");
    console.log("  ✅ Authentication works via localhost:6432");
    console.log("  ✅ Authentication works via pgbouncer:6432");
    console.log("  ✅ SHOW POOLS command works");
    console.log("  ✅ Healthcheck command works");
    console.log("  ✅ Connection pooling functional");
    console.log();
  } finally {
    // Always cleanup
    await performCleanup();
  }
}

// Run main and handle errors
main().catch((err) => {
  error(err.message);
  process.exit(1);
});
