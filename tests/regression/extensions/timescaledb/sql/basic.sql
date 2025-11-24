--
-- timescaledb - Basic regression test
-- Tests hypertable creation and time-series functionality
--
-- Create extension
CREATE EXTENSION IF NOT EXISTS timescaledb;


-- Verify timescaledb is loaded
SELECT
  extname
FROM
  pg_extension
WHERE
  extname = 'timescaledb';


-- Create test table (use unique name to avoid conflicts)
DROP TABLE IF EXISTS regression_test_metrics CASCADE;
CREATE TABLE regression_test_metrics (TIME TIMESTAMPTZ NOT NULL, device_id INTEGER, value DOUBLE PRECISION);


-- Create hypertable (returns table info - just verify it succeeds)
SELECT
  hypertable_name
FROM
  create_hypertable ('regression_test_metrics', 'time', if_not_exists => TRUE);


-- Insert test data with deterministic values
INSERT INTO
  regression_test_metrics (TIME, device_id, value)
VALUES
  ('2025-01-01 01:00:00'::TIMESTAMPTZ, 1, 10.0),
  ('2025-01-01 02:00:00'::TIMESTAMPTZ, 2, 20.0),
  ('2025-01-01 03:00:00'::TIMESTAMPTZ, 3, 30.0),
  ('2025-01-01 04:00:00'::TIMESTAMPTZ, 4, 40.0),
  ('2025-01-01 05:00:00'::TIMESTAMPTZ, 5, 50.0),
  ('2025-01-01 06:00:00'::TIMESTAMPTZ, 1, 15.0),
  ('2025-01-01 07:00:00'::TIMESTAMPTZ, 2, 25.0),
  ('2025-01-01 08:00:00'::TIMESTAMPTZ, 3, 35.0),
  ('2025-01-01 09:00:00'::TIMESTAMPTZ, 4, 45.0),
  ('2025-01-01 10:00:00'::TIMESTAMPTZ, 5, 55.0);


-- Query data (deterministic results now)
SELECT
  device_id,
  count(*),
  round(avg(value)::NUMERIC, 2) AS avg_value
FROM
  regression_test_metrics
GROUP BY
  device_id
ORDER BY
  device_id;


-- Cleanup
DROP TABLE regression_test_metrics CASCADE;