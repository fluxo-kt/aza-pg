#!/usr/bin/env bun
/**
 * Comprehensive extension test suite
 * Tests extensions dynamically from manifest-data.ts
 *
 * Usage: bun run scripts/test/test-extensions.ts [--image=aza-pg:phase1-fix]
 */

import { $ } from "bun";
import { MANIFEST_ENTRIES as manifest } from "../extensions/manifest-data.js";

const IMAGE = Bun.argv.find((arg) => arg.startsWith("--image="))?.split("=")[1] || "aza-pg:pg18";
const CONTAINER_NAME = `pg-test-${Date.now()}`;

interface ExtensionTest {
  name: string;
  category: string;
  createSQL: string;
  testSQL?: string; // Optional functional test
  expectError?: boolean; // Some extensions may not be creatable directly
}

// Generate test cases from manifest
const EXTENSIONS: ExtensionTest[] = manifest
  .filter((ext) => ext.kind === "extension" || ext.kind === "builtin")
  .map((ext) => ({
    name: ext.name,
    category: ext.category,
    createSQL:
      ext.kind === "builtin" && !["btree_gin", "btree_gist", "pg_trgm"].includes(ext.name)
        ? "" // Builtin extensions that don't need CREATE EXTENSION
        : `CREATE EXTENSION IF NOT EXISTS ${ext.name} CASCADE`,
    testSQL: `SELECT * FROM pg_extension WHERE extname = '${ext.name}'`,
  }));

async function startContainer(): Promise<void> {
  console.log(`Starting container ${CONTAINER_NAME}...`);
  await $`docker run -d --name ${CONTAINER_NAME} \
    --platform linux/amd64 \
    -e POSTGRES_PASSWORD=test \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    ${IMAGE}`.quiet();

  // Wait for PostgreSQL to be ready
  console.log("Waiting for PostgreSQL to be ready...");
  let retries = 30;
  while (retries > 0) {
    try {
      await $`docker exec ${CONTAINER_NAME} pg_isready -U postgres`.quiet();
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      retries--;
    }
  }

  if (retries === 0) {
    throw new Error("PostgreSQL failed to start");
  }

  console.log("PostgreSQL ready!\n");
}

async function stopContainer(): Promise<void> {
  console.log(`\nStopping and removing container ${CONTAINER_NAME}...`);
  await $`docker rm -f ${CONTAINER_NAME}`.quiet();
}

async function testExtension(
  ext: ExtensionTest,
  maxRetries = 3
): Promise<{ success: boolean; error?: string }> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Create extension if needed
      if (ext.createSQL) {
        const result =
          await $`docker exec ${CONTAINER_NAME} psql -U postgres -c ${ext.createSQL}`.nothrow();
        if (result.exitCode !== 0) {
          const error = result.stderr.toString();
          // Retry on transient connection/startup errors
          if (
            attempt < maxRetries &&
            (error.includes("shutting down") ||
              error.includes("starting up") ||
              error.includes("No such file or directory") ||
              error.includes("Connection refused"))
          ) {
            await new Promise((resolve) => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
            continue;
          }
          return { success: false, error };
        }
      }

      // Run functional test if provided
      if (ext.testSQL) {
        const result =
          await $`docker exec ${CONTAINER_NAME} psql -U postgres -c ${ext.testSQL}`.nothrow();
        if (result.exitCode !== 0) {
          const error = result.stderr.toString();
          // Retry on transient connection/startup errors
          if (
            attempt < maxRetries &&
            (error.includes("shutting down") ||
              error.includes("starting up") ||
              error.includes("No such file or directory") ||
              error.includes("Connection refused"))
          ) {
            await new Promise((resolve) => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
            continue;
          }
          return { success: false, error };
        }
      }

      return { success: true };
    } catch (error) {
      const errorStr = String(error);
      // Retry on transient errors
      if (
        attempt < maxRetries &&
        (errorStr.includes("shutting down") ||
          errorStr.includes("starting up") ||
          errorStr.includes("No such file or directory") ||
          errorStr.includes("Connection refused"))
      ) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
        continue;
      }
      return { success: false, error: errorStr };
    }
  }

  return { success: false, error: "Max retries exceeded" };
}

async function main() {
  console.log(`Testing extensions in image: ${IMAGE}\n`);

  try {
    await startContainer();

    const results: Map<string, { success: boolean; error?: string }> = new Map();
    let passed = 0;
    let failed = 0;

    for (const ext of EXTENSIONS) {
      process.stdout.write(`Testing ${ext.name.padEnd(25)} [${ext.category}]...`.padEnd(60));
      const result = await testExtension(ext);
      results.set(ext.name, result);

      if (result.success) {
        console.log("✅ PASS");
        passed++;
      } else {
        console.log("❌ FAIL");
        console.log(`  Error: ${result.error?.split("\n")[0]}`);
        failed++;
      }
    }

    console.log("\n" + "=".repeat(80));
    console.log(`SUMMARY: ${passed}/${EXTENSIONS.length} passed, ${failed} failed`);
    console.log("=".repeat(80));

    if (failed === 0) {
      console.log("\n🎉 All extensions working!");
      process.exit(0);
    } else {
      console.log("\n❌ Some extensions failed. Review output above.");
      process.exit(1);
    }
  } finally {
    await stopContainer();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
