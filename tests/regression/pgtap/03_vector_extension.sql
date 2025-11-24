-- Test: pgvector Extension Functionality
-- Verifies pgvector extension works correctly for vector similarity search

BEGIN;

SELECT plan(12);

-- Create extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Verify extension
SELECT has_extension('vector', 'vector extension should be installed');

-- Test vector type
CREATE TABLE test_vectors (
    id SERIAL PRIMARY KEY,
    embedding vector(3),
    description TEXT
);

SELECT has_table('public', 'test_vectors', 'test_vectors table should exist');
SELECT has_column('public', 'test_vectors', 'embedding', 'embedding column should exist');

-- Insert test data
INSERT INTO test_vectors (embedding, description) VALUES
    ('[1,2,3]', 'vector a'),
    ('[4,5,6]', 'vector b'),
    ('[7,8,9]', 'vector c');

SELECT is(
    (SELECT COUNT(*)::INTEGER FROM test_vectors),
    3,
    'should have 3 vectors inserted'
);

-- Test vector operations
SELECT ok(
    (SELECT embedding FROM test_vectors WHERE description = 'vector a') = '[1,2,3]'::vector,
    'vector a should match [1,2,3]'
);

-- Test L2 distance (Euclidean)
SELECT ok(
    (SELECT embedding <-> '[1,2,3]'::vector FROM test_vectors WHERE description = 'vector a') = 0,
    'L2 distance to itself should be 0'
);

-- Test inner product
SELECT ok(
    (SELECT (embedding <#> '[1,1,1]'::vector)::numeric::text FROM test_vectors WHERE description = 'vector a') = '-6',
    'inner product should work correctly'
);

-- Test cosine distance
SELECT ok(
    (SELECT embedding <=> '[2,4,6]'::vector FROM test_vectors WHERE description = 'vector a') < 0.1,
    'cosine distance should be small for similar vectors'
);

-- Test vector dimensions
SELECT is(
    (SELECT vector_dims(embedding) FROM test_vectors LIMIT 1),
    3,
    'vector dimensions should be 3'
);

-- Test index creation (IVFFlat)
CREATE INDEX idx_vectors_ivfflat ON test_vectors
    USING ivfflat (embedding vector_l2_ops)
    WITH (lists = 1);

SELECT has_index('public', 'test_vectors', 'idx_vectors_ivfflat', 'IVFFlat index should exist');

-- Test similarity search with index
SET enable_seqscan = off;

SELECT is(
    (SELECT description FROM test_vectors ORDER BY embedding <-> '[1.1,2.1,3.1]'::vector LIMIT 1),
    'vector a',
    'similarity search should return closest vector'
);

-- Test vector normalization
SELECT ok(
    abs((SELECT embedding <=> '[1,2,3]'::vector FROM test_vectors WHERE description = 'vector a') - 0) < 0.001,
    'cosine distance to itself should be ~0'
);

SELECT * FROM finish();

ROLLBACK;
