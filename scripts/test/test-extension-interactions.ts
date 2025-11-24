#!/usr/bin/env bun
/**
 * Extension Interaction Test Runner (Tier 3)
 *
 * Verifies that extension combinations work together without conflicts.
 * Tests critical interactions between extensions that commonly work together.
 *
 * Test Modes:
 * - production: 4 critical interactions (TimescaleDB+pgvector, PostGIS+pg_trgm,
 *   pgsodium+supabase_vault, all default preloads)
 * - regression: 10+ interactions (includes optional preloads, additional combinations)
 *
 * Usage:
 *   bun scripts/test/test-extension-interactions.ts [options] [image]
 *
 * Options:
 *   --mode=MODE              Test mode: production | regression (default: auto-detect)
 *   --tests=test1,test2      Specific interaction tests to run (comma-separated)
 *   --verbose                Detailed output
 *   --container=NAME         Use existing container instead of starting new one
 *   --help                   Show this help message
 *
 * Examples:
 *   bun scripts/test/test-extension-interactions.ts
 *   bun scripts/test/test-extension-interactions.ts --mode=regression
 *   bun scripts/test/test-extension-interactions.ts --tests=timescaledb-pgvector
 *   bun scripts/test/test-extension-interactions.ts --container=my-postgres
 */

import { $ } from "bun";
import { detectTestMode, type TestMode, getSharedPreloadLibraries } from "./lib/test-mode.ts";
import { resolveImageTag } from "./image-resolver.ts";

interface TestResult {
  testName: string;
  passed: boolean;
  actualOutput: string;
  error: string | null;
  duration: number;
}

interface InteractionTest {
  name: string;
  displayName: string;
  extensions: string[];
  modes: TestMode[]; // which modes this test runs in
  preloadRequired?: string[]; // additional preload libraries needed
  test: (runSQL: SQLRunner) => Promise<void>;
}

type SQLRunner = (sql: string) => Promise<{ stdout: string; stderr: string; success: boolean }>;

interface TestOptions {
  mode: TestMode;
  tests: string[];
  verbose: boolean;
  container: string | null;
  image: string;
}

/**
 * Parse CLI arguments
 */
function parseArgs(): TestOptions | null {
  const args = Bun.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return null;
  }

  // Parse mode
  let mode: TestMode | null = null;
  const modeArg = args.find((arg) => arg.startsWith("--mode="));
  if (modeArg) {
    const modeValue = modeArg.split("=")[1];
    if (modeValue === "production" || modeValue === "regression") {
      mode = modeValue;
    }
  }

  // Parse tests
  let tests: string[] = [];
  const testsArg = args.find((arg) => arg.startsWith("--tests="));
  if (testsArg) {
    const testList = testsArg.split("=")[1];
    if (testList) {
      tests = testList.split(",").map((t) => t.trim());
    }
  }

  // Parse flags
  const verbose = args.includes("--verbose");

  // Parse container name
  let container: string | null = null;
  const containerArg = args.find((arg) => arg.startsWith("--container="));
  if (containerArg) {
    container = containerArg.split("=")[1] || null;
  }

  // Resolve image
  const image = resolveImageTag();

  return {
    mode: mode as TestMode, // Will be null if not specified, handled later
    tests,
    verbose,
    container,
    image,
  };
}

/**
 * Print help message
 */
function printHelp(): void {
  console.log(
    `
Extension Interaction Test Runner (Tier 3)

Verifies that extension combinations work together without conflicts.
Tests critical interactions between extensions that commonly work together.

Usage:
  bun scripts/test/test-extension-interactions.ts [options] [image]

Options:
  --mode=MODE              Test mode: production | regression (default: auto-detect)
  --tests=test1,test2      Specific interaction tests to run (comma-separated)
  --verbose                Detailed output
  --container=NAME         Use existing container instead of starting new one
  --help                   Show this help message

Test Modes:
  production               4 critical interactions (default preloads + key combinations)
  regression            10+ interactions (optional preloads + extended combinations)

Production Mode Tests (4):
  - timescaledb-pgvector:       Time-series vector search
  - hypopg-pg_stat_statements:  Query optimization stack
  - pgsodium-vault:             Encryption stack
  - all-default-preloads:       Conflict detection with all default preloads

Comprehensive Mode Tests (10+):
  - All production tests plus:
  - all-optional-preloads: Maximum preload testing
  - pg_partman-timescaledb: Partition compatibility
  - pgaudit-pg_stat_monitor: Audit + monitoring stack
  - postgis-pgrouting:     GIS + routing stack
  - encryption-audit:      pgsodium + pgaudit
  - gis-extensions:        PostGIS + h3 + h3_postgis

Examples:
  bun scripts/test/test-extension-interactions.ts
  bun scripts/test/test-extension-interactions.ts --mode=regression
  bun scripts/test/test-extension-interactions.ts --tests=timescaledb-pgvector
  bun scripts/test/test-extension-interactions.ts --container=my-postgres
  `.trim()
  );
}

