# aza-pg — Agent Operations Guide

Production PostgreSQL 18 stack with auto-adaptive config, compiled extensions (pgvector/pg_cron/pgAudit), PgBouncer pooling, and multi-platform builds. Designed for 2GB-128GB deployments with zero manual tuning.

## Architecture

**Image:** Multi-stage build compiles extensions from SHA-pinned sources → copies `.so` files to slim final image. ENTRYPOINT script runs at `docker run` (container start on VPS) → detects deployment environment RAM/CPU → injects `-c` flags to postgres command. One image adapts to any hardware.

**Stacks:** Compose-based deployments. `primary/` = Postgres + PgBouncer + postgres_exporter (3 services). All values env-driven, no hardcoded IPs/passwords.

**Extensions:** pgvector 0.8.1, pg_cron 1.6.7, pgAudit 18.0 + contrib (pg_trgm/pg_stat_statements/auto_explain). SHA-pinned in Dockerfile ARGs to prevent supply chain attacks.

## Critical Patterns

### Auto-Config Logic (`docker-auto-config-entrypoint.sh`)
**When:** RUNTIME (container start on VPS), NOT build-time. Same image adapts to any deployment environment.

**How:**
- Detects RAM: cgroup v2 limit of RUNNING container → fallback to host RAM where DEPLOYED
- **Shared VPS Protection**: No memory limit → uses 50% of deployment host RAM (assumes shared node)
- Detects CPU: `nproc` on RUNNING container → scales workers/parallelism
- Injects: `-c shared_buffers=XMB -c max_connections=Y` flags to postgres command at START

**Caps:** shared_buffers max 8GB, maintenance_work_mem max 2GB, work_mem max 32MB, max_connections 20-200

**Override:** `POSTGRES_SKIP_AUTOCONFIG=true` uses static postgresql.conf

**Why:** One image works on 2GB VPS or 128GB server. Detection at runtime (not build) ensures adaptation to actual deployment environment.

### PgBouncer Auth Pattern
- **NO plaintext userlist.txt**: Uses `auth_query = SELECT * FROM pgbouncer_lookup($1)`
- Function: SECURITY DEFINER reads `pg_shadow` (password hashes)
- Bootstrap: `pgbouncer_auth` user created in `01-pgbouncer-auth.sh` via envsubst
- Dev password: `dev_pgbouncer_auth_test_2025` (safe, only for local testing)
- Prod: `${PGBOUNCER_AUTH_PASS}` injected via env

**Gotcha:** pgbouncer.ini line 6 hardcodes bootstrap connection password. MUST match postgres user password or auth fails silently. Health check uses regular DB, NOT admin "pgbouncer" database (restricted).

### Extension Pinning Strategy
**Pattern:** `@docker/postgres/Dockerfile` uses dual ARGs: `*_VERSION` (semver) + `*_COMMIT_SHA` (immutable). Git clone checks out SHA, not tag.

**Why:** Version tags are mutable (attacker can repush malicious code under same tag). Commit SHAs are immutable. Ensures reproducible builds forever.

**Upgrade:** Find new release commit SHA → update both ARGs in Dockerfile → rebuild → test → push GHCR.

### Init Script Execution Order
**CRITICAL:** Scripts in `docker/postgres/docker-entrypoint-initdb.d/` execute alphabetically. Dependencies MUST use numeric prefixes.

**Execution Order (required):**
1. `01-extensions.sql` — Creates ALL extensions (vector, pg_trgm, pg_cron, pgaudit, pg_stat_statements). MUST run first.
2. `01-pgbouncer-auth.sh` (primary stack only) — Creates `pgbouncer_auth` user + `pgbouncer_lookup()` function. Depends on extensions being loaded.
3. `02-replication.sh` — Creates `replicator` user + replication slot. After auth setup.

**Why Order Matters:**
- PgBouncer auth function uses `SECURITY DEFINER` (requires extension loading complete)
- Replication user creation should happen after core auth infrastructure exists
- Wrong order → cryptic "function does not exist" or "role does not exist" errors

**Adding New Scripts:** Use `03-`, `04-`, etc. Never `00-` (breaks extension dependency).

### Compose Override Pattern
**Pattern:** `compose.yml` (prod: private IPs, limits) + `compose.dev.yml` (dev: localhost, test memory). Use `!override` tag to replace arrays (ports) vs merge.

**Usage:** `docker compose -f compose.yml -f compose.dev.yml up` merges configs (dev wins on conflicts).

## Key Workflows

**Extension Testing:** CREATE EXTENSION + functional query → grep logs for RAM/CPU detection → test PgBouncer via :6432 → verify SHOW POOLS.

**CI/CD:** Manual trigger only (extensions change rarely). Multi-platform buildx with SBOM/provenance.

## Testing Strategy

**Critical Tests:**
1. Extension loading (CREATE + functional query)
2. Auto-config detection (grep logs for RAM/CPU/scaled values)
3. PgBouncer auth (via :6432, verify SHOW POOLS)
4. Memory limit verification (test 2GB/4GB/8GB → different auto-config outputs)

**Why Memory Tests Matter:** Auto-config may silently fail if cgroup v2 unavailable, falling back to host RAM (wrong values).

## Gotchas & Edge Cases

1. **PgBouncer password sync**: pgbouncer.ini bootstrap password MUST match postgres user or auth fails with zero error logs. Check with: `docker logs pgbouncer-primary | grep -i error`

2. **Auto-config override**: If postgresql.conf has conflicting settings, `-c` flags from entrypoint override them. Disable auto-config with `POSTGRES_SKIP_AUTOCONFIG=true` if needed.

3. **Extension SHA mismatch**: If git clone fails during build, SHA may be stale (force-push to tag). Verify at GitHub: `https://github.com/pgvector/pgvector/commit/<SHA>`

4. **Memory limit not detected on VPS**: Auto-config runs at container START on VPS (not at build). cgroup v2 required for accurate limit detection. Old Docker versions use v1 (not supported) → falls back to host RAM via `/proc/meminfo` → uses 50% (shared VPS protection).

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
- Max connections: 200 (prevents OOM on shared VPS, PgBouncer multiplexes)
- PgBouncer transaction mode: NO prepared statements/advisory locks/LISTEN/NOTIFY (use session mode if needed)
- Auto-config: Uses 50% of RAM when no memory limit set (assumes shared VPS with apps)
- PostgreSQL 18 only: No multi-version support (simplifies maintenance)

**Why Transaction Mode:** Stateless pooling maximizes connection efficiency. Session-local features (prepared statements) break pooling. Use direct Postgres connection (:5432) if needed, PgBouncer (:6432) for app connections.

**Why SHA Pinning:** Version tags are mutable (attacker repush). Commit SHAs are immutable forever. Trade-off: Manual SHA updates vs supply chain security.

---

**Philosophy:** One image, zero config tuning. Auto-adapts to hardware. SHA-pinned for reproducibility. Env-driven for universality.
