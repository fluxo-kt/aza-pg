-- pg_partman Extension Basic Functionality Test
-- Tests table partitioning and maintenance automation

CREATE EXTENSION IF NOT EXISTS pg_partman;

-- Test 1: Verify extension loaded
SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_partman';

-- Test 2: Verify partman schema exists
SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'partman';

-- Test 3: Verify part_config table exists (core partman metadata)
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'part_config';

-- Test 4: Verify key pg_partman functions exist
SELECT count(*) >= 3 AS has_core_functions
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname IN ('create_parent', 'run_maintenance', 'undo_partition');

-- Test 5: Create test partitioned table
CREATE TABLE test_partitioned (
    id SERIAL,
    created_at TIMESTAMPTZ NOT NULL,
    data TEXT,
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Test 6: Use pg_partman to create partitions
SELECT public.create_parent(
    p_parent_table := 'public.test_partitioned',
    p_control := 'created_at',
    p_interval := '1 day',
    p_premake := 2
);

-- Test 7: Verify partitions were created (premake=2 creates 2 future partitions)
SELECT count(*) >= 2 AS has_partitions
FROM pg_tables
WHERE tablename LIKE 'test_partitioned_p%';

-- Test 8: Verify part_config entry was created with correct settings
SELECT parent_table, partition_interval, premake
FROM public.part_config
WHERE parent_table = 'public.test_partitioned';

-- Test 9: Insert test data to verify partition routing works
INSERT INTO test_partitioned (created_at, data)
VALUES (now(), 'test data');

-- Test 10: Verify data was inserted successfully
SELECT count(*) = 1 AS data_inserted
FROM test_partitioned;

-- Cleanup (DROP CASCADE removes partitions and parent table)
DROP TABLE IF EXISTS test_partitioned CASCADE;
DELETE FROM public.part_config WHERE parent_table = 'public.test_partitioned';
