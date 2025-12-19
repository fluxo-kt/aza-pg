--
-- supabase_vault - Basic regression test
-- Tests vault infrastructure and pgsodium integration
--
-- Create pgsodium first (dependency)
CREATE EXTENSION IF NOT EXISTS pgsodium;


-- Create supabase_vault extension
CREATE EXTENSION IF NOT EXISTS supabase_vault;


-- Test 1: Verify both extensions are loaded
SELECT
  extname,
  extversion
FROM
  pg_extension
WHERE
  extname IN ('pgsodium', 'supabase_vault')
ORDER BY
  extname;


-- Test 2: Verify vault schema exists
SELECT
  schema_name
FROM
  information_schema.schemata
WHERE
  schema_name = 'vault';


-- Test 3: Verify vault.secrets table exists
SELECT
  table_name
FROM
  information_schema.tables
WHERE
  table_schema = 'vault'
  AND table_name = 'secrets';


-- Test 4: Verify vault schema objects (tables + views)
SELECT
  count(*) > 0 AS has_vault_objects
FROM
  information_schema.tables
WHERE
  table_schema = 'vault';


-- Test 5: Verify vault functions exist
SELECT
  count(*) > 0 AS has_vault_functions
FROM
  pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE
  n.nspname = 'vault';


-- Test 6: Verify critical vault functions are available
SELECT
  proname
FROM
  pg_proc
WHERE
  pronamespace = 'vault'::regnamespace
  AND proname IN ('create_secret', 'read_secret', 'update_secret', 'delete_secret')
ORDER BY
  proname;


-- Test 7: Verify pgsodium crypto functions available (vault dependency)
SELECT
  count(*) AS crypto_functions
FROM
  pg_proc
WHERE
  pronamespace = 'pgsodium'::regnamespace
  AND proname LIKE 'crypto_%';
