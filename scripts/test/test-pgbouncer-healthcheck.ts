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
import { join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { TIMEOUTS } from "../config/test-timeouts";
import { getTestDockerConfig, cleanupTestDockerConfig } from "../utils/docker-test-config";

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
  const postgresImage = Bun.env.POSTGRES_IMAGE ?? "ghcr.io/fluxo-kt/aza-pg:pg18";
  // POSTGRES_BIND_IP=0.0.0.0 is required for inter-container communication
  // This sets PostgreSQL's listen_addresses to allow PgBouncer to connect via Docker network
  // Note: This also exposes port to host on all interfaces - acceptable for testing
  const envContent = `POSTGRES_PASSWORD=${credentials.postgresPassword}
PGBOUNCER_AUTH_PASS=${credentials.pgbouncerPassword}
PG_REPLICATION_PASSWORD=${credentials.replicationPassword}
POSTGRES_IMAGE=${postgresImage}
POSTGRES_MEMORY_LIMIT=2g
POSTGRES_BIND_IP=0.0.0.0
COMPOSE_PROJECT_NAME=${projectName}
`;

  const envFile = Bun.file(join(stackPath, ".env.test"));
  await Bun.write(envFile, envContent);

  // Docker Compose v2 always loads .env from cwd before --env-file
  // Create .env copy for CI compatibility (where .env is gitignored and doesn't exist)
  const envFileCopy = Bun.file(join(stackPath, ".env"));
  await Bun.write(envFileCopy, envContent);
}

/**
 * Get service health status from Docker Compose
 */
async function getServiceHealth(
  stackPath: string,
  service: string,
  dockerEnv?: Record<string, string>
): Promise<string> {
  try {
    const cmd = $`docker compose --env-file .env.test ps ${service} --format json`.cwd(stackPath);
    const result = await (dockerEnv ? cmd.env(dockerEnv) : cmd).text();
    const serviceStatus: ServiceStatus = JSON.parse(result);
    return serviceStatus?.Health ?? "starting";
  } catch {
    return "starting";
  }
}

/**
 * Wait for services to be healthy
 */
async function waitForServicesHealthy(
  stackPath: string,
  timeout: number,
  dockerEnv?: Record<string, string>
): Promise<void> {
  info(`Waiting for services to be healthy (max ${timeout} seconds)...`);

  let elapsed = 0;
  let postgresHealthy = false;
  let pgbouncerHealthy = false;
  let lastPostgresStatus = "unknown";
  let lastPgbouncerStatus = "unknown";

  while (elapsed < timeout) {
    lastPostgresStatus = await getServiceHealth(stackPath, "postgres", dockerEnv);
    lastPgbouncerStatus = await getServiceHealth(stackPath, "pgbouncer", dockerEnv);

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
    const logsCmd = $`docker compose --env-file .env.test logs postgres`.cwd(stackPath);
    await (dockerEnv ? logsCmd.env(dockerEnv) : logsCmd);
    throw new Error(
      `PostgreSQL health check failed - timeout after ${timeout}s with status: ${lastPostgresStatus}`
    );
  }

  if (!pgbouncerHealthy) {
    error(`PgBouncer failed to become healthy after ${timeout}s`);
    error(`Last known status: ${lastPgbouncerStatus}`);
    error(`Container: pgbouncer (service in primary stack)`);
    const logsCmd = $`docker compose --env-file .env.test logs pgbouncer`.cwd(stackPath);
    await (dockerEnv ? logsCmd.env(dockerEnv) : logsCmd);
    throw new Error(
      `PgBouncer health check failed - timeout after ${timeout}s with status: ${lastPgbouncerStatus}`
    );
  }

  success("Both services are healthy");
}

/**
 * Get container ID for a service
 */
