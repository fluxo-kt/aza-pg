# aza-pg

Production-ready PostgreSQL 18 with auto-adaptive configuration, compiled extensions, and complete deployment stacks.

## Design Goals

**Purpose:** Universal Postgres stack eliminating manual tuning across 2GB VPS → 128GB burst nodes.

**Targets:** Solo devs, small teams, multi-project fleets. Optimized for Docker Compose (not K8s). RAM: 2-16GB sweet spot, scales to 128GB. CPUs: 1-64 cores.

**Criteria:**
- Zero config drift: One image + env vars adapts to any hardware
- Supply chain hardened: SHA-pinned extensions (immutable), SBOM/provenance
- Production-grade: PgBouncer pooling, replication, monitoring, SCRAM-SHA-256

**Non-Goals:**
- Kubernetes manifests (use Compose stacks)
- Multi-version support (PostgreSQL 18 only)
- Custom extension compilation at runtime (pre-compiled in image)

**Limitations:**
- Auto-config requires cgroup v2 (falls back to host RAM detection)
- Connection limit capped at 200 (prevent OOM on shared VPS)
- PgBouncer transaction mode (no prepared statements, advisory locks, LISTEN/NOTIFY)

## Features

- **Auto-Configuration**: Detects RAM and CPU cores, automatically scales settings
- **Production Extensions**: pgvector 0.8.1, pg_cron 1.6.7, pgAudit 18.0, pg_stat_statements, auto_explain, pg_trgm
- **Complete Stacks**: Single instance, Primary with PgBouncer + Exporter, Replica
- **Supply Chain Security**: SHA-pinned extension sources, multi-platform builds (amd64/arm64)
- **Connection Pooling**: PgBouncer with auth_query (SCRAM-SHA-256)
- **Monitoring**: postgres_exporter with custom queries

## Quick Start

**⚠️ IMPORTANT:** Before deploying, replace `ghcr.io/your-org` in compose files with your actual GitHub organization name, or use a local image tag.

### Build Image Locally

```bash
cd docker/postgres
docker build -t aza-pg:pg18 .

# Verify build
docker run --rm aza-pg:pg18 psql --version
docker run --rm aza-pg:pg18 postgres --version
```

### Deploy Primary Stack

```bash
cd stacks/primary
cp .env.example .env
# Edit .env with your passwords
docker compose up -d
```

Access:
- **Postgres**: `127.0.0.1:5432`
- **PgBouncer**: `127.0.0.1:6432`
- **Metrics**: `127.0.0.1:9187/metrics`

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
docker compose -f compose.yml -f compose.dev.yml up
```

### Single
Minimal setup for development or small deployments (just Postgres).

```bash
cd stacks/single
docker compose up
```

### Replica
Streaming replication setup (connects to primary).

```bash
cd stacks/replica
docker compose up
```

## Configuration

### Auto-Config (Default)

**Adapts at runtime** (container start on VPS, not build time). Same image auto-tunes to deployment environment.

Detects at container start:
- **RAM**: cgroup v2 limit of running container (preferred) or host RAM where deployed
- **Shared VPS Protection**: No memory limit → uses 50% of deployment host RAM (assumes coexistence with apps)
- **CPU**: Core count on running container → scales max_worker_processes, max_parallel_workers, max_connections

Baseline (2GB RAM with memory limit):
- shared_buffers: 256MB
- effective_cache: 768MB
- maintenance_work_mem: 64MB
- work_mem: 4MB

Scales proportionally for larger allocations with caps:
- shared_buffers: max 8GB
- maintenance_work_mem: max 2GB
- work_mem: max 32MB

**Example:** 2GB VPS without memory limit → detects 2GB → uses 1GB for calculations (leaves 1GB for apps)

### Disable Auto-Config

Set `POSTGRES_SKIP_AUTOCONFIG=true` to use static postgresql.conf values.

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

## Monitoring

postgres_exporter included with custom queries:
- Replication lag
- Memory settings
- Postmaster uptime

Integrate with Prometheus:
```yaml
scrape_configs:
  - job_name: 'postgres'
    static_configs:
      - targets: ['localhost:9187']
```

## Build from Source

GitHub Actions workflow builds multi-platform images (linux/amd64, linux/arm64) with SBOM and provenance.

Trigger manually via GitHub Actions UI or:
```bash
gh workflow run build-postgres-image.yml
```

Images pushed to: `ghcr.io/your-org/aza-pg:pg18`

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes
4. Test locally (build image + deploy stack)
5. Submit pull request

---

**Production-ready PostgreSQL with intelligent defaults and zero-config auto-adaptation.**
