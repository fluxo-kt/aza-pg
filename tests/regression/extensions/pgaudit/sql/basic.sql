--
-- pgaudit - Basic regression test
-- Tests extension availability and configuration
--
-- Verify extension is preloaded
SELECT
  extname
FROM
  pg_extension
WHERE
  extname = 'pgaudit';


-- Verify pgaudit settings are available
SELECT
  count(*)
FROM
  pg_settings
WHERE
  name LIKE 'pgaudit.%';


-- Test configuration (session-level)
SET
  pgaudit.log = 'read';


SHOW pgaudit.log;


-- Test log class configuration
SET
  pgaudit.log = 'write, ddl';


SHOW pgaudit.log;


-- Reset configuration
RESET pgaudit.log;


SHOW pgaudit.log;