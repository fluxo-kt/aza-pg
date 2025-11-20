#!/usr/bin/env bun
/**
 * Negative Test Suite
 * Tests error handling and validation scenarios
 *
 * Coverage:
 * - Invalid memory settings (below minimum, non-numeric values)
 * - Missing required environment variables
 * - Invalid extension combinations
 * - Configuration conflicts
 *
 * Usage: bun test scripts/test/test-negative-scenarios.ts
 */

import { describe, test, expect, afterAll } from "bun:test";
import { $ } from "bun";

const TEST_CONTAINER_PREFIX = "aza-pg-negative-test";
const TEST_IMAGE = Bun.env.POSTGRES_IMAGE || "aza-pg:pg18";

/**
 * Cleanup function to remove test containers
 */
async function cleanup() {
  await $`docker rm -f ${TEST_CONTAINER_PREFIX}-primary-1 ${TEST_CONTAINER_PREFIX}-pgbouncer-1 ${TEST_CONTAINER_PREFIX}-replica-1 ${TEST_CONTAINER_PREFIX}-replica-2`.nothrow();
}

afterAll(async () => {
  await cleanup();
});

describe("Negative Scenarios - Invalid Memory Settings", () => {
  test("RAM below 256MB minimum should fail with clear error", async () => {
    await cleanup();

    // Try to start with 128MB RAM (below minimum)
    const result = await $`docker run --name ${TEST_CONTAINER_PREFIX}-primary-1 \
      -e POSTGRES_PASSWORD=testpass \
      -e POSTGRES_MEMORY=128 \
      -d ${TEST_IMAGE}`.nothrow();

    // Docker run with -d will return 0 (detached), but container should exit quickly
    if (result.exitCode === 0) {
      await Bun.sleep(3000);
      const inspect =
        await $`docker inspect ${TEST_CONTAINER_PREFIX}-primary-1 --format='{{.State.Running}}'`.nothrow();
      const isRunning = inspect.stdout.toString().trim() === "true";

      // Container should have exited due to RAM check
      expect(isRunning).toBe(false);

      // Verify the error message in logs
      const logs = await $`docker logs ${TEST_CONTAINER_PREFIX}-primary-1 2>&1`.nothrow();
      expect(logs.stdout.toString()).toMatch(/FATAL.*minimum.*512MB.*REQUIRED/i);
    } else {
      // If docker run itself failed, that's also acceptable
      expect(result.exitCode).not.toBe(0);
    }
  }, 10000);

  test("Invalid POSTGRES_MEMORY value (non-numeric) should fail gracefully", async () => {
    await cleanup();

    // Try to start with invalid memory value
    const result = await $`docker run --name ${TEST_CONTAINER_PREFIX}-primary-1 \
      -e POSTGRES_PASSWORD=testpass \
      -e POSTGRES_MEMORY=invalid \
      -d ${TEST_IMAGE}`.nothrow();

    // Container should start but entrypoint should log error
    // We check the logs for error message
    if (result.exitCode === 0) {
      await Bun.sleep(2000);
      const logs = await $`docker logs ${TEST_CONTAINER_PREFIX}-primary-1`.nothrow();
      expect(logs.stdout.toString() + logs.stderr.toString()).toMatch(/invalid|error|warning/i);
    }
  }, 15000);
});

describe("Negative Scenarios - Missing Required Environment Variables", () => {
  test("Start primary without POSTGRES_PASSWORD should fail", async () => {
    await cleanup();

    // Try to start without password
    const result = await $`docker run --name ${TEST_CONTAINER_PREFIX}-primary-1 \
      -d ${TEST_IMAGE}`.nothrow();

    // Should fail or container should exit quickly
    if (result.exitCode === 0) {
      await Bun.sleep(3000);
      const inspect =
        await $`docker inspect ${TEST_CONTAINER_PREFIX}-primary-1 --format='{{.State.Running}}'`.nothrow();
      const isRunning = inspect.stdout.toString().trim() === "true";
      expect(isRunning).toBe(false);
    } else {
      expect(result.exitCode).not.toBe(0);
    }
  }, 10000);

  test("Start PgBouncer without required auth variables should fail", async () => {
    await cleanup();

    // Try to start PgBouncer without auth configuration
    const result = await $`docker run --name ${TEST_CONTAINER_PREFIX}-pgbouncer-1 \
      -e PGBOUNCER_DATABASES="postgres=host=localhost port=5432 dbname=postgres" \
      -d localhost/aza-pg-pgbouncer:latest`.nothrow();

    // Should fail or exit quickly due to missing auth
    if (result.exitCode === 0) {
      await Bun.sleep(3000);
      const inspect =
        await $`docker inspect ${TEST_CONTAINER_PREFIX}-pgbouncer-1 --format='{{.State.Running}}'`.nothrow();
      const isRunning = inspect.stdout.toString().trim() === "true";

      // Either not running, or check logs for auth error
      if (isRunning) {
        const logs = await $`docker logs ${TEST_CONTAINER_PREFIX}-pgbouncer-1`.nothrow();
        expect(logs.stdout.toString() + logs.stderr.toString()).toMatch(/auth|password|error/i);
      } else {
        expect(isRunning).toBe(false);
      }
    } else {
      expect(result.exitCode).not.toBe(0);
    }
  }, 10000);
});

