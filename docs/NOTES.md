# Notes & Ideas

- Queues/Workflows
    - https://www.perplexity.ai/search/S7BepfFYQPCa5Kj2C4qzNg
    - PGQ - Generic Queue for PostgreSQL (extension)
        - https://x.com/cyberdemn/status/1983259467593724229
        - https://github.com/pgq/pgq
    - pgmq - A lightweight message queue. Like AWS SQS and RSMQ but on Postgres (extension)
        - https://github.com/pgmq/pgmq
    - **pg-boss** - A simple, robust, and performant message queue for Node.js
        - https://github.com/timgit/pg-boss
    - **pgflow** - Postgres-centric workflow engine with optional deep integration with Supabase
        - https://github.com/pgflow-dev/pgflow
        - https://www.pgflow.dev
- PG Admin panels (Mathesar, Kottster, NocoDB, Baserow, Directus, pgAdmin, Apache Superset, Metabase) - https://www.perplexity.ai/search/gIhJG0_pS163fBGawdd3Mw
- PG extensions
    - **https://www.perplexity.ai/search/1Hg1uD3dQM6R0evCT1nIUw**
    - **https://github.com/supabase/postgres#postgresql-17-extensions**
    - Supabase PG extensions used: https://arc.net/l/quote/dzmqgqng
    - Realtime (WS polling for PG changes)
        - https://github.com/supabase/realtime
    - Citus (distributed PG via extension)
        - https://github.com/citusdata/citus
        - Popular Postgres extensions frequently used with Citus include Patroni, HyperLogLog (HLL), PostGIS, TopN, hstore, pg stat statements, dblink, plpgsql, uuid ossp, ltree, pgvector, & more.
    - pg_cron (cron)
        - https://github.com/citusdata/pg_cron
    - HyperLogLog data type, A probabilistic cardinality estimator (distinct count). Typically 1.2KB estimates billions of distinct values with ±4% error.
        - https://github.com/citusdata/postgresql-hll
        - https://agkn.wordpress.com/2012/10/25/sketch-of-the-day-hyperloglog-cornerstone-of-a-big-data-infrastructure/
        - https://www.perplexity.ai/search/WbkgpqlXTA6xezeIR7hQvA
    - TimescaleDB (time-series)
        - https://github.com/timescale/timescaledb
        - https://www.perplexity.ai/search/9.KYLcoRQ2.14fkjE3ss4w
    - PostGIS (geospatial)
        - https://github.com/postgis/postgis
    - PartMan - Partition management
        - https://github.com/pgpartman/pg_partman
- Backup/Monitoring
    - https://github.com/RostislavDugin/postgresus
    - https://github.com/postgres-ai/postgres_ai
- https://github.com/mayfer/dbpill (the Postgres proxy that automates index optimization)


Container publication
  - https://www.perplexity.ai/search/lhedbwYNQ96GWFPGZilJXA
  - private repo with public GHCR container