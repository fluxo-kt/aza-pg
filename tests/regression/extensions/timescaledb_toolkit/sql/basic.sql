--
-- timescaledb_toolkit - Basic regression test
-- Tests hyperfunction availability and basic operations
--
-- Create extension (requires timescaledb)
CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit;


-- Verify extension created
SELECT
  extname
FROM
  pg_extension
WHERE
  extname = 'timescaledb_toolkit';


-- Create test data
CREATE TEMP TABLE metrics (TIME TIMESTAMPTZ, value DOUBLE PRECISION);


INSERT INTO
  metrics (TIME, value)
SELECT
  '2025-01-01 00:00:00'::TIMESTAMPTZ + (i || ' hours')::INTERVAL,
  (i * 10.0) + random() * 5
FROM
  generate_series(1, 10) AS i;


-- Test approximate percentile
SELECT
  round(approx_percentile (0.5, percentile_agg (value))::NUMERIC, 2) AS median
FROM
  metrics;


-- Test statistical functions
SELECT
  round(average (stats_agg (value))::NUMERIC, 2) AS avg,
  round(stddev(stats_agg (value))::NUMERIC, 2) AS stddev
FROM
  metrics;


-- Cleanup (temp table auto-dropped)