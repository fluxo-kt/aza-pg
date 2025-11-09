# aza-pg — Agent Operations Guide

Production PostgreSQL 18 stack with auto-adaptive config, compiled extensions (pgvector/pg_cron/pgAudit), PgBouncer pooling, and multi-platform builds. Designed for 2GB-128GB deployments with minimal manual tuning.

## Architecture

**Image:** Multi-stage build compiles extensions from SHA-pinned sources → copies `.so` files to slim final image. ENTRYPOINT script runs at `docker run` (container start on VPS) → detects deployment environment RAM/CPU → injects `-c` flags to postgres command. One image adapts to any hardware.

**Stacks:** Compose-based deployments. `primary/` = Postgres + PgBouncer + postgres_exporter (3 services). All values env-driven, no hardcoded IPs/passwords.

**Extensions:** 38 total (6 builtin + 14 PGDG pre-compiled + 18 source-compiled: 12 extensions + 6 tools). Hybrid approach: PGDG packages for stability/speed, SHA-pinned compilation for specialized extensions. All production-ready for PG18. Note: "Tools" are hook-based or command-line utilities without CREATE EXTENSION support (pgbackrest, pgbadger, pg_plan_filter, pg_safeupdate, supautils, wal2json).

## Critical Patterns

### Auto-Config Logic (`docker-auto-config-entrypoint.sh`)

**When:** RUNTIME (container start on VPS), NOT build-time. Same image adapts to any deployment environment.

**How:**

- Detects RAM: cgroup v2 limit of the running container → manual override via `POSTGRES_MEMORY=<MB>` takes precedence → falls back to `/proc/meminfo` if no limit.
- Detects CPU: `nproc` fallback when no quota is set → sizes worker counts
- Injects runtime flags for buffers, cache, maintenance/work memory, connection caps, worker counts, **and** `shared_preload_libraries` so pg_cron/pgAudit stay loaded even if static configs drift

**Default Behavior:** Honors actual machine RAM (via cgroup or `/proc/meminfo`) or explicit `POSTGRES_MEMORY`.

**Caps:** shared_buffers capped at 32GB, maintenance_work_mem max 2GB, work_mem max 32MB, max_connections tiers at 80/120/200

**Overrides:**

- `POSTGRES_MEMORY=<MB>` — Manual RAM override (useful in dev shells/CI)
- `POSTGRES_SHARED_PRELOAD_LIBRARIES` — Override default preloaded extensions (default: `pg_stat_statements,auto_explain,pg_cron,pgaudit`)

**Optional Preload Extensions:** Additional extensions can be preloaded by setting POSTGRES_SHARED_PRELOAD_LIBRARIES. Candidates include `pgsodium` (requires pgsodium_getkey script for TCE), `timescaledb` (time-series), `supautils` (superuser guards), `pg_stat_monitor` (may conflict with pg_stat_statements; test before enabling both).

**Why:** One image works on 2GB VPS or 128GB server. Detection at runtime (not build) ensures adaptation to actual deployment environment.

### PgBouncer Auth Pattern

- **NO plaintext userlist.txt**: Uses `auth_query = SELECT * FROM pgbouncer_lookup($1)`
- Function: SECURITY DEFINER reads `pg_shadow` (password hashes)
- Bootstrap: `pgbouncer_auth` user created in stack-specific `03-pgbouncer-auth.sh`
- PgBouncer container renders config via `scripts/pgbouncer-entrypoint.sh` → writes `/tmp/.pgpass` with escaped password instead of inlining it in `pgbouncer.ini`
- Health check connects through PgBouncer using standard database connection (not the admin console)

**Credential flow:** set `${PGBOUNCER_AUTH_PASS}` in `.env`. Entry script escapes special characters for `.pgpass`, so passwords may include `:`, `@`, `&`, etc.

### Extension Hybrid Strategy (PGDG + Source Compilation)

**Pattern:** Hybrid approach combining PGDG pre-compiled packages with SHA-pinned source compilation.

**PGDG Extensions (14):** pg_cron, pgaudit, pgvector, timescaledb, postgis, pg_partman, pg_repack, plpgsql_check, hll, http, hypopg, pgrouting, rum, set_user