async function getContainerId(
  stackPath: string,
  service: string,
  dockerEnv?: Record<string, string>
): Promise<string> {
  const cmd = $`docker compose --env-file .env.test ps ${service} -q`.cwd(stackPath);
  const result = await (dockerEnv ? cmd.env(dockerEnv) : cmd).text();
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
 * Test 4: Verify auth_user exists in BOTH userlist.txt AND .pgpass
 */
async function testAuthUserDualFile(containerId: string): Promise<void> {
  info("Test 4: Verifying auth_user exists in both userlist.txt and .pgpass...");

  // Check userlist.txt exists and contains pgbouncer_auth
  try {
    const userlistContent = await $`docker exec ${containerId} cat /tmp/userlist.txt`.text();

    if (!userlistContent.includes("pgbouncer_auth")) {
      error("pgbouncer_auth not found in /tmp/userlist.txt");
      console.log("Userlist content:");
      console.log(userlistContent);
      throw new Error("pgbouncer_auth missing from userlist.txt");
    }
    success("pgbouncer_auth found in userlist.txt");
  } catch (err) {
    if (err instanceof Error && err.message.includes("missing from userlist.txt")) {
      throw err;
    }
    error("/tmp/userlist.txt not found or not readable");
    throw new Error("userlist.txt not accessible");
  }

  // Check .pgpass contains pgbouncer_auth (already verified file exists in Test 1)
  try {
    const pgpassContent = await $`docker exec ${containerId} cat /tmp/.pgpass`.text();

    if (!pgpassContent.includes("pgbouncer_auth")) {
      error("pgbouncer_auth not found in /tmp/.pgpass");
      console.log(".pgpass content:");
      console.log(pgpassContent);
      throw new Error("pgbouncer_auth missing from .pgpass");
    }
    success("pgbouncer_auth found in .pgpass");
  } catch (err) {
    if (err instanceof Error && err.message.includes("missing from .pgpass")) {
      throw err;
    }
    error("/tmp/.pgpass not readable");
    throw new Error(".pgpass not accessible");
  }

  success("auth_user (pgbouncer_auth) exists in BOTH userlist.txt and .pgpass");
}

/**
 * Test 5: Test authentication via localhost:6432
 */
async function testAuthLocalhost(containerId: string): Promise<void> {
  info("Test 5: Testing authentication via localhost:6432...");

  try {
    await $`docker exec ${containerId} sh -c HOME=/tmp psql -h localhost -p 6432 -U pgbouncer_auth -d postgres -c "SELECT 1"`.quiet();
    success("Authentication successful via localhost:6432");
  } catch {
    error("Authentication failed via localhost:6432");
    throw new Error("Authentication failed via localhost:6432");
  }
}

/**
 * Test 6: Test authentication via pgbouncer:6432 from postgres container
 */
async function testAuthHostname(
  postgresContainerId: string,
  pgbouncerPassword: string,
  stackPath: string,
  dockerEnv?: Record<string, string>
): Promise<void> {
  info("Test 6: Testing authentication via pgbouncer:6432...");

  try {
    await $`docker exec ${postgresContainerId} sh -c PGPASSWORD=${pgbouncerPassword} psql -h pgbouncer -p 6432 -U pgbouncer_auth -d postgres -c 'SELECT 1'`.quiet();
    success("Authentication successful via pgbouncer:6432");
  } catch {
    error("Authentication failed via pgbouncer:6432 from postgres container");
    const logsCmd = $`docker compose --env-file .env.test logs pgbouncer`.cwd(stackPath);
    await (dockerEnv ? logsCmd.env(dockerEnv) : logsCmd);
    throw new Error("Authentication failed via pgbouncer:6432");
  }
}

/**
 * Test 7: Verify SHOW POOLS works
 */
async function testShowPools(containerId: string, pgbouncerPassword: string): Promise<void> {
  info("Test 7: Testing SHOW POOLS command...");

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
 * Test 8: Verify healthcheck command works
 */
async function testHealthcheckCommand(containerId: string): Promise<void> {
  info("Test 8: Testing healthcheck command...");

  try {
    await $`docker exec ${containerId} sh -c HOME=/tmp psql -h localhost -p 6432 -U pgbouncer_auth -d postgres -c 'SELECT 1'`.quiet();
    success("Healthcheck command works correctly");
  } catch {
    error("Healthcheck command failed");
    throw new Error("Healthcheck command failed");
  }
}

/**
 * Test 9: Verify connection from host machine (if psql available)
 */
async function testHostConnection(pgbouncerPassword: string): Promise<void> {
  info("Test 9: Testing connection from host machine...");

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
async function cleanup(
  stackPath: string,
  projectName: string,
  dockerEnv?: Record<string, string>,
  testDockerConfig?: string
): Promise<void> {
  info("Cleaning up test environment...");

  try {
    const downCmd = $`docker compose --env-file .env.test down -v`.cwd(stackPath);
    await (
      dockerEnv ? downCmd.env(dockerEnv) : downCmd.env({ COMPOSE_PROJECT_NAME: projectName })
    ).quiet();

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

  // Also remove .env copy created for Docker Compose v2 compatibility
  const envFileCopy = join(stackPath, ".env");
  if (await Bun.file(envFileCopy).exists()) {
    await $`rm -f ${envFileCopy}`.quiet();
  }

  // Cleanup isolated Docker config if created
  await cleanupTestDockerConfig(testDockerConfig);

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

  try {
    const stats = await stat(stackPath);
    if (!stats.isDirectory()) {
      error(`Stack path is not a directory: ${stackPath}`);
      process.exit(1);
    }
  } catch {
    error(`Stack directory not found: ${stackPath}`);
    console.log("   Available stacks: primary, replica, single");
    process.exit(1);
  }

  const composeFile = join(stackPath, "compose.yml");
  if (!(await Bun.file(composeFile).exists())) {
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
      await cleanup(stackPath, projectName, dockerEnv, testDockerConfig);
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

  // Setup isolated Docker config if credential helper unavailable
  const testDockerConfig = await getTestDockerConfig();
  const dockerEnv = testDockerConfig
    ? { ...Bun.env, DOCKER_CONFIG: testDockerConfig, COMPOSE_PROJECT_NAME: projectName }
    : { COMPOSE_PROJECT_NAME: projectName };

  try {
    // Create test environment
    info("Creating test environment configuration...");
    await createTestEnv(stackPath, credentials, projectName);
    success("Test environment created");

    // Pre-pull images to avoid credential issues during compose up
    info("Pre-pulling required images...");
    const postgresImage = Bun.env.POSTGRES_IMAGE ?? "ghcr.io/fluxo-kt/aza-pg:pg18";
    const pgbouncerImage =
      Bun.env.PGBOUNCER_IMAGE ??
      "edoburu/pgbouncer:v1.25.1-p0@sha256:c7bfcaa24de830e29588bb9ad1eb39cebaf07c27149e1974445899b695634bb4";
    await Promise.all([
      $`docker pull ${postgresImage}`.quiet().nothrow(),
      $`docker pull ${pgbouncerImage}`.quiet().nothrow(),
    ]);

    // Start services
    info("Starting primary stack (postgres + pgbouncer)...");
    try {
      await $`docker compose --env-file .env.test up -d postgres pgbouncer`
        .cwd(stackPath)
        .env(dockerEnv);
      success("Services started");
    } catch {
      error("Failed to start services");
      await performCleanup();
      process.exit(1);
    }

    // Wait for services to be healthy (increased to 150s to account for 120s start_period)
    await waitForServicesHealthy(stackPath, TIMEOUTS.replication, dockerEnv);

    // Get container IDs
    const pgbouncerContainerId = await getContainerId(stackPath, "pgbouncer", dockerEnv);
    const postgresContainerId = await getContainerId(stackPath, "postgres", dockerEnv);

    // Run all tests
    await testPgpassExists(pgbouncerContainerId);
    await testPgpassPermissions(pgbouncerContainerId);
    await testPgpassEntries(pgbouncerContainerId);
    await testAuthUserDualFile(pgbouncerContainerId);
    await testAuthLocalhost(pgbouncerContainerId);
    await testAuthHostname(
      postgresContainerId,
      credentials.pgbouncerPassword,
      stackPath,
      dockerEnv
    );
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
    console.log("  ✅ auth_user (pgbouncer_auth) exists in BOTH userlist.txt and .pgpass");
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
