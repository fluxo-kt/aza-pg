-- Test: Schema and Database Objects
-- Verifies core PostgreSQL schema functionality and object creation
BEGIN;


SELECT
  plan (20);


-- Test schema operations
SELECT
  has_schema ('public', 'public schema should exist');


SELECT
  schema_owner_is ('public', 'postgres', 'public schema should be owned by postgres');


-- Create test schema
CREATE SCHEMA IF NOT EXISTS test_schema;


SELECT
  has_schema ('test_schema', 'test schema should be created');


-- Test table creation
CREATE TABLE test_schema.test_table (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


SELECT
  has_table ('test_schema', 'test_table', 'test table should exist');


SELECT
  has_pk ('test_schema', 'test_table', 'test table should have primary key');


SELECT
  has_column ('test_schema', 'test_table', 'id', 'id column should exist');


SELECT
  has_column ('test_schema', 'test_table', 'name', 'name column should exist');


SELECT
  has_column ('test_schema', 'test_table', 'email', 'email column should exist');


SELECT
  has_column ('test_schema', 'test_table', 'created_at', 'created_at column should exist');


SELECT
  col_not_null ('test_schema', 'test_table', 'name', 'name column should be NOT NULL');


SELECT
  col_is_unique ('test_schema', 'test_table', ARRAY['email'], 'email column should be UNIQUE');


-- Test index creation
CREATE INDEX idx_test_email ON test_schema.test_table (email);


SELECT
  has_index ('test_schema', 'test_table', 'idx_test_email', 'email index should exist');


-- Test view creation
CREATE VIEW test_schema.test_view AS
SELECT
  id,
  name,
  email
FROM
  test_schema.test_table
WHERE
  created_at > CURRENT_DATE - INTERVAL '30 days';


SELECT
  has_view ('test_schema', 'test_view', 'test view should exist');


-- Test function creation
CREATE OR REPLACE FUNCTION test_schema.get_user_count () RETURNS INTEGER AS $$
BEGIN
    RETURN (SELECT COUNT(*) FROM test_schema.test_table);
END;
$$ LANGUAGE plpgsql;


SELECT
  has_function ('test_schema', 'get_user_count', 'get_user_count function should exist');


SELECT
  function_lang_is ('test_schema', 'get_user_count', 'plpgsql', 'function should use plpgsql');


SELECT
  function_returns ('test_schema', 'get_user_count', 'integer', 'function should return integer');


-- Test trigger creation
CREATE OR REPLACE FUNCTION test_schema.update_timestamp () RETURNS TRIGGER AS $$
BEGIN
    NEW.created_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


CREATE TRIGGER trg_update_timestamp BEFORE
UPDATE ON test_schema.test_table FOR EACH ROW
EXECUTE FUNCTION test_schema.update_timestamp ();


SELECT
  has_trigger ('test_schema', 'test_table', 'trg_update_timestamp', 'trigger should exist');


-- Test data insertion and retrieval
INSERT INTO
  test_schema.test_table (name, email)
VALUES
  ('Alice', 'alice@example.com'),
  ('Bob', 'bob@example.com');


SELECT
  IS (
    (
      SELECT
        count(*)::INTEGER
      FROM
        test_schema.test_table
    ),
    2,
    'should have 2 rows inserted'
  );


SELECT
  IS (test_schema.get_user_count (), 2, 'get_user_count() should return 2');


SELECT
  *
FROM
  finish ();


ROLLBACK;