- Installed via APT from apt.postgresql.org
- GPG-signed packages with pinned versions (e.g., `postgresql-18-pgvector=0.8.1-2.pgdg13+1`)
- Benefits: Instant install, tested against PG18, multi-arch (amd64/arm64)

**Compiled Extensions (12):** index_advisor, pg_hashids, pg_jsonschema, pg_stat_monitor, pgmq, pgq, pgroonga, pgsodium, supabase_vault, timescaledb_toolkit, vectorscale, wrappers

**Tools (6):** pgbackrest (backup), pgbadger (log analyzer), pg_plan_filter (hook), pg_safeupdate (hook), supautils (hooks), wal2json (logical decoding)

- Built from SHA-pinned source (immutable Git commits)
- Required when: Not in PGDG, need latest features, or specialized (Supabase ecosystem)
- Manifest field in docker/postgres/extensions.manifest.json: `install_via: "pgdg"` flags PGDG extensions → skipped by build-extensions.sh

**Security Model:**

- PGDG: GPG-signed APT repository (PostgreSQL community trust)
- Compiled: SHA256-pinned Git commits (immutable, auditable)
- Both prevent supply chain attacks via different mechanisms

**Build Optimization:** 14 PGDG packages install in ~10s, 17 extensions compile in ~12min (down from ~20min for 31 extensions). Total build time: ~12min.

**Upgrade:** PGDG extensions → update version pin in Dockerfile RUN block. Compiled extensions → find commit SHA → update docker/postgres/extensions.manifest.json → rebuild.

**Analysis & Impact:** See comprehensive documentation:

- **Size analysis:** `docs/analysis/extension-size-analysis.md` (per-extension size breakdown, timescaledb_toolkit optimized from 186MB to 13MB in Phase 11)
- **Performance impact:** `docs/extensions/PERFORMANCE-IMPACT.md` (memory overhead, query performance, build time)
- **Pre-built binaries:** `docs/extensions/PREBUILT-BINARIES-ANALYSIS.md` (GitHub release availability, 3 viable candidates)
- **PGDG availability:** `docs/extensions/PGDG-AVAILABILITY.md` (pgroonga NOT available in PGDG for PostgreSQL 18)

### Hook-Based Extensions & Tools

**Pattern:** Some extensions load via `shared_preload_libraries` without `CREATE EXTENSION` support. Classified as `"kind": "tool"` in manifest.

**Hook-Based Extensions & Tools (6 total):**

- **pg_plan_filter**: Filters query plans based on configurable rules (hook-based, no .control file)
- **pg_safeupdate**: Prevents UPDATE/DELETE without WHERE clause (hook-based, no .control file)
- **supautils**: Superuser guards and event trigger hooks for managed Postgres (GUC-based, no CREATE EXTENSION)
- **pgbackrest**: Backup and restore tool (command-line utility)
- **pgbadger**: Log analyzer (Perl tool)
- **wal2json**: Logical decoding plugin (output plugin for logical replication)

**Characteristics:**

- Load at server start via shared_preload_libraries or session_preload_libraries
- No CREATE EXTENSION command (no .control/.sql files)
- Configure via GUC parameters (SHOW/SET commands) or hooks automatically active
- Cannot be installed per-database (server-wide or session-wide only)

**Logical Decoding Plugins (1):**

- **wal2json**: Output plugin for logical replication (CDC), not a CREATE EXTENSION extension
- Used with `pg_recvlogical` or replication slots, not installed via SQL

**Why Separate Classification:** Prevents init script failures (01-extensions.sql attempts CREATE EXTENSION on all "extension" kind entries). Tools/hooks load via configuration, not SQL commands.

**Manifest Fields:**

```json
{
  "kind": "tool",  // Not "extension"
  "runtime": {
    "sharedPreload": true,  // Load via shared_preload_libraries
    "defaultEnable": true/false
  }
}
```

### Extension Enable/Disable Pattern

**Pattern:** Extensions can be selectively enabled/disabled via manifest without breaking dependencies or losing test coverage. Build system enforces dependency validation and cleanup.

**Manifest Fields:**

```json
{
  "name": "pgq",
  "enabled": false, // NEW: Controls build/install (defaults to true)
  "disabledReason": "Not needed for AI workloads", // OPTIONAL: Documentation
  "runtime": {
    "defaultEnable": true // EXISTING: Controls CREATE EXTENSION in init script
  }
}
```