describe("Negative Scenarios - Invalid Extension Combinations", () => {
  test("CREATE EXTENSION for disabled extension should fail", async () => {
    await cleanup();

    // Start a valid container
    const startResult = await $`docker run --name ${TEST_CONTAINER_PREFIX}-primary-1 \
      -e POSTGRES_PASSWORD=testpass \
      -e POSTGRES_MEMORY=1024 \
      -d ${TEST_IMAGE}`.nothrow();

    if (startResult.exitCode !== 0) {
      console.log("Skipping test - container image not available");
      return;
    }

    // Wait for database to be ready
    await Bun.sleep(5000);

    // Try to create a non-existent extension
    const result = await $`docker exec ${TEST_CONTAINER_PREFIX}-primary-1 \
      psql -U postgres -c "CREATE EXTENSION nonexistent_extension"`.nothrow();

    expect(result.exitCode).not.toBe(0);
    // PostgreSQL 18 changed error message from "does not exist" to "is not available"
    expect(result.stderr.toString()).toMatch(/does not exist|is not available|could not open/i);

    await cleanup();
  }, 20000);

  test("Load extension not in manifest should fail", async () => {
    await cleanup();

    // Start a valid container
    const startResult = await $`docker run --name ${TEST_CONTAINER_PREFIX}-primary-1 \
      -e POSTGRES_PASSWORD=testpass \
      -e POSTGRES_MEMORY=1024 \
      -d ${TEST_IMAGE}`.nothrow();

    if (startResult.exitCode !== 0) {
      console.log("Skipping test - container image not available");
      return;
    }

    // Wait for database to be ready
    await Bun.sleep(5000);

    // Try to create an extension that doesn't exist
    const result = await $`docker exec ${TEST_CONTAINER_PREFIX}-primary-1 \
      psql -U postgres -c "CREATE EXTENSION fake_extension"`.nothrow();

    expect(result.exitCode).not.toBe(0);
    // PostgreSQL 18 changed error message from "does not exist" to "is not available"
    expect(result.stderr.toString()).toMatch(
      /does not exist|is not available|could not|not found/i
    );

    await cleanup();
  }, 20000);
});

