#!/usr/bin/env bun
/**
 * Test script: Verify pgflow security patches are applied
 * Usage: bun run scripts/test/test-pgflow-security.ts [image-tag]
 *
 * Tests that SECURITY DEFINER functions have SET search_path configured
 * to prevent search_path hijacking attacks (AZA-PGFLOW-001, AZA-PGFLOW-002).
 *
 * Examples:
 *   bun run scripts/test/test-pgflow-security.ts                    # Use default tag
 *   bun run scripts/test/test-pgflow-security.ts my-custom:tag      # Use custom tag
 */

import { $ } from "bun";
import { TestHarness } from "./harness.ts";
import { error, info, success } from "../utils/logger.ts";

// Get image tag from command line args, POSTGRES_IMAGE env var, or use default
const IMAGE_TAG = Bun.argv[2] ?? Bun.env.POSTGRES_IMAGE ?? "ghcr.io/fluxo-kt/aza-pg:pg18";

const harness = new TestHarness();

async function main(): Promise<void> {
  console.log("========================================");
  console.log("pgflow Security Patches Verification");
  console.log("========================================");
  console.log(`Image tag: ${IMAGE_TAG}`);
  console.log();

  info("Starting container with pgflow...");

  // Start container with pgflow
  const containerName = `pgflow-security-test-${process.pid}`;

  try {
    await $`docker run -d --name ${containerName} -e POSTGRES_PASSWORD=test ${IMAGE_TAG}`.quiet();
  } catch (err) {
    await harness.cleanup(containerName);
    throw new Error(`Failed to start container: ${err}`);
  }

  // Wait for PostgreSQL to be ready
  info("Waiting for PostgreSQL to be ready...");
  await harness.waitForReady(containerName);

  // Wait for pgflow schema AND security patches to be applied
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
    await Bun.sleep(1000);
  }

  if (!pgflowReady) {
    await harness.cleanup(containerName);
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
      success("get_run_with_states: search_path protection applied");
    } else {
      error("get_run_with_states: MISSING search_path protection (AZA-PGFLOW-001)");
      error(`  Found: ${result1.trim() || "(no configuration)"}`);
      testsPassed = false;
    }
  } catch (err) {
    error(`get_run_with_states: Failed to check configuration - ${err}`);
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
      success("start_flow_with_states: search_path protection applied");
    } else {
      error("start_flow_with_states: MISSING search_path protection (AZA-PGFLOW-002)");
      error(`  Found: ${result2.trim() || "(no configuration)"}`);
      testsPassed = false;
    }
  } catch (err) {
    error(`start_flow_with_states: Failed to check configuration - ${err}`);
    testsPassed = false;
  }

  await harness.cleanup(containerName);

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
