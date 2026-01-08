#!/usr/bin/env bun
/**
 * Test script: Validate .pgpass escaping for special characters
 * Usage: bun run scripts/test/test-pgpass-escaping.ts [stack-dir]
 *
 * Tests three scenarios:
 * 1. Password with colon: test:password:123
 * 2. Password with backslash: test\pass\word
 * 3. Password with both: test\:complex:pass\word
 *
 * Examples:
 *   bun run scripts/test/test-pgpass-escaping.ts                      # Use default 'stacks/primary'
 *   bun run scripts/test/test-pgpass-escaping.ts stacks/primary       # Explicit path
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
 * Test scenario configuration
 */
interface TestScenario {
  name: string;
  password: string;
  expectedEscaped: string;
  description: string;
}

/**
 * Test environment credentials with special password
 */
interface TestCredentials {
  pgbouncerPassword: string;
  postgresPassword: string;
  replicationPassword: string;
}

/**
 * Test scenarios for .pgpass escaping
 */
const TEST_SCENARIOS: TestScenario[] = [
  {
    name: "Password with colon",
    password: "test:password:123",
    expectedEscaped: "test\\:password\\:123",
    description: "Colons should be escaped to \\:",
  },
  {
    name: "Password with backslash",
    password: "test\\pass\\word",
    expectedEscaped: "test\\\\pass\\\\word",
    description: "Backslashes should be escaped to \\\\",
  },
  {
    name: "Password with both backslash and colon",
    password: "test\\:complex:pass\\word",
    expectedEscaped: "test\\\\\\:complex\\:pass\\\\word",
    description: "Both should be escaped in correct order (backslash first, then colon)",
  },
];

/**
 * Generate test credentials with special password
 */
function generateTestCredentials(specialPassword: string): TestCredentials {
  const timestamp = Date.now();
  const pid = process.pid;

  return {
    pgbouncerPassword: specialPassword,
    postgresPassword: Bun.env.TEST_POSTGRES_PASSWORD ?? `test_postgres_${timestamp}_${pid}`,
    replicationPassword:
      Bun.env.TEST_REPLICATION_PASSWORD ?? `test_replication_${timestamp}_${pid}`,
  };
}

/**
 * Create test .env file for Docker Compose with special password
 */
