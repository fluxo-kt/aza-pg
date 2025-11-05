-- PostgreSQL initialization: enable baseline extensions
-- Runs automatically on first cluster start.

-- Core observability & safety extensions pre-enabled by default.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgaudit;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS vector;

DO $$
BEGIN
  RAISE NOTICE 'Baseline extensions enabled (pg_stat_statements, pg_trgm, pgaudit, pg_cron, vector). Additional extensions are available but disabled by default.';
END;
$$;
