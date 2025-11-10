# Scripts Directory

Comprehensive collection of build, test, and operational scripts for aza-pg PostgreSQL stack. All scripts follow consistent patterns, use shared utilities from `lib/common.sh`, and include robust error handling.

## Directory Structure

```
scripts/
├── lib/              # Shared library functions
├── test/             # Test and validation scripts
├── tools/            # Operational tooling
├── build.ts          # Main build script (Bun TypeScript)
└── build.sh          # DEPRECATED: Use 'bun run build' instead
```

## Quick Reference

### Build & Development

```bash
# Build PostgreSQL image (canonical method)
bun run build                         # Single-platform build
bun run build -- --multi-arch --push  # Multi-platform (amd64 + arm64)
bun run build -- --push               # Build and push to registry

# Generate stack configurations
bun run generate                      # Recommended method
```

### Testing

```bash
# Comprehensive test suite
./scripts/test/test-build.sh                    # Build image + verify extensions
./scripts/test/test-auto-config.sh              # Validate auto-config detection
./scripts/test/run-extension-smoke.sh           # Extension dependency order test
./scripts/test/test-pgbouncer-healthcheck.sh    # PgBouncer connectivity test
./scripts/test/wait-for-postgres.sh             # Wait for PostgreSQL readiness
```

### Operations

```bash
# Backup and restore
./scripts/tools/backup-postgres.sh mydb         # Backup database to .sql.gz
./scripts/tools/restore-postgres.sh backup.sql.gz mydb  # Restore from backup

# Replica management
./scripts/tools/promote-replica.sh              # Promote replica to primary

# SSL/TLS
./scripts/tools/generate-ssl-certs.sh           # Generate self-signed certificates
```

## Detailed Documentation

### lib/ - Shared Library Functions

**`common.sh`** - Core utilities for all scripts

**Functions:**

- `log_info()`, `log_success()`, `log_warning()`, `log_error()` - Colored logging
- `docker_cleanup(container)` - Safe container removal
- `check_command(cmd)` - Verify command availability
- `check_docker_daemon()` - Verify Docker is running
- `wait_for_postgres(host, port, user, timeout, [container])` - Wait for PostgreSQL readiness

**Usage:**

```bash
# shellcheck source=scripts/lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

check_command docker || exit 1
check_docker_daemon || exit 1
wait_for_postgres localhost 5432 postgres 60
```

---

### test/ - Test Scripts

#### `test-build.sh [image-tag]`

Builds Docker image and verifies extensions are functional.

**What it tests:**

- Image build process (via buildx)
- PostgreSQL version
- Auto-config entrypoint presence
- Extension creation (vector, pg_trgm, pg_cron, pgaudit, etc.)
- Extension functionality (vector types, similarity, cron jobs)

**Usage:**

```bash
./scripts/test/test-build.sh                # Default tag: aza-pg:pg18
./scripts/test/test-build.sh my-custom:tag  # Custom tag
```

**Dependencies:** `docker`, `buildx`

**Output:** Comprehensive test report with extension verification

---

#### `test-auto-config.sh [image-tag]`

Validates auto-config RAM/CPU detection and PostgreSQL tuning.

**What it tests:**

1. Manual memory override (`POSTGRES_MEMORY`)
2. 2GB cgroup v2 detection
3. 512MB minimum memory limit
4. 64GB high-memory override
5. CPU core detection and worker tuning
6. Below-minimum memory rejection (256MB)
7. Custom `shared_preload_libraries` override

**Usage:**

```bash
./scripts/test/test-auto-config.sh                # Default tag: aza-pg:pg18
./scripts/test/test-auto-config.sh my-custom:tag  # Custom tag
```

**Dependencies:** `docker`

**Output:** 7 test cases validating auto-config behavior

---

#### `run-extension-smoke.sh [image-tag]`

Tests extension loading in dependency order using manifest.

**What it tests:**

