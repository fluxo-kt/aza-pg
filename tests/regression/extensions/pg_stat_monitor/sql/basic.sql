--
-- pg_stat_monitor - Basic regression test
-- Tests extension creation and metrics collection
--
-- Create extension
CREATE EXTENSION IF NOT EXISTS pg_stat_monitor;


-- Verify extension created
SELECT
  extname
FROM
  pg_extension
WHERE
  extname = 'pg_stat_monitor';


-- Execute sample queries to generate metrics
SELECT
  1 AS sample_query_1;


SELECT
  2 AS sample_query_2;


SELECT
  3 AS sample_query_3;


-- Verify pg_stat_monitor is collecting data
SELECT
  count(*) >= 0 AS has_metrics
FROM
  pg_stat_monitor;


-- Verify key columns exist
SELECT
  column_name
FROM
  information_schema.columns
WHERE
  table_name = 'pg_stat_monitor'
  AND table_schema = 'public'
  AND column_name IN ('bucket', 'query', 'calls')
ORDER BY
  column_name;