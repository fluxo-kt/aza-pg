# aza-pg

PostgreSQL 18 with auto-configuration, 36 compiled extensions, and deployment stacks. Single Docker image adapts to 2-16GB RAM (scales to 128GB), 1-64 cores. Docker Compose only.

> **Open Source Notice:** This is MIT licensed open source software provided AS IS with NO WARRANTY, NO SUPPORT, and NO LIABILITY. Docker images are published for convenience but come with NO GUARANTEES of functionality, security, or maintenance. Use at your own risk.

**Features:** Auto-config (RAM/CPU detection), SHA-pinned (reproducibility), PgBouncer pooling, replication, SCRAM-SHA-256, monitoring

## Requirements

- Docker Engine 24+ with Docker Compose v2
- GNU/Linux or macOS host (Windows via WSL2)
- `bun` for regenerating configs (`curl -fsSL https://bun.sh/install | bash`)

**Limitations:**

- PostgreSQL 18 only (no multi-version support)
- Docker Compose only (no Kubernetes)
- Auto-config requires cgroup v2 or `POSTGRES_MEMORY` env var
- Connection limits: 80 (≤512MB), 120 (<4GB), 200 (≥4GB)
- PgBouncer transaction mode: No prepared statements, advisory locks, or LISTEN/NOTIFY

## Extensions

36 enabled (6 builtin + 25 external + 5 tools): pgvector 0.8.1, pg_cron 1.6.7, pgAudit 18.0, PostGIS, contrib (pg_trgm, pg_stat_statements, auto_explain). 4 preloaded by default.

Complete list: `docker run --rm <image> cat /etc/postgresql/version-info.txt`

## Image Details

~450MB compressed (amd64 + arm64). Multi-stage build with parallel compilation. Runtime: ca-certificates, zstd, lz4.

## Quick Start

**Security:** Default binding 127.0.0.1 (localhost). TLS disabled. Set `POSTGRES_BIND_IP=0.0.0.0` for network access. See [Production](#security) for hardening.

### Setup

```bash
docker network create monitoring
bun run build  # 2min with remote cache
docker run --rm aza-pg:pg18 psql --version
```

### Deploy

```bash
cd stacks/primary
cp .env.example .env
# Edit .env: Set POSTGRES_PASSWORD, PGBOUNCER_AUTH_PASS, PG_REPLICATION_PASSWORD
docker compose up -d
```

**Ports:** Postgres 5432, PgBouncer 6432, Exporters 9187/9127
**Variants:** `stacks/single` (no PgBouncer), add `-f compose.dev.yml` for dev

## Stacks

| Stack   | Use Case    | Postgres | PgBouncer | Exporter(s) |
| ------- | ----------- | -------- | --------- | ----------- |
| Primary | Production  | 5432     | 6432      | 9187, 9127  |
| Single  | Dev/testing | 5432     | -         | 9189        |
| Replica | Replication | 5433     | -         | 9188        |

Configs in `stacks/{primary,replica,single}`.

## Configuration

### Auto-Config

Detects RAM (cgroup v2 → `POSTGRES_MEMORY` → /proc/meminfo) and CPU at startup:

| RAM  | shared_buffers | effective_cache_size | work_mem | max_connections |
| ---- | -------------- | -------------------- | -------- | --------------- |
| 512M | 128M (25%)     | 384M (75%)           | 1M       | 80              |
| 2G   | 512M (25%)     | 1536M (75%)          | 4M       | 120             |
| 4G   | 1G (25%)       | 3G (75%)             | 5M       | 200             |
| 64G  | 9830M (25%)    | 49152M (75%)         | 32M      | 200             |

Caps: `shared_buffers` ≤32GB, `work_mem` ≤32MB. Preloaded: auto_explain, pg_cron, pg_stat_statements, pgaudit (add via `POSTGRES_SHARED_PRELOAD_LIBRARIES`, ~100-250MB overhead).

**PgBouncer:** Set `PGBOUNCER_AUTH_PASS` in .env. Escape `:` and `\` only.

### Extension Customization

Edit `scripts/extensions/manifest-data.ts` → `bun run generate` → `bun run build`. Cannot disable preloaded (auto_explain, pg_cron, pg_stat_statements, pgaudit). See [docs/EXTENSIONS.md](docs/EXTENSIONS.md).

## Monitoring

postgres_exporter (replication lag, memory, uptime). Prometheus config:

```yaml
scrape_configs:
  - job_name: "postgres"
    static_configs:
      - targets: ["localhost:9187", "localhost:9188"]
  - job_name: "pgbouncer"
    static_configs:
      - targets: ["localhost:9127"]
```

## Build & Test

```bash
bun run build                # 2min with remote cache
bun run test:all             # Full suite
bun run test:all:fast        # Validation only
```

See [docs/BUILD.md](docs/BUILD.md) and [docs/TESTING.md](docs/TESTING.md).

## Troubleshooting

| Issue                | Solution                                           |
| -------------------- | -------------------------------------------------- |
| COPY path errors     | Build from repo root: `docker build -f docker/...` |
| Connection fails     | Check `POSTGRES_BIND_IP` (default: 127.0.0.1)      |
| PgBouncer auth fails | Verify `PGBOUNCER_AUTH_PASS` in .env               |
| Extension fails      | Check logs for preload errors                      |
| High memory usage    | Set `POSTGRES_MEMORY=<MB>`                         |
| Slow queries         | Review `pg_stat_statements`, `auto_explain` logs   |
| Slow compilation     | Use `bun run build` (remote cache)                 |

## Security

**Defaults:** SHA-pinned base + extensions, SCRAM-SHA-256 auth, 127.0.0.1 binding, TLS disabled.

**Production:** 1) Enable TLS (certs + `sslmode=require`), 2) Set `POSTGRES_BIND_IP=0.0.0.0` with firewall, 3) `chmod 600 .env`, 4) Review pgAudit logs.

See [docs/PRODUCTION.md](docs/PRODUCTION.md).

## FAQ

**Kubernetes support?** No. Use cloud-native operators.

**Why PgBouncer transaction mode?** Maximizes connection multiplexing. Use :5432 for prepared statements/advisory locks.

**Override auto-config?** Set `POSTGRES_MEMORY=<MB>` or modify entrypoint.

**Docker Desktop?** Yes, auto-detects limits.

## License

MIT License - see [LICENSE](LICENSE) file.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND. NO SUPPORT, NO GUARANTEES, NO LIABILITY. Use entirely at your own risk.

## Contributing

Fork → change → `bun run generate` (if manifest changed) → `bun run test:all` → PR
