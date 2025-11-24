--
-- pgrouting - Basic regression test
-- Tests routing graph and Dijkstra shortest path algorithm
--
-- Create extension (requires postgis)
CREATE EXTENSION IF NOT EXISTS pgrouting CASCADE;


-- Verify extension created
SELECT
  extname
FROM
  pg_extension
WHERE
  extname = 'pgrouting';


-- Create simple network graph
CREATE TABLE test_routing (id serial PRIMARY KEY, source INTEGER, target INTEGER, cost DOUBLE PRECISION);


-- Insert test edges
INSERT INTO
  test_routing (source, target, cost)
VALUES
  (1, 2, 1.0),
  (2, 3, 2.0),
  (1, 3, 5.0),
  (3, 4, 1.0);


-- Test Dijkstra shortest path (1 -> 4)
SELECT
  seq,
  node,
  edge,
  cost
FROM
  pgr_dijkstra ('SELECT id, source, target, cost FROM test_routing', 1, 4, FALSE)
ORDER BY
  seq;


-- Cleanup
DROP TABLE test_routing;