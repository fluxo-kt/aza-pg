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


-- Create test data with deterministic values
CREATE TEMP TABLE metrics (TIME TIMESTAMPTZ, value DOUBLE PRECISION);


INSERT INTO
  metrics (TIME, value)
VALUES
  ('2025-01-01 01:00:00'::TIMESTAMPTZ, 12.5),
  ('2025-01-01 02:00:00'::TIMESTAMPTZ, 22.5),
  ('2025-01-01 03:00:00'::TIMESTAMPTZ, 32.5),
  ('2025-01-01 04:00:00'::TIMESTAMPTZ, 42.5),
  ('2025-01-01 05:00:00'::TIMESTAMPTZ, 52.5),
  ('2025-01-01 06:00:00'::TIMESTAMPTZ, 62.5),
  ('2025-01-01 07:00:00'::TIMESTAMPTZ, 72.5),
  ('2025-01-01 08:00:00'::TIMESTAMPTZ, 82.5),
  ('2025-01-01 09:00:00'::TIMESTAMPTZ, 92.5),
  ('2025-01-01 10:00:00'::TIMESTAMPTZ, 102.5);


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