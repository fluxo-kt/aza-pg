# Postgres Extensions Chosen

All these extensions should be installed and available in the Postgres instance.
- Disabled by default when possible.
- All with last versions, tailored for PG 18 compatibility.
- Auto-configured and optimized for the container limits.


## From Supabase

**Research**
  - **https://github.com/supabase/postgres#postgresql-17-extensions**
  - https://arc.net/l/quote/dzmqgqng
  - https://www.perplexity.ai/search/zGJi32hzSnywVRc6qbZLBg

**Extensions List**
- **hypopg**  
  Hypothetical indexes for query planning (no I/O, no writes). Test if a proposed index would matter before adding it.  
  [source](https://github.com/HypoPG/hypopg)

- **index_advisor**
  Automatic index suggestions for a single query, using hypopg to simulate/test.  
  [source](https://github.com/supabase/index_advisor)

- **plpgsql_check**  
  Lint/static analyzer for PL/pgSQL code. Catches runtime, injection, and logic errors pre-deploy.  
  [source](https://github.com/okbob/plpgsql_check)

- **pg-safeupdate**  
  Enforces WHERE clause for UPDATE/DELETE. Prevents accidental data wipeouts.  
  [source](https://github.com/eradman/pg-safeupdate)

- **pgAudit**  
  Fine-grained audit logging for security/compliance.  
  [source](https://github.com/pgaudit/pgaudit)

- **supautils**  
  Enables triggers/events/extensions/publications without SUPERUSER via privileged role hooks (cloud safety). Required for managed/hosted Postgres safety.  
  [source](https://github.com/supabase/supautils)

- **pg_cron**  
  Native, job-scheduler. Schedule SQL/maintenance via cron syntax from inside PG.  
  [source](https://github.com/citusdata/pg_cron)

- **pg_net**  
  Async HTTP client for PG (non-blocking webhooks/triggers, supports GET/POST/DELETE). Triggers ALLOWED, doesn't block transaction.  
  [source](https://github.com/supabase/pg_net)

- **pgsql-http**  
  Synchronous HTTP client for PG. Straightforward GET/POST; CURL underneath. Use only for sync, non-trigger calls.  
  [source](https://github.com/pramsey/pgsql-http)

- **supabase-wrappers**  
  Rust-based FDW framework for API/db integration (Stripe, Firebase, BQ, etc). Query remote APIs like tables. Still pre-release—evaluate for prod stability.  
  [source](https://github.com/supabase/wrappers)

- **pgroonga**  
  Fast, full-text, multi-language search (excellent for Asian languages). Index supports LIKE/join/phrase.  
  [source](https://github.com/pgroonga/pgroonga)

- **rum**  
  Advanced full-text index for phrase search—stores position/rank info in index, allows true ORDER BY ranking, not heap-scan.  
  [source](https://github.com/postgrespro/rum)

- **postgis**  
  Geographic/spatial data, GIS topology, KNN, vector ops—industry-standard.  
  [source](https://github.com/postgis/postgis)

- **pgrouting**  
  Classic geospatial routing—Dijkstra/A*/TSP with PostGIS graphs.  
  [source](https://github.com/pgRouting/pgrouting)

- **pgsodium**  
  Modern symmetric/asymmetric/key management and secrets (libsodium backed). Encrypted-by-role, built for compliance workloads. Superior to `pgcrypto`. 
  [source](https://github.com/michelp/pgsodium)

- **vault**  
  Encrypted secret store for API keys, tokens, etc. (Supabase only; not HashiCorp Vault).  
  [source](https://github.com/supabase/vault)

- **pg_jsonschema**  
  JSON schema validation at insert/update; bridges schema/no-schema gap for JSONB columns.  
  [source](https://github.com/supabase/pg_jsonschema)

- **pg_hashids**  
  Short, non-sequential UID encoding of ints—hide PKs in API/URLs.   
  [source](https://github.com/iCyberon/pg_hashids)

- **pgmq**  
  Simple, persistent queue (SQS-like) using LISTEN/NOTIFY and sticky tables.  
  [source](https://github.com/tembo-io/pgmq)

- **pg_repack**  
  Online table/index reorg for bloat—does not require exclusive locks (reclaims, reclusters).  
  [source](https://github.com/reorg/pg_repack)

- **pg_stat_monitor**  
  Next-gen query profiling/statistics with time buckets, param captures, multi-dimensional grouping.  
  [source](https://github.com/percona/pg_stat_monitor)

- **pg_plan_filter**  
  Policy: block/disallow queries above a cost threshold, block non-SELECT, etc—protection for resource abuse.  
  [source](https://github.com/pgexperts/pg_plan_filter)

- **pgvector**  
  Dense/sparse vector search for ML embeddings; L2/cosine, HNSW/IVFFlat, production search at scale.  
  [source](https://github.com/pgvector/pgvector)

- **timescaledb**  
  Time-series optimized storage, hypertables, native time-bucket and compression.
  Enriched with additional [timescaledb-toolkit](https://github.com/timescale/timescaledb-toolkit) — helper functions extension.
  [source](https://github.com/timescale/timescaledb)
  see https://github.com/timescale/timescaledb-tune for tuning

- **wal2json**  
  Logical decoding output plugin: emits compact JSON DML events for CDC—real-time change feeds.  
  [source](https://github.com/eulerto/wal2json)

- Realtime
  WS polling for PG changes; Is it an extension, though?
  [source](https://github.com/supabase/realtime)


## From Percona

**Research**
  - https://www.percona.com/postgresql/software/postgresql-distribution#components_include

**List**
- **pgbackrest**  
  Full/differential/incremental backup and restore with encryption, parallel processing, multi-repository, PITR. Production-grade disaster recovery.  
  [source](https://github.com/pgbackrest/pgbackrest)

- **pgbadger**  
  Fast PostgreSQL log analyzer producing HTML/JSON reports: query slowness, error trends, connection patterns, load distribution over time. No external DB required.  
  [source](https://github.com/darold/pgbadger)

- **pgaudit_set_user**  
  Privilege escalation extension allowing safe sudo-like role switching with detailed logging. Blocks dangerous ops (ALTER SYSTEM, COPY PROGRAM) by default, configurable allowlists.  
  [source](https://github.com/pgaudit/set_user)


## Other extensions that should be installed and available

- pg_trgm            | Trigram fuzzy text search
- pg_stat_statements | Query performance monitoring
- auto_explain       | Auto-log slow query plans
- btree_gin          | GIN index enhancements
- btree_gist         | GIST index enhancements
- plpgsql            | Default procedural language

- **pg_partman**
  Automated declarative partition management  
  [source](https://github.com/pgpartman/pg_partman/)

- **pgVectorScale**
  A complement to pgvector for high performance, cost efficient vector search
  [source](https://github.com/timescale/pgvectorscale)

- **Citus**
  distributed Postgres via extension
  [source](https://github.com/citusdata/citus)

- **postgresql-hll**
  **HyperLogLog** data type, A probabilistic cardinality estimator (distinct count). Typically 1.2KB estimates billions of distinct values with ±4% error.
  [source](https://github.com/citusdata/postgresql-hll)
  https://agkn.wordpress.com/2012/10/25/sketch-of-the-day-hyperloglog-cornerstone-of-a-big-data-infrastructure/

_`uuid-ossp` IS NOT needed_.
