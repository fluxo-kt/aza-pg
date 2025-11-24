--
-- timescaledb - Basic regression test
-- Tests hypertable creation and time-series functionality
--
-- Create extension
CREATE EXTENSION IF NOT EXISTS timescaledb;


-- Verify timescaledb is loaded
SELECT
  extname,
  extversion
FROM
  pg_extension
WHERE
  extname = 'timescaledb';


-- Create test table
CREATE TABLE test_metrics (TIME TIMESTAMPTZ NOT NULL, device_id INTEGER, value DOUBLE PRECISION);


-- Create hypertable
SELECT
  create_hypertable ('test_metrics', 'time', if_not_exists => TRUE);


-- Insert test data
INSERT INTO
  test_metrics (TIME, device_id, value)
SELECT
  '2025-01-01 00:00:00'::TIMESTAMPTZ + (i || ' hours')::INTERVAL,
  (i % 5) + 1,
  random() * 100
FROM
  generate_series(1, 10) AS i;


-- Query data
SELECT
  device_id,
  count(*),
  round(avg(value)::NUMERIC, 2) AS avg_value
FROM
  test_metrics
GROUP BY
  device_id
ORDER BY
  device_id;


-- Cleanup
DROP TABLE test_metrics CASCADE;