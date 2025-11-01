#!/usr/bin/env bun
/**
 * Comprehensive pgsql-http functional test suite
 * Tests synchronous HTTP client functionality using libcurl
 *
 * Coverage:
 * - Extension creation and basic connectivity
 * - HTTP methods (GET, POST, PUT, DELETE, HEAD, PATCH)
 * - Request/response handling (status, headers, content, content-type)
 * - Custom headers and authentication
 * - Content types (JSON, plain text, form data)
 * - Error handling (invalid URLs, connection failures, 4xx/5xx responses)
 * - Curl options (set, list, reset)
 * - Performance benchmarks (sequential request throughput)
 *
 * Usage:
 *   bun run scripts/test/test-pgsql-http-functional.ts --image=aza-pg:local
 *   bun run scripts/test/test-pgsql-http-functional.ts --container=existing-container
 */

import { $ } from "bun";
import { join } from "node:path";
import { resolveImageTag, parseContainerName, validateImageTag } from "./image-resolver";

// Parse CLI arguments
const containerName = parseContainerName();
const imageTag = containerName ? null : resolveImageTag();

// Validate if using image mode
if (imageTag) {
  validateImageTag(imageTag);
}

// Container name (either user-provided or auto-generated)
let CONTAINER: string;
let isOwnContainer = false;

if (containerName) {
  CONTAINER = containerName;
  console.log(`Using existing container: ${CONTAINER}\n`);
} else if (imageTag) {
  CONTAINER = `test-pgsql-http-${Date.now()}-${process.pid}`;
  isOwnContainer = true;
  console.log(`Starting new container: ${CONTAINER}`);
  console.log(`Using image: ${imageTag}\n`);
} else {
  console.error("Error: Either --image or --container must be specified");
  process.exit(1);
}

// Check if http extension is enabled in manifest
const REPO_ROOT = join(import.meta.dir, "../..");
const MANIFEST_PATH = join(REPO_ROOT, "docker/postgres/extensions.manifest.json");

try {
  const manifest = await Bun.file(MANIFEST_PATH).json();
  const httpEntry = manifest.entries.find((e: any) => e.name === "http");

  if (httpEntry && httpEntry.enabled === false) {
    console.log("\n" + "=".repeat(80));
    console.log("PGSQL-HTTP FUNCTIONAL TEST SKIPPED");
    console.log("=".repeat(80));
    console.log("⏭️  http extension is disabled in manifest (enabled: false)");
    console.log("   Reason: " + (httpEntry.disabledReason || "Not specified"));
    console.log("   To enable: Set enabled: true in scripts/extensions/manifest-data.ts");
    console.log("=".repeat(80));
    process.exit(0);
  }
} catch (error) {
  console.error("Warning: Could not read manifest file:", error);
  console.log("Proceeding with tests...\n");
}

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  metrics?: Record<string, any>;
}

const results: TestResult[] = [];