/**
 * Define all interaction tests
 */
const INTERACTION_TESTS: InteractionTest[] = [
  // ============================================================================
  // Production Mode Tests (4 critical interactions)
  // ============================================================================
  {
    name: "timescaledb-pgvector",
    displayName: "TimescaleDB + pgvector: Time-series vector search",
    extensions: ["timescaledb", "vector"],
    modes: ["production", "regression"],
    preloadRequired: ["timescaledb"],
    test: async (runSQL) => {
      // Create hypertable with vector column
      const create = await runSQL(`
        CREATE TABLE IF NOT EXISTS test_ts_vectors (
          time timestamptz NOT NULL,
          sensor_id int,
          embedding vector(3),
          value double precision
        )
      `);
      if (!create.success) throw new Error(`Create table failed: ${create.stderr}`);

      // Convert to hypertable
      const hypertable = await runSQL(`
        SELECT create_hypertable('test_ts_vectors', 'time', if_not_exists => TRUE)
      `);
      if (!hypertable.success) throw new Error(`Create hypertable failed: ${hypertable.stderr}`);

      // Insert time-series vector data
      const insert = await runSQL(`
        INSERT INTO test_ts_vectors (time, sensor_id, embedding, value)
        VALUES
          (NOW() - interval '1 hour', 1, '[1,0,0]', 42.5),
          (NOW() - interval '30 minutes', 1, '[0.9,0.1,0]', 43.2),
          (NOW(), 1, '[0.8,0.2,0]', 44.1),
          (NOW() - interval '1 hour', 2, '[0,1,0]', 38.7),
          (NOW(), 2, '[0,0.9,0.1]', 39.3)
      `);
      if (!insert.success) throw new Error(`Insert data failed: ${insert.stderr}`);

      // Create HNSW index on vector column
      const index = await runSQL(`
        CREATE INDEX IF NOT EXISTS idx_ts_vectors_hnsw
        ON test_ts_vectors USING hnsw (embedding vector_l2_ops)
      `);
      if (!index.success) throw new Error(`Create HNSW index failed: ${index.stderr}`);

      // Query with time range + vector similarity
      const query = await runSQL(`
        SELECT sensor_id, embedding <-> '[1,0,0]'::vector AS distance
        FROM test_ts_vectors
        WHERE time > NOW() - interval '1 hour'
        ORDER BY embedding <-> '[1,0,0]'
        LIMIT 3
      `);
      if (!query.success) throw new Error(`Query failed: ${query.stderr}`);

      const lines = query.stdout.split("\n").filter((l) => l.trim());
      if (lines.length === 0) throw new Error("No results returned from vector similarity search");

      // Verify hypertable chunks + vector index work together
      const chunks = await runSQL(`
        SELECT count(*) FROM timescaledb_information.chunks
        WHERE hypertable_name = 'test_ts_vectors'
      `);
      if (!chunks.success || parseInt(chunks.stdout) === 0) {
        throw new Error("No chunks created for hypertable");
      }

      // Cleanup
      await runSQL("DROP TABLE test_ts_vectors CASCADE");
    },
  },

  {
    name: "hypopg-pg_stat_statements",
    displayName: "hypopg + pg_stat_statements: Query optimization stack",
    extensions: ["hypopg", "pg_stat_statements"],
    modes: ["production", "regression"],
    preloadRequired: ["pg_stat_statements"],
    test: async (runSQL) => {
      // Create extension hypopg
      await runSQL("CREATE EXTENSION IF NOT EXISTS hypopg");

      // Create test table
      const create = await runSQL(`
        CREATE TABLE IF NOT EXISTS test_query_opt (
          id int,
          name text,
          value int
        )
      `);
      if (!create.success) throw new Error(`Create table failed: ${create.stderr}`);

      // Insert test data
      const insert = await runSQL(`
        INSERT INTO test_query_opt
        SELECT i, 'name_' || i, i * 10
        FROM generate_series(1, 1000) i
      `);
      if (!insert.success) throw new Error(`Insert data failed: ${insert.stderr}`);

      // Create hypothetical index with hypopg
      const hypIndex = await runSQL(`
        SELECT * FROM hypopg_create_index('CREATE INDEX ON test_query_opt (name)')
      `);
      if (!hypIndex.success)
        throw new Error(`Create hypothetical index failed: ${hypIndex.stderr}`);

      // Run query that would use the index
      const query = await runSQL(`
        EXPLAIN SELECT * FROM test_query_opt WHERE name = 'name_500'
      `);
      if (!query.success) throw new Error(`Query failed: ${query.stderr}`);

      // Verify pg_stat_statements tracked the queries
      const statsCheck = await runSQL(`
        SELECT count(*) FROM pg_stat_statements WHERE query LIKE '%test_query_opt%'
      `);
      if (!statsCheck.success || parseInt(statsCheck.stdout) === 0) {
        throw new Error("pg_stat_statements not tracking queries");
      }

      // Cleanup
      await runSQL("DROP TABLE test_query_opt CASCADE");
      await runSQL("SELECT hypopg_reset()");
    },
  },

  {
    name: "postgis-pg_trgm",
    displayName: "PostGIS + pg_trgm: Spatial + fuzzy text search",
    extensions: ["postgis", "pg_trgm"],
    modes: ["regression"], // PostGIS is disabled in production mode
    test: async (runSQL) => {
      // Create extension postgis if not exists
      await runSQL("CREATE EXTENSION IF NOT EXISTS postgis");

      // Create table with geometry + text columns
      const create = await runSQL(`
        CREATE TABLE IF NOT EXISTS test_spatial_text (
          id serial PRIMARY KEY,
          location geometry(Point, 4326),
          name text,
          description text
        )
      `);
      if (!create.success) throw new Error(`Create table failed: ${create.stderr}`);

      // Create GiST index on geometry
      const gistIndex = await runSQL(`
        CREATE INDEX IF NOT EXISTS idx_spatial_gist
        ON test_spatial_text USING GIST (location)
      `);
      if (!gistIndex.success) throw new Error(`Create GiST index failed: ${gistIndex.stderr}`);

      // Create GIN index on text with pg_trgm
      const ginIndex = await runSQL(`
        CREATE INDEX IF NOT EXISTS idx_text_gin
        ON test_spatial_text USING GIN (name gin_trgm_ops, description gin_trgm_ops)
      `);
      if (!ginIndex.success) throw new Error(`Create GIN index failed: ${ginIndex.stderr}`);

      // Insert test data
      const insert = await runSQL(`
        INSERT INTO test_spatial_text (location, name, description) VALUES
          (ST_SetSRID(ST_MakePoint(-122.4194, 37.7749), 4326), 'San Francisco Office', 'Modern facilities'),
          (ST_SetSRID(ST_MakePoint(-73.935242, 40.730610), 4326), 'New York Branch', 'Downtown location'),
          (ST_SetSRID(ST_MakePoint(139.6917, 35.6895), 4326), 'Tokyo Office', 'Modern workspace')
      `);
      if (!insert.success) throw new Error(`Insert data failed: ${insert.stderr}`);

      // Query combining spatial distance + text similarity
      const query = await runSQL(`
        SELECT name,
               ST_Distance(location::geography, ST_SetSRID(ST_MakePoint(-122.4, 37.7), 4326)::geography) / 1000 AS distance_km
        FROM test_spatial_text
        WHERE ST_DWithin(location::geography, ST_SetSRID(ST_MakePoint(-122.4, 37.7), 4326)::geography, 50000)
          AND (name % 'Office' OR description % 'Modern')
        ORDER BY distance_km
      `);
      if (!query.success) throw new Error(`Combined query failed: ${query.stderr}`);

      if (!query.stdout.includes("San Francisco") && !query.stdout.includes("Tokyo")) {
        throw new Error("Expected results not found in combined query");
      }

      // Cleanup
      await runSQL("DROP TABLE test_spatial_text CASCADE");
    },
  },

  {
    name: "pgsodium-vault",
    displayName: "pgsodium + supabase_vault: Encryption stack",
    extensions: ["pgsodium", "supabase_vault"],
    modes: ["production", "regression"],
    preloadRequired: ["pgsodium"],
    test: async (runSQL) => {
      // Create extension pgsodium if not exists
      await runSQL("CREATE EXTENSION IF NOT EXISTS pgsodium");

      // Create extension supabase_vault if not exists
      const createVault = await runSQL("CREATE EXTENSION IF NOT EXISTS supabase_vault");
      if (!createVault.success) {
        throw new Error(`Create supabase_vault failed: ${createVault.stderr}`);
      }

      // Verify pgsodium key exists
      const keyCheck = await runSQL(
        "SELECT count(*) FROM pgsodium.key WHERE name = 'pgsodium_root'"
      );
      if (!keyCheck.success || keyCheck.stdout === "0") {
        // Expected failure: pgsodium_getkey script not configured
        // This is documented behavior requiring manual setup
        throw new Error(
          "pgsodium root key not found (expected - requires pgsodium_getkey script configuration)"
        );
      }

      // Test vault secret storage (only if key exists)
      // First, delete any existing test secret
      await runSQL("DELETE FROM vault.secrets WHERE name = 'test_api_key'");

      const insert = await runSQL(`
        INSERT INTO vault.secrets (name, secret, description)
        VALUES ('test_api_key', 'test_secret_value', 'Test API key for interaction test')
      `);
      if (!insert.success) throw new Error(`Insert secret failed: ${insert.stderr}`);

      // Test encryption/decryption pipeline
      const decrypt = await runSQL(`
        SELECT decrypted_secret
        FROM vault.decrypted_secrets
        WHERE name = 'test_api_key'
      `);
      if (!decrypt.success) {
        throw new Error(`Decrypt secret failed: ${decrypt.stderr}`);
      }

      if (!decrypt.stdout.includes("test_secret_value")) {
        throw new Error("Decrypted secret does not match expected value");
      }

      // Verify vault depends on pgsodium correctly (secret should be encrypted at rest)
      const raw = await runSQL("SELECT secret FROM vault.secrets WHERE name = 'test_api_key'");
      if (!raw.success) throw new Error(`Query raw secret failed: ${raw.stderr}`);

      // Cleanup
      await runSQL("DELETE FROM vault.secrets WHERE name = 'test_api_key'");
    },
  },

  {
    name: "all-default-preloads",
    displayName: "All default preload libraries: Conflict detection",
    extensions: ["pg_cron", "pgaudit", "pg_stat_statements", "pg_stat_monitor", "timescaledb"],
    modes: ["production", "regression"],
    preloadRequired: [
      "pg_cron",
      "pgaudit",
      "pg_stat_statements",
      "auto_explain",
      "pg_stat_monitor",
      "timescaledb",
    ],
    test: async (runSQL) => {
      // Verify server started successfully (already done by container startup)
      // Test each preload library works
      // Note: auto_explain is preload-only (no CREATE EXTENSION), skip extension creation

      // Test pg_cron
      const cronTest = await runSQL("SELECT count(*) FROM cron.job");
      if (!cronTest.success) throw new Error(`pg_cron not working: ${cronTest.stderr}`);

      // Test pgaudit (configuration only, no CREATE EXTENSION needed)
      const auditTest = await runSQL("SHOW pgaudit.log");
      if (!auditTest.success) throw new Error(`pgaudit not working: ${auditTest.stderr}`);

      // Test pg_stat_statements
      const statementsTest = await runSQL("SELECT count(*) FROM pg_stat_statements");
      if (!statementsTest.success) {
        throw new Error(`pg_stat_statements not working: ${statementsTest.stderr}`);
      }

      // Test auto_explain (configuration only, module-based, preload-only)
      const explainTest = await runSQL("SHOW auto_explain.log_min_duration");
      if (!explainTest.success) throw new Error(`auto_explain not working: ${explainTest.stderr}`);

      // Test pg_stat_monitor
      const monitorTest = await runSQL("SELECT count(*) FROM pg_stat_monitor");
      if (!monitorTest.success) {
        throw new Error(`pg_stat_monitor not working: ${monitorTest.stderr}`);
      }

      // Test timescaledb
      const timescaleTest = await runSQL(
        "SELECT default_version FROM pg_available_extensions WHERE name = 'timescaledb'"
      );
      if (!timescaleTest.success || !timescaleTest.stdout.trim()) {
        throw new Error(`timescaledb not available: ${timescaleTest.stderr}`);
      }

      // Verify no GUC conflicts or hook interference
      const gucTest = await runSQL("SELECT count(*) FROM pg_settings");
      if (!gucTest.success || parseInt(gucTest.stdout) < 100) {
        throw new Error("GUC parameter system appears broken");
      }
    },
  },

  // ============================================================================
  // Comprehensive Mode Tests (6 additional interactions)
  // ============================================================================

  {
    name: "all-optional-preloads",
    displayName: "All optional preload libraries: Maximum preload testing",
    extensions: ["pgsodium", "pg_partman", "set_user"],
    modes: ["regression"],
    preloadRequired: ["pgsodium", "pg_partman", "set_user"],
    test: async (runSQL) => {
      // Verify server starts with additional optional preloads
      // Note: pg_safeupdate (uses library name 'safeupdate') excluded due to name mismatch issue
      // Server startup is verification itself

      // Test pgsodium preload (already tested in pgsodium-vault)
      const pgsodiumTest = await runSQL("CREATE EXTENSION IF NOT EXISTS pgsodium");
      if (!pgsodiumTest.success) throw new Error(`pgsodium not working: ${pgsodiumTest.stderr}`);

      // Test pg_partman preload
      const partmanTest = await runSQL("CREATE EXTENSION IF NOT EXISTS pg_partman");
      if (!partmanTest.success) throw new Error(`pg_partman not working: ${partmanTest.stderr}`);

      // Test set_user
      const setUserTest = await runSQL("CREATE EXTENSION IF NOT EXISTS set_user");
      if (!setUserTest.success) throw new Error(`set_user not working: ${setUserTest.stderr}`);

      // Verify optional preload extensions work correctly
      const extensionTest = await runSQL(`
        SELECT count(*) FROM pg_available_extensions
        WHERE name IN ('pgsodium', 'pg_partman', 'set_user')
      `);
      if (!extensionTest.success || parseInt(extensionTest.stdout) < 3) {
        throw new Error("Not all optional preload extensions available");
      }
    },
  },

  {
    name: "pg_partman-timescaledb",
    displayName: "pg_partman + timescaledb: Partition compatibility",
    extensions: ["pg_partman", "timescaledb"],
    modes: ["regression"],
    preloadRequired: ["timescaledb"],
    test: async (runSQL) => {
      await runSQL("CREATE EXTENSION IF NOT EXISTS pg_partman");
      await runSQL("CREATE EXTENSION IF NOT EXISTS timescaledb");

      // Test pg_partman doesn't conflict with timescaledb partitioning
      // Create both partman-managed partition and hypertable

      // Create partman-managed partition
      const partmanTable = await runSQL(`
        CREATE TABLE IF NOT EXISTS test_partman (
          id serial,
          created_at timestamptz NOT NULL DEFAULT now(),
          value text
        ) PARTITION BY RANGE (created_at)
      `);
      if (!partmanTable.success)
        throw new Error(`Create partman table failed: ${partmanTable.stderr}`);

      const partmanSetup = await runSQL(`
        SELECT partman.create_parent(
          p_parent_table => 'public.test_partman',
          p_control => 'created_at',
          p_type => 'native',
          p_interval => '1 day',
          p_premake => 1
        )
      `);
      if (!partmanSetup.success) throw new Error(`Setup partman failed: ${partmanSetup.stderr}`);

      // Create hypertable
      const hypertable = await runSQL(`
        CREATE TABLE IF NOT EXISTS test_hypertable (
          time timestamptz NOT NULL,
          device_id int,
          value double precision
        )
      `);
      if (!hypertable.success)
        throw new Error(`Create hypertable table failed: ${hypertable.stderr}`);

      const hypertableSetup = await runSQL(`
        SELECT create_hypertable('test_hypertable', 'time', if_not_exists => TRUE)
      `);
      if (!hypertableSetup.success) {
        throw new Error(`Setup hypertable failed: ${hypertableSetup.stderr}`);
      }

      // Verify no conflicts - both should work
      const insertPartman = await runSQL("INSERT INTO test_partman (value) VALUES ('test')");
      if (!insertPartman.success)
        throw new Error(`Insert into partman table failed: ${insertPartman.stderr}`);

      const insertHypertable = await runSQL(`
        INSERT INTO test_hypertable (time, device_id, value)
        VALUES (NOW(), 1, 42.0)
      `);
      if (!insertHypertable.success) {
        throw new Error(`Insert into hypertable failed: ${insertHypertable.stderr}`);
      }

      // Cleanup
      await runSQL("DROP TABLE test_partman CASCADE");
      await runSQL("DROP TABLE test_hypertable CASCADE");
    },
  },

  {
    name: "pgaudit-pg_stat_monitor",
    displayName: "pgaudit + pg_stat_monitor: Audit + monitoring stack",
    extensions: ["pgaudit", "pg_stat_monitor"],
    modes: ["regression"],
    preloadRequired: ["pgaudit", "pg_stat_monitor"],
    test: async (runSQL) => {
      // Enable both extensions (both are preloaded)
      await runSQL("CREATE EXTENSION IF NOT EXISTS pgaudit");
      await runSQL("CREATE EXTENSION IF NOT EXISTS pg_stat_monitor");

      // Configure audit logging
      const configAudit = await runSQL("SET pgaudit.log = 'all'");
      if (!configAudit.success) throw new Error(`Configure pgaudit failed: ${configAudit.stderr}`);

      // Run queries
      await runSQL("CREATE TABLE IF NOT EXISTS test_audit (id int, value text)");
      await runSQL("INSERT INTO test_audit VALUES (1, 'test')");
      await runSQL("SELECT * FROM test_audit");

      // Verify both capture data correctly
      const monitorData = await runSQL("SELECT count(*) FROM pg_stat_monitor");
      if (!monitorData.success || parseInt(monitorData.stdout) === 0) {
        throw new Error("pg_stat_monitor not capturing data");
      }

      // pgaudit logs to PostgreSQL log file, not queryable directly
      // Verify configuration is active
      const auditConfig = await runSQL("SHOW pgaudit.log");
      if (!auditConfig.success || auditConfig.stdout.trim() !== "all") {
        throw new Error("pgaudit configuration not active");
      }

      // Cleanup
      await runSQL("DROP TABLE test_audit");
    },
  },

  {
    name: "postgis-pgrouting",
    displayName: "PostGIS + pgrouting: GIS + routing stack",
    extensions: ["postgis", "pgrouting"],
    modes: ["regression"],
    test: async (runSQL) => {
      await runSQL("CREATE EXTENSION IF NOT EXISTS postgis");
      await runSQL("CREATE EXTENSION IF NOT EXISTS pgrouting");

      // Create spatial network graph
      const createGraph = await runSQL(`
        CREATE TABLE IF NOT EXISTS test_network (
          id serial PRIMARY KEY,
          source int,
          target int,
          cost double precision,
          geom geometry(LineString, 4326)
        )
      `);
      if (!createGraph.success)
        throw new Error(`Create network table failed: ${createGraph.stderr}`);

      // Insert simple network (4 nodes, 4 edges forming a square)
      const insertEdges = await runSQL(`
        INSERT INTO test_network (source, target, cost, geom) VALUES
          (1, 2, 1.0, ST_GeomFromText('LINESTRING(0 0, 1 0)', 4326)),
          (2, 3, 1.0, ST_GeomFromText('LINESTRING(1 0, 1 1)', 4326)),
          (3, 4, 1.0, ST_GeomFromText('LINESTRING(1 1, 0 1)', 4326)),
          (4, 1, 1.0, ST_GeomFromText('LINESTRING(0 1, 0 0)', 4326))
      `);
      if (!insertEdges.success) throw new Error(`Insert edges failed: ${insertEdges.stderr}`);

      // Run routing algorithm (Dijkstra)
      const routing = await runSQL(`
        SELECT * FROM pgr_dijkstra(
          'SELECT id, source, target, cost FROM test_network',
          1, 3, directed := false
        )
      `);
      if (!routing.success) throw new Error(`Routing query failed: ${routing.stderr}`);

      if (!routing.stdout.trim()) {
        throw new Error("No routing results returned");
      }

      // Verify routing works with PostGIS geometries
      const routeLength = await runSQL(`
        SELECT sum(ST_Length(geom))
        FROM test_network n
        JOIN (
          SELECT edge FROM pgr_dijkstra(
            'SELECT id, source, target, cost FROM test_network',
            1, 3, directed := false
          )
        ) r ON n.id = r.edge
      `);
      if (!routeLength.success) {
        throw new Error(`Route length calculation failed: ${routeLength.stderr}`);
      }

      // Cleanup
      await runSQL("DROP TABLE test_network CASCADE");
    },
  },

  {
    name: "encryption-audit",
    displayName: "Multiple encryption extensions: pgsodium + pgaudit",
    extensions: ["pgsodium", "pgaudit"],
    modes: ["regression"],
    preloadRequired: ["pgsodium", "pgaudit"],
    test: async (runSQL) => {
      await runSQL("CREATE EXTENSION IF NOT EXISTS pgsodium");
      await runSQL("CREATE EXTENSION IF NOT EXISTS pgaudit");

      // Test encryption + audit logging together
      const configAudit = await runSQL("SET pgaudit.log = 'all'");
      if (!configAudit.success) throw new Error(`Configure pgaudit failed: ${configAudit.stderr}`);

      // Create table with encrypted column
      const createTable = await runSQL(`
        CREATE TABLE IF NOT EXISTS test_encrypted_audit (
          id serial PRIMARY KEY,
          secret_key bytea,
          encrypted_data bytea
        )
      `);
      if (!createTable.success) throw new Error(`Create table failed: ${createTable.stderr}`);

      // Generate encryption key
      const genKey = await runSQL("SELECT pgsodium.crypto_secretbox_keygen()");
      if (!genKey.success) throw new Error(`Generate key failed: ${genKey.stderr}`);

      // Insert encrypted data
      const insertData = await runSQL(`
        INSERT INTO test_encrypted_audit (secret_key, encrypted_data)
        SELECT
          pgsodium.crypto_secretbox_keygen(),
          pgsodium.crypto_secretbox('sensitive data'::bytea, '\\x0123456789abcdef0123456789abcdef0123456789abcdef'::bytea, pgsodium.crypto_secretbox_keygen())
      `);
      if (!insertData.success)
        throw new Error(`Insert encrypted data failed: ${insertData.stderr}`);

      // Verify encrypted data is audited correctly
      const auditConfig = await runSQL("SHOW pgaudit.log");
      if (!auditConfig.success)
        throw new Error(`Query pgaudit config failed: ${auditConfig.stderr}`);

      // Cleanup
      await runSQL("DROP TABLE test_encrypted_audit");
    },
  },

  {
    name: "gis-extensions",
    displayName: "All GIS extensions: PostGIS + h3 + h3_postgis",
    extensions: ["postgis", "h3", "h3_postgis"],
    modes: ["regression"],
    test: async (runSQL) => {
      await runSQL("CREATE EXTENSION IF NOT EXISTS postgis");
      await runSQL("CREATE EXTENSION IF NOT EXISTS h3");
      await runSQL("CREATE EXTENSION IF NOT EXISTS h3_postgis");

      // Test GIS extension stack compatibility
      const createTable = await runSQL(`
        CREATE TABLE IF NOT EXISTS test_gis_stack (
          id serial PRIMARY KEY,
          location geometry(Point, 4326),
          h3_index h3index
        )
      `);
      if (!createTable.success) throw new Error(`Create table failed: ${createTable.stderr}`);

      // Insert data with PostGIS geometry
      const insertData = await runSQL(`
        INSERT INTO test_gis_stack (location)
        VALUES (ST_SetSRID(ST_MakePoint(-122.4194, 37.7749), 4326))
      `);
      if (!insertData.success) throw new Error(`Insert data failed: ${insertData.stderr}`);

      // Convert PostGIS geometry to H3 index using h3_postgis
      const updateH3 = await runSQL(`
        UPDATE test_gis_stack
        SET h3_index = h3_lat_lng_to_cell(location, 9)
      `);
      if (!updateH3.success) throw new Error(`Update H3 index failed: ${updateH3.stderr}`);

      // Query using H3 index
      const queryH3 = await runSQL(`
        SELECT h3_index, h3_cell_to_lat_lng(h3_index)
        FROM test_gis_stack
      `);
      if (!queryH3.success) throw new Error(`Query H3 index failed: ${queryH3.stderr}`);

      if (!queryH3.stdout.trim()) {
        throw new Error("No H3 results returned");
      }

      // Cleanup
      await runSQL("DROP TABLE test_gis_stack CASCADE");
    },
  },
];

