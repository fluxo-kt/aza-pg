# Notes & Ideas

# THIS DOC IS FOR MANUAL CHANGE ONLY

# DO NOT EVEN TOUCH IT AS AN AI AGENT!

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
- PG Admin panels (Mathesar, Kottster, NocoDB, Baserow, Directus, pgAdmin, Apache Superset, Metabase)
  - https://www.perplexity.ai/search/gIhJG0_pS163fBGawdd3Mw
  - https://gateway.drizzle.team
- PG extensions
  - [EXTENSIONS.md](docs/EXTENSIONS.md)
  - **https://www.perplexity.ai/search/1Hg1uD3dQM6R0evCT1nIUw**
  - `SELECT * FROM pg_available_extensions ORDER BY name;` - All available + installed
  - **extension sources: https://arc.net/l/quote/ldpklvaq**
    - Layer 1: Built-in (70 extensions)
      - https://www.postgresql.org/docs/18/contrib.html
    - Layer 2: PGDG Repository (104+ DEB)
      - https://wiki.postgresql.org/wiki/Apt
      - https://apt.postgresql.org/pub/repos/apt/
    - Layer 3: PIGSTY Repository (420+ total)
      - https://pigsty.io/ext
      - https://repo.pigsty.io
    - Layer 4: Compile from source
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
  - pg_crdt (CRDT support in Postgres)
    - https://github.com/supabase/pg_crdt
    - https://supabase.github.io/pg_crdt/
    - https://supabase.github.io/pg_crdt/automerge/
  - HyperLogLog data type, A probabilistic cardinality estimator (distinct count). Typically, 1.2KB estimates billions of distinct values with ±4% error.
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
  - DuckDB-powered Postgres for high performance apps & analytics (OLAP)
    - https://github.com/duckdb/pg_duckdb
    - https://www.perplexity.ai/search/pg-duckdb-vs-timescaledb-THmyJ2KvQ22vAicYpFxLjQ
    - Running on production primary instance risks starving OLTP workloads
    - Best practice: Deploy on dedicated read replicas only
    - Each PG connection spawns its own DuckDB instance (min 125 MB per-connection)
  - Recurring dates in Postgres.
    - https://github.com/volkanunsal/postgres-rrule
- Reactivity
  - https://www.perplexity.ai/search/what-are-the-best-open-source-FB2dPeKCSYW7MGvxyu7SaA
    1. LISTEN/NOTIFY
    2. Logical Replication
    3. SKIP LOCKED Pattern
    4. wal2json
    5. decoderbufs
    6. pgoutput
    7. pgoutput
    8. pg_eventserv
    9. pgsync
- Backup & Disaster Recovery
  - Tier 1: pgBackRest (Compression, encryption, parallel backup/restore; Block-level incremental backups)
  - Tier 2: WAL-G (Cloud-optimized: S3, GCS, Azure; Used by GitLab.com; Go-based successor to WAL-E)
  - Tier 3: pg_dump + cron (Simple, works everywhere; No PITR without WAL archiving)
- Monitoring
  - https://github.com/RostislavDugin/postgresus monitoring and backups (with UI and self hosted)
    - https://postgresus.com
  - https://github.com/percona/pmm Percona Monitoring and Management: an open source database monitoring, observability and management tool
  - https://github.com/percona/grafana-dashboards PMM dashboards for database monitoring
  - https://github.com/postgres-ai/postgres_ai Postgres monitoring tool designed for humans and AI systems
  - https://github.com/supabase/etl Rust framework to stream your Postgres data anywhere in real-time
  - https://hub.docker.com/r/fluent/fluent-bit lightweight logs and metrics collector and forwarder
- Management
  - DbPill: Postgres proxy, automates index optimization
    - https://github.com/mayfer/dbpill
  - Percona Everest: cloud-native DB platform to deploy and manage database clusters
    - https://github.com/percona/everest
  - GUI
    - **pgadmin4**  
      Full-featured GUI for PostgreSQL: object browser, query tool, debugger, schema diff, ER diagrams, backup/restore, index management. Browser-based.  
      https://github.com/pgadmin-org/pgadmin4
- Balancing
  - **pgbouncer**  
    Connection pooler—maintains reusable server connections. Session/transaction/statement pooling modes. Essential for high-concurrency or microservice-heavy workloads.  
    https://github.com/pgbouncer/pgbouncer
  - **pgpool2**  
    Full-featured middleware: connection pooling, replication, load balancing, automatic failover, online recovery, watchdog (HA for pgpool itself). More complex than pgbouncer; use when all-in-one HA+replication needed.  
    https://github.com/pgpool/pgpool2
  - pgMux - PostgreSQL routing proxy for dev/testing envs
    https://github.com/boringSQL/pgmux
- Configuration
  - limit `maintenance_work_mem` and `work_mem`
    - https://vondra.me/posts/dont-give-postgres-too-much-memory/
  - https://www.perplexity.ai/search/NwhAMhApQAiqjQiKTlSCXw
- Testing
  - RegreSQL: Regression Testing for PostgreSQL Queries
    - https://boringsql.com/posts/regresql-testing-queries/
    - https://github.com/dimitri/regresql
- Compliance
  - **pg_sbom**  
    Software Bill of Materials generator for PostgreSQL packaging (CycloneDX/SPDX format). Supply chain transparency for regulatory/compliance scanning.  
    https://github.com/percona/postgres-packaging

Container publication

- https://www.perplexity.ai/search/lhedbwYNQ96GWFPGZilJXA
- private repo is possible with public images on GHCR

### Clusters, Kubernetes

- https://github.com/cloudnative-pg/cloudnative-pg

### Base OS Image

- Alpine is out-of-scope
  - musl libc handles string sorting differently than glibc
  - incompatible with many PostgreSQL extensions
  - ❌ maintenance nightmare, not worth the effort
- PostgreSQL on Distroless Debian: Feasibility Analysis
  - ❌ absolutely NOT recommended, https://arc.net/l/quote/secujiwd
  - https://github.com/GoogleContainerTools/distroless
- **Debian 13 Trixie** vs Ubuntu 24 Noble vs Ubuntu 22 Jammy: https://arc.net/l/quote/ddsmdqvf
  - **Debian 13 Trixie is the clear winner**

### Refs

- Docker Hardened Images — **NOT RECOMMENDED** (PG 18 unavailable, high migration cost)
  - See comprehensive assessment: [docs/DOCKER-HARDENED-IMAGES.md](docs/DOCKER-HARDENED-IMAGES.md)
  - https://hub.docker.com/hardened-images/catalog/dhi/postgres/images
  - https://www.docker.com/blog/docker-hardened-images-for-every-developer/
- Available PG containers: https://www.perplexity.ai/search/NwhAMhApQAiqjQiKTlSCXw
- https://github.com/percona/postgres-packaging
- https://render.com/docs/postgresql-extensions
- https://github.com/supabase/postgres
- https://ext.pgsty.com/list/
- https://github.com/cloudnative-pg/postgres-containers
  - https://github.com/cloudnative-pg/postgres-containers/issues/115#issuecomment-2563173289 (how to extend/change/add extensions)
- https://ardentperf.com/2025/04/07/waiting-for-postgres-18-docker-containers-34-smaller/
- Docker Build with provenance (https://github.com/actions/attest-build-provenance)
  - https://github.com/brendanbank/gpsd-prometheus-exporter/blob/d4e0a24/docker-publish-org.yml#L85
  - https://github.com/pagopa/dx/blob/a8f597a/actions/docker-build-push/action.yaml#L193

### Authorization

- https://www.keycloak.org / https://github.com/keycloak/keycloak
