--
-- pgmq - Basic regression test
-- Tests queue creation, message send/read operations
--
-- Create extension
CREATE EXTENSION IF NOT EXISTS pgmq;


-- Verify extension created
SELECT
  extname
FROM
  pg_extension
WHERE
  extname = 'pgmq';


-- Create queue
SELECT
  pgmq.create ('test_queue');


-- Verify queue exists
SELECT
  queue_name
FROM
  pgmq.list_queues ()
WHERE
  queue_name = 'test_queue';


-- Send message
SELECT
  pgmq.send ('test_queue', '{"task": "test", "id": 123}'::JSONB) AS msg_id;


-- Read message (with 5 second visibility timeout)
SELECT
  msg_id > 0 AS has_message
FROM
  pgmq.read ('test_queue', 5, 1);


-- Drop queue (cleanup)
SELECT
  pgmq.drop_queue ('test_queue');


-- Verify queue dropped
SELECT
  count(*) = 0 AS queue_dropped
FROM
  pgmq.list_queues ()
WHERE
  queue_name = 'test_queue';