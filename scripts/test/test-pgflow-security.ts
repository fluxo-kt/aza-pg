#!/usr/bin/env bun
/**
 * Test script: Verify pgflow security patches are applied
 * Usage: bun run scripts/test/test-pgflow-security.ts [image-tag]
 *
 * Tests that SECURITY DEFINER functions have SET search_path configured
 * to prevent search_path hijacking attacks (CVE-PGFLOW-001, CVE-PGFLOW-002).
 *
 * Examples:
 *   bun run scripts/test/test-pgflow-security.ts                    # Use default tag
 *   bun run scripts/test/test-pgflow-security.ts my-custom:tag      # Use custom tag
 */

import { $ } from "bun";
import { checkCommand, checkDockerDaemon, dockerCleanup } from "../utils/docker";
import { error, info, success } from "../utils/logger.ts";

// Get image tag from command line args, POSTGRES_IMAGE env var, or use default
const IMAGE_TAG = Bun.argv[2] ?? Bun.env.POSTGRES_IMAGE ?? "ghcr.io/fluxo-kt/aza-pg:pg18";

// Generate random test password at runtime
const TEST_POSTGRES_PASSWORD =
  Bun.env.TEST_POSTGRES_PASSWORD ?? `test_postgres_${Date.now()}_${process.pid}`;

async function main(): Promise<void> {
  // Check prerequisites
  try {
    await checkCommand("docker");
  } catch {
    error("Docker not found");
    console.log("   Install Docker: https://docs.docker.com/get-docker/");
    process.exit(1);
  }

  try {
    await checkDockerDaemon();
  } catch {
    error("Docker daemon not running");
    console.log("   Start Docker: open -a Docker (macOS) or sudo systemctl start docker (Linux)");
    process.exit(1);
  }

  console.log("========================================");
  console.log("pgflow Security Patches Verification");
  console.log("========================================");
  console.log(`Image tag: ${IMAGE_TAG}`);
  console.log();

  info("Starting container with pgflow...");

  // Start container with pgflow
  const containerName = `pgflow-security-test-${process.pid}`;
  try {
    await $`docker run -d --name ${containerName} -e POSTGRES_PASSWORD=${TEST_POSTGRES_PASSWORD} ${IMAGE_TAG}`.quiet();
  } catch {
    error("Failed to start container");
    process.exit(1);
  }

  // Wait for PostgreSQL to be ready (with retries)
  info("Waiting for PostgreSQL to be ready...");
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      await $`docker exec ${containerName} pg_isready -U postgres`.quiet();
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  if (!ready) {
    await dockerCleanup(containerName);
    error("PostgreSQL failed to start within timeout");
    process.exit(1);
  }

  // Wait for pgflow schema AND security patches to be applied (initdb scripts may still be running)
  info("Waiting for pgflow initialization and security patches...");
  let pgflowReady = false;
  for (let i = 0; i < 45; i++) {
    try {
      // Check if patches are applied by looking for search_path configuration
      const result =
        await $`docker exec ${containerName} psql -U postgres -t -c "SELECT proconfig FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'pgflow' AND p.proname = 'get_run_with_states'"`.text();
      if (result.trim().length > 0) {
        pgflowReady = true;
        break;
      }
    } catch {
      // Schema or function doesn't exist yet, keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!pgflowReady) {
    await dockerCleanup(containerName);
    error("pgflow schema or security patches not applied within timeout");
    process.exit(1);
  }

  info("PostgreSQL ready, checking security patches...");
  let testsPassed = true;

  // Check 1: get_run_with_states has search_path set
  try {
    const result1 = await $`docker exec ${containerName} psql -U postgres -t -c "
      SELECT proconfig::text
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'pgflow' AND p.proname = 'get_run_with_states'
    "`.text();

    if (result1.includes("search_path=")) {
      success("✓ get_run_with_states: search_path protection applied");
    } else {
      error("✗ get_run_with_states: MISSING search_path protection (CVE-PGFLOW-001)");
      error(`  Found: ${result1.trim() || "(no configuration)"}`);
      testsPassed = false;
    }
  } catch (err) {
    error(`✗ get_run_with_states: Failed to check configuration - ${err}`);
    testsPassed = false;
  }

  // Check 2: start_flow_with_states has search_path set
  try {
    const result2 = await $`docker exec ${containerName} psql -U postgres -t -c "
      SELECT proconfig::text
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'pgflow' AND p.proname = 'start_flow_with_states'
    "`.text();

    if (result2.includes("search_path=")) {
      success("✓ start_flow_with_states: search_path protection applied");
    } else {
      error("✗ start_flow_with_states: MISSING search_path protection (CVE-PGFLOW-002)");
      error(`  Found: ${result2.trim() || "(no configuration)"}`);
      testsPassed = false;
    }
  } catch (err) {
    error(`✗ start_flow_with_states: Failed to check configuration - ${err}`);
    testsPassed = false;
  }

  await dockerCleanup(containerName);

  console.log();
  console.log("========================================");

  if (testsPassed) {
    success("All security patches verified successfully!");
    process.exit(0);
  } else {
    error("Security patch verification FAILED");
    error("Functions remain vulnerable to search_path hijacking");
    process.exit(1);
  }
}

// Run main function
main();
