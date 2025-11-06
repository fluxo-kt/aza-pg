#!/usr/bin/env bun
/**
 * Comprehensive extension test suite
 * Tests 38 extensions + 1 schema (39 total: 6 builtin + 14 PGDG + 18 compiled + 1 schema)
 *
 * Usage: bun run scripts/test/test-extensions.ts [--image=aza-pg:phase1-fix]
 */

import { $ } from "bun";

const IMAGE = Bun.argv.find(arg => arg.startsWith('--image='))?.split('=')[1] || 'aza-pg:pgdg-opt';
const CONTAINER_NAME = `pg-test-${Date.now()}`;

interface ExtensionTest {
  name: string;
  category: string;
  createSQL: string;
  testSQL?: string; // Optional functional test
  expectError?: boolean; // Some extensions may not be creatable directly
}

const EXTENSIONS: ExtensionTest[] = [
  // Builtin extensions (6)
  { name: 'auto_explain', category: 'builtin', createSQL: '', testSQL: "SHOW auto_explain.log_min_duration" },
  { name: 'btree_gin', category: 'builtin', createSQL: 'CREATE EXTENSION IF NOT EXISTS btree_gin CASCADE', testSQL: "SELECT 1" },
  { name: 'btree_gist', category: 'builtin', createSQL: 'CREATE EXTENSION IF NOT EXISTS btree_gist CASCADE', testSQL: "SELECT 1" },
  { name: 'pg_stat_statements', category: 'builtin', createSQL: '', testSQL: "SELECT count(*) FROM pg_stat_statements" },
  { name: 'pg_trgm', category: 'builtin', createSQL: 'CREATE EXTENSION IF NOT EXISTS pg_trgm CASCADE', testSQL: "SELECT 'test' % 'test'" },
  { name: 'plpgsql', category: 'builtin', createSQL: '', testSQL: "SELECT 1" },

  // PGDG extensions (13)
  { name: 'pg_cron', category: 'pgdg', createSQL: 'CREATE EXTENSION IF NOT EXISTS pg_cron CASCADE', testSQL: "SELECT count(*) FROM cron.job" },
  { name: 'pgaudit', category: 'pgdg', createSQL: '', testSQL: "SHOW pgaudit.log" },
  { name: 'pgvector', category: 'pgdg', createSQL: 'CREATE EXTENSION IF NOT EXISTS vector CASCADE', testSQL: "SELECT '[1,2,3]'::vector" },
  { name: 'timescaledb', category: 'pgdg', createSQL: 'CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE', testSQL: "SELECT default_version FROM pg_available_extensions WHERE name = 'timescaledb'" },
  { name: 'postgis', category: 'pgdg', createSQL: 'CREATE EXTENSION IF NOT EXISTS postgis CASCADE', testSQL: "SELECT PostGIS_Version()" },
  { name: 'pg_partman', category: 'pgdg', createSQL: 'CREATE EXTENSION IF NOT EXISTS pg_partman CASCADE', testSQL: "SELECT count(*) FROM part_config" },
  { name: 'pg_repack', category: 'pgdg', createSQL: 'CREATE EXTENSION IF NOT EXISTS pg_repack CASCADE', testSQL: "SELECT default_version FROM pg_available_extensions WHERE name = 'pg_repack'" },
  { name: 'plpgsql_check', category: 'pgdg', createSQL: 'CREATE EXTENSION IF NOT EXISTS plpgsql_check CASCADE', testSQL: "SELECT default_version FROM pg_available_extensions WHERE name = 'plpgsql_check'" },
  { name: 'hll', category: 'pgdg', createSQL: 'CREATE EXTENSION IF NOT EXISTS hll CASCADE', testSQL: "SELECT hll_empty()" },
  { name: 'http', category: 'pgdg', createSQL: 'CREATE EXTENSION IF NOT EXISTS http CASCADE', testSQL: "SELECT default_version FROM pg_available_extensions WHERE name = 'http'" },
  { name: 'hypopg', category: 'pgdg', createSQL: 'CREATE EXTENSION IF NOT EXISTS hypopg CASCADE', testSQL: "SELECT default_version FROM pg_available_extensions WHERE name = 'hypopg'" },
  { name: 'pgrouting', category: 'pgdg', createSQL: 'CREATE EXTENSION IF NOT EXISTS pgrouting CASCADE', testSQL: "SELECT default_version FROM pg_available_extensions WHERE name = 'pgrouting'" },
  { name: 'rum', category: 'pgdg', createSQL: 'CREATE EXTENSION IF NOT EXISTS rum CASCADE', testSQL: "SELECT default_version FROM pg_available_extensions WHERE name = 'rum'" },
  { name: 'set_user', category: 'pgdg', createSQL: 'CREATE EXTENSION IF NOT EXISTS set_user CASCADE', testSQL: "SELECT default_version FROM pg_available_extensions WHERE name = 'set_user'" },
  { name: 'wal2json', category: 'compiled-tool', createSQL: '', testSQL: "" }, // Logical decoding plugin, not a CREATE EXTENSION extension

  // Compiled extensions (19: 14 standard + 2 hook-based + 3 CLI tools)
  { name: 'pg_jsonschema', category: 'compiled', createSQL: 'CREATE EXTENSION IF NOT EXISTS pg_jsonschema CASCADE', testSQL: "SELECT json_matches_schema('true', '{}')" },
  { name: 'index_advisor', category: 'compiled', createSQL: 'CREATE EXTENSION IF NOT EXISTS index_advisor CASCADE', testSQL: "SELECT count(*) FROM index_advisor('SELECT 1')" },
  { name: 'pg_hashids', category: 'compiled', createSQL: 'CREATE EXTENSION IF NOT EXISTS pg_hashids CASCADE', testSQL: "SELECT id_encode(123)" },
  { name: 'pg_plan_filter', category: 'compiled-hook', createSQL: '', testSQL: "" }, // Hook-based extension, no .control file
  { name: 'safeupdate', category: 'compiled-hook', createSQL: '', testSQL: "" }, // Hook-based extension, no .control file
  { name: 'pg_stat_monitor', category: 'compiled', createSQL: 'CREATE EXTENSION IF NOT EXISTS pg_stat_monitor CASCADE', testSQL: "SELECT count(*) FROM pg_stat_monitor" },
  { name: 'pgbackrest', category: 'compiled-tool', createSQL: '', testSQL: "" }, // CLI tool, not extension
  { name: 'pgbadger', category: 'compiled-tool', createSQL: '', testSQL: "" }, // CLI tool, not extension
  { name: 'pgmq', category: 'compiled', createSQL: 'CREATE EXTENSION IF NOT EXISTS pgmq CASCADE', testSQL: "SELECT pgmq.create('test_queue')" },
  { name: 'pgq', category: 'compiled', createSQL: 'CREATE EXTENSION IF NOT EXISTS pgq CASCADE', testSQL: "SELECT pgq.create_queue('test_pgq_queue')" },
  { name: 'pgroonga', category: 'compiled', createSQL: 'CREATE EXTENSION IF NOT EXISTS pgroonga CASCADE', testSQL: "SELECT pgroonga_command('status')" },
  { name: 'pgsodium', category: 'compiled', createSQL: 'CREATE EXTENSION IF NOT EXISTS pgsodium CASCADE', testSQL: "SELECT pgsodium.crypto_secretbox_keygen()" },
  { name: 'supabase_vault', category: 'compiled', createSQL: 'CREATE EXTENSION IF NOT EXISTS supabase_vault CASCADE', testSQL: "SELECT count(*) FROM vault.secrets" },
  { name: 'supautils', category: 'compiled-hook', createSQL: '', testSQL: "SHOW supautils.superuser" }, // Hook-based extension, provides GUC variables only
  { name: 'timescaledb_toolkit', category: 'compiled', createSQL: 'CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit CASCADE', testSQL: "SELECT default_version FROM pg_available_extensions WHERE name = 'timescaledb_toolkit'" },
  { name: 'vectorscale', category: 'compiled', createSQL: 'CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE', testSQL: "SELECT default_version FROM pg_available_extensions WHERE name = 'vectorscale'" },
  { name: 'wrappers', category: 'compiled', createSQL: 'CREATE EXTENSION IF NOT EXISTS wrappers CASCADE', testSQL: "SELECT default_version FROM pg_available_extensions WHERE name = 'wrappers'" },
  { name: 'pgflow', category: 'schema', createSQL: '', testSQL: "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'pgflow'" }, // SQL schema installed via init script
];

