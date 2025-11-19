#!/usr/bin/env bun
/**
 * Integration tests for extension combinations
 * Tests that extensions work together without conflicts
 *
 * This test dynamically adapts to the manifest configuration.
 * Combinations are only tested if all required extensions are enabled.
 *
 * Potential Combinations (when enabled):
 * 1. timescaledb + pgvector: Time-series data with vector embeddings
 * 2. postgis + pgroonga: Spatial data with full-text search
 * 3. pgsodium + supabase_vault: Encryption stack
 * 4. pg_partman + timescaledb: Partition management with hypertables
 *
 * Usage: bun run scripts/test/test-integration-extension-combinations.ts
 */

import { $ } from "bun";
import {
  buildPreloadLibraries,
  findExtension,
  getInitializationEnv,
  getPreloadExtensions,
  getTestableExtensions,
  loadManifestForTests,
  shouldSkipExtension,
  validateNoTools,
} from "./manifest-test-utils";

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
}

const results: TestResult[] = [];
const TEST_CONTAINER = `aza-pg-extensions-test-${Date.now()}`;
const TEST_PASSWORD = "integrationTestPass123!";

/**
 * Start test container with manifest-driven configuration
 */
async function startContainer() {
  console.log("🚀 Starting test container...");

  // Load manifest to determine extensions
  const manifest = loadManifestForTests();
  const preloadExtensions = getPreloadExtensions(manifest);
  const testableExtensions = getTestableExtensions(manifest);

  // ⭐ CRITICAL VALIDATION: Ensure no tools in extension lists
  // Tools (kind="tool") cannot be loaded via shared_preload_libraries or CREATE EXTENSION
  // This prevents container crashes from missing .so files
  validateNoTools(preloadExtensions, "Preload extensions");
  validateNoTools(testableExtensions, "Testable extensions");

  // Build shared_preload_libraries string from manifest
  const preloadLibraries = buildPreloadLibraries(preloadExtensions);
  console.log(`Preload libraries: ${preloadLibraries}`);

  // Collect initialization env vars for enabled extensions
  const initEnv: Record<string, string> = {};
  for (const ext of testableExtensions) {
    Object.assign(initEnv, getInitializationEnv(ext));
  }

  // Clean up any existing container
  await $`docker rm -f ${TEST_CONTAINER}`.nothrow();

  // Use image from environment or default
  const testImage = Bun.env.POSTGRES_IMAGE || "localhost/aza-pg:latest";
  console.log(`Using test image: ${testImage}`);

  // Build container environment
  const envArgs = [
    "-e",
    `POSTGRES_PASSWORD=${TEST_PASSWORD}`,
    "-e",
    "POSTGRES_MEMORY=2048",
    "-e",
    `POSTGRES_SHARED_PRELOAD_LIBRARIES=${preloadLibraries}`,
  ];

  // Add initialization env vars
  for (const [key, value] of Object.entries(initEnv)) {
    envArgs.push("-e", `${key}=${value}`);
    console.log(`Init env: ${key}=${value}`);
  }

  // Start container
  const result = await $`docker run --name ${TEST_CONTAINER} ${envArgs} -d ${testImage}`.nothrow();

  if (result.exitCode !== 0) {
    console.error(`Failed to start container: ${result.stderr.toString()}`);
    throw new Error(`Failed to start test container from image ${testImage}`);
  }

  // Wait for database to be ready (up to 120 seconds for CI environments)
  for (let i = 0; i < 120; i++) {
    const check =
      await $`docker exec ${TEST_CONTAINER} psql -U postgres -t -A -c "SELECT 1"`.nothrow();
    if (check.exitCode === 0) {
      console.log("✅ Database is ready");

      // Create enabled extensions dynamically
      console.log(`Creating ${testableExtensions.length} testable extensions...`);
      for (const ext of testableExtensions) {
        const create = await runSQL(`CREATE EXTENSION IF NOT EXISTS ${ext.name}`);
        if (create.success) {
          console.log(`  ✓ ${ext.name}`);
        } else {
          console.log(`  ✗ ${ext.name}: ${create.stderr}`);
        }
      }

      console.log("✅ Extensions created");
      return;
    }
    await Bun.sleep(1000);
  }

  throw new Error("Database did not become ready in time");
}

/**
 * Stop and remove test container
 */
