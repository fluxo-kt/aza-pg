# aza-pg

Production-ready PostgreSQL 18 with auto-adaptive configuration, compiled extensions, and complete deployment stacks.

## Design Goals
 
**Purpose:** Universal Postgres stack minimizing manual tuning across 2GB VPS → 128GB burst nodes.

**Targets:** Solo devs, small teams, multi-project fleets. Optimized for Docker Compose (not K8s). RAM: 2-16GB sweet spot, scales to 128GB. CPUs: 1-64 cores.

**Criteria:**
- Minimal config drift: One image + env vars adapts to any hardware
- Supply chain hardened: SHA-pinned extensions (immutable), SBOM/provenance
- Production-grade: PgBouncer pooling, replication, monitoring, SCRAM-SHA-256

## Requirements
- Docker Engine 24+ with Docker Compose v2
- GNU/Linux or macOS host (Windows via WSL2)
- `bun` for regenerating configs (`curl -fsSL https://bun.sh/install | bash`)

**Non-Goals:**
- Kubernetes manifests (use Compose stacks)
- Multi-version support (PostgreSQL 18 only)
- Custom extension compilation at runtime (pre-compiled in image)

**Limitations:**
- Auto-config reads cgroup v2 limits or `/proc/meminfo`; set `POSTGRES_MEMORY` when neither is available.
- Connection limit tiers at 80/120/200 to protect low-memory nodes (PgBouncer recommended for concurrency).
- PgBouncer runs in transaction mode (no prepared statements, advisory locks, LISTEN/NOTIFY).

## Features

- **Auto-Configuration**: Detects RAM and CPU cores at runtime, automatically scales settings (cgroup v2 preferred, `/proc/meminfo` fallback, or manual `POSTGRES_MEMORY` override)
- **Production Extensions**: 38 PostgreSQL extensions (pgflow workflow orchestration available as optional add-on)
- **Complete Stacks**: Single instance, Primary with PgBouncer + Exporter, Replica
- **Supply Chain Security**: SHA-pinned extension sources, multi-platform builds (amd64/arm64)
- **Connection Pooling**: PgBouncer with auth_query (SCRAM-SHA-256)
- **Monitoring**: postgres_exporter with custom queries

## Image Specifications

### Size
- Base `postgres:18-trixie`: ~93-154MB
- With compiled extensions (pgvector, pg_cron, pgaudit): ~450MB
- Multi-platform manifest (amd64 + arm64): ~900MB total

### Optimizations
- Multi-stage build (builder artifacts not included in final image)
- Minimal runtime dependencies (ca-certificates, zstd, lz4 only)
- Parallel extension compilation (~40% faster builds)

### Extensions Included
- **pgvector 0.8.1**: Vector similarity search
- **pg_cron 1.6.7**: Job scheduling
- **pgAudit 18.0**: Audit logging
- **PostgreSQL contrib**: pg_trgm, pg_stat_statements, auto_explain, uuid-ossp

## Quick Start

**⚠️ SECURITY WARNINGS:**
1. **TLS Not Enabled by Default**: Connections use plaintext. For production with network exposure, enable TLS (see `docker/postgres/configs/postgresql-*.conf` for TLS settings). Requires valid certificates.
2. **Local Binding Default**: Services bind to `127.0.0.1` by default (localhost only). To allow network access, change `POSTGRES_BIND_IP=0.0.0.0` in `.env` AND ensure firewall/network security is configured.
3. **Image Placeholder**: Replace `ghcr.io/fluxo-kt` in compose files with your actual registry or use a local image tag.


### Prerequisites

Before deploying any stack:

