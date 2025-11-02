# aza-pg — Agent Operations Guide

Production PostgreSQL 18 stack with auto-adaptive config, compiled extensions (pgvector/pg_cron/pgAudit), PgBouncer pooling, and multi-platform builds. Designed for 2GB-128GB deployments with minimal manual tuning.

## Architecture

**Image:** Multi-stage build compiles extensions from SHA-pinned sources → copies `.so` files to slim final image. ENTRYPOINT script runs at `docker run` (container start on VPS) → detects deployment environment RAM/CPU → injects `-c` flags to postgres command. One image adapts to any hardware.

**Stacks:** Compose-based deployments. `primary/` = Postgres + PgBouncer + postgres_exporter (3 services). All values env-driven, no hardcoded IPs/passwords.

**Extensions:** pgvector 0.8.1, pg_cron 1.6.7, pgAudit 18.0 + contrib (pg_trgm/pg_stat_statements/auto_explain). SHA-pinned in Dockerfile ARGs to prevent supply chain attacks.

## Critical Patterns

### Auto-Config Logic (`docker-auto-config-entrypoint.sh`)
**When:** RUNTIME (container start on VPS), NOT build-time. Same image adapts to any deployment environment.

**How:**
- Detects RAM: cgroup v2 limit of RUNNING container → fallback to 1GB default if no limit
- Detects CPU: `nproc` on RUNNING container → scales workers/parallelism
- Injects: `-c shared_buffers=XMB -c max_connections=Y` flags to postgres command at START

**Default Behavior:** No memory limit detected → defaults to 1GB (conservative baseline)

**Caps:** shared_buffers max 8GB, maintenance_work_mem max 2GB, work_mem max 32MB, max_connections 100-200

**Overrides:**
- `POSTGRES_SKIP_AUTOCONFIG=true` — Uses static postgresql.conf values
- `POSTGRES_MEMORY=<MB>` — Manual RAM override when cgroup detection unavailable

**Why:** One image works on 2GB VPS or 128GB server. Detection at runtime (not build) ensures adaptation to actual deployment environment.

### PgBouncer Auth Pattern
- **NO plaintext userlist.txt**: Uses `auth_query = SELECT * FROM pgbouncer_lookup($1)`
- Function: SECURITY DEFINER reads `pg_shadow` (password hashes)
- Bootstrap: `pgbouncer_auth` user created in stack-specific `03-pgbouncer-auth.sh` via envsubst
- Dev password: `dev_pgbouncer_auth_test_2025` (safe, only for local testing)
- Prod: `${PGBOUNCER_AUTH_PASS}` injected via env

**Gotcha:** pgbouncer.ini line 6 hardcodes bootstrap connection password. MUST match postgres user password or auth fails silently. Health check uses regular DB, NOT admin "pgbouncer" database (restricted).

### Extension Pinning Strategy
**Pattern:** `@docker/postgres/Dockerfile` uses dual ARGs: `*_VERSION` (semver) + `*_COMMIT_SHA` (immutable). Git clone checks out SHA, not tag.

**Why:** Version tags are mutable (attacker can repush malicious code under same tag). Commit SHAs are immutable. Ensures reproducible builds forever.

**Upgrade:** Find new release commit SHA → update both ARGs in Dockerfile → rebuild → test → push GHCR.

### Init Script Execution Order
**CRITICAL:** Init scripts execute alphabetically from two sources:
1. Shared scripts: `docker/postgres/docker-entrypoint-initdb.d/` (mounted to ALL stacks)
2. Stack-specific scripts: `stacks/*/configs/initdb/` (mounted per stack)

**Shared Script Order (ALL stacks):**
1. `01-extensions.sql` — Creates ALL extensions (vector, pg_trgm, pg_cron, pgaudit, pg_stat_statements). MUST run first.
2. `02-replication.sh` — Creates `replicator` user + replication slot (if replication enabled).

**Stack-Specific Scripts:**
- Primary: `03-pgbouncer-auth.sh` — Creates `pgbouncer_auth` user + `pgbouncer_lookup()` function
- Replica: (empty, uses shared scripts only)
- Single: (empty, uses shared scripts only)

**Why Order Matters:**
- Extensions MUST load before user creation (SECURITY DEFINER functions require extensions)
- Replication user creation before stack-specific auth infrastructure
- Wrong order → cryptic "function does not exist" or "role does not exist" errors

**Adding New Scripts:**
- Shared scripts: Use `03-`, `04-`, etc. (after replication)
- Stack-specific: Can reuse prefixes (only visible to that stack), but maintain logical order
- Never use `00-` (breaks extension dependency)

### Compose Override Pattern
**Pattern:** `compose.yml` (prod: private IPs, limits) + `compose.dev.yml` (dev: localhost, test memory). Use `!override` tag to replace arrays (ports) vs merge.

**Usage:** `docker compose -f compose.yml -f compose.dev.yml up` merges configs (dev wins on conflicts).

### Shared Base Configuration Pattern
**Pattern:** Extract common PostgreSQL settings to `docker/postgres/configs/postgresql-base.conf`, use `include` directive in stack-specific configs.

