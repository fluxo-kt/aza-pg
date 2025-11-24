-- Test: Extension Availability
-- Verifies that all enabled extensions are available and can be created

BEGIN;

SELECT plan(15);

-- Extension: pgTAP itself
SELECT has_extension('pgtap', 'pgTAP extension should be available');

-- Core extensions (always available)
SELECT has_extension('plpgsql', 'plpgsql extension should be available');
SELECT has_extension('pg_stat_statements', 'pg_stat_statements extension should be available');
SELECT has_extension('pgaudit', 'pgaudit extension should be available');

-- Vector search
SELECT has_extension('vector', 'pgvector extension should be available');

-- Time-series
SELECT has_extension('timescaledb', 'TimescaleDB extension should be available');

-- Message queue
SELECT has_extension('pgmq', 'pgmq extension should be available');

-- Job scheduling
SELECT has_extension('pg_cron', 'pg_cron extension should be available');

-- Monitoring
SELECT has_extension('pg_stat_monitor', 'pg_stat_monitor extension should be available');

-- Hypothetical indexes
SELECT has_extension('hypopg', 'hypopg extension should be available');

-- Encryption
SELECT has_extension('pgsodium', 'pgsodium extension should be available');

-- Full-text search
SELECT has_extension('pg_trgm', 'pg_trgm extension should be available');

-- Graph analytics (if enabled in regression mode)
SELECT CASE
  WHEN current_setting('server_version_num')::int >= 180000 THEN
    CASE
      WHEN EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'age')
      THEN has_extension('age', 'Apache AGE extension should be available')
      ELSE pass('Apache AGE not available in production mode')
    END
  ELSE pass('Apache AGE requires PostgreSQL 18+')
END;

-- Message broker (if enabled in regression mode)
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pgq')
  THEN has_extension('pgq', 'pgq extension should be available')
  ELSE pass('pgq not available in production mode')
END;

-- Performance monitoring
SELECT has_extension('pg_qualstats', 'pg_qualstats extension should be available');

SELECT * FROM finish();

ROLLBACK;