1. **Create monitoring network**: `docker network create monitoring`
   - Required for Prometheus/Grafana integration (exporters connect to this network)
   - Shared across all stacks (primary, replica, single)
   - The `postgres_net` network is created automatically by each stack
   - See [docs/PRODUCTION.md#monitoring-network-setup](docs/PRODUCTION.md#monitoring-network-setup) for detailed explanation

### Build Image First

**IMPORTANT:** Build the image locally before deploying any stack:

```bash
# Recommended: Use build script with intelligent caching
./scripts/build.sh

# Verify build
docker run --rm aza-pg:pg18 psql --version
docker run --rm aza-pg:pg18 postgres --version
```

The build script uses Docker Buildx with remote cache from CI artifacts, dramatically speeding up builds (~2min cached vs ~12min from scratch).

### Deploy Primary Stack

```bash
cd stacks/primary
cp .env.example .env
# Edit .env with your passwords (REQUIRED: POSTGRES_PASSWORD, PGBOUNCER_AUTH_PASS, PG_REPLICATION_PASSWORD)
# Optional: Set POSTGRES_BIND_IP=0.0.0.0 for network access (localhost by default)
docker compose up -d
```

Access:
- **Postgres**: `127.0.0.1:5432`
- **PgBouncer**: `127.0.0.1:6432`
- **Postgres Exporter**: `127.0.0.1:9187/metrics`
- **PgBouncer Exporter**: `127.0.0.1:9127/metrics`

> The compose files set `mem_limit`/`mem_reservation` so Docker applies cgroup v2 limits. If you modify memory values or use a different orchestrator, make sure a limit (or `POSTGRES_MEMORY`) is present so auto-config can size itself correctly.

### Local Quick Start (Development)

For quick local testing with dev overrides:

```bash
cd stacks/primary
cp .env.example .env
# Edit .env with local passwords
docker compose -f compose.yml -f compose.dev.yml up -d
```

Or deploy a minimal single instance:

```bash
cd stacks/single
cp .env.example .env
# Edit .env with local password
docker compose up -d
```

### Test Extensions

```bash
psql postgresql://postgres:password@localhost:5432/postgres -c "CREATE EXTENSION vector;"
psql postgresql://postgres:password@localhost:5432/postgres -c "SELECT '[1,2,3]'::vector;"
```

## Stacks

### Primary
Full production stack with Postgres + PgBouncer + postgres_exporter.

```bash
cd stacks/primary
docker compose up -d
# For local overrides: docker compose -f compose.yml -f compose.dev.yml up -d
```

### Single
Minimal setup for development or small deployments (just Postgres).

```bash
cd stacks/single
docker compose up
```

Access:
- **Postgres**: `127.0.0.1:5432`
- **Postgres Exporter**: `127.0.0.1:9189/metrics` (note: different port than primary to avoid conflicts)

### Replica
Streaming replication setup (connects to primary).

```bash
cd stacks/replica
docker compose up
```

Access:
- **Postgres**: `127.0.0.1:5433` (note: different port than primary to avoid conflicts)
- **Postgres Exporter**: `127.0.0.1:9188/metrics` (note: different port than primary to avoid conflicts)

## Configuration

### Auto-Config (Default)

**Adapts at runtime** (container start on VPS, not build time). Same image auto-tunes to deployment environment.

Detects at container start:
- **RAM**: cgroup v2 memory limit (preferred). Set `POSTGRES_MEMORY=<MB>` to override, or fall back to `/proc/meminfo` when running without limits.
- **CPU**: Core count → scales `max_worker_processes`, `max_parallel_workers`, `max_connections`

The entrypoint targets ~25% of available RAM for `shared_buffers` (capped at 32GB) and derives other settings from that baseline (maintenance_work_mem capped at 2GB, work_mem at 32MB). Connection ceilings tier with memory: 80 (≤512MB), 120 (<4GB), 200 (≥4GB).

Reference points:
- 512MB limit → `shared_buffers=128MB`, `effective_cache_size=384MB`, `work_mem=1MB`, `max_connections=80`
- 1GB manual override (`POSTGRES_MEMORY=1024`) → `shared_buffers=256MB`, `effective_cache_size=768MB`, `work_mem=2MB`, `max_connections=120`
- 2GB limit → `shared_buffers=512MB`, `effective_cache_size=1536MB`, `work_mem=4MB`, `max_connections=120`
- 4GB limit → `shared_buffers=1024MB`, `effective_cache_size=3072MB`, `work_mem≈5MB`, `max_connections=200`
- 8GB limit → `shared_buffers=2048MB`, `effective_cache_size=6144MB`, `work_mem≈10MB`, `max_connections=200`
- 64GB manual override (`POSTGRES_MEMORY=65536`) → `shared_buffers≈9830MB`, `effective_cache_size≈49152MB`, `work_mem≈32MB`, `max_connections=200`

`shared_preload_libraries` is enforced at runtime with 4 preloaded by default (`pg_stat_statements`, `auto_explain`, `pg_cron`, `pgaudit`) to keep required extensions consistent even if static configs drift. Optional extensions (pgsodium, timescaledb, supautils, pg_stat_monitor) can be enabled via `POSTGRES_SHARED_PRELOAD_LIBRARIES` env var.

**Note:** pg_stat_monitor may conflict with pg_stat_statements; test before enabling both in the same session.

**Preloaded Extension Memory Overhead:** ~100-250MB depending on usage patterns and enabled extensions.

### PgBouncer Auth

The PgBouncer container renders `/tmp/.pgpass` at startup (see `stacks/primary/scripts/pgbouncer-entrypoint.sh`). Provide `PGBOUNCER_AUTH_PASS` in `.env`; passwords may include special characters because they are escaped before being written to `.pgpass`. The rendered config never stores credentials in plaintext.

## Extensions

| Extension | Version | Purpose |
|-----------|---------|---------|
| pgvector | 0.8.1 | Vector similarity search for AI/RAG |
| pg_cron | 1.6.7 | Database job scheduler |
| pgAudit | 18.0 | Audit logging for compliance |
| pg_trgm | Built-in | Trigram fuzzy text search |
| pg_stat_statements | Built-in | Query performance monitoring |
| auto_explain | Built-in | Auto-log slow query plans |

All extensions are SHA-pinned for reproducible builds.

**Note:** This image includes 38 extensions (6 built-in, 14 PGDG, 18 compiled from source). The 5 baseline extensions (pg_stat_statements, pg_trgm, pgaudit, pg_cron, vector) are created automatically by init scripts. 4 extensions are preloaded by default via `shared_preload_libraries`: pg_stat_statements, auto_explain, pg_cron, pgaudit. The remaining 33 extensions are available on-demand via CREATE EXTENSION. pgflow workflow orchestration is available as an optional add-on (see `examples/pgflow/`).

### Customizing Extensions

You can build custom images with only the extensions you need. The manifest-driven system lets you disable unused extensions to reduce image size and build time.

**Example:** To disable an extension (e.g., `pgq`):
1. Edit `scripts/extensions/manifest-data.ts`: Set `enabled: false` and add `disabledReason`
2. Regenerate: `bun scripts/extensions/generate-manifest.ts`
3. Build: `./scripts/build.sh`

**Restrictions:** Core preloaded extensions (auto_explain, pg_cron, pg_stat_statements, pgaudit) cannot be disabled.

See [docs/EXTENSIONS.md](docs/EXTENSIONS.md) for step-by-step instructions and [docs/development/EXTENSION-ENABLE-DISABLE.md](docs/development/EXTENSION-ENABLE-DISABLE.md) for complete design details.

## Monitoring

postgres_exporter included with custom queries:
- Replication lag
- Memory settings
- Postmaster uptime

### Exporter Ports by Stack

Default exporter ports (configurable via `.env`):

| Stack | Postgres Port | Postgres Exporter | PgBouncer Exporter | Notes |
|-------|--------------|-------------------|--------------------| ------|
| Primary | 5432 | 9187 | 9127 | Full production stack |
| Replica | 5433 | 9188 | N/A | Different ports to avoid conflicts |
| Single | 5432 | 9189 | N/A | Minimal stack |

Configure in `.env`:
```env
# Primary stack
POSTGRES_EXPORTER_PORT=9187
PGBOUNCER_EXPORTER_PORT=9127

# Replica stack
POSTGRES_EXPORTER_PORT=9188

# Single stack
POSTGRES_EXPORTER_PORT=9189
```

Integrate with Prometheus:
```yaml
scrape_configs:
  - job_name: 'postgres-primary'
    static_configs:
      - targets: ['localhost:9187']

  - job_name: 'postgres-replica'
    static_configs:
      - targets: ['localhost:9188']

  - job_name: 'pgbouncer'
    static_configs:
      - targets: ['localhost:9127']
```

## Build from Source

### Local Builds (Recommended)

Use the build script with Docker Buildx for fast, optimized builds:

```bash
# Default: Single-platform with intelligent caching
./scripts/build.sh

# Multi-platform build (amd64 + arm64, requires push)
./scripts/build.sh --multi-arch --push

# Build and push to registry
./scripts/build.sh --push
```

**Performance:**
- First build: ~12 minutes (compiles all extensions)
- Cached build: ~2 minutes (reuses CI artifacts)
- No network: ~12 minutes (falls back to local cache)

**How it works:**
- Uses Docker Buildx with BuildKit for parallel builds
- Pulls remote cache from GitHub Container Registry
- Falls back to local cache if network unavailable
- Automatically creates buildx builder if needed

**Requirements:**
- Docker Buildx v0.8+ (bundled with Docker 19.03+)
- Network access to `ghcr.io` for cache pull (optional but recommended)
- Registry write access for `--push` (run `docker login ghcr.io`)

### CI/CD Builds

GitHub Actions workflow builds multi-platform images (linux/amd64, linux/arm64) with SBOM and provenance.

Trigger manually via GitHub Actions UI or:
```bash
gh workflow run build-postgres-image.yml
```

Images pushed to: `ghcr.io/fluxo-kt/aza-pg:pg18`

## Troubleshooting

### Build Failures
- **COPY path errors**: Use repo root as build context: `docker build -f docker/postgres/Dockerfile .`
- **Extension compilation timeout**: Increase Docker build timeout or use cached image

### Connection Issues
- **Can't connect on 5432**: Check `POSTGRES_BIND_IP` in .env (default 127.0.0.1 = localhost only)
- **PgBouncer auth fails**: Verify `PGBOUNCER_AUTH_PASS` matches in .env and `/tmp/.pgpass` in container

### Extension Errors
- **CREATE EXTENSION fails**: Check `docker logs` for preload errors - extension may need `shared_preload_libraries`
- **pg_cron not working**: Verify `cron.database_name` is set (empty on replicas)

### Performance
- **High memory usage**: Auto-config detects RAM via cgroup limits - set `POSTGRES_MEMORY=<MB>` to override
- **Slow queries**: Check `pg_stat_statements` output, review `auto_explain` logs for plan issues

## Security

### Hardening Checklist
- ✅ All extensions SHA-pinned to prevent supply chain attacks
- ✅ Base image SHA256-pinned (`postgres:18-trixie@sha256:...`)
- ✅ APT packages authenticated (no `--allow-unauthenticated`)
- ✅ SCRAM-SHA-256 authentication (no MD5)
- ✅ PgBouncer uses `.pgpass` auth (no password env vars in healthchecks)
- ✅ SQL injection protection in replica setup script
- ⚠️ `.env` files require `chmod 600` (warned in .env.example files)
- ⚠️ Default bind: localhost only - set `POSTGRES_BIND_IP=0.0.0.0` with firewall/VPN


### Enabling TLS/SSL

By default, TLS is **not configured** (connections unencrypted). To enable:

1. Generate certificates (see `scripts/tools/generate-ssl-certs.sh` for self-signed certs)
2. Mount certificates in compose.yml:
   ```yaml
   volumes:
     - ./certs/server.crt:/etc/ssl/certs/ssl-cert-snakeoil.pem:ro
     - ./certs/server.key:/etc/ssl/private/ssl-cert-snakeoil.key:ro
   ```
3. Enable TLS in PostgreSQL config (uncomment TLS section in `postgresql-base.conf`)
4. Set `PGBOUNCER_SERVER_SSLMODE=require` to enforce TLS between PgBouncer and PostgreSQL

**Default:** `sslmode=prefer` (allows both encrypted and unencrypted connections)
**Production:** Set `sslmode=require` after configuring certificates

See `docs/PRODUCTION.md` for complete TLS setup guide.

### Threat Model
- **Supply chain attacks**: Mitigated via SHA pinning (extensions + base image)
- **Credential exposure**: Mitigated via SCRAM-SHA-256, .pgpass, no hardcoded passwords
- **Network exposure**: Default localhost binding, TLS config template available
- **Audit compliance**: pgAudit tracks DDL/DML/role changes to logs

## FAQ

**Q: Why 4 preloaded extensions vs 38 total?**
A: Only monitoring/audit extensions need preloading. Others (34 extensions) load on-demand via CREATE EXTENSION.

**Q: Can I use this in Kubernetes?**
A: Not designed for K8s - optimized for Compose/VPS deployments. Use cloud-native operators for K8s.

**Q: Why transaction mode for PgBouncer?**
A: Maximizes connection multiplexing. Use direct :5432 if you need prepared statements/advisory locks.

**Q: How do I change PostgreSQL settings?**
A: Auto-config runtime flags (-c) override config files. To set custom values, either use `POSTGRES_MEMORY=<MB>` to control auto-config calculations or modify the entrypoint script directly.

**Q: Does auto-config work in Docker Desktop?**
A: Yes - detects Docker Desktop memory limits. Use `POSTGRES_MEMORY=<MB>` to override.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes
4. Regenerate configs if you touch `scripts/config-generator` (`./scripts/generate-configs.sh`, requires `bun`)
5. Test locally (build image + deploy stack)
6. Submit pull request

---

**Production-ready PostgreSQL with intelligent defaults and minimal-config auto-adaptation.**