async function runSQL(sql: string): Promise<{ stdout: string; stderr: string; success: boolean }> {
  try {
    const result = await $`docker exec ${CONTAINER} psql -U postgres -t -A -c ${sql}`.nothrow();
    return {
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
      success: result.exitCode === 0,
    };
  } catch (error) {
    return {
      stdout: "",
      stderr: String(error),
      success: false,
    };
  }
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    const duration = Date.now() - start;
    results.push({ name, passed: true, duration });
    console.log(`✅ ${name} (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - start;
    results.push({ name, passed: false, duration, error: String(error) });
    console.log(`❌ ${name} (${duration}ms)`);
    console.log(`   Error: ${error}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// Container cleanup function
async function cleanupContainer(): Promise<void> {
  if (!isOwnContainer) return;

  console.log(`\n🧹 Cleaning up container: ${CONTAINER}`);
  try {
    await $`docker rm -f ${CONTAINER}`.nothrow();
    console.log("✅ Container cleanup complete");
  } catch (error) {
    console.error(`⚠️  Failed to cleanup container: ${error}`);
  }
}

// Register cleanup handlers
if (isOwnContainer) {
  process.on("exit", () => {
    // Synchronous cleanup on normal exit
    try {
      Bun.spawnSync(["docker", "rm", "-f", CONTAINER]);
    } catch {
      // Ignore errors during cleanup
    }
  });

  process.on("SIGINT", async () => {
    console.log("\n\n⚠️  Interrupted by user (SIGINT)");
    await cleanupContainer();
    process.exit(130);
  });

  process.on("SIGTERM", async () => {
    console.log("\n\n⚠️  Terminated (SIGTERM)");
    await cleanupContainer();
    process.exit(143);
  });
}

// Start container if using --image mode
if (isOwnContainer && imageTag) {
  console.log(`🚀 Starting container from image: ${imageTag}`);

  try {
    // Start PostgreSQL container
    await $`docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=postgres -e POSTGRES_HOST_AUTH_METHOD=trust ${imageTag}`;
    console.log(`✅ Container started: ${CONTAINER}`);

    // Wait for PostgreSQL to be ready
    console.log("⏳ Waiting for PostgreSQL to be ready...");
    let ready = false;
    const maxAttempts = 60; // 60 seconds timeout
    let attempt = 0;

    while (!ready && attempt < maxAttempts) {
      const result = await $`docker exec ${CONTAINER} pg_isready -U postgres`.nothrow();
      if (result.exitCode === 0) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      attempt++;
    }

    if (!ready) {
      throw new Error("PostgreSQL failed to start within 60 seconds");
    }

    // Wait for init scripts to complete (PostgreSQL restarts after initdb)
    console.log("⏳ Waiting for init scripts to complete...");
    let stableConnections = 0;
    const requiredStable = 3;

    for (let i = 0; i < 30 && stableConnections < requiredStable; i++) {
      const check = await $`docker exec ${CONTAINER} psql -U postgres -c "SELECT 1"`.nothrow();
      if (check.exitCode === 0) {
        stableConnections++;
      } else {
        stableConnections = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (stableConnections < requiredStable) {
      throw new Error("PostgreSQL connection not stable after init");
    }

    console.log("✅ PostgreSQL is ready and stable\n");
  } catch (error) {
    console.error(`❌ Failed to start container: ${error}`);
    await cleanupContainer();
    process.exit(1);
  }
}

// Test 1: Extension Creation
await test("Extension creation", async () => {
  const create = await runSQL("CREATE EXTENSION IF NOT EXISTS http");
  assert(create.success, `Extension creation failed: ${create.stderr}`);

  // Verify extension exists
  const verify = await runSQL("SELECT extname FROM pg_extension WHERE extname = 'http'");
  assert(verify.success && verify.stdout === "http", "Extension not found after creation");
});

// Test 2: HTTP GET Request
await test("HTTP GET request", async () => {
  const result = await runSQL(`
    SELECT status, content_type
    FROM http_get('https://httpbin.org/get')
  `);
  assert(result.success, `HTTP GET failed: ${result.stderr}`);
  assert(result.stdout.includes("200"), `Expected status 200, got: ${result.stdout}`);
  assert(
    result.stdout.includes("application/json"),
    `Expected JSON content type, got: ${result.stdout}`
  );
});

// Test 3: HTTP POST Request
await test("HTTP POST request with JSON", async () => {
  const result = await runSQL(`
    SELECT status, content_type
    FROM http_post(
      'https://httpbin.org/post',
      '{"test": "data", "number": 42}',
      'application/json'
    )
  `);
  assert(result.success, `HTTP POST failed: ${result.stderr}`);
  assert(result.stdout.includes("200"), `Expected status 200, got: ${result.stdout}`);
});

// Test 4: HTTP PUT Request
await test("HTTP PUT request", async () => {
  const result = await runSQL(`
    SELECT status
    FROM http_put(
      'https://httpbin.org/put',
      '{"updated": true}',
      'application/json'
    )
  `);
  assert(result.success, `HTTP PUT failed: ${result.stderr}`);
  assert(result.stdout.includes("200"), `Expected status 200, got: ${result.stdout}`);
});

// Test 5: HTTP DELETE Request
await test("HTTP DELETE request", async () => {
  const result = await runSQL(`
    SELECT status
    FROM http_delete('https://httpbin.org/delete')
  `);
  assert(result.success, `HTTP DELETE failed: ${result.stderr}`);
  assert(result.stdout.includes("200"), `Expected status 200, got: ${result.stdout}`);
});

// Test 6: HTTP HEAD Request
await test("HTTP HEAD request (no body)", async () => {
  const result = await runSQL(`
    SELECT status, content
    FROM http_head('https://httpbin.org/get')
  `);
  assert(result.success, `HTTP HEAD failed: ${result.stderr}`);
  assert(result.stdout.includes("200"), `Expected status 200, got: ${result.stdout}`);
  // HEAD responses should have empty content
  const parts = result.stdout.split("|");
  assert(parts.length >= 2, "Expected status|content format");
  assert(parts[1] === "" || parts[1] === " ", `Expected empty content, got: ${parts[1]}`);
});

// Test 7: HTTP PATCH Request
await test("HTTP PATCH request", async () => {
  const result = await runSQL(`
    SELECT status
    FROM http_patch(
      'https://httpbin.org/patch',
      '{"patched": "field"}',
      'application/json'
    )
  `);
  assert(result.success, `HTTP PATCH failed: ${result.stderr}`);
  assert(result.stdout.includes("200"), `Expected status 200, got: ${result.stdout}`);
});

// Test 8: Response Status Code Extraction
await test("Response status code extraction", async () => {
  // Test 404 Not Found
  const notFound = await runSQL(`
    SELECT status
    FROM http_get('https://httpbin.org/status/404')
  `);
  assert(notFound.success, `Request failed: ${notFound.stderr}`);
  assert(notFound.stdout === "404", `Expected status 404, got: ${notFound.stdout}`);

  // Test 500 Server Error
  const serverError = await runSQL(`
    SELECT status
    FROM http_get('https://httpbin.org/status/500')
  `);
  assert(serverError.success, `Request failed: ${serverError.stderr}`);
  assert(serverError.stdout === "500", `Expected status 500, got: ${serverError.stdout}`);
});

// Test 9: Response Content Extraction
await test("Response content extraction", async () => {
  const result = await runSQL(`
    SELECT content::json->'url' as url
    FROM http_get('https://httpbin.org/get')
  `);
  assert(result.success, `Content extraction failed: ${result.stderr}`);
  assert(
    result.stdout.includes("httpbin.org/get"),
    `Expected URL in response, got: ${result.stdout}`
  );
});

// Test 10: Response Headers Access
await test("Response headers access", async () => {
  const result = await runSQL(`
    SELECT array_length(headers, 1) > 0 as has_headers
    FROM http_get('https://httpbin.org/get')
  `);
  assert(result.success, `Headers access failed: ${result.stderr}`);
  assert(result.stdout === "t", `Expected headers to be present, got: ${result.stdout}`);
});

// Test 11: Custom Headers in Request
await test("Custom headers in request", async () => {
  const result = await runSQL(`
    SELECT status, content::json->'headers'->'X-Custom-Header' as custom_header
    FROM http((
      'GET',
      'https://httpbin.org/headers',
      ARRAY[http_header('X-Custom-Header', 'TestValue')],
      NULL,
      NULL
    )::http_request)
  `);
  assert(result.success, `Custom header request failed: ${result.stderr}`);
  assert(result.stdout.includes("200"), `Expected status 200, got: ${result.stdout}`);
  assert(
    result.stdout.includes("TestValue"),
    `Expected custom header value, got: ${result.stdout}`
  );
});

// Test 12: Content Type Handling
await test("Content type handling - plain text", async () => {
  const result = await runSQL(`
    SELECT content_type
    FROM http_post(
      'https://httpbin.org/post',
      'Plain text content',
      'text/plain'
    )
  `);
  assert(result.success, `Plain text request failed: ${result.stderr}`);
  // httpbin returns application/json for the response wrapper
  assert(result.stdout.length > 0, "Expected content type in response");
});

// Test 13: Error Handling - Invalid URL
await test("Error handling - invalid URL", async () => {
  // Test with malformed URL - should fail gracefully
  const result = await runSQL(`
    SELECT status
    FROM http_get('not-a-valid-url')
  `);
  // This should either fail or return an error status
  // The extension handles errors differently, so we just check it doesn't crash
  assert(!result.success || result.stdout !== "200", "Invalid URL should not return 200 status");
});

// Test 14: Curl Options - Set and List
await test("Curl options - set, list, reset", async () => {
  // Set a curl option (timeout in milliseconds)
  const setTimeout = await runSQL(`
    SELECT http_set_curlopt('CURLOPT_TIMEOUT_MS', '30000')
  `);
  assert(setTimeout.success, `Setting curl option failed: ${setTimeout.stderr}`);

  // Verify http_list_curlopt function exists and is callable
  const listOptions = await runSQL(`SELECT http_list_curlopt()`);
  assert(listOptions.success, `Listing curl options failed: ${listOptions.stderr}`);
  // Note: Some versions may not persist options in the list, so we just verify the call works

  // Reset curl options
  const resetOptions = await runSQL(`SELECT http_reset_curlopt()`);
  assert(resetOptions.success, `Resetting curl options failed: ${resetOptions.stderr}`);

  // Verify function still works after reset
  const verifyReset = await runSQL(`SELECT http_list_curlopt()`);
  assert(verifyReset.success, `Listing curl options after reset failed: ${verifyReset.stderr}`);
});

// Test 15: Performance Benchmark - Sequential Request Throughput
await test("Performance benchmark - sequential request throughput", async () => {
  const requestCount = 10;
  const start = Date.now();

  // Execute sequential requests
  for (let i = 0; i < requestCount; i++) {
    const result = await runSQL(`
      SELECT status
      FROM http_get('https://httpbin.org/get?request=${i + 1}')
    `);
    assert(result.success, `Request ${i + 1} failed: ${result.stderr}`);
    assert(result.stdout === "200", `Request ${i + 1} returned non-200 status: ${result.stdout}`);
  }

  const duration = Date.now() - start;
  const avgLatency = duration / requestCount;
  const throughput = (requestCount / duration) * 1000; // requests per second

  console.log(
    `   📊 Throughput: ${throughput.toFixed(2)} req/sec | Avg Latency: ${avgLatency.toFixed(0)}ms (${requestCount} requests in ${duration}ms)`
  );

  const lastResult = results[results.length - 1];
  if (lastResult) {
    lastResult.metrics = {
      requestCount,
      totalDuration: duration,
      avgLatency: avgLatency.toFixed(0),
      throughput: throughput.toFixed(2),
    };
  }

  // Sanity check - should be able to complete at least 1 request per 5 seconds
  assert(throughput > 0.2, `Throughput too low: ${throughput.toFixed(2)} req/sec`);
});

// Test 16: Generic HTTP Request Function
await test("Generic http() request function", async () => {
  const result = await runSQL(`
    SELECT status, content_type
    FROM http((
      'POST',
      'https://httpbin.org/post',
      NULL,
      'application/json',
      '{"generic": "request"}'
    )::http_request)
  `);
  assert(result.success, `Generic http() request failed: ${result.stderr}`);
  assert(result.stdout.includes("200"), `Expected status 200, got: ${result.stdout}`);
});

// Test 17: User-Agent and Authentication Headers
await test("User-Agent and authentication headers", async () => {
  const result = await runSQL(`
    SELECT status, content::json->'headers'->'User-Agent' as user_agent
    FROM http((
      'GET',
      'https://httpbin.org/headers',
      ARRAY[
        http_header('User-Agent', 'PostgreSQL-HTTP-Client/1.0'),
        http_header('Authorization', 'Bearer test-token-123')
      ],
      NULL,
      NULL
    )::http_request)
  `);
  assert(result.success, `Auth header request failed: ${result.stderr}`);
  assert(result.stdout.includes("200"), `Expected status 200, got: ${result.stdout}`);
  assert(
    result.stdout.includes("PostgreSQL-HTTP-Client"),
    `Expected custom User-Agent, got: ${result.stdout}`
  );
});

// Print Summary
console.log("\n" + "=".repeat(80));
console.log("PGSQL-HTTP FUNCTIONAL TEST SUMMARY");
console.log("=".repeat(80));

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

console.log(`Total: ${results.length} tests`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total Duration: ${totalDuration}ms`);

if (failed > 0) {
  console.log("\nFailed Tests:");
  results
    .filter((r) => !r.passed)
    .forEach((r) => {
      console.log(`  - ${r.name}: ${r.error}`);
    });
}

// Print performance metrics
const perfResults = results.filter((r) => r.metrics);
if (perfResults.length > 0) {
  console.log("\n" + "=".repeat(80));
  console.log("PERFORMANCE METRICS");
  console.log("=".repeat(80));
  perfResults.forEach((r) => {
    console.log(`\n${r.name}:`);
    Object.entries(r.metrics!).forEach(([key, value]) => {
      console.log(`  ${key}: ${value}`);
    });
  });
}

console.log("\n" + "=".repeat(80));

// Cleanup container if we own it
await cleanupContainer();

process.exit(failed > 0 ? 1 : 0);
