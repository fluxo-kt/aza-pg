--
-- pgq (PgQ) - Basic regression test
-- Tests queue creation and event operations
--
-- Create extension
CREATE EXTENSION IF NOT EXISTS pgq;


-- Verify extension created in pg_catalog
SELECT
  extname
FROM
  pg_extension
WHERE
  extname = 'pgq';


-- Create test queue
SELECT
  pgq.create_queue ('test_pgq_queue');


-- Verify queue exists
SELECT
  queue_name
FROM
  pgq.get_queue_info ()
WHERE
  queue_name = 'test_pgq_queue';


-- Register consumer
SELECT
  pgq.register_consumer ('test_pgq_queue', 'test_consumer');


-- Insert event into queue
SELECT
  pgq.insert_event ('test_pgq_queue', 'test_event', 'test_data');


-- Get next batch for consumer
SELECT
  batch_id > 0 AS has_batch
FROM
  pgq.next_batch ('test_pgq_queue', 'test_consumer');


-- Cleanup: unregister consumer and drop queue
SELECT
  pgq.unregister_consumer ('test_pgq_queue', 'test_consumer');


SELECT
  pgq.drop_queue ('test_pgq_queue');


-- Verify queue dropped
SELECT
  count(*) = 0 AS queue_dropped
FROM
  pgq.get_queue_info ()
WHERE
  queue_name = 'test_pgq_queue';