**Field Semantics:**

- `enabled` (top-level): Controls whether extension is **built and installed** in Docker image
  - `true` (default): Extension compiled/installed, available for use
  - `false`: Skipped during build, not in final image
- `runtime.defaultEnable`: Controls whether extension is **created automatically** via `01-extensions.sql`
  - `true`: Created via `CREATE EXTENSION` on first cluster start
  - `false`: Available but requires manual `CREATE EXTENSION`

**Workflow:**

1. `enabled: false` → Skip build/install entirely (not in image, dependency errors fail fast)
2. `enabled: true, defaultEnable: false` → Built/installed but not created (manual activation)
3. `enabled: true, defaultEnable: true` → Built, installed, and auto-created (baseline extensions)

**4-Gate Build Logic:**

**Gate 0 (Enabled Check):**

- Reads `enabled` field from manifest (defaults to `true` for backward compatibility)
- Tracks disabled extensions in array for post-build cleanup
- Continues building disabled extensions (verify they still work)
- Logs disabled reason for documentation

**Gate 1 (Dependency Validation):**

- Validates all dependencies are enabled before building
- Fails fast with clear error if dependency disabled or missing
- Example error: `Extension index_advisor requires dependency 'hypopg' which is disabled`

**Gate 2 (Binary Cleanup):**

- Runs AFTER all extensions built and tested
- Removes `.so` files and SQL/control files for disabled extensions only
- Verifies extension was built (basic smoke test, warns if missing)
- Prevents disabled extensions from appearing in final image
- Cleans: `/usr/lib/postgresql/18/lib/*.so`, `/usr/share/postgresql/18/extension/*`, bitcode

**Gate 3 (Init Script Generation):**

- `01-extensions.sql` generated from manifest via `./scripts/generate-configs.sh`
- Only includes extensions with `enabled: true AND runtime.defaultEnable: true`
- Automatically excludes disabled extensions and tools (no CREATE EXTENSION support)

**Usage Example:**

```bash
# Disable pgq in manifest
jq '.entries |= map(if .name == "pgq" then . + {"enabled": false, "disabledReason": "Not needed"} else . end)' \
  docker/postgres/extensions.manifest.json > /tmp/manifest.json && \
  mv /tmp/manifest.json docker/postgres/extensions.manifest.json

# Regenerate init script
./scripts/generate-configs.sh

# Rebuild image (pgq will be skipped)
./scripts/build.sh
```

**Dependency Cascade Protection:**
If extension A depends on extension B:

- Disabling B → Build fails when processing A (clear error message)
- Either enable B or disable A to resolve

**Core Preloaded Extension Protection:**

**Cannot Disable These 4 Extensions:**

- `auto_explain` - Query plan logging (observability)
- `pg_cron` - Cron-based job scheduler (operations)
- `pg_stat_statements` - Query statistics (observability)
- `pgaudit` - Audit logging (security)

**Why:** Auto-config hardcodes these in `shared_preload_libraries`. Disabling causes runtime crash:

```
FATAL: could not load library "pg_cron.so": No such file or directory
```

**Behavior:** Build fails immediately with actionable error:

```
[ext-build] ERROR: Cannot disable extension 'pg_cron'
[ext-build]        This extension is required in shared_preload_libraries
[ext-build]        Disabling would cause runtime crash
[ext-build]
[ext-build]        To disable this extension, you must ALSO set:
[ext-build]        POSTGRES_SHARED_PRELOAD_LIBRARIES='pg_stat_statements,auto_explain,pgaudit'
[ext-build]        (exclude 'pg_cron' from the list)
```

**Workaround:** Set `POSTGRES_SHARED_PRELOAD_LIBRARIES` environment variable:

```bash
# Disable pg_cron AND override preload list
POSTGRES_SHARED_PRELOAD_LIBRARIES='pg_stat_statements,auto_explain,pgaudit'

# Must exclude pg_cron from BOTH manifest AND preload list
```

**Validation:** Build-time check converts runtime crash → build-time error (fail fast)

**Testing Disabled Extensions (CRITICAL REQUIREMENT):**

