--
-- postgis - Basic regression test
-- Tests spatial data types and basic operations
--
-- Create extension
CREATE EXTENSION IF NOT EXISTS postgis;


-- Verify PostGIS version available
SELECT
  length(PostGIS_Version ()) > 0 AS postgis_installed;


-- Test basic geometry creation
SELECT
  ST_AsText (ST_GeomFromText ('POINT(1 1)'));


-- Create test table
CREATE TABLE test_postgis (id serial PRIMARY KEY, name TEXT, geom geometry (Point, 4326));


-- Insert test points
INSERT INTO
  test_postgis (name, geom)
VALUES
  ('Point A', ST_SetSRID (ST_MakePoint (-71.060316, 48.432044), 4326)),
  ('Point B', ST_SetSRID (ST_MakePoint (-71.050000, 48.430000), 4326));


-- Test spatial distance query (within 5km)
SELECT
  name,
  ST_Distance (geom::geography, ST_SetSRID (ST_MakePoint (-71.055, 48.431), 4326)::geography) < 5000 AS within_5km
FROM
  test_postgis
ORDER BY
  name;


-- Create spatial index
CREATE INDEX test_postgis_geom_idx ON test_postgis USING GIST (geom);


-- Cleanup
DROP TABLE test_postgis;