--
-- pg_net - Basic regression test
-- Tests HTTP request capability (critical for pgflow integration)
-- Note: Tests focus on metadata validation without requiring network access
--
-- Verify extension is loaded
SELECT
  extname
FROM
  pg_extension
WHERE
  extname = 'pg_net';


-- Verify net schema exists
SELECT
  count(*)
FROM
  information_schema.schemata
WHERE
  schema_name = 'net';


-- Verify core HTTP functions exist (http_get, http_post, http_delete)
SELECT
  count(*)
FROM
  pg_proc
WHERE
  pronamespace = 'net'::regnamespace
  AND proname IN ('http_get', 'http_post', 'http_delete');


-- Verify net._http_response table exists (stores async responses)
SELECT
  count(*)
FROM
  pg_tables
WHERE
  schemaname = 'net'
  AND tablename = '_http_response';


-- Verify http_post function signature includes url parameter (key for pgflow integration)
SELECT
  pg_get_functiondef ('net.http_post'::regproc) LIKE '%url%' AS has_url_param;


-- Verify net.check_worker_is_up function exists (health check capability)
SELECT
  count(*)
FROM
  pg_proc
WHERE
  pronamespace = 'net'::regnamespace
  AND proname = 'check_worker_is_up';