**Files:**
- Base: `docker/postgres/configs/postgresql-base.conf` (61 lines)
- Primary: Stack-specific overrides only (44 lines total)
- Replica: Stack-specific overrides only (32 lines total)
- Single: Stack-specific overrides only (26 lines total)

**Usage:** `include = '/etc/postgresql/postgresql-base.conf'` at top of each config

**Benefits:** DRY, single source of truth, no config drift. Common settings (I/O, logging, extensions, autovacuum) defined once.

**What goes in base:** Universal settings (listen_addresses, io_method, WAL compression, TLS config, pg_stat_statements, auto_explain, logging format).

**What stays in stack configs:** Deployment-specific (replication settings, synchronous_commit, max_wal_senders, hot_standby delays, pg_cron).

### Auto-Config Memory Allocation
**Detection:** Detects cgroup v2 memory limits. If no limit: defaults to 1GB RAM (conservative baseline).

**Overrides:**
- `POSTGRES_SKIP_AUTOCONFIG=true` — Uses static `postgresql.conf` values
- `POSTGRES_MEMORY=<MB>` — Manual RAM override when cgroup detection unavailable

**Baseline:** 2GB RAM = 256MB shared_buffers (12.5% ratio), scales linearly up to 8GB cap

**Default Behavior:** No memory limit detected → uses 1GB default → shared_buffers=128MB, effective_cache=384MB, maintenance_work_mem=32MB.

**Example with limit:** 4GB memory limit → shared_buffers=512MB, effective_cache=1536MB, maintenance_work_mem=128MB.

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

**CI/CD:** Manual trigger only (extensions change rarely). Multi-platform buildx with SBOM/provenance.

## Testing Strategy

**Critical Tests:**
1. Extension loading (CREATE + functional query)
2. Auto-config detection (grep logs for RAM/CPU/scaled values)
3. PgBouncer auth (via :6432, verify SHOW POOLS)
4. Memory limit verification (test 2GB/4GB/8GB → different auto-config outputs)

**Why Memory Tests Matter:** Auto-config requires cgroup v2 for limit detection. If unavailable, defaults to 1GB (may be too low). Use `POSTGRES_MEMORY` env var to override when needed.

## Gotchas & Edge Cases

1. **PgBouncer password sync**: pgbouncer.ini bootstrap password MUST match postgres user or auth fails with zero error logs. Check with: `docker logs pgbouncer-primary | grep -i error`

2. **Auto-config override**: If postgresql.conf has conflicting settings, `-c` flags from entrypoint override them. Disable auto-config with `POSTGRES_SKIP_AUTOCONFIG=true` if needed.

3. **Extension SHA mismatch**: If git clone fails during build, SHA may be stale (force-push to tag). Verify at GitHub: `https://github.com/pgvector/pgvector/commit/<SHA>`

4. **Memory limit not detected**: Auto-config runs at container START (not at build). cgroup v2 required for limit detection. If no limit detected → defaults to 1GB RAM (conservative baseline). Override with `POSTGRES_MEMORY=<MB>` env var for manual control.

5. **Health check failures**: PgBouncer test uses regular database connection, NOT admin "pgbouncer" database. Wrong: `psql pgbouncer://...@localhost:6432/pgbouncer`. Right: `psql postgres://...@localhost:6432/postgres`.

6. **Build vs Runtime confusion**: Extension versions (PG_VERSION, PGVECTOR_VERSION) = build-time ARGs (baked into image). RAM/CPU detection = runtime (adapts to VPS where deployed). One image works everywhere.

## Monitoring

**postgres_exporter** (`:9187/metrics`): Exposes `pg_stat_database_*`, custom queries from `@stacks/primary/configs/postgres_exporter_queries.yaml` (replication lag, memory settings, postmaster uptime).

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

1. Test locally: Build image → deploy primary stack → verify extensions
2. Check auto-config: Test with 2GB/4GB/8GB memory limits
3. Verify no secrets leaked: `grep -ri "password\|secret" . | grep -v .env.example`
4. Update CHANGELOG.md
5. PR with clear description of changes

## Design Constraints

**Target Range:** 2-16GB RAM optimal, scales 2-128GB. 1-64 CPU cores. Compose-only (no K8s).

**Deliberate Limits:**
- Max connections: 100-200 (prevents OOM on shared VPS, PgBouncer multiplexes)
- PgBouncer transaction mode: NO prepared statements/advisory locks/LISTEN/NOTIFY (use session mode if needed)
- Auto-config: Defaults to 1GB when no memory limit detected (conservative baseline, override with POSTGRES_MEMORY)
- PostgreSQL 18 only: No multi-version support (simplifies maintenance)

**Why Transaction Mode:** Stateless pooling maximizes connection efficiency. Session-local features (prepared statements) break pooling. Use direct Postgres connection (:5432) if needed, PgBouncer (:6432) for app connections.

**Why SHA Pinning:** Version tags are mutable (attacker repush). Commit SHAs are immutable forever. Trade-off: Manual SHA updates vs supply chain security.

---

**Philosophy:** One image, minimal config tuning. Auto-adapts to hardware. SHA-pinned for reproducibility. Env-driven for universality.
