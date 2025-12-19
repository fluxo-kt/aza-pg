-- vectorscale Extension Basic Functionality Test
-- Tests AI/ML vector operations (depends on pgvector)

-- vectorscale requires pgvector
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS vectorscale;

-- Test 1: Verify extensions loaded
SELECT extname, extversion FROM pg_extension
WHERE extname IN ('vector', 'vectorscale')
ORDER BY extname;

-- Test 2: Verify vectorscale schema exists
SELECT count(*) > 0 AS has_vectorscale_schema
FROM pg_namespace
WHERE nspname = 'vectorscale';

-- Test 3: Verify vectorscale functions exist
SELECT count(*) > 0 AS has_functions
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'vectorscale';

-- Test 4: Create test table with vector column
CREATE TABLE test_vectors (
    id SERIAL PRIMARY KEY,
    embedding vector(3),
    metadata TEXT
);

-- Test 5: Insert test vectors
INSERT INTO test_vectors (embedding, metadata) VALUES
    ('[1,2,3]'::vector, 'first'),
    ('[4,5,6]'::vector, 'second'),
    ('[7,8,9]'::vector, 'third'),
    ('[2,3,4]'::vector, 'fourth'),
    ('[5,6,7]'::vector, 'fifth');

-- Test 6: Test cosine similarity search (pgvector operator)
-- Using <=> for cosine distance (1 - cosine similarity)
SELECT id, metadata, embedding <=> '[1,2,3]'::vector AS cosine_distance
FROM test_vectors
ORDER BY cosine_distance
LIMIT 3;

-- Test 7: Test L2 distance (Euclidean)
SELECT id, metadata, embedding <-> '[1,2,3]'::vector AS l2_distance
FROM test_vectors
ORDER BY l2_distance
LIMIT 3;

-- Test 8: Test inner product (negative for max-heap)
SELECT id, metadata, embedding <#> '[1,2,3]'::vector AS neg_inner_product
FROM test_vectors
ORDER BY neg_inner_product
LIMIT 3;

-- Test 9: Create StreamingDiskANN index (vectorscale-specific)
-- This is the key feature of vectorscale - optimized indexing for large-scale vectors
CREATE INDEX ON test_vectors USING diskann (embedding);

-- Test 10: Verify index created
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'test_vectors'
  AND indexdef LIKE '%diskann%';

-- Test 11: Test query with index (should use DiskANN)
-- Same cosine similarity query, but now with index
SELECT id, metadata
FROM test_vectors
ORDER BY embedding <=> '[1,2,3]'::vector
LIMIT 2;

-- Test 12: Vector operations work correctly
SELECT
    '[1,0,0]'::vector <=> '[1,0,0]'::vector AS identical_vectors,
    '[1,0,0]'::vector <=> '[0,1,0]'::vector AS orthogonal_vectors;

-- Cleanup
DROP TABLE test_vectors;

-- Test 13: Verify cleanup
SELECT count(*) AS remaining_test_tables
FROM pg_tables
WHERE tablename = 'test_vectors';
