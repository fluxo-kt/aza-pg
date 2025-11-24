-- Test: Security and Permissions
-- Verifies security features, roles, and permission management
BEGIN;


SELECT
  plan (20);


-- Test default roles
SELECT
  has_role ('postgres', 'postgres role should exist');


SELECT
  is_superuser ('postgres', 'postgres should be superuser');


-- Create test role
CREATE ROLE test_user
WITH
  LOGIN PASSWORD 'test_password';


SELECT
  has_role ('test_user', 'test_user role should be created');


SELECT
  isnt_superuser ('test_user', 'test_user should not be superuser');


-- Test schema permissions
CREATE SCHEMA IF NOT EXISTS test_security;


SELECT
  has_schema ('test_security', 'test_security schema should exist');


GRANT USAGE ON SCHEMA test_security TO test_user;


SELECT
  schema_privs_are (
    'test_security',
    'test_user',
    ARRAY['USAGE'],
    'test_user should have USAGE on test_security schema'
  );


-- Test table permissions
CREATE TABLE test_security.sensitive_data (id SERIAL PRIMARY KEY, data TEXT NOT NULL);


SELECT
  has_table ('test_security', 'sensitive_data', 'sensitive_data table should exist');


GRANT
SELECT
  ON test_security.sensitive_data TO test_user;


SELECT
  table_privs_are (
    'test_security',
    'sensitive_data',
    'test_user',
    ARRAY['SELECT'],
    'test_user should have only SELECT on sensitive_data'
  );


-- Test row-level security (RLS)
ALTER TABLE test_security.sensitive_data ENABLE ROW LEVEL SECURITY;


SELECT
  ok (
    (
      SELECT
        rowsecurity
      FROM
        pg_tables
      WHERE
        schemaname = 'test_security'
        AND tablename = 'sensitive_data'
    ),
    'RLS should be enabled on sensitive_data'
  );


-- Create RLS policy
CREATE POLICY user_data_policy ON test_security.sensitive_data FOR
SELECT
  TO test_user USING (current_user = 'test_user');


SELECT
  ok (
    (
      SELECT
        count(*)
      FROM
        pg_policies
      WHERE
        schemaname = 'test_security'
        AND tablename = 'sensitive_data'
        AND policyname = 'user_data_policy'
    ) = 1,
    'RLS policy should be created'
  );


-- Test function security
CREATE OR REPLACE FUNCTION test_security.secure_function () RETURNS TEXT SECURITY DEFINER
SET
  search_path = pg_catalog,
  pg_temp AS $$
BEGIN
    RETURN 'secure result';
END;
$$ LANGUAGE plpgsql;


SELECT
  has_function ('test_security', 'secure_function', 'secure_function should exist');


-- Test pgcrypto extension (if available)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pgcrypto') THEN
        CREATE EXTENSION IF NOT EXISTS pgcrypto;
    END IF;
END $$;


SELECT
  CASE
    WHEN EXISTS (
      SELECT
        1
      FROM
        pg_extension
      WHERE
        extname = 'pgcrypto'
    ) THEN pass ('pgcrypto extension loaded')
    ELSE skip ('pgcrypto extension not available', 1)
  END;


-- Test password encryption (if pgcrypto available)
SELECT
  CASE
    WHEN EXISTS (
      SELECT
        1
      FROM
        pg_extension
      WHERE
        extname = 'pgcrypto'
    ) THEN ok (
      crypt ('test_password', gen_salt ('bf')) != 'test_password',
      'password should be encrypted'
    )
    ELSE skip ('pgcrypto not available for password test', 1)
  END;


-- Test SSL/TLS settings
SELECT
  ok (current_setting('ssl')::BOOLEAN IS NOT NULL, 'SSL setting should be defined');


-- Test connection limits
ALTER ROLE test_user CONNECTION
LIMIT
  10;


SELECT
  IS (
    (
      SELECT
        rolconnlimit
      FROM
        pg_roles
      WHERE
        rolname = 'test_user'
    ),
    10,
    'connection limit should be set to 10'
  );


-- Test password validity
ALTER ROLE test_user VALID UNTIL '2025-12-31';


SELECT
  ok (
    (
      SELECT
        rolvaliduntil
      FROM
        pg_roles
      WHERE
        rolname = 'test_user'
    ) IS NOT NULL,
    'password validity should be set'
  );


-- Test pg_read_all_data role (PostgreSQL 14+)
SELECT
  CASE
    WHEN current_setting('server_version_num')::INT >= 140000 THEN has_role ('pg_read_all_data', 'pg_read_all_data role should exist')
    ELSE skip ('pg_read_all_data requires PostgreSQL 14+', 1)
  END;


-- Test pg_write_all_data role (PostgreSQL 14+)
SELECT
  CASE
    WHEN current_setting('server_version_num')::INT >= 140000 THEN has_role ('pg_write_all_data', 'pg_write_all_data role should exist')
    ELSE skip ('pg_write_all_data requires PostgreSQL 14+', 1)
  END;


-- Test default privileges
ALTER DEFAULT PRIVILEGES IN SCHEMA test_security
GRANT
SELECT
  ON TABLES TO test_user;


SELECT
  ok (
    (
      SELECT
        count(*)
      FROM
        pg_default_acl
      WHERE
        defaclnamespace = (
          SELECT
            oid
          FROM
            pg_namespace
          WHERE
            nspname = 'test_security'
        )
    ) >= 1,
    'default privileges should be set'
  );


-- Test audit logging (pgaudit extension)
SELECT
  has_extension ('pgaudit', 'pgaudit extension should be available');


-- Cleanup
DROP ROLE test_user;


SELECT
  *
FROM
  finish ();


ROLLBACK;