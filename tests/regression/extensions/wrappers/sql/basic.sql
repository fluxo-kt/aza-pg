--
-- wrappers - Basic regression test
-- Tests Supabase FDW framework infrastructure (no external connections)
--

-- Verify extension is installed
SELECT
  extname,
  extversion
FROM
  pg_extension
WHERE
  extname = 'wrappers';


-- Verify pg_stat_statements dependency (required by wrappers)
SELECT
  extname
FROM
  pg_extension
WHERE
  extname = 'pg_stat_statements';


-- Verify wrappers_fdw_stats table exists
SELECT
  count(*)
FROM
  pg_tables
WHERE
  tablename = 'wrappers_fdw_stats'
  AND schemaname = 'public';


-- Check wrappers_fdw_stats table structure
SELECT
  column_name,
  data_type
FROM
  information_schema.columns
WHERE
  table_name = 'wrappers_fdw_stats'
ORDER BY
  ordinal_position;


-- Verify extension is in available extensions catalog
SELECT
  name,
  default_version IS NOT NULL AS has_default_version
FROM
  pg_available_extensions
WHERE
  name = 'wrappers';


-- Count wrappers-related objects in pg_class
SELECT
  count(*) > 0 AS has_wrappers_objects
FROM
  pg_class
WHERE
  relname LIKE 'wrappers%';
