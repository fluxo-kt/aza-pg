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
    - [EXTENSIONS.md](EXTENSIONS.md)
    - **https://www.perplexity.ai/search/1Hg1uD3dQM6R0evCT1nIUw**
    - Supabase PG extensions used:
        - **https://github.com/supabase/postgres#postgresql-17-extensions**
        - https://arc.net/l/quote/dzmqgqng
        - https://www.perplexity.ai/search/zGJi32hzSnywVRc6qbZLBg
    - Percona extensions:
        - https://www.percona.com/postgresql/software/postgresql-distribution#components_include
    - TigerData documented extensions:
        - https://www.tigerdata.com/learn/postgres-extensions
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
    - PartMan: Partition management
        - https://github.com/pgpartman/pg_partman
        - https://www.perplexity.ai/search/tA64IBQyRaOHfGmLFm0k8Q
    - pg_lake: Postgres for Iceberg and Data lakes
        - https://github.com/snowflake-labs/pg_lake
- Backup/Monitoring
    - https://github.com/RostislavDugin/postgresus
    - https://github.com/percona/pmm
    - https://github.com/percona/grafana-dashboards
    - https://github.com/postgres-ai/postgres_ai
    - https://github.com/supabase/etl
- Management
    - DbPill: Postgres proxy, automates index optimization
        - https://github.com/mayfer/dbpill
    - Percona Everest: cloud-native DB platform to deploy and manage database clusters
        - https://github.com/percona/everest
    - GUI
        - **pgadmin4**  
          Full-featured GUI for PostgreSQL: object browser, query tool, debugger, schema diff, ER diagrams, backup/restore, index management. Browser-based.  
          [source](https://github.com/pgadmin-org/pgadmin4)
- Balancing
    - **pgbouncer**  
      Connection pooler—maintains reusable server connections. Session/transaction/statement pooling modes. Essential for high-concurrency or microservice-heavy workloads.  
      [source](https://github.com/pgbouncer/pgbouncer)
    - **pgpool2**  
      Full-featured middleware: connection pooling, replication, load balancing, automatic failover, online recovery, watchdog (HA for pgpool itself). More complex than pgbouncer; use when all-in-one HA+replication needed.  
      [source](https://github.com/pgpool/pgpool2)
- Configuration
    - limit `maintenance_work_mem` and `work_mem`
        - https://vondra.me/posts/dont-give-postgres-too-much-memory/
- Compliance
  - **pg_sbom**  
    Software Bill of Materials generator for PostgreSQL packaging (CycloneDX/SPDX format). Supply chain transparency for regulatory/compliance scanning.  
    [source](https://github.com/percona/postgres-packaging)


Container publication
  - https://www.perplexity.ai/search/lhedbwYNQ96GWFPGZilJXA
  - private repo with public GHCR container


### Refs
- https://github.com/percona/postgres-packaging
- https://github.com/supabase/postgres