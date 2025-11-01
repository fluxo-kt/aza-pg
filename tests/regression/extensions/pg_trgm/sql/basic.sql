--
-- pg_trgm - Basic regression test
-- Tests trigram similarity and GIN index functionality
--
-- Create extension
CREATE EXTENSION IF NOT EXISTS pg_trgm;


-- Test similarity function (deterministic inputs)
SELECT
  similarity ('hello', 'helo');


-- Test similarity with exact match
SELECT
  similarity ('test', 'test');


-- Create test table
CREATE TABLE test_trgm (id serial PRIMARY KEY, text_col TEXT);


-- Insert test data
INSERT INTO
  test_trgm (text_col)
VALUES
  ('hello world'),
  ('hello universe'),
  ('goodbye world');


-- Create GIN trigram index
CREATE INDEX test_trgm_idx ON test_trgm USING GIN (text_col gin_trgm_ops);


-- Test trigram similarity query
SELECT
  text_col
FROM
  test_trgm
WHERE
  text_col % 'helo wrld'
ORDER BY
  similarity (text_col, 'helo wrld') DESC;


-- Cleanup
DROP TABLE test_trgm;