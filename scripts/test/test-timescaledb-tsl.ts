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
 * A job started by the scheduler must succeed: policies run in a background worker, a path no direct call takes.
 *
 * Usage: bun scripts/test/test-timescaledb-tsl.ts [image] [--image=TAG]
 */
import { $ } from "bun";
import { TIMEOUTS } from "../config/test-timeouts";
import { TEST_SERVER, generateUniqueContainerName, waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";
import { sqlOk } from "../utils/psql";

const container = generateUniqueContainerName("aza-pg-tsdb-tsl");

const sql = (query: string) => sqlOk(container, query);

async function run(): Promise<void> {
  await $`docker run -d --name ${container} ${TEST_SERVER} -e POSTGRES_PASSWORD=postgres ${resolveImageTag()}`.quiet();
  await waitForPostgres({ container, timeout: TIMEOUTS.startup });

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

  // Every policy (compression, retention, aggregate refresh) runs in the scheduler's background worker through
  // job_execute(), which the direct calls above never reach. A PostgreSQL minor can break only that path
  // (18.7's PortalDrop check failed every scheduled job while CALL run_job() still passed), so a job the
  // scheduler itself starts must succeed. A user-defined action takes the same path with no policy offsets.
  await sql(
    "CREATE PROCEDURE tsl_tick(job_id int, config jsonb) LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; END $$"
  );
  const jobId = Number(await sql("SELECT add_job('tsl_tick', '1 second')"));
  const deadline = Date.now() + TIMEOUTS.health * 1000;
  let successes = 0;
  while (Date.now() < deadline && successes === 0) {
    const [ok = 0, failed = 0] = (
      await sql(
        `SELECT total_successes || ' ' || total_failures FROM timescaledb_information.job_stats WHERE job_id = ${jobId}`
      )
    )
      .split(" ")
      .map(Number);
    if (failed > 0) {
      const reason = await sql(
        `SELECT coalesce(string_agg(err_message, '; '), 'no job_errors row') FROM timescaledb_information.job_errors WHERE job_id = ${jobId}`
      );
      throw new Error(`a job started by the TimescaleDB scheduler failed: ${reason}`);
    }
    successes = ok;
    if (successes === 0) await Bun.sleep(250);
  }
  if (successes === 0) {
    throw new Error(
      `the TimescaleDB scheduler ran no job within ${TIMEOUTS.health} s (scheduler not started, or no background worker slot)`
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
console.log(
  "PASS: timescaledb TSL compression, continuous aggregate over compressed chunks, scheduler-run job"
);
