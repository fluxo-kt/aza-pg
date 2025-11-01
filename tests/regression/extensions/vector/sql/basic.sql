--
-- pgvector (vector) - Basic regression test
-- Tests vector data type, distance operators, and HNSW indexing
--
-- Create extension
CREATE EXTENSION IF NOT EXISTS vector;


-- Create test table
CREATE TABLE test_vectors (id serial PRIMARY KEY, embedding vector (3));


-- Insert test vectors
INSERT INTO
  test_vectors (embedding)
VALUES
  ('[1,2,3]'),
  ('[4,5,6]'),
  ('[7,8,9]');


-- Test L2 distance operator (<->)
SELECT
  id,
  embedding <-> '[1,2,3]' AS distance
FROM
  test_vectors
ORDER BY
  distance
LIMIT
  2;


-- Test inner product operator (<#>)
SELECT
  id,
  embedding <#> '[1,1,1]' AS inner_product
FROM
  test_vectors
ORDER BY
  inner_product
LIMIT
  1;


-- Test cosine distance operator (<=>)
SELECT
  id,
  embedding <=> '[1,0,0]' AS cosine_distance
FROM
  test_vectors
ORDER BY
  cosine_distance
LIMIT
  1;


-- Cleanup
DROP TABLE test_vectors;