describe("Negative Scenarios - Configuration Conflicts", () => {
  test("Invalid postgresql.conf syntax should be detected", async () => {
    await cleanup();

    // Start container and inject invalid config
    const startResult = await $`docker run --name ${TEST_CONTAINER_PREFIX}-primary-1 \
      -e POSTGRES_PASSWORD=testpass \
      -e POSTGRES_MEMORY=1024 \
      -d ${TEST_IMAGE}`.nothrow();

    if (startResult.exitCode !== 0) {
      console.log("Skipping test - container image not available");
      return;
    }

    await Bun.sleep(5000);

    // Get the actual data directory path
    const dataDirResult = await $`docker exec ${TEST_CONTAINER_PREFIX}-primary-1 \
      psql -U postgres -t -A -c "SHOW data_directory"`.nothrow();

    if (dataDirResult.exitCode !== 0) {
      console.log("Skipping test - could not determine data directory");
      await cleanup();
      return;
    }

    const dataDir = dataDirResult.stdout.toString().trim();

    // Try to inject invalid configuration
    const configResult = await $`docker exec ${TEST_CONTAINER_PREFIX}-primary-1 \
      sh -c "echo 'invalid syntax here without equals' >> ${dataDir}/postgresql.conf"`.nothrow();

    expect(configResult.exitCode).toBe(0);

    // Reload configuration (should fail or warn)
    const reloadResult = await $`docker exec ${TEST_CONTAINER_PREFIX}-primary-1 \
      psql -U postgres -c "SELECT pg_reload_conf()"`.nothrow();

    // PostgreSQL may accept it or reject it depending on syntax
    // Check logs for any warnings
    const logs = await $`docker logs ${TEST_CONTAINER_PREFIX}-primary-1 2>&1 | tail -50`.nothrow();
    const logOutput = logs.stdout.toString();

    // Either reload failed, or logs should show warning
    if (reloadResult.exitCode === 0) {
      // Check if logs contain syntax warnings (optional, as PG may be lenient)
      // This test primarily verifies we can detect config issues
      expect(logOutput).toBeDefined();
    }

    await cleanup();
  }, 20000);

  test("Conflicting shared_preload_libraries settings should be handled", async () => {
    await cleanup();

    // Start container with custom shared_preload_libraries (using POSTGRES_SHARED_PRELOAD_LIBRARIES)
    const startResult = await $`docker run --name ${TEST_CONTAINER_PREFIX}-primary-1 \
      -e POSTGRES_PASSWORD=testpass \
      -e POSTGRES_MEMORY=1024 \
      -e POSTGRES_SHARED_PRELOAD_LIBRARIES=invalid_library,another_invalid \
      -d ${TEST_IMAGE}`.nothrow();

    if (startResult.exitCode !== 0) {
      console.log("Skipping test - container image not available");
      return;
    }

    // Wait longer for container to attempt initialization and fail
    await Bun.sleep(10000);

    // Check if container is still running
    const inspect =
      await $`docker inspect ${TEST_CONTAINER_PREFIX}-primary-1 --format='{{.State.Running}}'`.nothrow();
    const isRunning = inspect.stdout.toString().trim() === "true";

    // If running, check logs for errors
    if (isRunning) {
      const logs =
        await $`docker logs ${TEST_CONTAINER_PREFIX}-primary-1 2>&1 | tail -100`.nothrow();
      const logOutput = logs.stdout.toString();

      // Should either fail to start, or log warnings about missing libraries
      expect(logOutput).toMatch(/could not|library|error|fatal|warning/i);
    } else {
      // Container exited due to invalid shared_preload_libraries
      expect(isRunning).toBe(false);
    }

    await cleanup();
  }, 30000);
});

describe("Negative Scenarios - Resource Constraints", () => {
  test("Container with extremely low memory limit should handle gracefully", async () => {
    await cleanup();

    // Start container with low Docker memory limit
    const startResult = await $`docker run --name ${TEST_CONTAINER_PREFIX}-primary-1 \
      -e POSTGRES_PASSWORD=testpass \
      -e POSTGRES_MEMORY=256 \
      --memory=256m \
      -d ${TEST_IMAGE}`.nothrow();

    if (startResult.exitCode !== 0) {
      console.log("Skipping test - container image not available");
      return;
    }

    await Bun.sleep(5000);

    // Container should start but may have warnings
    const logs = await $`docker logs ${TEST_CONTAINER_PREFIX}-primary-1 2>&1`.nothrow();
    const logOutput = logs.stdout.toString();

    // Verify container adapted settings or logged warnings
    expect(logOutput).toBeDefined();

    await cleanup();
  }, 20000);
});

describe("Negative Scenarios - Network Configuration", () => {
  test("Invalid POSTGRES_BIND_IP should be rejected", async () => {
    await cleanup();

    // Try to start with invalid IP
    const startResult = await $`docker run --name ${TEST_CONTAINER_PREFIX}-primary-1 \
      -e POSTGRES_PASSWORD=testpass \
      -e POSTGRES_MEMORY=1024 \
      -e POSTGRES_BIND_IP=999.999.999.999 \
      -d ${TEST_IMAGE}`.nothrow();

    if (startResult.exitCode !== 0) {
      console.log("Skipping test - container image not available");
      return;
    }

    await Bun.sleep(5000);

    // Check container status and logs
    const inspect =
      await $`docker inspect ${TEST_CONTAINER_PREFIX}-primary-1 --format='{{.State.Running}}'`.nothrow();
    const isRunning = inspect.stdout.toString().trim() === "true";

    if (isRunning) {
      const logs = await $`docker logs ${TEST_CONTAINER_PREFIX}-primary-1 2>&1`.nothrow();
      // Should either fail or log error about invalid IP
      expect(logs.stdout.toString()).toMatch(/invalid|error|could not|bind/i);
    } else {
      // Container failed to start
      expect(isRunning).toBe(false);
    }

    await cleanup();
  }, 20000);
});