**Absolute Requirement:** ALL extensions and tools, even disabled ones, MUST be built and tested.

**Why This Matters:**

- Disabled extensions use SHA-pinned commits (immutable Git references)
- Without build+test, upstream changes or SHA staleness go undetected
- Re-enabling later = surprise build failures in production
- Testing disabled extensions = continuous verification they still work

**Build System Behavior:**

1. **Build Phase:** ALL extensions compiled (enabled + disabled)
   - Disabled extensions marked with: "building for testing only"
   - Compilation verifies SHA-pinned commits still work
   - Build failures surface immediately (fail fast)

2. **Test Phase:** Basic smoke tests run automatically
   - Gate 2 verifies binaries exist (warns if missing)
   - Presence of `.so` and `.control` files confirms successful build
   - No separate test infrastructure needed (build = test)

3. **Cleanup Phase:** ONLY disabled extensions removed from image
   - Runs AFTER build+test complete
   - Prevents disabled extensions from shipping to production
   - Image contains only enabled extensions

4. **Init Script:** Disabled extensions excluded from CREATE EXTENSION
   - Generated from manifest: `enabled: true AND defaultEnable: true`
   - No manual intervention needed

**Current Status:** ✅ IMPLEMENTED

- Gate 0: Tracks disabled extensions, continues building
- Gate 1: Validates dependencies (fails if disabled dep required)
- Gate 2: Removes disabled extensions AFTER successful build
- Gate 3: Generates init script excluding disabled extensions

**Verification:**

```bash
# During build, you should see:
[ext-build] Extension pgq disabled (reason: Not needed for AI workloads) - building for testing only
[ext-build] Running pgxs build in /tmp/extensions-build/pgq
# ... compilation output ...
[ext-build] Removing 1 disabled extension(s) from image
[ext-build]   Cleaning up: pgq
[ext-build]     ✓ Removed pgq.so
[ext-build]     ✓ Removed pgq.control
[ext-build] Disabled extensions built and tested, then removed from image
```

Per design doc `docs/development/EXTENSION-ENABLE-DISABLE.md`, future enhancements:

- Functional tests for disabled extensions (verify basic queries work)
- Load tests without CREATE EXTENSION (binary compatibility)
- Regression detection for upstream changes

**Related Documentation:**

- Implementation guide: `docs/development/EXTENSION-ENABLE-DISABLE.md` (974 lines, comprehensive)
- 7 critical risks identified via inversion reasoning (dependency validation, binary cleanup, etc.)

### Workflow Orchestration (pgflow) - Optional

**pgflow v0.7.2** is an **optional** workflow orchestration system available as an add-on (not installed by default):

- **Installation**: Manual - copy `examples/pgflow/10-pgflow.sql` to stack-specific `initdb/` directory or custom image
- **Dependency**: Requires **pgmq extension** (Postgres Message Queue) - already installed
- **Features**: DAG workflows, task queues, retry logic, step dependencies, map steps for parallel array processing
- **Limitations**: Real-time events stubbed (no Supabase Edge Functions), requires custom worker implementation
- **Documentation**: See `examples/pgflow/README.md` for installation and `docs/pgflow/INTEGRATION.md` for integration guide

**Key Tables**: flows, steps, deps, runs, step_states, step_tasks, workers
**Key Functions**: create_flow(), add_step(), start_flow(), complete_task(), fail_task()

Unlike traditional extensions, pgflow is schema-based workflow state management. The execution worker must be implemented separately (see integration docs for 3 implementation patterns). Only install if you need PostgreSQL-native DAG workflows.

### Init Script Execution Order

**CRITICAL:** Init scripts execute alphabetically from two sources:

1. Shared scripts: `docker/postgres/docker-entrypoint-initdb.d/` (mounted to ALL stacks)
2. Stack-specific scripts: `stacks/*/configs/initdb/` (mounted per stack)

**Shared Script Order (ALL stacks):**

1. `01-extensions.sql` — Creates 7 baseline extensions (auto_explain, pg_cron, pg_stat_statements, pg_trgm, pgaudit, plpgsql, vector). Additional 31 extensions available but disabled by default. MUST run first.
2. `02-replication.sh` — Creates `replicator` user + replication slot (if replication enabled).
3. `03-pgsodium-init.sh` — Initializes pgsodium extension and generates root key (if ENABLE_PGSODIUM_INIT=true, optional).

