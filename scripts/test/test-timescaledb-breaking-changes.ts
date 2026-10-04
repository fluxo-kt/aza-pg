#!/usr/bin/env bun
/**
 * TimescaleDB TSL (community-licensed) features: owner of "the image ships the TSL module".
 *
 * Compression and continuous aggregates live only in the TSL library. An image built or configured
 * Apache-only still creates the extension and runs hypertables, so only exercising a TSL feature
 * catches it — and every error here is a failure, including a license error.
 *
 * The continuous aggregate is refreshed over chunks that are already compressed and its rows must
 * equal the same aggregate computed directly, so a refresh that silently skips compressed chunks
 * fails too.
 *
 * Usage: bun scripts/test/test-timescaledb-breaking-changes.ts [image] [--image=TAG]
 */
import { $ } from "bun";
import { generateUniqueContainerName, waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";

const container = generateUniqueContainerName("aza-pg-tsdb-tsl");

async function sql(query: string): Promise<string> {
  const r = await $`docker exec ${container} psql -X -v ON_ERROR_STOP=1 -U postgres -tA -c ${query}`
    .quiet()
    .nothrow();
  if (r.exitCode !== 0) throw new Error(`${query}\n${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

async function run(): Promise<void> {
  await $`docker run -d --name ${container} -e POSTGRES_PASSWORD=postgres ${resolveImageTag()}`.quiet();
  await waitForPostgres({ container, timeout: 120 });

  await sql("CREATE EXTENSION IF NOT EXISTS timescaledb");
  await sql("CREATE TABLE metrics (time timestamptz NOT NULL, device text, val integer)");
  await sql("SELECT create_hypertable('metrics', 'time', chunk_time_interval => interval '1 day')");
  // Fixed timestamps and values: the expected aggregate is computed from the same rows below.
  await sql(
    `INSERT INTO metrics SELECT t, 'dev_' || (i % 3), i
       FROM generate_series(1, 3) i,
            generate_series('2026-01-01'::timestamptz, '2026-01-05'::timestamptz, interval '1 hour') t`
  );
  await sql(
    "ALTER TABLE metrics SET (timescaledb.compress, timescaledb.compress_segmentby = 'device')"
  );
  await sql("SELECT compress_chunk(c) FROM show_chunks('metrics') c");

  const uncompressed = await sql(
    "SELECT count(*) FROM timescaledb_information.chunks WHERE hypertable_name = 'metrics' AND NOT is_compressed"
  );
  if (uncompressed !== "0") throw new Error(`${uncompressed} chunk(s) still uncompressed`);

  await sql(
    `CREATE MATERIALIZED VIEW metrics_daily WITH (timescaledb.continuous) AS
       SELECT time_bucket('1 day', time) AS bucket, device, sum(val) AS total
       FROM metrics GROUP BY 1, 2 WITH NO DATA`
  );
  await sql("CALL refresh_continuous_aggregate('metrics_daily', NULL, NULL)");

  const fromAggregate = await sql(
    "SELECT string_agg(bucket || ' ' || device || ' ' || total, ',' ORDER BY bucket, device) FROM metrics_daily"
  );
  const direct = await sql(
    `SELECT string_agg(bucket || ' ' || device || ' ' || total, ',' ORDER BY bucket, device)
       FROM (SELECT time_bucket('1 day', time) AS bucket, device, sum(val) AS total
             FROM metrics GROUP BY 1, 2) d`
  );
  if (fromAggregate === "" || fromAggregate !== direct) {
    throw new Error(
      `continuous aggregate rows differ from direct aggregate:\n${fromAggregate}\n!=\n${direct}`
    );
  }
}

let failure: string | null = null;
try {
  await run();
} catch (err) {
  failure = err instanceof Error ? err.message : String(err);
} finally {
  await $`docker rm -f -v ${container}`.quiet().nothrow();
}
if (failure) {
  console.error(`FAIL: timescaledb TSL: ${failure}`);
  process.exit(1);
}
console.log("PASS: timescaledb TSL compression and continuous aggregate over compressed chunks");