- Topological sort of extension dependencies
- CREATE EXTENSION for all extensions (excluding tools)
- Dependency resolution accuracy

**Usage:**

```bash
./scripts/test/run-extension-smoke.sh                # Default tag: aza-pg:test
./scripts/test/run-extension-smoke.sh my-custom:tag  # Custom tag
```

**Dependencies:** `docker`, `python3`

**Output:** Dependency-ordered extension creation results

---

#### `test-pgbouncer-healthcheck.sh [stack-dir]`

Validates PgBouncer healthcheck and authentication.

**What it tests:**

- Stack deployment (compose up)
- PostgreSQL readiness
- PgBouncer auth via `pgbouncer_lookup()` function
- Health check connectivity
- Query execution through PgBouncer

**Usage:**

```bash
./scripts/test/test-pgbouncer-healthcheck.sh                  # Default: stacks/primary
./scripts/test/test-pgbouncer-healthcheck.sh stacks/primary   # Explicit path
```

**Dependencies:** `docker`, `docker compose`, `psql`

**Output:** PgBouncer authentication and connectivity validation

---

#### `wait-for-postgres.sh [host] [port] [user] [timeout]`

Waits for PostgreSQL to accept connections.

**Usage:**

```bash
./scripts/test/wait-for-postgres.sh                             # localhost:5432, 60s
./scripts/test/wait-for-postgres.sh db.example.com 5432 admin   # Remote host
PGHOST=localhost PGPORT=6432 ./scripts/test/wait-for-postgres.sh  # Via PgBouncer
./scripts/test/wait-for-postgres.sh localhost 5432 postgres 120   # 2min timeout
```

**Dependencies:** `pg_isready`

**Output:** Success when PostgreSQL is ready, error after timeout

---

### tools/ - Operational Scripts

#### `backup-postgres.sh [database] [output-file]`

Creates compressed PostgreSQL backup using `pg_dump`.

**Features:**

- Auto-named backup files with timestamp
- Gzip compression
- Backup validation (file size, gzip integrity)
- Remote host support via `PGHOST`/`PGPORT`/`PGUSER`
- Safe: prevents overwriting existing backups

**Usage:**

```bash
./scripts/tools/backup-postgres.sh                      # Backup 'postgres' db
./scripts/tools/backup-postgres.sh mydb                 # Backup 'mydb'
./scripts/tools/backup-postgres.sh mydb backup.sql.gz   # Custom output file
PGHOST=db.example.com PGUSER=admin ./scripts/tools/backup-postgres.sh mydb
```

**Environment variables:**

- `PGHOST` - PostgreSQL host (default: localhost)
- `PGPORT` - PostgreSQL port (default: 5432)
- `PGUSER` - PostgreSQL user (default: postgres)
- `PGPASSWORD` - PostgreSQL password (required for remote)

**Dependencies:** `pg_dump`, `pg_isready`, `gzip`, `du`

**Output:** Compressed `.sql.gz` backup file

---

#### `restore-postgres.sh <backup-file> [database]`

Restores PostgreSQL database from backup.

**Features:**

- Compressed (.gz) and plain SQL file support
- Backup file validation (existence, readability, gzip integrity)
- Interactive confirmation (destructive operation)
- Database statistics after restore

**Usage:**

```bash
./scripts/tools/restore-postgres.sh backup.sql.gz           # Restore to 'postgres'
./scripts/tools/restore-postgres.sh backup.sql.gz mydb      # Restore to 'mydb'
PGHOST=db.example.com ./scripts/tools/restore-postgres.sh backup.sql.gz
```

**Environment variables:** Same as `backup-postgres.sh`

**Dependencies:** `psql`, `pg_isready`, `gunzip`

**Output:** Restored database with statistics

---

#### `promote-replica.sh [OPTIONS]`

Promotes PostgreSQL replica to primary role.

**Features:**

- Verifies replica is in recovery mode
- Optional pre-promotion backup
- Safe promotion using `pg_ctl promote`
- Configuration updates (removes `standby.signal`)
- Post-promotion verification

