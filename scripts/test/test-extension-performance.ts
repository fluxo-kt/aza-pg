#!/usr/bin/env bun
/**
 * Extension Performance Benchmark Suite
 * Measures performance impact of key extensions
 *
 * Tests:
 * - Query execution time (with/without extension features)
 * - Memory overhead
 * - Index performance
 * - Throughput benchmarks
 *
 * Usage: bun run scripts/test/test-extension-performance.ts [--image=aza-pg:latest]
 */

import { $ } from "bun";

const IMAGE =
  Bun.argv.find((arg) => arg.startsWith("--image="))?.split("=")[1] || "aza-pg:bitcode-cleanup";
const CONTAINER_NAME = `pg-perf-${Date.now()}`;
const DB_NAME = "perf_test";

interface BenchmarkResult {
  extension: string;
  test: string;
  executionTimeMs: number;
  rowsProcessed: number;
  throughputPerSec: number;
  memoryUsedMB?: number;
  notes?: string;
}

const results: BenchmarkResult[] = [];

async function startContainer(): Promise<void> {
  console.log(`\n📦 Starting container ${CONTAINER_NAME}...`);
  await $`docker run -d --name ${CONTAINER_NAME} \
    --platform linux/amd64 \
    -e POSTGRES_PASSWORD=test \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    -e POSTGRES_MEMORY=2048 \
    --memory=2g \
    ${IMAGE}`.quiet();

  console.log("⏳ Waiting for PostgreSQL to be ready...");
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

  console.log("✅ PostgreSQL ready!\n");
}

async function stopContainer(): Promise<void> {
  console.log(`\n🛑 Stopping and removing container ${CONTAINER_NAME}...`);
  await $`docker rm -f ${CONTAINER_NAME}`.quiet();
}

async function execSQL(sql: string, quiet = false): Promise<string> {
  const result =
    await $`docker exec ${CONTAINER_NAME} psql -U postgres -d ${DB_NAME} -t -A -c ${sql}`.text();
  if (!quiet) {
    console.log(`   SQL: ${sql.substring(0, 80)}${sql.length > 80 ? "..." : ""}`);
  }
  return result.trim();
}

async function execSQLTimed(sql: string, description: string): Promise<number> {
  const start = performance.now();
  await execSQL(sql, true);
  const end = performance.now();
  const duration = end - start;
  console.log(`   ${description}: ${duration.toFixed(2)}ms`);
  return duration;
}

async function getMemoryUsage(): Promise<number> {
  const result = await execSQL("SELECT pg_size_pretty(pg_database_size(current_database()))", true);
  const match = result.match(/(\d+)\s*MB/);
  return match ? parseInt(match[1]) : 0;
}

// ==========================
// Benchmark: pgvector
// ==========================
async function benchmarkPgVector(): Promise<void> {
  console.log("\n🔬 Benchmarking pgvector (vector similarity search)...");

  await execSQL("CREATE EXTENSION IF NOT EXISTS vector CASCADE");

  // Create test table with 10k vectors (768 dimensions, common for embeddings)
  console.log("   Creating 10,000 768-dimensional vectors...");
  await execSQL(`
    CREATE TABLE IF NOT EXISTS embeddings (
      id SERIAL PRIMARY KEY,
      embedding vector(768)
    )
  `);

  const insertTime = await execSQLTimed(
    `
    INSERT INTO embeddings (embedding)
    SELECT array_agg(random())::vector(768)
    FROM generate_series(1, 10000), generate_series(1, 768)
    GROUP BY generate_series
  `,
    "Insert 10k vectors"
  );

  results.push({
    extension: "pgvector",
    test: "Insert 10,000 768-dim vectors",
    executionTimeMs: insertTime,
    rowsProcessed: 10000,
    throughputPerSec: 10000 / (insertTime / 1000),
  });

  // Test similarity search without index
  const searchTime = await execSQLTimed(
    `
    SELECT id, embedding <-> '[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1.0,${Array(758).fill(0.5).join(",")}]'::vector AS distance
    FROM embeddings
    ORDER BY distance
    LIMIT 10
  `,
    "Similarity search (no index)"
  );

  results.push({
    extension: "pgvector",
    test: "Similarity search (no index, 10k vectors)",
    executionTimeMs: searchTime,
    rowsProcessed: 10,
    throughputPerSec: 10 / (searchTime / 1000),
    notes: "Sequential scan",
  });

  // Create HNSW index
  const indexTime = await execSQLTimed(
    `
    CREATE INDEX ON embeddings USING hnsw (embedding vector_cosine_ops)
  `,
    "Create HNSW index"
  );

  results.push({
    extension: "pgvector",
    test: "Create HNSW index (10k vectors)",
    executionTimeMs: indexTime,
    rowsProcessed: 10000,
    throughputPerSec: 10000 / (indexTime / 1000),
  });

  // Test similarity search with index
  const indexedSearchTime = await execSQLTimed(
    `
    SELECT id, embedding <-> '[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1.0,${Array(758).fill(0.5).join(",")}]'::vector AS distance
    FROM embeddings
    ORDER BY distance
    LIMIT 10
  `,
    "Similarity search (with index)"
  );

  results.push({
    extension: "pgvector",
    test: "Similarity search (HNSW index, 10k vectors)",
    executionTimeMs: indexedSearchTime,
    rowsProcessed: 10,
    throughputPerSec: 10 / (indexedSearchTime / 1000),
    notes: `${(searchTime / indexedSearchTime).toFixed(2)}x faster than no index`,
  });

  await execSQL("DROP TABLE embeddings");
}