**Stack-Specific Scripts:**
Scripts in `stacks/*/configs/initdb/` execute alphabetically alongside shared scripts (both sources merged, sorted 01→99). Stack-specific 03-_ scripts (e.g., `03-pgbouncer-auth.sh`) run after shared 03-_ but before 04-\*:

- Primary: `03-pgbouncer-auth.sh` — Creates `pgbouncer_auth` user + `pgbouncer_lookup()` function
- Replica: (empty, uses shared scripts only)
- Single: (empty, uses shared scripts only)

**Why Order Matters:**

- Extensions MUST load before user creation (SECURITY DEFINER functions require extensions)
- Replication user creation before stack-specific auth infrastructure
- pgsodium initialization before any other extensions that depend on encryption
- Wrong order → cryptic "function does not exist" or "role does not exist" errors

**Adding New Scripts:**

- Shared scripts: Use `03-`, `04-`, etc. (after replication)
- Stack-specific: Can reuse prefixes (only visible to that stack), but maintain logical order
- Never use `00-` (breaks extension dependency)

### Compose Override Pattern

**Pattern:** `compose.yml` (prod: private IPs, limits) + `compose.dev.yml` (dev: localhost, test memory). Compose merges configurations using standard YAML merge semantics (later files override earlier values). Base compose now relies on `mem_limit`/`mem_reservation` so Docker applies cgroup limits; keep those values aligned with auto-config expectations.

**Usage:** `docker compose -f compose.yml -f compose.dev.yml up` merges configs (dev wins on conflicts).

### Shared Base Configuration Pattern

**Pattern:** Extract common PostgreSQL settings to `docker/postgres/configs/postgresql-base.conf`, use `include` directive in stack-specific configs.

**Files:**

- Base: `docker/postgres/configs/postgresql-base.conf` (75 lines)
- Primary: Stack-specific overrides only (44 lines total)
- Replica: Stack-specific overrides only (35 lines total)
- Single: Stack-specific overrides only (24 lines total)

**Usage:** `include = '/etc/postgresql/postgresql-base.conf'` at top of each config

**Benefits:** DRY, single source of truth, no config drift. Common settings (I/O, logging, extensions, autovacuum) defined once.

**What goes in base:** Universal settings (listen_addresses, io_method, WAL compression, TLS config, pg_stat_statements, auto_explain, logging format).

**What stays in stack configs:** Deployment-specific (replication settings, synchronous_commit, max_wal_senders, hot_standby delays, pg_cron).

### Auto-Config Memory Allocation

**Detection:** Prefers cgroup v2 limits, respects manual overrides (`POSTGRES_MEMORY=<MB>`), otherwise inspects `/proc/meminfo`.

**Overrides:**

- `POSTGRES_MEMORY=<MB>` — Manual RAM override (works even when cgroup limits exist)

**Baseline ratios:** ~25% of detected RAM allocated to shared_buffers up to 32GB, with effective_cache ≥2× buffers. Work mem capped at 32MB, maintenance_work_mem at 2GB. Connection tiers: 80 (≤512MB), 120 (<4GB), 200 (≥4GB).

**Common cases:**

- 512MB limit → shared_buffers 128MB, effective_cache 384MB, work_mem 1MB, max_connections 80
- 1GB override (`POSTGRES_MEMORY=1024`) → shared_buffers 256MB, effective_cache 768MB, work_mem 2MB, max_connections 120
- 2GB limit → shared_buffers 512MB, effective_cache 1536MB, work_mem 4MB, max_connections 120
- 4GB limit → shared_buffers 1024MB, effective_cache 3072MB, work_mem ~5MB, max_connections 200
- 8GB limit → shared_buffers 2048MB, effective_cache 6144MB, work_mem ~10MB, max_connections 200
- 64GB override (`POSTGRES_MEMORY=65536`) → shared_buffers ~9830MB, effective_cache ~49152MB, work_mem 32MB, max_connections 200

**Memory Allocation Table:**