async function startContainer(): Promise<void> {
  console.log(`Starting container ${CONTAINER_NAME}...`);
  await $`docker run -d --name ${CONTAINER_NAME} \
    --platform linux/amd64 \
    -e POSTGRES_PASSWORD=test \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    ${IMAGE}`.quiet();

  // Wait for PostgreSQL to be ready
  console.log('Waiting for PostgreSQL to be ready...');
  let retries = 30;
  while (retries > 0) {
    try {
      await $`docker exec ${CONTAINER_NAME} pg_isready -U postgres`.quiet();
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 1000));
      retries--;
    }
  }

  if (retries === 0) {
    throw new Error('PostgreSQL failed to start');
  }

  console.log('PostgreSQL ready!\n');
}

async function stopContainer(): Promise<void> {
  console.log(`\nStopping and removing container ${CONTAINER_NAME}...`);
  await $`docker rm -f ${CONTAINER_NAME}`.quiet();
}

async function testExtension(ext: ExtensionTest, maxRetries = 3): Promise<{ success: boolean; error?: string }> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Create extension if needed
      if (ext.createSQL) {
        const result = await $`docker exec ${CONTAINER_NAME} psql -U postgres -c ${ext.createSQL}`.nothrow();
        if (result.exitCode !== 0) {
          const error = result.stderr.toString();
          // Retry on transient connection/startup errors
          if (attempt < maxRetries && (
            error.includes('shutting down') ||
            error.includes('starting up') ||
            error.includes('No such file or directory') ||
            error.includes('Connection refused')
          )) {
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
            continue;
          }
          return { success: false, error };
        }
      }

      // Run functional test if provided
      if (ext.testSQL) {
        const result = await $`docker exec ${CONTAINER_NAME} psql -U postgres -c ${ext.testSQL}`.nothrow();
        if (result.exitCode !== 0) {
          const error = result.stderr.toString();
          // Retry on transient connection/startup errors
          if (attempt < maxRetries && (
            error.includes('shutting down') ||
            error.includes('starting up') ||
            error.includes('No such file or directory') ||
            error.includes('Connection refused')
          )) {
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
            continue;
          }
          return { success: false, error };
        }
      }

      return { success: true };
    } catch (error) {
      const errorStr = String(error);
      // Retry on transient errors
      if (attempt < maxRetries && (
        errorStr.includes('shutting down') ||
        errorStr.includes('starting up') ||
        errorStr.includes('No such file or directory') ||
        errorStr.includes('Connection refused')
      )) {
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
        continue;
      }
      return { success: false, error: errorStr };
    }
  }

  return { success: false, error: 'Max retries exceeded' };
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
        console.log('✅ PASS');
        passed++;
      } else {
        console.log('❌ FAIL');
        console.log(`  Error: ${result.error?.split('\n')[0]}`);
        failed++;
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log(`SUMMARY: ${passed}/${EXTENSIONS.length} passed, ${failed} failed`);
    console.log('='.repeat(80));

    if (failed === 0) {
      console.log('\n🎉 All extensions working!');
      process.exit(0);
    } else {
      console.log('\n❌ Some extensions failed. Review output above.');
      process.exit(1);
    }
  } finally {
    await stopContainer();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
