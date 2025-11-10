# Research & Experimental Ideas

**⚠️ DISCLAIMER**: This document contains speculative features and research notes. Items here are NOT in scope for current implementation. Content is gathered from exploratory research and may not align with project goals.

---

## Future Extension Candidates

### Queue & Workflow Systems

**pgq** - Generic Queue for PostgreSQL

- Source: https://github.com/pgq/pgq
- Status: Currently enabled as extension
- Notes: Basic queue functionality for PostgreSQL

**pgmq** - Lightweight Message Queue

- Source: https://github.com/pgmq/pgmq
- Description: AWS SQS/RSMQ-like message queue on Postgres
- Use Case: Simple job queuing without external dependencies

**pg-boss** - Node.js Message Queue

- Source: https://github.com/timgit/pg-boss
- Description: Robust message queue for Node.js applications
- Status: NOT a PostgreSQL extension (application library)

**pgflow** - Postgres-Centric Workflow Engine

- Source: https://github.com/pgflow-dev/pgflow
- Website: https://www.pgflow.dev
- Description: Workflow orchestration with optional Supabase integration
- Status: NOT a PostgreSQL extension (application framework)

### Analytics & OLAP Extensions

**pg_duckdb** - DuckDB-Powered Postgres

- Source: https://github.com/duckdb/pg_duckdb
- Description: High-performance analytics (OLAP) via DuckDB integration
- **CRITICAL WARNING**: Running on production primary risks starving OLTP workloads
- **Best Practice**: Deploy on dedicated read replicas only
- **Resource Impact**: Min 125 MB per connection (each spawns DuckDB instance)
- Comparison: https://www.perplexity.ai/search/pg-duckdb-vs-timescaledb-THmyJ2KvQ22vAicYpFxLjQ

**pg_lake** - Postgres for Iceberg and Data Lakes

- Source: https://github.com/snowflake-labs/pg_lake
- Description: Integrate PostgreSQL with Apache Iceberg data lakes

### Specialized Data Types

**HyperLogLog (HLL)** - Probabilistic Cardinality Estimator

- Source: https://github.com/citusdata/postgresql-hll
- Description: Distinct count estimation (1.2KB estimates billions with ±4% error)
- Use Case: Approximate unique counts at scale
- Background: https://agkn.wordpress.com/2012/10/25/sketch-of-the-day-hyperloglog-cornerstone-of-a-big-data-infrastructure/

### Partitioning & Optimization

**pg_partman** - Partition Management

- Source: https://github.com/pgpartman/pg_partman
- Description: Automated partition creation/management for time-series or range data
- Research: https://www.perplexity.ai/search/tA64IBQyRaOHfGmLFm0k8Q

### Distributed & Clustering

**Citus** - Distributed PostgreSQL

- Source: https://github.com/citusdata/citus
- Description: Distributed Postgres via extension (sharding, distributed queries)
- Popular companion extensions: Patroni, HLL, PostGIS, TopN, hstore, pg_stat_statements, dblink, plpgsql, uuid_ossp, ltree, pgvector
- **Note**: Major architectural change - requires careful evaluation

---

## Experimental Features

### Base OS Image Research

**Alpine Linux** - ❌ OUT OF SCOPE

- Reason: musl libc handles string sorting differently than glibc
- Impact: Incompatible with many PostgreSQL extensions
- Verdict: Maintenance nightmare, not worth the effort

**Distroless Debian** - ❌ NOT RECOMMENDED

- Source: https://github.com/GoogleContainerTools/distroless
- Analysis: https://arc.net/l/quote/secujiwd
- Verdict: Absolutely NOT recommended for PostgreSQL

**Debian 13 Trixie vs Ubuntu Comparison**

- Analysis: https://arc.net/l/quote/ddsmdqvf
- Winner: **Debian 13 Trixie** (current choice)
- Alternatives: Ubuntu 24 Noble, Ubuntu 22 Jammy

### Advanced Configuration

**Memory Tuning Research**

- Limit `maintenance_work_mem` and `work_mem` to prevent issues
- Reference: https://vondra.me/posts/dont-give-postgres-too-much-memory/
- Research: https://www.perplexity.ai/search/NwhAMhApQAiqjQiKTlSCXw

---

## Management & Monitoring Tools

### GUI Administration Panels

**Evaluated Options**:

- pgAdmin (full-featured GUI)
- Mathesar, Kottster, NocoDB, Baserow
- Directus, Apache Superset, Metabase
- Research: https://www.perplexity.ai/search/gIhJG0_pS163fBGawdd3Mw

**pgAdmin 4**

- Source: https://github.com/pgadmin-org/pgadmin4
- Description: Full-featured GUI (object browser, query tool, debugger, schema diff, ER diagrams, backup/restore)
- Type: Browser-based
- Status: Not included in container (external tool)

### Advanced Connection Pooling

**pgpool2** - Full-Featured Middleware