// ==========================
// Benchmark: TimescaleDB
// ==========================
async function benchmarkTimescaleDB(): Promise<void> {
  console.log("\n🔬 Benchmarking timescaledb (time-series data)...");

  await execSQL("CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE");

  // Create hypertable with 100k time-series rows
  console.log("   Creating 100,000 time-series rows...");
  await execSQL(`
    CREATE TABLE IF NOT EXISTS metrics (
      time TIMESTAMPTZ NOT NULL,
      device_id INT,
      temperature DOUBLE PRECISION,
      humidity DOUBLE PRECISION
    )
  `);

  await execSQL(`SELECT create_hypertable('metrics', 'time', if_not_exists => TRUE)`);

  const insertTime = await execSQLTimed(
    `
    INSERT INTO metrics (time, device_id, temperature, humidity)
    SELECT
      NOW() - (random() * INTERVAL '30 days'),
      (random() * 100)::INT,
      (random() * 40) + 10,
      (random() * 100)
    FROM generate_series(1, 100000)
  `,
    "Insert 100k time-series rows"
  );

  results.push({
    extension: "timescaledb",
    test: "Insert 100k time-series rows",
    executionTimeMs: insertTime,
    rowsProcessed: 100000,
    throughputPerSec: 100000 / (insertTime / 1000),
  });

  // Test time-bucket aggregation
  const aggregationTime = await execSQLTimed(
    `
    SELECT
      time_bucket('1 hour', time) AS hour,
      device_id,
      AVG(temperature) AS avg_temp,
      MAX(humidity) AS max_humidity
    FROM metrics
    WHERE time > NOW() - INTERVAL '7 days'
    GROUP BY hour, device_id
    ORDER BY hour DESC
    LIMIT 100
  `,
    "Time-bucket aggregation (7 days)"
  );

  results.push({
    extension: "timescaledb",
    test: "Time-bucket aggregation (100k rows, 7 days)",
    executionTimeMs: aggregationTime,
    rowsProcessed: 100,
    throughputPerSec: 100 / (aggregationTime / 1000),
  });

  await execSQL("DROP TABLE metrics CASCADE");
}

// ==========================
// Benchmark: PostGIS
// ==========================
async function benchmarkPostGIS(): Promise<void> {
  console.log("\n🔬 Benchmarking postgis (geospatial queries)...");

  await execSQL("CREATE EXTENSION IF NOT EXISTS postgis CASCADE");

  // Create 10k random points
  console.log("   Creating 10,000 geospatial points...");
  await execSQL(`
    CREATE TABLE IF NOT EXISTS locations (
      id SERIAL PRIMARY KEY,
      name TEXT,
      geom GEOMETRY(Point, 4326)
    )
  `);

  const insertTime = await execSQLTimed(
    `
    INSERT INTO locations (name, geom)
    SELECT
      'Location ' || i,
      ST_SetSRID(ST_MakePoint(
        (random() * 360) - 180,
        (random() * 180) - 90
      ), 4326)
    FROM generate_series(1, 10000) AS i
  `,
    "Insert 10k geospatial points"
  );

  results.push({
    extension: "postgis",
    test: "Insert 10k geospatial points",
    executionTimeMs: insertTime,
    rowsProcessed: 10000,
    throughputPerSec: 10000 / (insertTime / 1000),
  });

  // Distance search without index
  const distanceSearchTime = await execSQLTimed(
    `
    SELECT id, name, ST_Distance(geom, ST_SetSRID(ST_MakePoint(0, 0), 4326)) AS distance
    FROM locations
    ORDER BY distance
    LIMIT 10
  `,
    "Distance search (no index)"
  );

  results.push({
    extension: "postgis",
    test: "Distance search (no index, 10k points)",
    executionTimeMs: distanceSearchTime,
    rowsProcessed: 10,
    throughputPerSec: 10 / (distanceSearchTime / 1000),
  });

  // Create spatial index
  const indexTime = await execSQLTimed(
    `
    CREATE INDEX ON locations USING GIST (geom)
  `,
    "Create GIST spatial index"
  );

  results.push({
    extension: "postgis",
    test: "Create GIST index (10k points)",
    executionTimeMs: indexTime,
    rowsProcessed: 10000,
    throughputPerSec: 10000 / (indexTime / 1000),
  });

  // Distance search with index
  const indexedSearchTime = await execSQLTimed(
    `
    SELECT id, name
    FROM locations
    WHERE ST_DWithin(geom, ST_SetSRID(ST_MakePoint(0, 0), 4326), 10)
    LIMIT 100
  `,
    "Distance search (with index)"
  );

  results.push({
    extension: "postgis",
    test: "Distance search (GIST index, 10k points)",
    executionTimeMs: indexedSearchTime,
    rowsProcessed: 100,
    throughputPerSec: 100 / (indexedSearchTime / 1000),
  });

  await execSQL("DROP TABLE locations");
}