| RAM   | shared_buffers | effective_cache   | maint_work_mem  | work_mem   | max_conn | Ratio      |
| ----- | -------------- | ----------------- | --------------- | ---------- | -------- | ---------- |
| 512MB | 128MB (25%)    | 384MB (75%)       | 32MB (6%)       | 1MB        | 80       | Min viable |
| 1GB   | 256MB (25%)    | 768MB (75%)       | 32MB (3%)       | 2MB        | 120      | Dev/test   |
| 2GB   | 512MB (25%)    | 1536MB (75%)      | 64MB (3%)       | 4MB        | 120      | Small prod |
| 4GB   | 1024MB (25%)   | 3072MB (75%)      | 128MB (3%)      | 5MB        | 200      | Med prod   |
| 8GB   | 2048MB (25%)   | 6144MB (75%)      | 256MB (3%)      | 10MB       | 200      | Large prod |
| 16GB  | 3276MB (20%)   | 12288MB (75%)     | 512MB (3%)      | 20MB       | 200      | High-load  |
| 32GB  | 6553MB (20%)   | 24576MB (75%)     | 1024MB (3%)     | 32MB (cap) | 200      | Enterprise |
| 64GB  | 9830MB (15%)   | 49152MB (75% cap) | 2048MB (3% cap) | 32MB (cap) | 200      | Burst node |

**Extension Memory Overhead (Estimated):**

- **Base overhead**: ~50-100MB (pg_stat_statements, auto_explain, pgaudit shared memory)
- **pgvector**: ~10-50MB per connection (depends on vector dimensions and HNSW index size)
- **timescaledb**: ~20-100MB (hypertable metadata, compression buffers)
- **pg_cron**: ~5-10MB (job scheduler state)
- **Total extension overhead**: ~100-250MB depending on usage patterns

**Why These Numbers Matter:**

- 512MB deployments leave ~250-300MB for OS/connections after buffers (tight but functional)
- 2GB+ deployments have comfortable headroom for connection pooling and temp workloads
- 16GB+ can handle hundreds of pooled connections via PgBouncer with minimal memory pressure
- work_mem cap (32MB) prevents OOM from complex queries on low-RAM nodes

### PostgreSQL 18 Optimizations Applied

- **Async I/O:** `io_method = 'worker'` (2-3x I/O performance on NVMe/cloud storage)
- **LZ4 WAL compression:** Faster than legacy `pglz`, reduces WAL volume 30-60%
- **Data checksums:** Enabled by default (opt-out via `DISABLE_DATA_CHECKSUMS=true`)
- **TLS 1.3 support:** Configured (commented out, requires cert setup)
- **Enhanced monitoring:** `pg_stat_io` and `pg_stat_wal` views for I/O/WAL analysis
- **Idle replication slot timeout:** Prevents WAL bloat from abandoned slots (48h)
- **pgAudit log_statement_once:** Reduces duplicate audit log entries (PG18 feature)

### Security Hardening Pattern

**User isolation:**

- `NOINHERIT` on replicator and pgbouncer_auth users (prevents privilege escalation)
- Per-user connection limits (postgres: 50, replicator: 5, pgbouncer_auth: 10)

**Audit logging:**

- pgAudit tracks DDL, write operations, and role changes
- `pgaudit.log_statement_once = on` reduces log duplication (PostgreSQL 18 feature)
- Output to stderr (captured by Docker logs)

**Network isolation:**

- Default: localhost (127.0.0.1) binding via `POSTGRES_BIND_IP` env var
- Production: Change to 0.0.0.0 for network access (requires firewall/network security)
- Development: localhost override via `compose.dev.yml`

**Secrets management:**

- All passwords via env vars (never committed)
- Dev test password (`dev_pgbouncer_auth_test_2025`) safe for local testing only
- Production: `${PGBOUNCER_AUTH_PASS}`, `${POSTGRES_PASSWORD}` injected at runtime

## Key Workflows

**Extension Testing:** CREATE EXTENSION + functional query → grep logs for RAM/CPU detection → test PgBouncer via :6432 → verify SHOW POOLS.

**Local Builds (Default):** `./scripts/build.sh` uses Docker Buildx with remote cache from CI artifacts. This is the canonical build method. First build: ~12min (full compilation). Cached build: ~2min (reuses CI layers). Falls back to local cache if network unavailable. Multi-platform requires `--push` flag.

