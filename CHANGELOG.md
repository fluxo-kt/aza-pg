# Changelog

All notable changes to the aza-pg Docker image will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Focus**: This changelog tracks changes affecting the **release Docker image** only.
Development tooling, test infrastructure, and CI/CD changes are noted briefly if relevant.

## [Unreleased]

### Breaking

- **Compose stacks: postgres_exporter 0.19.1 → 0.20.1**: replication-slot metrics are renamed from `pg_replication_slot_*` to `pg_replication_slots_*` (e.g. `pg_replication_slots_slot_is_active`), and the `replication_slot` collector flag is now `--collector.replication_slots`; update alerts, recording rules and dashboards. `PG_EXPORTER_DISABLE_SETTINGS_METRICS` no longer exists (use `--no-collector.settings`), and the stacks drop it together with `PG_EXPORTER_COLLECTOR_STAT_BGWRITER`, which had no effect: collector flags have no environment variable (0.20.1 `--help`), so the bgwriter collector always ran, and it works on PostgreSQL 18. pgbouncer_exporter 0.12.0 → 0.12.1 fixes `reserve_pool` on PgBouncer 1.24+.
- **Your own `-c` flags and `ALTER SYSTEM` values now override auto-tuning**: auto-tuned values used to be appended as `-c` flags after yours, so `command: postgres -c max_connections=500` and every `ALTER SYSTEM SET` of a tuned setting (`shared_buffers`, `work_mem`, `max_connections`, `wal_level`, `shared_preload_libraries`, …) were silently ignored. They now apply, including `ALTER SYSTEM` + `SELECT pg_reload_conf()` for reloadable settings. **Before upgrading**, check for stored values that will start applying: `SELECT name, setting FROM pg_file_settings WHERE sourcefile LIKE '%postgresql.auto.conf'` — e.g. a `wal_level = 'replica'` from older deployment docs would disable wal2json and pgflow realtime; remove one with `ALTER SYSTEM RESET <name>`. Values in `postgresql.conf` files still do not override auto-tuning (initdb writes defaults there). Every override, and every ignored config-file value, is logged at start as `[AUTO-CONFIG] <setting>: …`.
- **TimescaleDB 2.27.1 → 2.30.2**: Adaptive chunking is removed (`set_adaptive_chunking()` and the `chunk_target_size`/`chunk_sizing_func` arguments of `create_hypertable()`); the granular continuous-aggregate refresh options are renamed to `timescaledb.cagg_granular_refresh_*`. The extension upgrade drops sparse bloom-filter indexes on compressed `smallint` columns that the new version cannot use (upstream 2.28.2).
- **timescaledb_toolkit 1.22.0 → 1.26.0**: `gauge_agg` and its accessors moved from `toolkit_experimental` to the public schema; `time_weight`'s combine/serialize/deserialize functions are removed, so `time_weight` no longer aggregates in parallel. The extension is now `trusted`, so any role with `CREATE` on a database can install it.
- **pg_partman 5.4.3 → 5.5.0**: `pg_partman_bgw.role` now defaults to `partman_maintainer`; a background worker relying on the old default (`postgres`) fails until that role exists or the setting names a role (upstream advises a non-superuser one). A target retention schema must now be owned by the child table's owner.
- **plpgsql_check 2.9.0 → 2.10.11**: Upstream ships no 2.9 → 2.10 upgrade script, so on data volumes created by an older image every call errors until `DROP EXTENSION plpgsql_check; CREATE EXTENSION plpgsql_check;`. Adds `plpgsql_make_pragma()` and a `pragmas` argument to `plpgsql_check_function()`.
- **pgBackRest 2.58.0 → 2.59.3**: Only `restore` may run as root; run other commands as `postgres` (`docker exec -u postgres …`) or set `allow-root`.
- **pg_stat_monitor 2.3.2 → 2.4.0**: The `pgsm_overflow_target` setting is removed and `pgsm_track_application_names` is deprecated (always on); `application_name` shows `NULL` instead of `'unknown'`.
- **pgvectorscale 0.9.0 → 0.9.1**: DiskANN indexes need a `vector(N)` column; an existing index built on a column without a dimension now errors on scan, insert and vacuum and must be dropped and recreated (`REINDEX` cannot repair it). Run `ALTER EXTENSION vectorscale UPDATE` in existing databases.
- **pgflow 0.14.1 → 0.17.2**: `pgflow.is_local()` now behaves as upstream (false unless the Supabase CLI's local JWT secret is set) instead of always true, so a worker deploying a changed flow definition refuses to start rather than deleting that flow and all its runs. `start_tasks()` takes the queue name (and optional step) explicitly; use `@pgflow/client` and `@pgflow/dsl` 0.17.2. Workers compile or verify their flow before polling (migration-based compilation is gone). New databases get 0.17.2; databases created by an older image keep their pgflow schema until you run `docker exec <container> pgflow-upgrade` (stop pgflow workers first; it detects each database's version and upgrades it in one transaction; databases created by images with pgflow 0.13.x are refused unchanged — see docs/PGFLOW.md). pgflow 0.17's usage telemetry stays off unless you run `SELECT pgflow_telemetry.enable();`.