// ==========================
// Benchmark: pg_jsonschema
// ==========================
async function benchmarkPgJsonSchema(): Promise<void> {
  console.log("\n🔬 Benchmarking pg_jsonschema (JSON validation)...");

  await execSQL("CREATE EXTENSION IF NOT EXISTS pg_jsonschema CASCADE");

  const schema = `{
    "type": "object",
    "properties": {
      "name": {"type": "string"},
      "age": {"type": "number", "minimum": 0},
      "email": {"type": "string", "format": "email"}
    },
    "required": ["name", "age"]
  }`;

  // Validate 1000 JSON documents
  const validationTime = await execSQLTimed(
    `
    SELECT json_matches_schema(
      '${schema}',
      '{"name": "John Doe", "age": 30, "email": "john@example.com"}'
    )
    FROM generate_series(1, 1000)
  `,
    "Validate 1000 JSON documents"
  );

  results.push({
    extension: "pg_jsonschema",
    test: "JSON schema validation (1000 docs)",
    executionTimeMs: validationTime,
    rowsProcessed: 1000,
    throughputPerSec: 1000 / (validationTime / 1000),
  });
}

// ==========================
// Benchmark: pgroonga (Full-Text Search)
// ==========================
async function benchmarkPgroonga(): Promise<void> {
  console.log("\n🔬 Benchmarking pgroonga (full-text search)...");

  await execSQL("CREATE EXTENSION IF NOT EXISTS pgroonga CASCADE");

  // Create test table with 10k text documents
  console.log("   Creating 10,000 text documents...");
  await execSQL(`
    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY,
      title TEXT,
      content TEXT
    )
  `);

  const insertTime = await execSQLTimed(
    `
    INSERT INTO documents (title, content)
    SELECT
      'Document ' || i,
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' ||
      'This is document number ' || i || '. ' ||
      'It contains various words for full-text search testing. ' ||
      repeat('Sample text for search. ', 10)
    FROM generate_series(1, 10000) AS i
  `,
    "Insert 10k text documents"
  );

  results.push({
    extension: "pgroonga",
    test: "Insert 10k text documents",
    executionTimeMs: insertTime,
    rowsProcessed: 10000,
    throughputPerSec: 10000 / (insertTime / 1000),
  });

  // Create PGroonga index
  const indexTime = await execSQLTimed(
    `
    CREATE INDEX ON documents USING pgroonga (content)
  `,
    "Create PGroonga FTS index"
  );

  results.push({
    extension: "pgroonga",
    test: "Create PGroonga index (10k docs)",
    executionTimeMs: indexTime,
    rowsProcessed: 10000,
    throughputPerSec: 10000 / (indexTime / 1000),
  });

  // Full-text search
  const searchTime = await execSQLTimed(
    `
    SELECT id, title
    FROM documents
    WHERE content &@~ 'search testing'
    LIMIT 100
  `,
    "Full-text search (PGroonga)"
  );

  results.push({
    extension: "pgroonga",
    test: "Full-text search (10k docs)",
    executionTimeMs: searchTime,
    rowsProcessed: 100,
    throughputPerSec: 100 / (searchTime / 1000),
  });

  await execSQL("DROP TABLE documents");
}