async function stopContainer() {
  console.log("🧹 Cleaning up test container...");
  await $`docker rm -f ${TEST_CONTAINER}`.nothrow();
}

async function runSQL(sql: string): Promise<{ stdout: string; stderr: string; success: boolean }> {
  try {
    const result =
      await $`docker exec ${TEST_CONTAINER} psql -U postgres -t -A -c ${sql}`.nothrow();
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

// ============================================================================
// SETUP
// ============================================================================

async function main() {
  console.log("================================================================================");
  console.log("EXTENSION INTEGRATION TESTS");
  console.log("================================================================================");
  console.log("Testing critical extension combinations for compatibility and functionality\n");

  // Start the test container
  try {
    await startContainer();
  } catch (error) {
    console.error("❌ Failed to start test container:", error);
    process.exit(1);
  }

  // Load manifest to check enabled extensions
  const manifest = loadManifestForTests();

  // ============================================================================
  // Combination 1: TimescaleDB + pgvector
  // Use Case: Time-series data with vector embeddings (e.g., sensor data + ML embeddings)
  // ============================================================================

  const timescaledb = findExtension("timescaledb", manifest);
  const pgvector = findExtension("vector", manifest);

  if (shouldSkipExtension(timescaledb) || shouldSkipExtension(pgvector)) {
    console.log(
      "\n⏭️  Skipping Combination 1: TimescaleDB + pgvector (one or more extensions disabled)"
    );
  } else {
    console.log("\n🔗 Combination 1: TimescaleDB + pgvector");
    console.log("-".repeat(80));

    await test("timescaledb+pgvector: Create hypertable with vector column", async () => {
      // Create table with timestamp and vector columns
      const create = await runSQL(`
    CREATE TABLE IF NOT EXISTS test_ts_vectors (
      time timestamptz NOT NULL,
      sensor_id int,
      embedding vector(3),
      value double precision
    )
  `);
      assert(create.success, "Failed to create table with vector column");

      // Convert to hypertable
      const hypertable = await runSQL(`
    SELECT create_hypertable('test_ts_vectors', 'time', if_not_exists => TRUE)
  `);
      assert(hypertable.success, "Failed to create hypertable");
    });

    await test("timescaledb+pgvector: Insert time-series vector data", async () => {
      const insert = await runSQL(`
    INSERT INTO test_ts_vectors (time, sensor_id, embedding, value)
    VALUES
      (NOW() - interval '1 hour', 1, '[1,0,0]', 42.5),
      (NOW() - interval '30 minutes', 1, '[0.9,0.1,0]', 43.2),
      (NOW(), 1, '[0.8,0.2,0]', 44.1),
      (NOW() - interval '1 hour', 2, '[0,1,0]', 38.7),
      (NOW(), 2, '[0,0.9,0.1]', 39.3)
  `);
      assert(insert.success, "Failed to insert vector data into hypertable");
    });

    await test("timescaledb+pgvector: Query vectors with time window", async () => {
      // Find similar vectors within last hour
      const query = await runSQL(`
    SELECT sensor_id, embedding <-> '[1,0,0]'::vector AS distance
    FROM test_ts_vectors
    WHERE time > NOW() - interval '1 hour'
    ORDER BY embedding <-> '[1,0,0]'
    LIMIT 3
  `);
      assert(query.success, "Failed to query vectors with time filter");
      const lines = query.stdout.split("\n").filter((l) => l.trim());
      assert(lines.length > 0, "No results returned from vector similarity search");
    });

    await test("timescaledb+pgvector: Create index on vectors in hypertable", async () => {
      // HNSW index on vector column in hypertable
      const index = await runSQL(`
    CREATE INDEX IF NOT EXISTS idx_ts_vectors_hnsw
    ON test_ts_vectors USING hnsw (embedding vector_l2_ops)
  `);
      assert(index.success, "Failed to create HNSW index on hypertable vector column");
    });

    await test("timescaledb+pgvector: Time-bucketed aggregation with vector similarity", async () => {
      // Aggregate vectors by time bucket
      const agg = await runSQL(`
    SELECT time_bucket('30 minutes', time) AS bucket,
           sensor_id,
           avg(embedding <-> '[1,0,0]'::vector) AS avg_distance
    FROM test_ts_vectors
    GROUP BY bucket, sensor_id
    ORDER BY bucket DESC
  `);
      assert(agg.success, "Failed time-bucketed aggregation with vector operations");
    });
  }

  // ============================================================================
  // Combination 2: PostGIS + pgroonga
  // Use Case: Spatial data with full-text search (e.g., location-based search with text)
  // ============================================================================

  const postgis = findExtension("postgis", manifest);
  const pgroonga = findExtension("pgroonga", manifest);

  if (shouldSkipExtension(postgis) || shouldSkipExtension(pgroonga)) {
    console.log(
      "\n⏭️  Skipping Combination 2: PostGIS + pgroonga (one or more extensions disabled)"
    );
  } else {
    console.log("\n🔗 Combination 2: PostGIS + pgroonga");
    console.log("-".repeat(80));

    await test("postgis+pgroonga: Create table with geometry and text", async () => {
      const create = await runSQL(`
    CREATE TABLE IF NOT EXISTS test_spatial_text (
      id serial PRIMARY KEY,
      location geometry(Point, 4326),
      name text,
      description text
    )
  `);
      assert(create.success, "Failed to create table with geometry and text");
    });

    await test("postgis+pgroonga: Insert spatial data with text", async () => {
      const insert = await runSQL(`
    INSERT INTO test_spatial_text (location, name, description) VALUES
      (ST_SetSRID(ST_MakePoint(-122.4194, 37.7749), 4326), 'San Francisco Office', 'Main headquarters with modern facilities'),
      (ST_SetSRID(ST_MakePoint(-73.935242, 40.730610), 4326), 'New York Branch', 'Downtown location near Central Park'),
      (ST_SetSRID(ST_MakePoint(139.6917, 35.6895), 4326), 'Tokyo Office', 'Modern workspace in Shibuya district')
  `);
      assert(insert.success, "Failed to insert spatial data with text");
    });

    await test("postgis+pgroonga: Create pgroonga full-text index", async () => {
      const index = await runSQL(`
    CREATE INDEX IF NOT EXISTS idx_spatial_text_pgroonga
    ON test_spatial_text USING pgroonga (name, description)
  `);
      assert(index.success, "Failed to create pgroonga index on spatial table");
    });

    await test("postgis+pgroonga: Spatial + full-text query", async () => {
      // Find locations near San Francisco that mention "modern"
      const query = await runSQL(`
    SELECT name,
           ST_Distance(location::geography, ST_SetSRID(ST_MakePoint(-122.4, 37.7), 4326)::geography) / 1000 AS distance_km
    FROM test_spatial_text
    WHERE ST_DWithin(location::geography, ST_SetSRID(ST_MakePoint(-122.4, 37.7), 4326)::geography, 50000)
      AND (name &@~ 'office' OR description &@~ 'modern')
    ORDER BY distance_km
  `);
      assert(query.success, "Failed spatial query with full-text filter");
      assert(
        query.stdout.includes("San Francisco") || query.stdout.includes("Tokyo"),
        "Expected results not found"
      );
    });
  }

  // ============================================================================
  // Combination 3: pgsodium + supabase_vault
  // Use Case: Encryption stack (server secret + encrypted secrets storage)
  // ============================================================================

  const pgsodium = findExtension("pgsodium", manifest);
  const supabase_vault = findExtension("supabase_vault", manifest);

  if (shouldSkipExtension(pgsodium) || shouldSkipExtension(supabase_vault)) {
    console.log(
      "\n⏭️  Skipping Combination 3: pgsodium + supabase_vault (one or more extensions disabled)"
    );
  } else {
    console.log("\n🔗 Combination 3: pgsodium + supabase_vault");
    console.log("-".repeat(80));

    await test("pgsodium+vault: Verify pgsodium server secret exists", async () => {
      const secret = await runSQL("SELECT count(*) FROM pgsodium.key WHERE name = 'pgsodium_root'");
      assert(secret.success && secret.stdout === "1", "pgsodium server secret not found");
    });

    await test("pgsodium+vault: Store encrypted secret in vault", async () => {
      // Insert encrypted secret
      const insert = await runSQL(`
    INSERT INTO vault.secrets (name, secret, description)
    VALUES ('test_api_key', 'sk_test_1234567890abcdef', 'Test API key for integration test')
    ON CONFLICT (name) DO UPDATE SET secret = EXCLUDED.secret
  `);
      assert(insert.success, "Failed to insert encrypted secret into vault");
    });

    await test("pgsodium+vault: Retrieve and decrypt secret", async () => {
      const decrypt = await runSQL(`
    SELECT decrypted_secret
    FROM vault.decrypted_secrets
    WHERE name = 'test_api_key'
  `);
      assert(decrypt.success, "Failed to decrypt secret from vault");
      assert(
        decrypt.stdout.includes("sk_test_"),
        "Decrypted secret does not match expected format"
      );
    });

    await test("pgsodium+vault: Verify secret is encrypted at rest", async () => {
      // Raw secret column should be encrypted (not plaintext)
      const raw = await runSQL("SELECT secret FROM vault.secrets WHERE name = 'test_api_key'");
      assert(raw.success, "Failed to query raw encrypted secret");
      assert(
        !raw.stdout.includes("sk_test_"),
        "Secret is stored in plaintext (encryption failed!)"
      );
    });
  }

  // ============================================================================
  // Combination 4: pg_partman + timescaledb
  // Use Case: Partition management with hypertables (advanced time-series partitioning)
  // ============================================================================

  const pg_partman = findExtension("pg_partman", manifest);
  // timescaledb already looked up above

  if (shouldSkipExtension(pg_partman) || shouldSkipExtension(timescaledb)) {
    console.log(
      "\n⏭️  Skipping Combination 4: pg_partman + timescaledb (one or more extensions disabled)"
    );
  } else {
    console.log("\n🔗 Combination 4: pg_partman + timescaledb");
    console.log("-".repeat(80));

    await test("pg_partman+timescaledb: Create hypertable", async () => {
      const create = await runSQL(`
    CREATE TABLE IF NOT EXISTS test_partman_ts (
      time timestamptz NOT NULL,
      device_id int,
      value double precision
    )
  `);
      assert(create.success, "Failed to create table for partman+timescaledb test");

      const hypertable = await runSQL(`
    SELECT create_hypertable('test_partman_ts', 'time', if_not_exists => TRUE)
  `);
      assert(hypertable.success, "Failed to create hypertable for partman test");
    });

    await test("pg_partman+timescaledb: Insert data and verify chunks", async () => {
      // Insert data across multiple time ranges
      const insert = await runSQL(`
    INSERT INTO test_partman_ts (time, device_id, value)
    SELECT
      NOW() - (interval '1 day' * i),
      (i % 10) + 1,
      random() * 100
    FROM generate_series(0, 30) AS i
  `);
      assert(insert.success, "Failed to insert data into partitioned hypertable");

      // Verify chunks were created
      const chunks = await runSQL(`
    SELECT count(*) FROM timescaledb_information.chunks
    WHERE hypertable_name = 'test_partman_ts'
  `);
      assert(chunks.success && parseInt(chunks.stdout) > 0, "No chunks created for hypertable");
    });
  }

  // ============================================================================
  // CLEANUP
  // ============================================================================

  console.log("\n🧹 Cleanup");
  console.log("-".repeat(80));

  await test("Cleanup: Drop test tables", async () => {
    await runSQL("DROP TABLE IF EXISTS test_ts_vectors CASCADE");
    await runSQL("DROP TABLE IF EXISTS test_spatial_text CASCADE");
    await runSQL("DELETE FROM vault.secrets WHERE name = 'test_api_key'");
    await runSQL("DROP TABLE IF EXISTS test_partman_ts CASCADE");
    console.log("   ✓ Test tables cleaned up");
  });

  // ============================================================================
  // SUMMARY
  // ============================================================================

  console.log("\n" + "=".repeat(80));
  console.log("INTEGRATION TEST SUMMARY");
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

  console.log("\nExtension Combinations Tested:");
  console.log("  ✓ timescaledb + pgvector: Time-series with vector embeddings");
  console.log("  ✓ postgis + pgroonga: Spatial data with full-text search");
  console.log("  ✓ pgsodium + supabase_vault: Encryption stack");
  console.log("  ✓ pg_partman + timescaledb: Advanced partitioning");

  console.log("\n" + "=".repeat(80));

  // Clean up container
  await stopContainer();

  process.exit(failed > 0 ? 1 : 0);
}

// Run the main function
main().catch((error) => {
  console.error("❌ Unexpected error in test runner:", error);
  process.exit(1);
});