async function createTestEnvWithPassword(
  stackPath: string,
  password: string,
  projectName: string
): Promise<void> {
  const postgresImage = Bun.env.POSTGRES_IMAGE ?? "ghcr.io/fluxo-kt/aza-pg:pg18";
  const credentials = generateTestCredentials(password);

  // POSTGRES_BIND_IP=0.0.0.0 is required for inter-container communication
  // This sets PostgreSQL's listen_addresses to allow PgBouncer to connect via Docker network
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
 * Verify .pgpass file contains properly escaped password
 */
async function verifyPgpassEscaping(
  containerId: string,
  password: string,
  expectedEscaped: string
): Promise<void> {
  info("Verifying .pgpass escaping...");

  // Read .pgpass content
  const content = await $`docker exec ${containerId} cat /tmp/.pgpass`.text();

  // Log details for debugging (mask original password in production, show for testing)
  console.log(`   Original password: ${password}`);
  console.log(`   Expected escaped: ${expectedEscaped}`);
  console.log(`   .pgpass content:`);
  content.split("\n").forEach((line) => {
    if (line.trim()) {
      console.log(`      ${line}`);
    }
  });

  // Verify each entry contains the properly escaped password
  const entries = content.trim().split("\n");
  const expectedEntries = [
    `postgres:5432:postgres:pgbouncer_auth:${expectedEscaped}`,
    `localhost:6432:postgres:pgbouncer_auth:${expectedEscaped}`,
    `pgbouncer:6432:postgres:pgbouncer_auth:${expectedEscaped}`,
  ];

  for (const expectedEntry of expectedEntries) {
    if (!entries.includes(expectedEntry)) {
      error(`.pgpass missing or incorrect entry: ${expectedEntry}`);
      error("Actual content:");
      console.log(content);
      throw new Error(`.pgpass escaping verification failed - missing entry: ${expectedEntry}`);
    }
  }

  success(".pgpass contains properly escaped password in all entries");
}

/**
 * Test authentication works via localhost:6432
 */
async function testAuthLocalhost(containerId: string): Promise<void> {
  info("Testing authentication via localhost:6432...");

  try {
    await $`docker exec ${containerId} sh -c HOME=/tmp psql -h localhost -p 6432 -U pgbouncer_auth -d postgres -c "SELECT 1"`.quiet();
    success("Authentication successful via localhost:6432");
  } catch {
    error("Authentication failed via localhost:6432");
    throw new Error("Authentication failed via localhost:6432");
  }
}

/**
 * Test authentication works via pgbouncer:6432 from postgres container
 */
async function testAuthHostname(
  postgresContainerId: string,
  password: string,
  stackPath: string,
  dockerEnv?: Record<string, string>
): Promise<void> {
  info("Testing authentication via pgbouncer:6432...");

  try {
    // Use PGPASSWORD environment variable for authentication
    // Note: Password must be passed as-is (unescaped) when using PGPASSWORD
    await $`docker exec ${postgresContainerId} sh -c PGPASSWORD=${password} psql -h pgbouncer -p 6432 -U pgbouncer_auth -d postgres -c 'SELECT 1'`.quiet();
    success("Authentication successful via pgbouncer:6432");
  } catch {
    error("Authentication failed via pgbouncer:6432 from postgres container");
    const logsCmd = $`docker compose --env-file .env.test logs pgbouncer`.cwd(stackPath);
    await (dockerEnv ? logsCmd.env(dockerEnv) : logsCmd);
    throw new Error("Authentication failed via pgbouncer:6432");
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
 * Run a single test scenario
 */
async function runTestScenario(
  scenario: TestScenario,
  stackPath: string,
  dockerEnv: Record<string, string>
): Promise<void> {
  console.log("\n========================================");
  console.log(`Test Scenario: ${scenario.name}`);
  console.log("========================================");
  console.log(`Description: ${scenario.description}`);
  console.log(`Password: ${scenario.password}`);
  console.log(`Expected escaped: ${scenario.expectedEscaped}`);
  console.log();

  // Generate unique project name for test isolation
  const projectName = generateUniqueProjectName("aza-pg-pgpass-test");
  info(`Using unique project name: ${projectName}`);

  // Update dockerEnv with project name
  const scenarioDockerEnv = { ...dockerEnv, COMPOSE_PROJECT_NAME: projectName };

  // Setup signal handlers for cleanup
  let cleanupCalled = false;
  const performCleanup = async () => {
    if (!cleanupCalled) {
      cleanupCalled = true;
      await cleanup(stackPath, projectName, scenarioDockerEnv, undefined);
    }
  };

  const sigintHandler = async () => {
    console.log("\n\nCaught interrupt signal, cleaning up...");
    await performCleanup();
    process.exit(130);
  };

  const sigtermHandler = async () => {
    console.log("\n\nCaught termination signal, cleaning up...");
    await performCleanup();
    process.exit(143);
  };

  process.on("SIGINT", sigintHandler);
  process.on("SIGTERM", sigtermHandler);

  try {
    // Create test environment
    info("Creating test environment configuration...");
    await createTestEnvWithPassword(stackPath, scenario.password, projectName);
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
        .env(scenarioDockerEnv);
      success("Services started");
    } catch {
      error("Failed to start services");
      await performCleanup();
      throw new Error("Failed to start services");
    }

    // Wait for services to be healthy
    await waitForServicesHealthy(stackPath, TIMEOUTS.replication, scenarioDockerEnv);

    // Get container IDs
    const pgbouncerContainerId = await getContainerId(stackPath, "pgbouncer", scenarioDockerEnv);
    const postgresContainerId = await getContainerId(stackPath, "postgres", scenarioDockerEnv);

    // Run verification tests
    await verifyPgpassEscaping(pgbouncerContainerId, scenario.password, scenario.expectedEscaped);
    await testAuthLocalhost(pgbouncerContainerId);
    await testAuthHostname(postgresContainerId, scenario.password, stackPath, scenarioDockerEnv);

    // Scenario passed
    console.log();
    success(`✅ ${scenario.name} - All checks passed!`);
  } finally {
    // Always cleanup
    await performCleanup();

    // Remove signal handlers
    process.off("SIGINT", sigintHandler);
    process.off("SIGTERM", sigtermHandler);
  }
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
  console.log(".pgpass Escaping Test");
  console.log("========================================");
  console.log(`Stack: ${stackDir}`);
  console.log(`Total scenarios: ${TEST_SCENARIOS.length}`);
  console.log();

  // Setup isolated Docker config if credential helper unavailable
  const testDockerConfig = await getTestDockerConfig();
  const baseDockerEnv = testDockerConfig
    ? { ...Bun.env, DOCKER_CONFIG: testDockerConfig }
    : { ...Bun.env };

  const results: { scenario: string; passed: boolean; error?: string }[] = [];

  // Run all test scenarios sequentially
  for (const scenario of TEST_SCENARIOS) {
    try {
      await runTestScenario(scenario, stackPath, baseDockerEnv as Record<string, string>);
      results.push({ scenario: scenario.name, passed: true });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      error(`Scenario failed: ${scenario.name}`);
      error(`Error: ${errorMessage}`);
      results.push({ scenario: scenario.name, passed: false, error: errorMessage });
    }
  }

  // Print final summary
  console.log();
  console.log("========================================");
  console.log("TEST SUMMARY");
  console.log("========================================");
  console.log();

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  results.forEach((result) => {
    if (result.passed) {
      success(`${result.scenario}`);
    } else {
      error(`${result.scenario}`);
      if (result.error) {
        console.log(`   Error: ${result.error}`);
      }
    }
  });

  console.log();
  console.log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log();

  if (failed > 0) {
    console.log("========================================");
    error(`❌ ${failed} scenario(s) failed`);
    console.log("========================================");
    process.exit(1);
  } else {
    console.log("========================================");
    success("✅ All .pgpass escaping tests passed!");
    console.log("========================================");
    console.log();
    console.log("Summary:");
    console.log("  ✅ Password with colon - escaping verified and authentication works");
    console.log("  ✅ Password with backslash - escaping verified and authentication works");
    console.log("  ✅ Password with both - escaping verified and authentication works");
    console.log();
  }
}

// Run main and handle errors
main().catch((err) => {
  error(err.message);
  process.exit(1);
});
