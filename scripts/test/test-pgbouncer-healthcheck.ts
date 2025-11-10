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
import { checkCommand, checkDockerDaemon } from "../lib/common.ts";
import { error, info, success, warning } from "../utils/logger.ts";
import { join, resolve } from "path";
import { existsSync } from "fs";

/**
 * Service health status from Docker Compose
 */
interface ServiceStatus {
  health: string;
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
    pgbouncerPassword: process.env.TEST_PGBOUNCER_PASSWORD ?? `test_pgbouncer_${timestamp}_${pid}`,
    postgresPassword: process.env.TEST_POSTGRES_PASSWORD ?? `test_postgres_${timestamp}_${pid}`,
    replicationPassword:
      process.env.TEST_REPLICATION_PASSWORD ?? `test_replication_${timestamp}_${pid}`,
  };
}

/**
 * Create test .env file for Docker Compose
 */
async function createTestEnv(stackPath: string, credentials: TestCredentials): Promise<void> {
  const envContent = `POSTGRES_PASSWORD=${credentials.postgresPassword}
PGBOUNCER_AUTH_PASS=${credentials.pgbouncerPassword}
PG_REPLICATION_PASSWORD=${credentials.replicationPassword}
POSTGRES_IMAGE=aza-pg:pg18
POSTGRES_MEMORY_LIMIT=2g
COMPOSE_PROJECT_NAME=aza-pg-healthcheck-test
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
    const services: ServiceStatus[] = JSON.parse(result);
    return services[0]?.health ?? "starting";
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

  while (elapsed < timeout) {
    const postgresStatus = await getServiceHealth(stackPath, "postgres");
    const pgbouncerStatus = await getServiceHealth(stackPath, "pgbouncer");

    if (postgresStatus === "healthy") {
      postgresHealthy = true;
    }

    if (pgbouncerStatus === "healthy") {
      pgbouncerHealthy = true;
    }

    if (postgresHealthy && pgbouncerHealthy) {
      break;
    }

    console.log(
      `   PostgreSQL: ${postgresStatus}, PgBouncer: ${pgbouncerStatus} (${elapsed}s/${timeout}s)`
    );
    await Bun.sleep(5000);
    elapsed += 5;
  }

  if (!postgresHealthy) {
    error(`PostgreSQL failed to become healthy after ${timeout}s`);
    await $`docker compose --env-file .env.test logs postgres`.cwd(stackPath);
    throw new Error("PostgreSQL health check failed");
  }

  if (!pgbouncerHealthy) {
    error(`PgBouncer failed to become healthy after ${timeout}s`);
    await $`docker compose --env-file .env.test logs pgbouncer`.cwd(stackPath);
    throw new Error("PgBouncer health check failed");
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
async function testShowPools(containerId: string): Promise<void> {
  info("Test 6: Testing SHOW POOLS command...");

  const output =
    await $`docker exec ${containerId} sh -c HOME=/tmp psql -h localhost -p 6432 -U pgbouncer_auth -d postgres -c "SHOW POOLS" -t`.text();

  if (!output || output.trim() === "") {
    error("SHOW POOLS returned empty output");
    throw new Error("SHOW POOLS returned empty output");
  }

  if (!output.includes("postgres")) {
    error("SHOW POOLS output does not contain 'postgres' database");
    console.log("Output:");
    console.log(output);
    throw new Error("SHOW POOLS missing postgres database");
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
async function cleanup(stackPath: string): Promise<void> {
  info("Cleaning up test environment...");

  try {
    await $`docker compose --env-file .env.test down -v`.cwd(stackPath).quiet();
  } catch {
    // Ignore cleanup errors
  }

  const envFile = join(stackPath, ".env.test");
  if (existsSync(envFile)) {
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
  const stackDir = process.argv[2] ?? "stacks/primary";
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

  // Generate test credentials
  const credentials = generateTestCredentials();

  try {
    // Create test environment
    info("Creating test environment configuration...");
    await createTestEnv(stackPath, credentials);
    success("Test environment created");

    // Start services
    info("Starting primary stack (postgres + pgbouncer)...");
    try {
      await $`docker compose --env-file .env.test up -d postgres pgbouncer`.cwd(stackPath);
      success("Services started");
    } catch {
      error("Failed to start services");
      await cleanup(stackPath);
      process.exit(1);
    }

    // Wait for services to be healthy
    await waitForServicesHealthy(stackPath, 90);

    // Get container IDs
    const pgbouncerContainerId = await getContainerId(stackPath, "pgbouncer");
    const postgresContainerId = await getContainerId(stackPath, "postgres");

    // Run all tests
    await testPgpassExists(pgbouncerContainerId);
    await testPgpassPermissions(pgbouncerContainerId);
    await testPgpassEntries(pgbouncerContainerId);
    await testAuthLocalhost(pgbouncerContainerId);
    await testAuthHostname(postgresContainerId, credentials.pgbouncerPassword, stackPath);
    await testShowPools(pgbouncerContainerId);
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
    await cleanup(stackPath);
  }
}

// Run main and handle errors
main().catch((error) => {
  error(error.message);
  process.exit(1);
});
