-- hll Extension Basic Functionality Test
-- Tests cardinality estimation for analytics workloads

CREATE EXTENSION IF NOT EXISTS hll;

-- Test 1: Verify extension loaded
SELECT extname, extversion FROM pg_extension WHERE extname = 'hll';

-- Test 2: Verify hll type exists
SELECT typname FROM pg_type WHERE typname = 'hll';

-- Test 3: Create test table with hll column
CREATE TABLE test_hll (
    id SERIAL PRIMARY KEY,
    users hll
);

-- Test 4: Insert HLL sketches
INSERT INTO test_hll (users) VALUES
    (hll_empty()),
    (hll_add(hll_empty(), hll_hash_text('user1'))),
    (hll_add(hll_add(hll_empty(), hll_hash_text('user1')), hll_hash_text('user2')));

-- Test 5: Test cardinality estimation
SELECT id, hll_cardinality(users)::int AS estimated_cardinality
FROM test_hll
ORDER BY id;

-- Test 6: Test HLL union operation
SELECT hll_cardinality(hll_union_agg(users))::int AS total_unique
FROM test_hll;

-- Test 7: Test HLL with larger dataset
CREATE TABLE test_events (
    event_id SERIAL,
    user_id TEXT,
    day DATE
);

INSERT INTO test_events (user_id, day)
SELECT
    'user_' || (i % 100),
    '2024-01-01'::date + (i % 7)
FROM generate_series(1, 500) i;

-- Test 8: Aggregate HLL sketches per day
CREATE TABLE daily_users AS
SELECT
    day,
    hll_add_agg(hll_hash_text(user_id)) AS user_sketch
FROM test_events
GROUP BY day;

-- Test 9: Verify daily unique counts
SELECT
    day,
    hll_cardinality(user_sketch)::int AS unique_users
FROM daily_users
ORDER BY day;

-- Test 10: Test HLL union across days (weekly unique)
SELECT hll_cardinality(hll_union_agg(user_sketch))::int AS weekly_unique
FROM daily_users;

-- Test 11: Verify hll functions exist
SELECT count(*) > 10 AS has_multiple_functions
FROM pg_proc
WHERE proname LIKE 'hll_%';

-- Test 12: Test HLL schema_version (verify different sketch types work)
SELECT hll_schema_version(hll_empty());

-- Test 13: Test hll_type for different sketches
SELECT
    id,
    hll_type(users) AS sketch_type
FROM test_hll
ORDER BY id;

-- Cleanup
DROP TABLE test_hll;
DROP TABLE test_events;
DROP TABLE daily_users;