**Options:**

- `-c, --container NAME` - Container name (default: postgres-replica)
- `-d, --data-dir PATH` - Data directory (default: /var/lib/postgresql/data)
- `-n, --no-backup` - Skip backup before promotion
- `-y, --yes` - Skip confirmation prompt
- `-h, --help` - Show help message

**Usage:**

```bash
./scripts/tools/promote-replica.sh                     # Interactive promotion
./scripts/tools/promote-replica.sh -c my-replica -y    # Skip confirmation
./scripts/tools/promote-replica.sh -n -y               # Fast (no backup)
```

**Dependencies:** `docker`

**Output:** Promoted primary with verification steps

**Warnings:**

- One-way operation (cannot revert)
- Ensure old primary is stopped (avoid split-brain)
- Update client connection strings after promotion

---

#### `generate-ssl-certs.sh`

Generates self-signed SSL certificates for PostgreSQL TLS.

**Output:**

- `server.key` - Private key
- `server.crt` - Self-signed certificate

**Usage:**

```bash
./scripts/tools/generate-ssl-certs.sh
```

**Dependencies:** `openssl`

---

### Root Scripts

#### `build.ts`

**Canonical build script** for PostgreSQL image using Docker Buildx (Bun TypeScript).

**Features:**

- Intelligent caching (pulls from ghcr.io registry)
- Fast cached builds (~2min vs ~12min cold build)
- Multi-platform support (amd64 + arm64)
- Automatic fallback to local cache without network
- Type-safe Bun TypeScript implementation

**Usage:**

```bash
bun run build                      # Single-platform (current arch)
bun run build -- --multi-arch --push  # Multi-platform (amd64 + arm64)
bun run build -- --push            # Build and push to registry

# Or directly:
bun scripts/build.ts               # Single-platform
bun scripts/build.ts --help        # Show help
```

**Requirements:**

- Bun runtime (>=1.3.2)
- Docker Buildx (bundled with Docker Desktop / Docker 19.03+)
- Network access to ghcr.io for cache pull
- ghcr.io write access for `--push` (requires `docker login ghcr.io`)

**Performance:**

- First build: ~12min (compiles all extensions)
- Cached build: ~2min (reuses CI artifacts)
- No network: ~12min (falls back to local cache)

**Configuration:**

- `POSTGRES_IMAGE` - Image name (default: ghcr.io/fluxo-kt/aza-pg)
- `POSTGRES_TAG` - Image tag (default: pg18)

---

#### `build.sh` (DEPRECATED)

**DEPRECATED:** Use `bun run build` instead.

This script has been superseded by `scripts/build.ts` following the Bun-First philosophy. The bash version is kept temporarily for backwards compatibility but will be removed in a future release.

**Migration:**

```bash
# Old (deprecated):
./scripts/build.sh
./scripts/build.sh --multi-arch --push

# New (recommended):
bun run build
bun run build -- --multi-arch --push
```

---

#### `generate-configs.sh` (REMOVED)

**REMOVED:** This script has been deleted. Use `bun run generate` instead.

This was a 4-line bash wrapper that simply called `bun run generate`. Following the Bun-First philosophy, the wrapper has been removed.

**Migration:**

```bash
# Old (removed):
./scripts/generate-configs.sh

# New (use instead):
bun run generate
```

---

## Common Patterns

### Error Handling

All scripts follow consistent error handling:

```bash
set -euo pipefail  # Fail on errors, undefined vars, pipe failures

# Prerequisites check
check_command docker || exit 1
check_docker_daemon || exit 1

# Cleanup trap
cleanup() {
  docker_cleanup "$CONTAINER_NAME"
}
trap cleanup EXIT
```

### Shellcheck Integration

All scripts include shellcheck directives:

```bash
# shellcheck source=scripts/lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"
```

Run shellcheck validation:

```bash
shellcheck scripts/**/*.sh
```

