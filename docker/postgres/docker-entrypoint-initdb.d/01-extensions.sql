-- PostgreSQL initialization: Create extensions
-- Runs automatically on first container start

-- pgvector: Vector similarity search for embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- pg_trgm: Trigram text search for fuzzy matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- pg_cron: Database job scheduler (requires shared_preload_libraries)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- pgAudit: Audit logging for compliance (requires shared_preload_libraries)
CREATE EXTENSION IF NOT EXISTS pgaudit;

-- pg_stat_statements: Query performance monitoring (requires shared_preload_libraries)
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Additional useful extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "btree_gin";
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- Verify extensions
DO $body$
DECLARE
    ext_count integer;
BEGIN
    SELECT COUNT(*) INTO ext_count
    FROM pg_extension
    WHERE extname IN ('vector', 'pg_trgm', 'pg_cron', 'pgaudit', 'pg_stat_statements', 'uuid-ossp', 'btree_gin', 'btree_gist');

    IF ext_count < 8 THEN
        RAISE EXCEPTION 'Required extensions not installed correctly. Expected 8, found %', ext_count;
    END IF;

    RAISE NOTICE 'Extensions installed successfully: vector, pg_trgm, pg_cron, pgaudit, pg_stat_statements, uuid-ossp, btree_gin, btree_gist';
END $body$;