- Source: https://github.com/pgpool/pgpool2
- Description: Connection pooling, replication, load balancing, automatic failover, online recovery, watchdog (HA)
- Comparison: More complex than pgbouncer
- Use Case: All-in-one HA+replication solution

**Note**: Current stack uses pgbouncer (simpler, focused on connection pooling only)

### Monitoring Systems

**Evaluated Solutions**:

- https://github.com/RostislavDugin/postgresus - Monitoring and backups with UI (self-hosted)
- https://github.com/percona/pmm - Percona Monitoring and Management (open source database observability)
- https://github.com/percona/grafana-dashboards - PMM dashboards for database monitoring
- https://github.com/postgres-ai/postgres_ai - Postgres monitoring tool designed for humans and AI systems
- https://github.com/supabase/etl - Rust framework to stream Postgres data in real-time
- https://hub.docker.com/r/fluent/fluent-bit - Lightweight logs and metrics collector

**Note**: Current stack uses postgres_exporter + Prometheus (standard monitoring)

### Automation & Optimization

**DbPill** - Postgres Proxy with Auto-Indexing

- Source: https://github.com/mayfer/dbpill
- Description: Automates index optimization
- Status: Experimental, not evaluated for production

**Percona Everest** - Cloud-Native DB Platform

- Source: https://github.com/percona/everest
- Description: Deploy and manage database clusters
- Status: Kubernetes-focused, not evaluated

---

## Backup & Disaster Recovery Alternatives

**Current Solution**: pgBackRest (Tier 1)

**Evaluated Alternatives**:

**Tier 2: WAL-G**

- Description: Cloud-optimized (S3, GCS, Azure)
- Used by: GitLab.com
- Type: Go-based successor to WAL-E
- Status: Not selected (pgBackRest preferred)

**Tier 3: pg_dump + cron**

- Description: Simple, works everywhere
- Limitation: No PITR without WAL archiving
- Status: Too basic for production needs

---

## Kubernetes & Clustering

**CloudNativePG**

- Source: https://github.com/cloudnative-pg/cloudnative-pg
- Description: Kubernetes operator for PostgreSQL
- Status: Out of scope (current architecture is Docker Compose-based)

---

## Compliance & Security

**pg_sbom** - Software Bill of Materials Generator

- Source: https://github.com/percona/postgres-packaging
- Description: CycloneDX/SPDX format SBOM generator for PostgreSQL
- Use Case: Supply chain transparency for regulatory/compliance scanning
- Status: Not implemented (GitHub Actions provides SBOM via attestation)

---

## Reference Links

### Extension Catalogs

- PostgreSQL Built-in Extensions (70): https://www.postgresql.org/docs/18/contrib.html
- PGDG Repository (104+ DEB): https://apt.postgresql.org/pub/repos/apt/
- PIGSTY Repository (420+ total): https://pigsty.io/ext, https://repo.pigsty.io
- Supabase PG Extensions: https://github.com/supabase/postgres#postgresql-17-extensions
- Percona Extensions: https://www.percona.com/postgresql/software/postgresql-distribution#components_include
- TigerData Documented Extensions: https://www.tigerdata.com/learn/postgres-extensions
- pgSTY Extension List: https://ext.pgsty.com/list/

### Container Publishing

- Research: https://www.perplexity.ai/search/lhedbwYNQ96GWFPGZilJXA
- Pattern: Private repo with public GHCR container

### Architecture References

- Percona Postgres Packaging: https://github.com/percona/postgres-packaging
- Supabase Postgres: https://github.com/supabase/postgres
- CloudNativePG Containers: https://github.com/cloudnative-pg/postgres-containers
- Extension Guide: https://github.com/cloudnative-pg/postgres-containers/issues/115#issuecomment-2563173289
- PostgreSQL 18 Size Improvements: https://ardentperf.com/2025/04/07/waiting-for-postgres-18-docker-containers-34-smaller/

### Research Queries

- Extension sources: https://arc.net/l/quote/ldpklvaq
- Supabase extension decisions: https://arc.net/l/quote/dzmqgqng
- Queue/workflow systems: https://www.perplexity.ai/search/S7BepfFYQPCa5Kj2C4qzNg
- Extension overview: https://www.perplexity.ai/search/1Hg1uD3dQM6R0evCT1nIUw
- Supabase choices: https://www.perplexity.ai/search/zGJi32hzSnywVRc6qbZLBg
- HyperLogLog: https://www.perplexity.ai/search/WbkgpqlXTA6xezeIR7hQvA
- TimescaleDB: https://www.perplexity.ai/search/9.KYLcoRQ2.14fkjE3ss4w
- Postgres containers: https://www.perplexity.ai/search/NwhAMhApQAiqjQiKTlSCXw
- Configuration tuning: https://www.perplexity.ai/search/NwhAMhApQAiqjQiKTlSCXw

---

**Last Updated**: 2025-11-10 (from NOTES.md research content)