**CI/CD:** Manual trigger only (extensions change rarely). Multi-platform buildx with SBOM/provenance. arm64 validation via QEMU emulation (tests pgvector, pg_cron, pg_jsonschema on emulated arm64 before release).

## Testing Strategy

**Critical Tests:**

1. Extension loading (CREATE + functional query)
2. Auto-config detection (grep logs for RAM/CPU/scaled values)
3. PgBouncer auth (via :6432, verify SHOW POOLS)
4. Memory limit verification (512MB, manual 1GB override, 2GB limit, 64GB override)
5. arm64 validation (QEMU emulation: pgvector, pg_cron, pg_jsonschema + auto-config)

**Why Memory Tests Matter:** Auto-config prefers cgroup v2. Without limits it consults `/proc/meminfo`, which may reflect the host. Exercising manual overrides (`POSTGRES_MEMORY`) ensures deterministic tuning in CI/local shells.

## Gotchas & Edge Cases

1. **PgBouncer password sync**: `.pgpass` must exist inside PgBouncer container. If auth fails, check `docker exec pgbouncer-primary ls -l /tmp/.pgpass` and container logs.

2. **Auto-config runtime flags**: If postgresql.conf has conflicting settings, `-c` flags from entrypoint override them. Auto-config is always enabled and cannot be disabled.

3. **Extension SHA mismatch**: If git clone fails during build, SHA may be stale (force-push to tag). Verify at GitHub: `https://github.com/pgvector/pgvector/commit/<SHA>`

4. **Memory limit not detected**: Auto-config reads `/proc/meminfo` when no limit is set, which may reflect the host's full RAM. Specify `mem_limit` in Compose or set `POSTGRES_MEMORY=<MB>` to pin tuning.

5. **Health check failures**: PgBouncer test uses regular database connection, NOT admin "pgbouncer" database. Wrong: `psql pgbouncer://...@localhost:6432/pgbouncer`. Right: `psql postgres://...@localhost:6432/postgres`.

6. **Build vs Runtime confusion**: Extension versions (PG_VERSION, PGVECTOR_VERSION) = build-time ARGs (baked into image). RAM/CPU detection = runtime (adapts to VPS where deployed). One image works everywhere.

7. **arm64 QEMU slowness**: CI arm64 tests run via QEMU emulation (2-3x slower startup). Local arm64 testing requires Docker Desktop with QEMU or native arm64 hardware. Production arm64 deployments run natively (no emulation overhead). See `docs/ci/ARM64-TESTING.md` for troubleshooting.

## Monitoring

**postgres_exporter** (`:9187/metrics`): Exposes `pg_stat_database_*`, custom queries from `docker/postgres/configs/postgres_exporter_queries.yaml` (replication lag, memory settings, postmaster uptime).

**Integration:** Prometheus scrapes `:9187`, Grafana dashboards query Prometheus. No special auth (metrics are public on monitoring network).

## Security

- Extensions: SHA-pinned to prevent tag poisoning
- Auth: SCRAM-SHA-256 (no MD5/plaintext)
- PgBouncer: auth_query via SECURITY DEFINER function (no plaintext userlist)
- Networks: Private IPs only in prod (127.0.0.1 in dev)
- Secrets: env vars, never committed (only dev test password safe)

## Upgrading

**PostgreSQL Major:** Update `PG_VERSION` ARG → check extension compat → update extension ARGs + SHAs → rebuild → pg_upgrade.

**Extensions Minor:** Find commit SHA from release → update `*_VERSION` + `*_COMMIT_SHA` ARGs → rebuild → `ALTER EXTENSION <name> UPDATE;`

**Key:** Always update BOTH ARGs (version + SHA). Rebuild triggers multi-platform CI/CD.

## Contributing

1. Test locally: `./scripts/build.sh` → deploy primary stack → verify extensions
2. Check auto-config: Run `./scripts/test/test-auto-config.sh` (covers manual + 512MB + 2GB + 64GB cases)
3. Regenerate configs if touching generator files: `./scripts/generate-configs.sh` (requires `bun`)
4. Verify no secrets leaked: `grep -ri "password\|secret" . | grep -v .env.example`
5. Update CHANGELOG.md
6. PR with clear description of changes