### Security

- **Compose stacks: PgBouncer 1.25.1 → 1.26.0**: fixes CVE-2026-19888 (unauthenticated crash through a SCRAM message without a nonce), CVE-2026-6668 (unauthenticated hang through an oversized packet) and CVE-2026-6669 (a malicious server could stall logins). `search_path` set by one client in transaction pooling no longer leaks to the next client on the same server connection. Online restart (`pgbouncer -R`, `SUSPEND`, `SHOW FDS`) is removed upstream.
- **Replication role without `pg_monitor`**: new databases no longer grant `pg_monitor` (which reads every session's query text) or `CONNECT` to the `replicator` role; streaming and `pg_basebackup` need neither. Existing databases: `REVOKE pg_monitor FROM replicator;`.
- **pgsodium root key per database**: the image shipped one fixed pgsodium root key, published in this repository, so values encrypted through pgsodium or Vault in any aza-pg database could be decrypted by anyone holding a copy of the data. Each new data directory now gets its own random key (`$PGDATA/pgsodium_root.key`, created at first start), or uses the file named by `PGSODIUM_KEY_FILE`. Existing data directories keep the published key so their encrypted data stays readable, and every start logs a warning until you rotate it ([docs/PGSODIUM-SETUP.md](docs/PGSODIUM-SETUP.md)). Back up the key file: `pg_dump` does not include it. A `pgsodium_getkey` script you mount that fails now stops the server instead of starting it without pgsodium and Vault.
- **PostgreSQL 18.4 → 18.6** (18.5 was never released upstream): fixes 28 CVEs, including several CVSS 8.8 memory-safety and SQL-injection issues. After upgrading: `ANALYZE` tables whose GIN indexes were built in parallel (their `reltuples` may be corrupt), `REINDEX` `btree_gist` indexes on float/bit columns and `ltree` btree indexes as the [18.6 release notes](https://www.postgresql.org/docs/release/18.6/) describe, and use `pgp_sym_decrypt(..., 'ignore-cipher-failure=1')` to recover pgcrypto data encrypted with a cipher OpenSSL had disabled.
- **TimescaleDB 2.29.1+**: Fixes [GHSA-hcfx-29v5-2rcw](https://github.com/timescale/timescaledb/security/advisories/GHSA-hcfx-29v5-2rcw) (high; missing permission checks in chunk management functions) and decompressor crashes on malformed compressed data.
- **pg_partman 5.5.0**: Fixes SQL-injection/privilege-escalation CVE-2026-61781 (critical), CVE-2026-61817 to CVE-2026-61821, and CVE-2026-61822.
- **pgsql-http 1.7.0 → 1.7.2**: The `http.curlopt_*` settings for CA file, credentials, client certificate/key and TLS verification become superuser-only, and a buffer overrun in header parsing is fixed.
- **hll 2.20 → 2.21**: Hardens input validation of serialized hll values.
- **pgvector 0.8.2 → 0.8.7**: Fixes [CVE-2026-103484](https://github.com/pgvector/pgvector/issues/1036) (a role that can build an IVFFlat index can write out of bounds, leading to arbitrary code execution), plus possible HNSW index corruption during vacuum and IVFFlat memory use above `maintenance_work_mem`. PGDG does not ship 0.8.7 yet, so the image now builds pgvector from source.
- **supautils 3.2.2 → 3.4.4**: Fixes four critical privilege escalations to superuser ([GHSA-5pqj-rc76-r669](https://github.com/supabase/supautils/security/advisories/GHSA-5pqj-rc76-r669), [GHSA-v9vh-54vv-7vfg](https://github.com/supabase/supautils/security/advisories/GHSA-v9vh-54vv-7vfg), [GHSA-vxh6-6m4g-c39q](https://github.com/supabase/supautils/security/advisories/GHSA-vxh6-6m4g-c39q), [GHSA-xj9m-rx42-rfc7](https://github.com/supabase/supautils/security/advisories/GHSA-xj9m-rx42-rfc7)); the library is no longer compiled with test-only code enabled. Affects only deployments that preload `supautils`.
- **pgvectorscale 0.9.0 → 0.9.1**: Hardens DiskANN against type confusion and malformed vectors that could crash the backend, leak memory or write out of bounds.
- **pgBackRest 2.59.3**: Earlier versions could generate weak encryption subkeys and salts when reading system random data failed, and could raise checksum errors loading encrypted info and manifest files. Only encrypted repositories (`repo-cipher-type`) are affected, and upgrading does not replace a weak subkey already stored in `archive.info`/`backup.info`: check yours with the procedure in the [pgBackRest advisory](https://pgbackrest.org/news.html#weak-encryption). PGDG does not ship 2.59.3 yet, so the image builds pgBackRest from source; it stays at `/usr/bin/pgbackrest` with the same SFTP, S3, Azure and GCS support.
- **pgsodium 3.1.9 → 3.1.11, libsodium 1.0.18 → 1.0.22**: Fixes a SQL injection in `pgsodium.mask_role` and a buffer-size error in `crypto_aead_ietf_encrypt_by_id`, and adds IP-address encryption (`crypto_ipcrypt_*`). libsodium is now built from the signed upstream release and shared by pgsodium and supabase_vault; it replaces Debian's `libsodium23`. Run `ALTER EXTENSION pgsodium UPDATE` in existing databases.

### Added

- **pg_plan_filter 1.0.0** (PostgreSQL 14–18 support upstream): rejects statements whose estimated plan cost exceeds `plan_filter.statement_cost_limit` (and, new in 1.0.0, a per-transaction `plan_filter.transaction_cost_limit`). Not preloaded by default: add `plan_filter` (the library name, not `pg_plan_filter`) to `POSTGRES_SHARED_PRELOAD_LIBRARIES`; the limits are superuser-only settings.

### Changed

- **Base configuration in every container**: a plain `docker run` (and any custom compose file) now gets the settings the stacks always had: slow-query, connection, checkpoint, lock-wait and autovacuum logging, `pg_stat_statements.track = all`, `auto_explain` for queries over 3 s, tuned autovacuum, `wal_compression = lz4`, and TimescaleDB telemetry off. Your config file, `ALTER SYSTEM` and `-c` still override each of them; `SELECT name, setting, sourcefile FROM pg_settings` shows which applies.
- **Logical decoding plugins** (PostgreSQL 18.6, CVE-2026-6471): slots may only use plugins listed in `output_plugin_libraries`, superusers included. The image sets it to `pgoutput,test_decoding,wal2json` so wal2json CDC keeps working; change it with the new `POSTGRES_OUTPUT_PLUGIN_LIBRARIES` variable (it is passed as `-c`, so `postgresql.conf` and `ALTER SYSTEM` cannot override it). Outside this image, write `ALTER SYSTEM SET output_plugin_libraries = pgoutput, test_decoding, wal2json` as an unquoted list: one quoted string becomes a single plugin name that matches nothing.
- **pg_cron 1.6.7 → 1.6.8**: Fixes a shutdown hang with synchronous replication and a launcher shared-memory leak; job owner checks are now case-sensitive; adds `cron.match_dom_and_dow`.
- **hypopg 1.4.2 → 1.4.3**, **pg_repack** and **set_user** (PGDG packaging rebuilds), **wal2json** (Percona packaging rebuild): bug-fix and rebuild updates.
- **pg_safeupdate 1.5 → 1.7**: When disabled it now still calls the next query-analysis hook, so extensions loaded after it (such as `pg_stat_statements`) keep working; it no longer blocks `pg_upgrade`.
- **pg_net 0.20.3 → 0.20.5**: Fixes a worker crash loop when a `net` schema exists without the extension. Upstream did not bump the extension version, so `\dx` still shows 0.20.4.
- **wrappers 0.6.1 → 0.6.3**: Adds a MongoDB wrapper; `mysql_fdw` no longer leaks MySQL error details and supports `varchar`/`bpchar` text columns; Iceberg REST catalog HTTP timeouts are configurable.
- **PGroonga 4.0.6 → 4.0.9**: Adds `pgroonga_physical_table_names()` and an index option that raises the lexicon key-size limit from 4 GiB to 1 TiB.
- **pgmq 1.11.1 → 1.13.0**: Fixes partitioned queues that silently overran their pre-created partitions and could not recover.
- **Build optimisation**: PGroonga (`-O3`) and pgsodium (`-O2`) are now compiled with optimisation (both were built unoptimised at `-O0`), and the Rust extensions (`wrappers`, `pg_jsonschema`) use their upstream release profile (opt-level 3, fat LTO) instead of size-tuned settings.

### Fixed

- **Compose stacks started without `POSTGRES_IMAGE` could not pull the image**: their default `ghcr.io/fluxo-kt/aza-pg:pg18` was never published. The default is now `ghcr.io/fluxo-kt/aza-pg:18`, the latest PostgreSQL 18 release; pin a versioned tag or digest for production.
- **Replicas smaller than their primary never started**: auto-tuning sized `max_connections` and `max_worker_processes` from the replica's own RAM and CPUs, and a standby refuses to start below its primary's values, so the replica stack's shipped 512 MB replica could not start under its 2 GB primary. A standby (and a backup restore) now raises `max_connections`, `max_worker_processes`, `max_wal_senders`, `max_prepared_transactions` and `max_locks_per_transaction` to the primary's values at every start, logging each raise; replica memory limits no longer need to match the primary's.
- **Replica stack ignored its own config**: the replica ran on the configuration cloned from the primary, so `hot_standby_feedback` and the rest of `postgresql-replica.conf`, and the stack's `pg_hba.conf`, never applied. The replica stack now clones the primary before the server's first start (`scripts/replica-entrypoint.sh`, replacing the initdb script) and starts with its own files. It no longer deletes anything in the data directory: a non-empty directory without a database stops it with pg_basebackup's error.
- **pg_repack failed with the default preloads**: safeupdate rejected pg_repack's own `DELETE` without `WHERE`, so every repack aborted. `pg_repack` in the container now turns safeupdate off for its own sessions only; from another machine use `PGOPTIONS="-c safeupdate.enabled=off" pg_repack …`.
- **Vault could not store secrets in a default container**: supabase_vault 0.3 loads its key through pgsodium only when it is preloaded, so `vault.create_secret` failed out of the box (pgflow uses Vault). `supabase_vault` is now in the default `shared_preload_libraries`. If you set `POSTGRES_SHARED_PRELOAD_LIBRARIES`, it replaces the default: add `supabase_vault` to your list.
- **pgflow in additional databases**: the documented `\i /opt/pgflow/schema.sql` failed in any database other than `POSTGRES_DB`, because the file created `pg_cron`, which PostgreSQL allows only in `cron.database_name`, and `supabase_vault` unconditionally. The shipped schema now creates `pg_cron` only in the cron database and `supabase_vault` only where it is available; pgflow's cron setup functions report "skipped" elsewhere.
- **Compose stacks: pgbouncer, the exporters and replicas could not reach PostgreSQL with the shipped `POSTGRES_BIND_IP=127.0.0.1`**: the image also uses that variable as PostgreSQL's listen address, so PostgreSQL listened only inside its own container, and the documented workaround (`0.0.0.0`) published PostgreSQL on every host interface. In the stacks PostgreSQL now listens on the stack's Docker networks (`pg_hba.conf` still requires passwords) and `POSTGRES_BIND_IP` only chooses the host address the port is published on.
- **Compose stacks: `POSTGRES_DATA_VOLUME`, `POSTGRES_BACKUP_VOLUME`, `MONITORING_NETWORK` now work with any value**: services referred to the volume or network by the variable's value, so any non-default name made `docker compose up` fail with "refers to undefined volume". Services now use fixed keys and the variables only name the Docker objects; existing deployments using the defaults are unaffected.
- **pgvectorscale on x86-64 CPUs without AVX2 or FMA**: upstream's amd64 binary executes those instructions unconditionally, so creating or loading the extension killed the server process (SIGILL) and forced crash recovery, including during first-start initialisation. vectorscale is now built from source and uses AVX2/FMA only when the CPU has them, so it works on every amd64 CPU.

### Removed

- **Build tools in the image**: earlier images shipped the Bun runtime (`/usr/local/bin/bun`) and the extension build script in `/usr/local/bin`, unused at runtime. Both are gone; `/usr/local/bin` holds only the image's own scripts and tools (`gosu`, `pg_repack`, `pgflow-upgrade`, the entrypoints). A script that ran `bun` inside the container needs its own image.

### Development

- Test suites run against the shipped image in parallel from one registry, in CI and locally; CI reuses an unchanged image instead of rebuilding it.

## [v18.4-202606031012] - 2026-06-03

### Security

- **TimescaleDB 2.27.1**: Fixes an information leak where the `job_errors` view exposed failed-job details to non-owners, adds hypertable ownership checks before recompression, and fixes an information leak in `policy_reorder_remove`.

### Changed

- **TimescaleDB 2.27.0 → 2.27.1**: Adds columnar index scan correctness fixes for grouped/`ROLLUP`/`CUBE` queries; realigned to PostgreSQL 18.4 (`~debian13-1804`).
- **plpgsql_check 2.8.11 → 2.9.0**: Rewrites the profiler internals for maintainability; statement-statistics memory is now bounded by the `plch_max_stat_size` setting.
- **pg_net 0.20.2 → 0.20.3**: The background worker now reports its activity to `pg_stat_activity` and flushes pgstat counters so autovacuum observes its writes.
- **hll 2.19 → 2.20**: Adds PostgreSQL 19 build support and enforces thresholds in explicit-representation handling.

### Development

- pg_partman now installs from the PGDG apt package (`postgresql-18-partman` 5.4.3) instead of a source build — identical upstream version and background worker, removing a compile step from the image build.
- Hardened the build-time supply chain: adopted the `bun-osv-scanner-extended` install-time OSV scanner with an audited ignore policy, and patched transitive `ws`/`uuid` advisories via `overrides` (`ws` ^8.20.1 CVE-2026-45736, `uuid` ^14.0.0 CVE-2026-41907) — build/test tooling only, never in the runtime image.
- Dev deps: oxlint 1.68.0, squawk-cli 2.56.0.

---

## [v18.4-202605172147] - 2026-05-17

### Security

- **Base OS security refresh**: Applies current Debian package updates during the final image build before runtime dependency installation. This prevents a digest-pinned base image from shipping stale fixable OS CVEs when Debian security packages move after the upstream PostgreSQL image was published.
- **Final image attack surface**: Purges install-only `curl`, `unzip`, GnuPG CLI tools, `lsb-release`, and `percona-release` after all repositories and release assets are installed; PostgreSQL runtime libraries and extension tools remain installed.

### Changed

- **pg_partman 5.4.2 → 5.4.3**: Fixes upstream version-reporting bug (v5.4.2 `\dx` incorrectly showed `5.4.1`); inherits toast table relation options from template table
- **PostgreSQL 18.3 → 18.4**: Updates the pinned `postgres:18.4-trixie` base image for upstream security fixes and reproducible rebuilds
- **TimescaleDB 2.25.2 → 2.27.0**: Adds Hypercore vectorized filters and bloom-filter pruning for compressed `UPDATE`/`DELETE`/`UPSERT`; includes PG18 module magic support and fixes for compression, continuous aggregates, and planner stability. ⚠️ Upgrade can be blocked for databases with affected sparse bloom indexes on compressed `int2` columns; drop those indexes before upgrading.
- **pgflow 0.13.3 → 0.14.1**: Adds conditional step execution with skipped-state propagation and refreshed SQL schema
- **pgmq 1.11.0 → 1.11.1**: Adds `read_grouped_head()` and SQL-only install/upgrade parity fixes
- **supautils 3.1.0 → 3.2.2**: Adds privilege-error hints and fixes ALTER ROLE hook and executor hook crash paths
- **wrappers 0.6.0 → 0.6.1**: Updates the FDW framework with parameter rescan, aggregate pushdown for enabled FDWs, and dependency fixes
- **PGroonga 4.0.5 → 4.0.6**: Fixes tokenizer error cleanup and fuzzy search distance initialization
- **pgbouncer-exporter v0.9.0 → v0.12.0** (primary stack): Adds client metrics, prepared statement metrics, and fixed stats counter tracking. ⚠️ v0.11.0 changed connection behaviour: exporter now opens a new PgBouncer connection per scrape instead of at startup (PgBouncer ≥ 1.8 required; we use v1.25.1)
- **postgres_exporter v0.18.1 → v0.19.1** (all stacks): Fixed NULL handling in multiple collectors and excessive temp file creation in `pg_stat_statements` queries. ⚠️ Duplicate `pg_stat_statements` entries are now filtered and logged (previously silent)

### Development

- Dev deps: Bun 1.3.14, @pgflow/client/dsl 0.14.1, oxlint 1.65.0, squawk-cli 2.52.1
- Disabled/regression-only catalog sync: PostGIS 3.6.3; pg_jsonschema now pinned to release tag v0.3.4
- GitHub Actions pins refreshed; release gates now verify public manifests, signatures, SBOM, attestation, and GitHub Release digest

---

## [v18.3-202603040417] - 2026-03-04

### Security

- **gosu → su-exec**: Replaced `gosu` (Go binary, `/usr/local/bin/gosu`) with [`su-exec v0.2`](https://github.com/ncopa/su-exec) — a functionally identical pure-C privilege-drop utility. gosu was compiled with Go 1.24.6 which carries CVE-2025-68121 (CRITICAL, CVSS 8.8) and five HIGH-severity Go stdlib CVEs with no upstream fix available. su-exec has zero Go stdlib dependency, permanently eliminating this CVE class. Drop-in compatible: placed at the same path, same CLI syntax.

### Fixed

- **Dockerfile generator silent failure bug**: `|| true` at end of `&&` chains in `generate-dockerfile.ts` caused `set -e` to be completely ineffective for all installation commands. A failing `apt-get install` would short-circuit its `&&` chain but `|| true` made the RUN step exit 0, silently committing a broken layer with missing `.so` files. Fixed by separating `find … strip … || true` with `;` from each install chain in all 5 affected generators (PGDG, Percona, Timescale, GitHub release, Regression mode). The `.so` verification `test -f` steps were also being silently bypassed — this fix restores them as effective guards.
- **pg_stat_monitor startup failure**: Percona removed v2.3.1 from the ppg-18 apt repository (only v2.3.2 available). Combined with the `|| true` build bug above, this caused `pg_stat_monitor.so` to be silently absent from the image, producing a PostgreSQL `FATAL: could not access file "pg_stat_monitor"` crash on startup. ⚠️ Images built while v2.3.1 was still in Percona's repo may be unaffected; images built after Percona purged it (before this release) will have the absent `.so` and must be rebuilt.
- **TimescaleDB loader version split**: The `timescaledb-2-loader-postgresql-18` package was unpinned and jumped to v2.25.2 while the main extension was pinned to v2.25.1, causing `ERROR: extension timescaledb has no installation script for version 2.25.2` at startup. Loader package is now explicitly pinned to match the main extension in the Dockerfile generator.
- **gosu → su-exec: self-contained compilation + trivyignore**: Six prior fix attempts failed — four due to GHA layer cache interference (`COPY --from=builder-base`, `RUN --mount=type=bind`, `apt-get install su-exec` — package absent, `COPY via builder-pgxs output dir` — COPY key matched stale GHA entry); the fifth added `apt-get purge gosu` (gosu is not an apt package in the postgres base image — it's a direct binary download, so purge is a no-op); the sixth realised Trivy scans ALL image layers including immutable base layers and finds gosu in the postgres:18.3-trixie base layer — the replacement in later layers cannot affect base layer content. Definitive fix: compile su-exec (v0.2, SHA-pinned) in the final stage, install at `/usr/local/bin/gosu` (shadows the base layer's gosu in the merged filesystem), add CVE-2025-68121 to `.trivyignore` with justification (the running binary is su-exec; gosu in base layers is unreachable). Also excludes gosu from builder-pgxs rsync to avoid adding another intermediate layer.

### Changed

- **PostgreSQL 18.1 → 18.3**: 5 CVEs fixed (including CVSS 8.8 intarray arbitrary code execution via bitset operations), plus emergency regression fixes from 18.2. ⚠️ If upgrading from pre-18.2: ltree column indexes may need `REINDEX`
- **pg_partman 5.4.0 → 5.4.2**: Security hardening against `search_path` injection in `run_maintenance()` and related functions (v5.4.1); regression fix for non-default schema partitioned tables (v5.4.2)
- **TimescaleDB 2.25.0 → 2.25.2**: Fixed continuous aggregate invalidation log cleanup and variable bucket batching (2.25.1); bugfix release (2.25.2). Loader package explicitly pinned to prevent future version split (see Fixed).
- **pgmq 1.10.0 → 1.11.0**: Full AMQP-style topic routing — bind queues to patterns and fan out via `send_topic()`. Uses `*` (one segment) and `#` (zero or more segments) wildcards. New SQL: `bind_topic()`, `unbind_topic()`, `send_topic()`, `send_batch_topic()`, `list_topic_bindings()`
- **wrappers 0.5.7 → 0.6.0**: New Infura (Ethereum/IPFS) and OpenAPI FDWs; ClickHouse FDW fixes; memory context improvements
- **pgvector 0.8.1 → 0.8.2**: Fixed buffer overflow in parallel HNSW builds; fixed Index Searches in EXPLAIN output for PG18
- **plpgsql_check 2.8.8 → 2.8.11**: Migrated from source build to PGDG apt (~2–3 min faster Docker builds); fixed false positives on composite constants and domain types
- **pg_stat_monitor 2.3.1 → 2.3.2**: Required version bump — see Fixed above

### Development

- Dev deps: Bun 1.3.10, oxlint 1.51.0, squawk-cli 2.43.0; Cosign v3.0.4; GH Actions pins updated
- Disabled extensions synced to PGDG: PostGIS 3.6.2, pgRouting 4.0.1
- Test coverage: pgvector HNSW/EXPLAIN, pgmq topic routing, plpgsql_check semantics; assertions hardened for patch-release robustness

---

## [v18.1-202602082259] - 2026-02-08

### Changed

- **TimescaleDB 2.24.0 → 2.25.0**: Major continuous aggregate performance improvements
  - Direct compress during refresh reduces I/O significantly
  - DELETE optimizations lower resource usage on columnstore
  - Default `buckets_per_batch` changed to 10 (reduced WAL holding)
  - ⚠️ **Breaking**: Old continuous aggregate format removed (deprecated since 2.10.0)
  - ⚠️ **Breaking**: `time_bucket_ng` function removed
  - ⚠️ **Breaking**: WAL-based invalidation removed
  - ⚠️ **Breaking**: `_timescaledb_debug` schema removed
- **pgmq 1.9.0 → 1.10.0**: Message read tracking and flexible visibility timeout
  - New `last_read_at` column tracks message read times
  - `set_vt()` now accepts `INTEGER` or `TIMESTAMPTZ` for absolute timeout
- **supautils 3.0.6 → 3.1.0**: PostgreSQL 18 introspection improvements
  - PG_MODULE_MAGIC_EXT support enables module visibility via `pg_get_loaded_modules()`
  - Fixed spurious `supautils.disable_program` GUC connection warnings
- **plpgsql_check 2.8.5 → 2.8.8**: Stability and debugging improvements (switched from PGDG to source build)
  - Fixed memory corruption crash
  - Rewritten pldbgapi debugging API
  - New warnings for expression volatility and reserved keyword labels
- **pgflow 0.13.2 → 0.13.3**: Edge worker authentication and connection improvements
  - Optional `PGFLOW_AUTH_SECRET` support for worker authentication
  - Fixed `maxPgConnections` parameter propagation

### Development (non-image)

- Updated Bun dev dependencies: @pgflow/client 0.13.3, @pgflow/dsl 0.13.3, @types/bun 1.3.8, oxlint 1.43.0, prettier 3.8.1, squawk-cli 2.40.0

---

## [v18.1-202601221905] - 2026-01-22

### Changed

- **pgflow 0.13.1 → 0.13.2**: Automatic stalled task recovery for worker crash resilience
  - New: Tasks stuck in 'started' status beyond `timeout + 30s` are automatically requeued (up to 3 attempts)
  - New: `requeued_count` and `last_requeued_at` columns in `step_tasks` table for monitoring
  - New: Cron job (`requeue_stalled_tasks`) runs every 15 seconds
  - Fixed: `maxPgConnections` parameter now respected in edge-worker (was ignored, default changed 10→4)
- **pgmq 1.8.1 → 1.9.0**: FIFO queue support with message groups, `read_grouped()` functions
  - New `read_grouped()`, `read_grouped_rr()` functions for FIFO message group ordering
  - New `create_fifo_index()` / `create_fifo_indexes_all()` for GIN indexes on message headers
  - ⚠️ **Breaking**: `conditional` parameter removed from FIFO-grouped read functions (violated ordering guarantees)
- **pgbackrest 2.57.0 → 2.58.0**: Latest backup/restore tool from PGDG
  - ⚠️ **Breaking**: Minimum `repo-storage-upload-chunk-size` increased to vendor minimums
  - ⚠️ **Breaking**: TLS 1.2 now required (unless verification disabled)
  - New: HTTP support for S3/GCS/Azure, Azure managed identities

### Development (non-image)

- Updated oxlint to 1.41.0, squawk-cli to 2.37.0, @pgflow/client and @pgflow/dsl to 0.13.2
- Enhanced pgmq test suite with FIFO tests, error handling, batch operations, `list_queues` metadata verification
- Added pgflow-pgmq contract tests: `pgmq.format_table_name()` and `pgflow.set_vt_batch()` internal API verification

---

## [v18.1-202601171501] - 2026-01-17

### Added

- **pgflow v0.13.1 Supabase Compatibility Layer**: Full integration with Supabase-to-standalone PostgreSQL compatibility
  - `realtime.send()` stub replacing Supabase Realtime API (3-layer: pg_notify + pgmq + pg_net webhooks)
  - Template1 installation: new databases inherit the `realtime.send()` compatibility stub automatically
  - Custom installation marker (`app.aza_pg_custom`) for environment detection
  - Comprehensive documentation: `docs/PGFLOW.md`
  - Test suite: `test-pgflow-security.ts`, `test-pgflow-new-database.ts`
  - **Security**: SSRF protection (REVOKE EXECUTE FROM PUBLIC), role-based access control
  - Security patches: AZA-PGFLOW-001 (get_run_with_states), AZA-PGFLOW-002 (start_flow_with_states), COMPAT-AZA-PG-001 (is_local)

### Changed

- **Base image**: Updated `postgres:18.1-trixie` SHA from `bfe50b2b...` to `5773fe72...` (Debian Trixie 13.8.2→13.8.3, GnuPG CVE-2025-30258 fix)
- **pgflow**: 0.13.0 → 0.13.1
  - Fixed Supabase CLI local environment detection (now uses `SUPABASE_URL` check instead of API keys)
  - Includes v0.13.0 performance improvements (2.17× faster Map→Map chains via atomic step output storage)
- **pg_partman**: 5.3.1 → 5.4.0 (switched from PGDG to source build)
  - New `create_partition()` and `create_sub_partition()` functions (backward-compatible aliases for `create_parent()`/`create_sub_parent()`)
  - New `config_cleanup()` function to remove pg_partman configuration while preserving partition structure
  - Fixed critical bug in DESC order partitioning (`p_order := 'DESC'`) causing "relation does not exist" errors
  - Added infinity value handling via `p_ignore_infinity` parameter in `partition_data_time()`, `partition_data_proc()`, and `check_default()`
  - PostgreSQL 17 MAINTAIN privilege now properly inherited (automatically applied when using PG17+)
  - **Note**: PGDG repository only has v5.3.1 - building from source for latest features
- **pgbadger**: 13.1 → 13.2
  - **Critical fix for PostgreSQL 18**: Fixed checkpoint parsing regression
  - Updated embedded pgFormatter to v5.9
  - Fixed SQL normalization for escaped quotes handling
  - Fixed PgBouncer stats parsing
  - New `--ssh-sudo` command for remote log analysis with sudo authentication

### Fixed

- **CRITICAL**: Fixed hll PGDG version causing all PGDG extensions to silently fail installation
  - **Root cause**: Docker BuildKit cached successful apt-get layer while actual package version didn't exist (2.19-1.pgdg13+1 vs 2.19-2.pgdg13+2)
  - **Symptom**: Image built successfully but extensions missing at runtime ("No such file or directory" errors)
  - **Impact**: Affected all 12 PGDG extensions (pg_cron, pgaudit, pgvector, postgis, pgrouting, pg_repack, hll, http, hypopg, rum, plpgsql_check, set_user)
  - **Fix**: Updated hll pgdgVersion to correct value (2.19-2.pgdg13+2)
  - **Prevention**: Created PGDG version validation script to catch mismatches before build

### Development (non-image)

- **Build system**: Removed pg_partman from PGDG package installation (now built from source)
- **Validation**: Added PGDG version validation against actual repository (prevents silent apt-get failures)
- **Testing**: Updated pgflow schema to v0.13.1 (test fixtures regenerated)
- **Stacks**: Updated PgBouncer to v1.25.1-p0 in primary stack (CVE-2025-12819 fix, LDAP auth, transaction_timeout)
- **Dependencies**: Updated dev dependencies (bun 1.3.5→1.3.6, oxlint 1.38.0→1.39.0, prettier 3.7.4→3.8.0, sql-formatter 15.6.12→15.7.0)

---

## [18.1-202601081823-single-node] - 2026-01-08

### Changed

- **Base image**: Updated `postgres:18.1-trixie` SHA from `38d5c9d5...` to `bfe50b2b...` (security patches)
- **pgflow**: 0.11.0 → 0.13.0
  - 2.17× faster Map→Map chains via atomic step output storage
  - **BREAKING**: v0.12.0 changed handler signatures (root: flowInput, dependent: deps + ctx.flowInput)
- **pgmq**: 1.8.0 → 1.8.1
  - Fixed time-based archive partitioning
  - SQL typo fixes

### Added

- CHANGELOG.md following Keep a Changelog format

### Security

- **CVE-2025-13836**: Accepted Python http.client memory exhaustion vulnerability
  - Does not affect PostgreSQL (core is C, no extensions use http.client)
  - Debian classified as minor issue, awaiting upstream fix
  - Added to .trivyignore and documented in SECURITY.md

### Development (non-image)

- **CI Reliability**: Added Cosign retry logic with exponential backoff for image signing
- **CI Reliability**: Made git tag creation atomic with verification to prevent race conditions
- **CI Reliability**: Fixed Bun cache monitoring (exit 127) by adding setup-bun to build jobs
- **CI Reliability**: Improved cleanup script resilience for GitHub API eventual consistency
- **Testing**: Updated `@pgflow/client` and `@pgflow/dsl` devDependencies to 0.13.0
- **Testing**: Added tests for pgflow v0.13.0 atomic outputs
- **Testing**: Added tests for pgmq v1.8.1 archive partitioning
- **Testing**: Fixed test pre-cleanup to safely handle stale volumes without affecting production containers
- **Dependencies**: Bumped GitHub Actions: checkout (4→6), upload-artifact (4→6), download-artifact (6→7), cache (4→5), attest-build-provenance (3.0.0→3.1.0)

---

## [18.1-202512241648-single-node]

### Changed

- Production artifacts with updated dependencies
- Documentation improvements

---

## [18.1-202512192240-single-node]

### Added

- **pg_net**: Added to default `shared_preload_libraries`
- **pgsodium**: Added to default `shared_preload_libraries`

### Development (non-image)

- Enhanced nightly CI workflow

---

## [18.1-202512190839-single-node]

### Fixed

- **Docker security**: Fixed apt cleanup for Dockle DKL-DI-0005 compliance

---

## Version Format

Image tags follow: `MM.mm-YYYYMMDDHHMM-TYPE`

- `MM.mm`: PostgreSQL version (e.g., 18.1)
- `YYYYMMDDHHMM`: Build timestamp
- `TYPE`: `single-node` or `replica-set`

Example: `18.1-202501071430-single-node`