// ==========================
// Benchmark: pg_cron
// ==========================
async function benchmarkPgCron(): Promise<void> {
  console.log("\n🔬 Benchmarking pg_cron (job scheduling)...");

  await execSQL("CREATE EXTENSION IF NOT EXISTS pg_cron CASCADE");

  // Create test job
  const scheduleTime = await execSQLTimed(
    `
    SELECT cron.schedule('test-job', '*/5 * * * *', \\$\\$ SELECT 1 \\$\\$)
  `,
    "Schedule cron job"
  );

  results.push({
    extension: "pg_cron",
    test: "Schedule cron job",
    executionTimeMs: scheduleTime,
    rowsProcessed: 1,
    throughputPerSec: 1 / (scheduleTime / 1000),
  });

  // Query jobs
  const queryTime = await execSQLTimed(
    `
    SELECT count(*) FROM cron.job
  `,
    "Query cron jobs"
  );

  results.push({
    extension: "pg_cron",
    test: "Query cron jobs table",
    executionTimeMs: queryTime,
    rowsProcessed: 1,
    throughputPerSec: 1 / (queryTime / 1000),
  });

  // Cleanup
  await execSQL("SELECT cron.unschedule('test-job')");
}

// ==========================
// Memory Overhead Analysis
// ==========================
async function analyzeMemoryOverhead(): Promise<void> {
  console.log("\n🔬 Analyzing extension memory overhead...");

  const baselineMemory = await getMemoryUsage();
  console.log(`   Baseline database size: ${baselineMemory}MB`);

  // Create extensions and measure memory growth
  const extensions = ["pg_stat_statements", "vector", "timescaledb", "postgis", "pgroonga"];

  for (const ext of extensions) {
    await execSQL(`CREATE EXTENSION IF NOT EXISTS ${ext} CASCADE`);
    const memoryAfter = await getMemoryUsage();
    const overhead = memoryAfter - baselineMemory;
    console.log(`   ${ext}: +${overhead}MB overhead`);

    results.push({
      extension: ext,
      test: "Memory overhead (extension only)",
      executionTimeMs: 0,
      rowsProcessed: 0,
      throughputPerSec: 0,
      memoryUsedMB: overhead,
    });
  }
}

// ==========================
// Main Execution
// ==========================
async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════");
  console.log("   Extension Performance Benchmark Suite");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`Image: ${IMAGE}`);
  console.log(`Container: ${CONTAINER_NAME}`);
  console.log(`Memory Limit: 2GB`);
  console.log("═══════════════════════════════════════════════════════\n");

  try {
    await startContainer();

    // Create test database
    await $`docker exec ${CONTAINER_NAME} createdb -U postgres ${DB_NAME}`.quiet();

    // Run benchmarks
    await benchmarkPgVector();
    await benchmarkTimescaleDB();
    await benchmarkPostGIS();
    await benchmarkPgJsonSchema();
    await benchmarkPgroonga();
    await benchmarkPgCron();
    await analyzeMemoryOverhead();

    // Print results
    console.log("\n═══════════════════════════════════════════════════════");
    console.log("   BENCHMARK RESULTS");
    console.log("═══════════════════════════════════════════════════════\n");

    const groupedResults = results.reduce(
      (acc, r) => {
        if (!acc[r.extension]) acc[r.extension] = [];
        acc[r.extension].push(r);
        return acc;
      },
      {} as Record<string, BenchmarkResult[]>
    );

    for (const [ext, extResults] of Object.entries(groupedResults)) {
      console.log(`\n📊 ${ext.toUpperCase()}`);
      console.log("─".repeat(60));

      for (const result of extResults) {
        console.log(`   ${result.test}`);
        console.log(`     ⏱  Execution Time: ${result.executionTimeMs.toFixed(2)}ms`);
        if (result.rowsProcessed > 0) {
          console.log(`     📈 Throughput: ${result.throughputPerSec.toFixed(0)} ops/sec`);
        }
        if (result.memoryUsedMB !== undefined) {
          console.log(`     💾 Memory Used: ${result.memoryUsedMB}MB`);
        }
        if (result.notes) {
          console.log(`     ℹ️  ${result.notes}`);
        }
        console.log("");
      }
    }

    // Summary statistics
    console.log("\n═══════════════════════════════════════════════════════");
    console.log("   SUMMARY");
    console.log("═══════════════════════════════════════════════════════\n");

    const avgTime = results.reduce((sum, r) => sum + r.executionTimeMs, 0) / results.length;
    const totalRows = results.reduce((sum, r) => sum + r.rowsProcessed, 0);

    console.log(`   Total Tests: ${results.length}`);
    console.log(`   Average Execution Time: ${avgTime.toFixed(2)}ms`);
    console.log(`   Total Rows Processed: ${totalRows.toLocaleString()}`);
    console.log("");

    // Export results as JSON
    const resultsPath = "/tmp/extension-performance-results.json";
    await Bun.write(resultsPath, JSON.stringify(results, null, 2));
    console.log(`   Results exported to: ${resultsPath}`);
    console.log("");
  } catch (error) {
    console.error("❌ Benchmark failed:", error);
    throw error;
  } finally {
    await stopContainer();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
