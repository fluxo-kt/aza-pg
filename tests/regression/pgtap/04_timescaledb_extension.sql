-- Test: TimescaleDB Extension Functionality
-- Verifies TimescaleDB extension works correctly for time-series data
BEGIN;


SELECT
  plan (15);


-- Create extension
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;


-- Verify extension
SELECT
  has_extension ('timescaledb', 'timescaledb extension should be installed');


-- Create test hypertable
CREATE TABLE test_metrics (
  TIME TIMESTAMPTZ NOT NULL,
  device_id INTEGER NOT NULL,
  temperature DOUBLE PRECISION,
  humidity DOUBLE PRECISION
);


SELECT
  has_table ('public', 'test_metrics', 'test_metrics table should exist');


-- Convert to hypertable
SELECT
  create_hypertable ('test_metrics', 'time');


SELECT
  ok (
    (
      SELECT
        count(*)
      FROM
        timescaledb_information.hypertables
      WHERE
        hypertable_name = 'test_metrics'
    ) = 1,
    'test_metrics should be a hypertable'
  );


-- Insert test data
INSERT INTO
  test_metrics (TIME, device_id, temperature, humidity)
VALUES
  (now() - INTERVAL '1 hour', 1, 22.5, 45.0),
  (now() - INTERVAL '2 hours', 1, 23.0, 46.0),
  (now() - INTERVAL '3 hours', 2, 21.5, 44.0),
  (now() - INTERVAL '4 hours', 2, 22.0, 45.5);


SELECT
  IS (
    (
      SELECT
        count(*)::INTEGER
      FROM
        test_metrics
    ),
    4,
    'should have 4 metrics inserted'
  );


-- Test time-bucket aggregation
SELECT
  ok (
    (
      SELECT
        count(*)
      FROM
        (
          SELECT
            time_bucket ('1 hour', TIME) AS bucket,
            device_id,
            avg(temperature) AS avg_temp
          FROM
            test_metrics
          GROUP BY
            bucket,
            device_id
        ) AS bucketed
    ) >= 2,
    'time_bucket aggregation should work'
  );


-- Test continuous aggregates
CREATE MATERIALIZED VIEW test_metrics_hourly
WITH
  (timescaledb.continuous) AS
SELECT
  time_bucket ('1 hour', TIME) AS bucket,
  device_id,
  avg(temperature) AS avg_temperature,
  avg(humidity) AS avg_humidity
FROM
  test_metrics
GROUP BY
  bucket,
  device_id;


SELECT
  has_view ('public', 'test_metrics_hourly', 'continuous aggregate view should exist');


SELECT
  ok (
    (
      SELECT
        count(*)
      FROM
        timescaledb_information.continuous_aggregates
      WHERE
        view_name = 'test_metrics_hourly'
    ) = 1,
    'test_metrics_hourly should be a continuous aggregate'
  );


-- Test data retention policy
SELECT
  add_retention_policy ('test_metrics', INTERVAL '90 days');


SELECT
  ok (
    (
      SELECT
        count(*)
      FROM
        timescaledb_information.jobs
      WHERE
        proc_name = 'policy_retention'
    ) >= 1,
    'retention policy should be added'
  );


-- Test compression policy
SELECT
  add_compression_policy ('test_metrics', INTERVAL '7 days');


SELECT
  ok (
    (
      SELECT
        count(*)
      FROM
        timescaledb_information.jobs
      WHERE
        proc_name = 'policy_compression'
    ) >= 1,
    'compression policy should be added'
  );


-- Test chunk information
SELECT
  ok (
    (
      SELECT
        count(*)
      FROM
        timescaledb_information.chunks
      WHERE
        hypertable_name = 'test_metrics'
    ) >= 1,
    'hypertable should have at least one chunk'
  );


-- Test approximate row count
SELECT
  ok (
    (
      SELECT
        approximate_row_count ('test_metrics')::INTEGER
    ) >= 4,
    'approximate_row_count should return >= 4'
  );


-- Test first/last aggregates
SELECT
  ok (
    (
      SELECT
        first (temperature, TIME)
      FROM
        test_metrics
    ) IS NOT NULL,
    'first() aggregate should work'
  );


SELECT
  ok (
    (
      SELECT
        last (temperature, TIME)
      FROM
        test_metrics
    ) IS NOT NULL,
    'last() aggregate should work'
  );


-- Test time_bucket_gapfill
SELECT
  ok (
    (
      SELECT
        count(*)
      FROM
        (
          SELECT
            time_bucket_gapfill ('1 hour', TIME) AS bucket,
            device_id,
            avg(temperature) AS avg_temp
          FROM
            test_metrics
          WHERE
            TIME > now() - INTERVAL '6 hours'
          GROUP BY
            bucket,
            device_id
        ) AS gapfilled
    ) >= 2,
    'time_bucket_gapfill should work'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;