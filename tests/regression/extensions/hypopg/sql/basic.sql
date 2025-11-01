--
-- hypopg - Basic regression test
-- Tests hypothetical index creation and visibility
--
-- Create extension
CREATE EXTENSION IF NOT EXISTS hypopg;


-- Create test table
CREATE TABLE test_hypopg (id serial PRIMARY KEY, value INTEGER);


-- Insert test data
INSERT INTO
  test_hypopg (value)
SELECT
  generate_series(1, 100);


-- Create hypothetical index
SELECT
  indexname
FROM
  hypopg_create_index ('CREATE INDEX ON test_hypopg (value)');


-- Verify hypothetical index exists (in same session)
SELECT
  count(*) > 0 AS hypo_index_exists
FROM
  hypopg_list_indexes;


-- Reset hypothetical indexes
SELECT
  hypopg_reset ();


-- Verify reset worked
SELECT
  count(*) = 0 AS hypo_indexes_cleared
FROM
  hypopg_list_indexes;


-- Cleanup
DROP TABLE test_hypopg;