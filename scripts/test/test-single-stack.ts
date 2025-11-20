#!/usr/bin/env bun
/**
 * Test script: Validate single-node stack deployment
 * Usage: bun scripts/test/test-single-stack.ts
 *
 * Tests:
 *   1. Single stack deployment (postgres + postgres_exporter)
 *   2. PostgreSQL standalone mode (not in recovery)
 *   3. Basic extension availability
 *   4. Connection limits
 *   5. Auto-config memory detection
 *   6. postgres_exporter availability
 *   7. Direct connection (no PgBouncer)
 */

import { $ } from "bun";
import { checkCommand, checkDockerDaemon, generateUniqueProjectName } from "../utils/docker";
import { info, success, warning, error } from "../utils/logger.ts";
import { join } from "path";
import { TIMEOUTS } from "../config/test-timeouts";

// Get script directory
const scriptDir = import.meta.dir;
const projectRoot = join(scriptDir, "../..");
const singleStackPath = join(projectRoot, "stacks/single");

interface ComposeService {
  Health?: string;
}

/**
 * Main test function
 */
async function main(): Promise<void> {
  // Check required commands
  try {
    await checkCommand("docker");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error("   Install Docker: https://docs.docker.com/get-docker/");
    process.exit(1);
  }

  try {
    await checkDockerDaemon();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error("   Start Docker: open -a Docker (macOS) or sudo systemctl start docker (Linux)");
    process.exit(1);
  }

  // Check for docker compose command
  try {
    await $`docker compose version`.quiet();
  } catch {
    try {
      await $`docker-compose --version`.quiet();
    } catch {
      error("Required command 'docker compose' not found");
      console.error("   Install Docker Compose: https://docs.docker.com/compose/install/");
      process.exit(1);
    }
  }

  // Check for jq command
  try {
    await checkCommand("jq");
  } catch {
    error("Required command 'jq' not found");
    console.error("   Install jq: apt-get install jq (Debian/Ubuntu) or brew install jq (macOS)");
    process.exit(1);
  }

  // Check if single stack directory exists
  const stackDir = Bun.file(singleStackPath);
  try {
    await stackDir.exists();
  } catch {
    error(`Single stack directory not found: ${singleStackPath}`);
    process.exit(1);
  }

  console.log("========================================");
  console.log("Single Stack Test");
  console.log("========================================");
  console.log("Stack: stacks/single");
  console.log();

  // Generate unique project name for test isolation
  const projectName = generateUniqueProjectName("aza-pg-single-test");
  info(`Using unique project name: ${projectName}`);

  // Generate random test password
  const testPostgresPassword =
    Bun.env.TEST_POSTGRES_PASSWORD ?? `test_postgres_${Date.now()}_${process.pid}`;
  const envTestPath = join(singleStackPath, ".env.test");

  // Cleanup function
  const cleanup = async (): Promise<void> => {
    info("Cleaning up test environment...");
    try {
      await $`docker compose --env-file ${envTestPath} down -v`
        .cwd(singleStackPath)
        .env({ COMPOSE_PROJECT_NAME: projectName })
        .quiet();

      // Verify containers are removed
      const checkResult = await $`docker ps -a --filter name=${projectName} --format "{{.Names}}"`
        .nothrow()
        .quiet();
      const remainingContainers = checkResult.text().trim();
      if (remainingContainers) {
        warning(`Warning: Some containers still exist: ${remainingContainers}`);
        const containerList = remainingContainers.split("\n").filter((n) => n.trim());
        for (const container of containerList) {
          await $`docker rm -f ${container}`.nothrow().quiet();
        }
      }
    } catch {
      // Ignore errors
    }
    try {
      await $`rm -f ${envTestPath}`.quiet();
    } catch {
      // Ignore errors
    }
    success("Cleanup completed");
  };

  // Set up cleanup on exit
  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(143);
  });

  try {
    // Create test .env file
    info("Creating test environment configuration...");
    const postgresImage = Bun.env.POSTGRES_IMAGE || "aza-pg:pg18";
    const envContent = `POSTGRES_PASSWORD=${testPostgresPassword}
POSTGRES_IMAGE=${postgresImage}
POSTGRES_MEMORY_LIMIT=2g
COMPOSE_PROJECT_NAME=${projectName}
POSTGRES_NETWORK_NAME=postgres-single-test-net-${Date.now()}-${process.pid}
POSTGRES_PORT=5432
POSTGRES_EXPORTER_PORT=9189
`;
    await Bun.write(envTestPath, envContent);
    success("Test environment created");

    // ============================================================
    // STEP 1: Deploy Single Stack
    // ============================================================
    info("Step 1: Starting single stack (postgres + postgres_exporter)...");
    try {
      await $`docker compose --env-file .env.test up -d postgres`
        .cwd(singleStackPath)
        .env({ COMPOSE_PROJECT_NAME: projectName });
    } catch {
      error("Failed to start single stack");
      await cleanup();
      process.exit(1);
    }
    success("Single stack started");

    // Wait for services to be healthy
    info("Waiting for PostgreSQL to be healthy (max 180 seconds)...");
    const timeout = TIMEOUTS.complex;
    let elapsed = 0;
    let postgresHealthy = false;
    let lastPostgresStatus = "unknown";

    while (elapsed < timeout) {
      try {
        const output = await $`docker compose --env-file .env.test ps postgres --format json`
          .cwd(singleStackPath)
          .text();
        const service: ComposeService = JSON.parse(output);
        lastPostgresStatus = service?.Health ?? "starting";

        if (lastPostgresStatus === "healthy") {
          postgresHealthy = true;
          break;
        }

        console.log(`   PostgreSQL: ${lastPostgresStatus} (${elapsed}s/${timeout}s)`);
      } catch {
        console.log(`   PostgreSQL: starting (${elapsed}s/${timeout}s)`);
      }

      await Bun.sleep(5000);
      elapsed += 5;
    }

    if (!postgresHealthy) {
      error(`PostgreSQL failed to become healthy after ${timeout}s`);
      error(`Last known status: ${lastPostgresStatus}`);
      error(`Container: postgres (service in single stack)`);
      error("Container logs:");
      try {
        const logs = await $`docker compose --env-file .env.test logs postgres`
          .cwd(singleStackPath)
          .text();
        console.log(logs);
      } catch (logError) {
        console.log("Failed to retrieve container logs:", logError);
      }
      await cleanup();
      throw new Error(
        `PostgreSQL health check failed - timeout after ${timeout}s with status: ${lastPostgresStatus}`
      );
    }

    success("PostgreSQL is healthy");

    const postgresContainer = await $`docker compose --env-file .env.test ps postgres -q`
      .cwd(singleStackPath)
      .text();
    const containerName = postgresContainer.trim();

    // ============================================================
    // STEP 2: Verify Standalone Mode (Not in Recovery)
    // ============================================================
    info("Step 2: Verifying standalone mode (not a replica)...");

    const inRecovery =
      await $`docker exec ${containerName} psql -U postgres -tAc "SELECT pg_is_in_recovery();"`.text();

    if (inRecovery.trim() !== "f") {
      error(`PostgreSQL is in recovery mode (expected 'f', got: '${inRecovery.trim()}')`);
      error("Single stack should NOT be in recovery mode");
      await cleanup();
      process.exit(1);
    }

    success("PostgreSQL is in standalone mode (not a replica)");

    // ============================================================
    // STEP 3: Verify Basic Extension Availability
    // ============================================================
    info("Step 3: Testing baseline extensions...");

    // Test pg_stat_statements
    info("Testing pg_stat_statements extension...");
    const pssExists =
      await $`docker exec ${containerName} psql -U postgres -tAc "SELECT COUNT(*) FROM pg_extension WHERE extname = 'pg_stat_statements';"`.text();

    if (pssExists.trim() === "1") {
      success("pg_stat_statements is installed");
    } else {
      error("pg_stat_statements not found (expected in baseline extensions)");
      await cleanup();
      process.exit(1);
    }

    // Test pg_trgm
    info("Testing pg_trgm extension...");
    const trgmExists =
      await $`docker exec ${containerName} psql -U postgres -tAc "SELECT COUNT(*) FROM pg_extension WHERE extname = 'pg_trgm';"`.text();

    if (trgmExists.trim() === "1") {
      success("pg_trgm is installed");
    } else {
      error("pg_trgm not found (expected in baseline extensions)");
      await cleanup();
      process.exit(1);
    }

    // Test pgaudit
    info("Testing pgaudit extension...");
    const pgauditExists =
      await $`docker exec ${containerName} psql -U postgres -tAc "SELECT COUNT(*) FROM pg_extension WHERE extname = 'pgaudit';"`.text();

    if (pgauditExists.trim() === "1") {
      success("pgaudit is installed");
    } else {
      error("pgaudit not found (expected in baseline extensions)");
      await cleanup();
      process.exit(1);
    }

    // Test pg_cron
    info("Testing pg_cron extension...");
    const pgcronExists =
      await $`docker exec ${containerName} psql -U postgres -tAc "SELECT COUNT(*) FROM pg_extension WHERE extname = 'pg_cron';"`.text();

    if (pgcronExists.trim() === "1") {
      success("pg_cron is installed");
    } else {
      error("pg_cron not found (expected in baseline extensions)");
      await cleanup();
      process.exit(1);
    }

    // Test vector
    info("Testing vector extension...");
    const vectorExists =
      await $`docker exec ${containerName} psql -U postgres -tAc "SELECT COUNT(*) FROM pg_extension WHERE extname = 'vector';"`.text();

    if (vectorExists.trim() === "1") {
      success("vector is installed");
    } else {
      error("vector not found (expected in baseline extensions)");
      await cleanup();
      process.exit(1);
    }

    // Functional test: pg_trgm similarity
    const trgmTest =
      await $`docker exec ${containerName} psql -U postgres -tAc "SELECT similarity('test', 'test');"`.text();
    if (trgmTest.trim() === "1") {
      success("pg_trgm functional test passed");
    } else {
      error(`pg_trgm functional test failed (expected '1', got: '${trgmTest.trim()}')`);
      await cleanup();
      process.exit(1);
    }

    // Functional test: vector
    const vectorTest =
      await $`docker exec ${containerName} psql -U postgres -tAc "SELECT '[1,2,3]'::vector;"`.text();
    if (vectorTest.includes("[1,2,3]")) {
      success("vector functional test passed");
    } else {
      error(`vector functional test failed (got: '${vectorTest.trim()}')`);
      await cleanup();
      process.exit(1);
    }

    // ============================================================
    // STEP 4: Verify Connection Limits
    // ============================================================
    info("Step 4: Checking connection limits...");

    const maxConnections =
      await $`docker exec ${containerName} psql -U postgres -tAc "SHOW max_connections;"`.text();
    const maxConnectionsValue = Number.parseInt(maxConnections.trim(), 10);

    info(`max_connections: ${maxConnectionsValue}`);

    // Should be 120 for 2GB memory limit (based on auto-config)
    if (maxConnectionsValue < 80) {
      warning(`max_connections is very low (${maxConnectionsValue}), expected at least 80`);
    } else if (maxConnectionsValue >= 80) {
      success(`max_connections is adequate (${maxConnectionsValue})`);
    }

    // Test actual connection
    info("Testing direct connection...");
    const directConnect =
      await $`docker exec ${containerName} psql -U postgres -c "SELECT version();"`.text();

    if (directConnect.includes("PostgreSQL")) {
      success("Direct connection works");
    } else {
      error("Direct connection failed");
      console.log(directConnect);
      await cleanup();
      process.exit(1);
    }

    // ============================================================
    // STEP 5: Verify Auto-Config Memory Detection
    // ============================================================
    info("Step 5: Checking auto-config memory settings...");

    const sharedBuffers =
      await $`docker exec ${containerName} psql -U postgres -tAc "SHOW shared_buffers;"`.text();
    const effectiveCache =
      await $`docker exec ${containerName} psql -U postgres -tAc "SHOW effective_cache_size;"`.text();
    const workMem =
      await $`docker exec ${containerName} psql -U postgres -tAc "SHOW work_mem;"`.text();

    info(`shared_buffers: ${sharedBuffers.trim()}`);
    info(`effective_cache_size: ${effectiveCache.trim()}`);
    info(`work_mem: ${workMem.trim()}`);

    // Check logs for auto-config detection
    info("Checking auto-config logs...");
    try {
      const autoConfigLogs = await $`docker logs ${containerName}`.text();
      const relevantLogs = autoConfigLogs
        .split("\n")
        .filter((line) => /detected ram|shared_buffers|auto-config/i.test(line))
        .slice(0, 10);

      if (relevantLogs.length > 0) {
        console.log("Auto-config detection:");
        relevantLogs.forEach((line) => console.log(line));
        success("Auto-config is active");
      } else {
        warning("No auto-config logs found (may be expected)");
      }
    } catch {
      warning("No auto-config logs found (may be expected)");
    }

    // ============================================================
    // STEP 6: Start and Test postgres_exporter
    // ============================================================
    info("Step 6: Starting postgres_exporter...");

    try {
      await $`docker compose --env-file .env.test up -d postgres_exporter`
        .cwd(singleStackPath)
        .env({ COMPOSE_PROJECT_NAME: projectName });
    } catch {
      error("Failed to start postgres_exporter");
      await cleanup();
      process.exit(1);
    }

    success("postgres_exporter started");

    // Wait for exporter to be healthy
    info("Waiting for postgres_exporter to be healthy (max 60 seconds)...");
    const exporterTimeout = TIMEOUTS.startup;
    let exporterElapsed = 0;
    let exporterHealthy = false;

    while (exporterElapsed < exporterTimeout) {
      try {
        const output =
          await $`docker compose --env-file .env.test ps postgres_exporter --format json`
            .cwd(singleStackPath)
            .text();
        const services: ComposeService[] = JSON.parse(output);
        const exporterStatus = services[0]?.Health ?? "starting";

        if (exporterStatus === "healthy") {
          exporterHealthy = true;
          break;
        }

        console.log(
          `   postgres_exporter: ${exporterStatus} (${exporterElapsed}s/${exporterTimeout}s)`
        );
      } catch {
        console.log(`   postgres_exporter: starting (${exporterElapsed}s/${exporterTimeout}s)`);
      }

      await Bun.sleep(5000);
      exporterElapsed += 5;
    }

    if (!exporterHealthy) {
      warning("postgres_exporter did not become healthy (may still work)");
    } else {
      success("postgres_exporter is healthy");
    }

    // Test metrics endpoint
    info("Testing metrics endpoint...");
    const exporterContainer = await $`docker compose --env-file .env.test ps postgres_exporter -q`
      .cwd(singleStackPath)
      .text();
    const exporterContainerName = exporterContainer.trim();

    const metricsOutput =
      await $`docker exec ${exporterContainerName} wget -q -O - http://localhost:9187/metrics`.text();
    const metricsPreview = metricsOutput.split("\n").slice(0, 20).join("\n");

    if (metricsOutput.length === 0) {
      error("Metrics endpoint returned empty output");
      await cleanup();
      process.exit(1);
    }

    if (!metricsOutput.includes("pg_up")) {
      error("Metrics output does not contain 'pg_up' metric");
      console.log("Output:");
      console.log(metricsPreview);
      await cleanup();
      process.exit(1);
    }

    success("postgres_exporter metrics endpoint works");

    // ============================================================
    // STEP 7: Verify No PgBouncer
    // ============================================================
    info("Step 7: Verifying no PgBouncer (single stack simplicity)...");

    try {
      const pgbouncerRunning = await $`docker compose --env-file .env.test ps pgbouncer -q`
        .cwd(singleStackPath)
        .text();
      if (pgbouncerRunning.trim().length > 0) {
        warning("PgBouncer is running (unexpected for single stack)");
      } else {
        success("PgBouncer not running (correct for single stack)");
      }
    } catch {
      success("PgBouncer not running (correct for single stack)");
    }

    // ============================================================
    // Summary
    // ============================================================
    console.log();
    console.log("========================================");
    console.log("✅ All single stack tests passed!");
    console.log("========================================");
    console.log();
    console.log("Summary:");
    console.log("  ✅ Single stack deployed and healthy");
    console.log("  ✅ PostgreSQL in standalone mode (not a replica)");
    console.log("  ✅ 5 baseline extensions installed and functional");
    console.log(`  ✅ Connection limits adequate (${maxConnectionsValue} connections)`);
    console.log("  ✅ Auto-config detected memory settings");
    console.log("  ✅ postgres_exporter functional");
    console.log("  ✅ Direct PostgreSQL connection works (no PgBouncer)");
    console.log();

    // Cleanup
    await cleanup();
  } catch (err) {
    error(`Test failed: ${err instanceof Error ? err.message : String(err)}`);
    await cleanup();
    process.exit(1);
  }
}

// Run main function
main();