## Design Constraints

**Target Range:** 2-16GB RAM optimal, scales 2-128GB. 1-64 CPU cores. Compose-only (no K8s).

**Deliberate Limits:**

- Max connections: 80/120/200 (tiers by RAM to prevent OOM; PgBouncer multiplexes)
- PgBouncer transaction mode: NO prepared statements/advisory locks/LISTEN/NOTIFY (use session mode if needed)
- Auto-config: Reads cgroup v2, manual `POSTGRES_MEMORY`, or `/proc/meminfo`; set a limit if you need deterministic tuning
- PostgreSQL 18 only: No multi-version support (simplifies maintenance)

**Why Transaction Mode:** Stateless pooling maximizes connection efficiency. Session-local features (prepared statements) break pooling. Use direct Postgres connection (:5432) if needed, PgBouncer (:6432) for app connections.

**Why SHA Pinning:** Version tags are mutable (attacker repush). Commit SHAs are immutable forever. Trade-off: Manual SHA updates vs supply chain security.

## Development Tooling

**Runtime:** Bun 1.3.0+ (primary), TypeScript 5.9.3 strict mode, Node 24.0.0+ (engines min). All scripts/tools use Bun-native APIs (`$` spawn, bunx). NO Node-compat needed.

**Code Quality:**

- **Linting:** Oxlint 0.11.1 (Rust-based, 50-100x faster than ESLint) — `bun run lint`
- **Formatting:** Prettier 3.6.2 — `bun run format` / `bun run format:check`
- **Type Check:** TypeScript strict mode — `bun run type-check`
- **Shell Linting:** shellcheck (20 bash scripts) — `bun run lint:shell`
- **Dockerfile Linting:** hadolint via Docker — `bun run lint:docker`
- **YAML Linting:** yaml-lint — `bun run lint:yaml`

**Validation Pipelines:**

- `bun run validate` — Oxlint + Prettier check + TypeScript (fast, pre-commit)
- `bun run validate:full` — All linters including shell/docker/yaml (comprehensive, pre-push)

**Git Hooks:**

- **pre-commit** — Linting (oxlint) + format check (prettier)
- **pre-push** — Full validation suite (`bun run validate:full`: all linters + types)
- Managed by `bun-git-hooks` (config in `git-hooks.config.ts`), installed as bash scripts in `.git/hooks/`
- Install: `bun run hooks:install`, Uninstall: `bun run hooks:uninstall`

**IDE Consistency:** `.editorconfig` enforces LF line endings, 2-space indents, UTF-8, trim trailing whitespace

**Package Management:** bun.lock (binary format, committed). All deps in devDependencies (infrastructure project, no runtime deps). ArkType for runtime validation (NOT Zod — locked decision in TOOLING.md).

**Testing:** 4,185 lines of integration tests (Docker-based, no mocks). Test via `./scripts/test/*.ts` using Bun's native `$` spawn. Tests cover 11 scenarios: extension loading, auto-config detection, replication, stack deployments, multi-arch builds.

**Critical Files:**

- `package.json` — Scripts, workspaces (root + `scripts/config-generator`)
- `tsconfig.json` — Strict mode, ES2024 target, bundler module resolution
- `.oxlintrc.json` — Linting rules (correctness/suspicious/pedantic/restriction)
- `.prettierrc.json` — Code formatting rules
- `git-hooks.config.ts` — Hook definitions (reference, but hooks installed manually)
- `.editorconfig` — IDE settings

**Key Commands:**

```bash
bun install                 # Install dependencies
bun run validate           # Fast validation (lint + format + types)
bun run validate:full      # Comprehensive (all linters)
bun run lint:fix           # Auto-fix Oxlint issues
bun run format             # Format all files
./scripts/build.sh         # Build Docker image
```

**Tooling Philosophy:** Bun-first (no Node quirks), strict TypeScript (no `any` escape hatches), fast linters (Oxlint/Rust), comprehensive validation (shell/docker/yaml), immutable dependencies (bun.lock committed).

---

**Philosophy:** One image, minimal config tuning. Auto-adapts to hardware. SHA-pinned for reproducibility. Env-driven for universality.