### Logging

Consistent colored logging via `common.sh`:

```bash
log_info "Starting operation..."
log_success "Operation completed"
log_warning "Non-critical issue detected"
log_error "Critical failure"
```

## Testing Workflow

**Recommended test sequence:**

1. **Build verification:**

   ```bash
   ./scripts/test/test-build.sh
   ```

2. **Auto-config validation:**

   ```bash
   ./scripts/test/test-auto-config.sh
   ```

3. **Extension smoke test:**

   ```bash
   ./scripts/test/run-extension-smoke.sh
   ```

4. **PgBouncer integration:**
   ```bash
   ./scripts/test/test-pgbouncer-healthcheck.sh
   ```

## Operational Workflow

**Backup and restore cycle:**

```bash
# Backup production database
PGHOST=prod.db.example.com PGPASSWORD=xxx ./scripts/tools/backup-postgres.sh mydb

# Restore to staging
PGHOST=staging.db.example.com PGPASSWORD=yyy ./scripts/tools/restore-postgres.sh backup_mydb_20250131_120000.sql.gz mydb
```

**Replica promotion (failover):**

```bash
# 1. Stop old primary (critical!)
docker stop postgres-primary

# 2. Promote replica
./scripts/tools/promote-replica.sh -c postgres-replica

# 3. Verify promotion
docker exec postgres-replica psql -U postgres -c "SELECT pg_is_in_recovery();"  # Should return 'f'

# 4. Update application connection strings to new primary
```

## Dependencies

**Required for all scripts:**

- `bash` 4.0+ (macOS: install via Homebrew)
- `docker` (Docker Engine or Docker Desktop)

**Test scripts:**

- `docker buildx` (bundled with Docker Desktop)
- `python3` (for extension smoke test)
- `psql` / `pg_isready` (for PgBouncer test)

**Tool scripts:**

- `pg_dump`, `pg_isready`, `psql` (PostgreSQL client tools)
- `gzip`, `gunzip`, `du` (standard Unix utilities)
- `openssl` (for SSL cert generation)

**Build/config:**

- `bun` (for config generator)

## Troubleshooting

### "Docker daemon is not running"

```bash
# macOS
open -a Docker

# Linux
sudo systemctl start docker
```

### "Required command not found"

```bash
# Install PostgreSQL client tools
# macOS
brew install postgresql

# Ubuntu/Debian
sudo apt-get install postgresql-client

# Fedora/RHEL
sudo dnf install postgresql
```

### "PostgreSQL not ready after timeout"

```bash
# Check container logs
docker logs <postgres-container>

# Verify container is running
docker ps | grep postgres

# Check network connectivity
nc -zv localhost 5432
```

### "Backup file is corrupted"

```bash
# Test gzip integrity
gzip -t backup_file.sql.gz

# Decompress and inspect
gunzip -c backup_file.sql.gz | head -100
```

## Contributing

When adding new scripts:

1. **Use common library:** Source `lib/common.sh` for shared functions
2. **Add shellcheck directive:** `# shellcheck source=scripts/lib/common.sh`
3. **Consistent error handling:** Use `set -euo pipefail`
4. **Logging:** Use `log_*()` functions from common.sh
5. **Cleanup traps:** Use `trap cleanup EXIT` pattern
6. **Documentation:** Add usage header and update this README
7. **Testing:** Verify script works on clean environment

**Example script template:**

```bash
#!/bin/bash
# Script description
# Usage: ./script.sh [args]
#
# Examples:
#   ./script.sh example1
#   ./script.sh example2

set -euo pipefail

# Source common library
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

# Check prerequisites
check_command docker || exit 1

# Cleanup trap
cleanup() {
  docker_cleanup "$CONTAINER_NAME"
}
trap cleanup EXIT

# Main logic
log_info "Starting operation..."
# ... implementation ...
log_success "Operation complete"
```

## License

Same as parent project (aza-pg).