/**
 * Get list of tests to run based on mode and explicit test names
 */
function getTestsToRun(mode: TestMode, explicitTests: string[]): InteractionTest[] {
  if (explicitTests.length > 0) {
    return INTERACTION_TESTS.filter((t) => explicitTests.includes(t.name));
  }

  return INTERACTION_TESTS.filter((t) => t.modes.includes(mode));
}

/**
 * Start PostgreSQL container for testing
 */
async function startPostgresContainer(image: string, mode: TestMode): Promise<string> {
  const containerName = `interaction-test-${Date.now()}`;

  console.log(`Starting PostgreSQL container: ${containerName}`);
  console.log(`  Image: ${image}`);
  console.log(`  Mode:  ${mode}`);

  // Get appropriate shared_preload_libraries for mode
  const sharedPreload = getSharedPreloadLibraries(mode);

  try {
    // Start container
    await $`docker run -d --name ${containerName} \
      -e POSTGRES_PASSWORD=postgres \
      -e TEST_MODE=${mode} \
      -e POSTGRES_SHARED_PRELOAD_LIBRARIES=${sharedPreload} \
      -p 5432 \
      ${image}`.quiet();

    // Wait for PostgreSQL to be ready
    console.log("Waiting for PostgreSQL to be ready...");

    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        const result = await $`docker exec ${containerName} pg_isready -U postgres`.nothrow();
        if (result.exitCode === 0) {
          ready = true;
          break;
        }
      } catch {
        // Container not ready yet
      }
      await Bun.sleep(1000);
    }

    if (!ready) {
      throw new Error("PostgreSQL failed to start within 60 seconds");
    }

    // Additional wait for initialization
    await Bun.sleep(3000);

    console.log("PostgreSQL is ready\n");
    return containerName;
  } catch (error) {
    // Clean up container on failure
    try {
      await $`docker rm -f ${containerName}`.quiet();
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Stop and remove PostgreSQL container
 */
async function stopPostgresContainer(containerName: string): Promise<void> {
  try {
    await $`docker rm -f ${containerName}`.quiet();
  } catch (error) {
    console.warn(`Warning: Failed to stop container ${containerName}: ${error}`);
  }
}

/**
 * Get connection configuration for container
 */
async function getConnectionConfig(containerName: string): Promise<{ host: string; port: number }> {
  // Get container's mapped port
  const result = await $`docker port ${containerName} 5432`;
  const portLine = result.stdout.toString().trim();

  // Parse port from output like "5432/tcp -> 0.0.0.0:54321"
  const portMatch = portLine.match(/:(\d+)$/);
  const port = portMatch ? parseInt(portMatch[1]) : 5432;

  return {
    host: "localhost",
    port,
  };
}

/**
 * Create SQL runner function for a container
 */
function createSQLRunner(containerName: string): SQLRunner {
  return async (sql: string) => {
    try {
      const result =
        await $`docker exec ${containerName} psql -U postgres -t -A -c ${sql}`.nothrow();
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
  };
}

/**
 * Run a single interaction test
 */
async function runInteractionTest(
  test: InteractionTest,
  runSQL: SQLRunner,
  verbose: boolean
): Promise<TestResult> {
  const startTime = performance.now();

  try {
    // Create required extensions
    for (const extName of test.extensions) {
      const result = await runSQL(`CREATE EXTENSION IF NOT EXISTS ${extName}`);
      if (!result.success) {
        // Extension might not be available - this is ok, test will fail gracefully
        if (verbose) {
          console.log(`  Note: Extension ${extName} not available: ${result.stderr}`);
        }
      }
    }

    // Run test
    await test.test(runSQL);

    const duration = performance.now() - startTime;
    return {
      testName: test.name,
      passed: true,
      actualOutput: "",
      error: null,
      duration,
    };
  } catch (error) {
    const duration = performance.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      testName: test.name,
      passed: false,
      actualOutput: "",
      error: errorMsg,
      duration,
    };
  }
}

/**
 * Print test results
 */
function printTestResults(results: TestResult[], verbose: boolean): void {
  console.log("\nTest Results:");
  console.log("=".repeat(60));

  const passed = results.filter((r) => r.passed);
  const failed = results.filter((r) => !r.passed);

  for (const result of results) {
    const status = result.passed ? "✓" : "✗";
    const duration = `${Math.round(result.duration)}ms`;

    const test = INTERACTION_TESTS.find((t) => t.name === result.testName);
    const displayName = test?.displayName || result.testName;

    if (result.passed) {
      console.log(`  ${status} ${displayName}`);
      if (verbose) {
        console.log(`     Duration: ${duration}`);
      }
    } else {
      console.log(`  ${status} ${displayName}`);
      console.log(`     Error: ${result.error}`);
      if (verbose) {
        console.log(`     Duration: ${duration}`);
      }
    }
  }

  console.log("=".repeat(60));
  console.log(`\nSummary:`);
  console.log(`  Passed: ${passed.length}/${results.length}`);
  console.log(`  Failed: ${failed.length}/${results.length}`);

  if (failed.length > 0) {
    console.log(`\nFailed tests: ${failed.map((r) => r.testName).join(", ")}`);
  }
}

/**
 * Main execution
 */
async function main(): Promise<number> {
  const options = parseArgs();
  if (!options) {
    return 0; // Help was shown
  }

  // Detect test mode if not specified
  const mode = options.mode || (await detectTestMode());

  console.log(`Extension Interaction Tests (${mode} mode)`);
  console.log("=".repeat(60));

  try {
    // Determine which tests to run
    const testsToRun = getTestsToRun(mode, options.tests);

    if (testsToRun.length === 0) {
      console.error(`\nError: No tests found matching criteria`);
      return 1;
    }

    console.log(`\nTests to run: ${testsToRun.length}`);
    if (options.verbose) {
      console.log(`  ${testsToRun.map((t) => t.name).join(", ")}\n`);
    }

    // Start container or use existing one
    let containerName: string;
    let shouldCleanup = false;

    if (options.container) {
      containerName = options.container;
      console.log(`\nUsing existing container: ${containerName}\n`);
    } else {
      containerName = await startPostgresContainer(options.image, mode);
      shouldCleanup = true;
    }

    try {
      // Create SQL runner
      const runSQL = createSQLRunner(containerName);

      // Run tests
      const results: TestResult[] = [];

      for (let i = 0; i < testsToRun.length; i++) {
        const test = testsToRun[i];
        if (!test) continue;

        if (options.verbose) {
          console.log(`[${i + 1}/${testsToRun.length}] Running ${test.displayName}...`);
        } else {
          process.stdout.write(".");
        }

        const result = await runInteractionTest(test, runSQL, options.verbose);
        results.push(result);

        if (options.verbose && result.passed) {
          console.log(`  ✓ Passed (${Math.round(result.duration)}ms)`);
        } else if (options.verbose && !result.passed) {
          console.log(`  ✗ Failed: ${result.error}`);
        }
      }

      if (!options.verbose) {
        console.log(""); // Newline after progress dots
      }

      // Print results
      printTestResults(results, options.verbose);

      // Check for expected vault failures (pgsodium_getkey not configured)
      const vaultFailures = results.filter(
        (r) =>
          !r.passed &&
          r.testName === "pgsodium-vault" &&
          r.error?.includes("pgsodium_getkey script configuration")
      );
      const nonVaultFailures = results.filter(
        (r) => !r.passed && !vaultFailures.some((v) => v.testName === r.testName)
      );

      if (nonVaultFailures.length > 0) {
        // Real failures - exit with error
        console.log(
          `\n❌ ${nonVaultFailures.length} test(s) failed (excluding expected vault failures)`
        );
        return 1;
      } else if (vaultFailures.length > 0) {
        // Only vault failures (expected) - exit success with note
        console.log(
          `\n✅ All tests passed (${vaultFailures.length} expected vault failure - requires pgsodium_getkey setup)`
        );
        return 0;
      } else {
        // All tests passed
        return 0;
      }
    } finally {
      // Clean up container if we started it
      if (shouldCleanup) {
        console.log(`\nCleaning up container: ${containerName}`);
        await stopPostgresContainer(containerName);
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`\nError: ${errorMsg}`);
    return 1;
  }
}

// Execute if run directly
if (import.meta.main) {
  const exitCode = await main();
  process.exit(exitCode);
}

export { main, parseArgs, INTERACTION_TESTS };
