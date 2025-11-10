# Scripts Directory

Comprehensive collection of build, test, and operational scripts for aza-pg PostgreSQL stack. All scripts follow Bun-first TypeScript patterns, use shared utilities from `lib/common.ts`, and include robust error handling.

## Directory Structure

```
scripts/
├── lib/              # Shared library functions
├── test/             # Test and validation scripts
├── tools/            # Operational tooling
├── build.ts          # Main build script (Bun TypeScript)
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
bun scripts/test/test-build.ts                    # Build image + verify extensions
bun scripts/test/test-auto-config.ts              # Validate auto-config detection
bun scripts/test/run-extension-smoke.ts           # Extension dependency order test
bun scripts/test/test-pgbouncer-healthcheck.ts    # PgBouncer connectivity test
bun scripts/test/wait-for-postgres.ts             # Wait for PostgreSQL readiness
```

### Operations

```bash
# Backup and restore
bun scripts/tools/backup-postgres.ts mydb         # Backup database to .sql.gz
bun scripts/tools/restore-postgres.ts backup.sql.gz mydb  # Restore from backup

# Replica management
bun scripts/tools/promote-replica.ts              # Promote replica to primary

# SSL/TLS
bun scripts/tools/generate-ssl-certs.ts           # Generate self-signed certificates
```

## Detailed Documentation

### lib/ - Shared Library Functions

**`common.ts`** - Core utilities for all scripts

**Functions:**

- `logInfo()`, `logSuccess()`, `logWarning()`, `logError()` - Colored logging
- `dockerCleanup(container)` - Safe container removal
- `checkCommand(cmd)` - Verify command availability
- `checkDockerDaemon()` - Verify Docker is running
- `waitForPostgres(host, port, user, timeout, container?)` - Wait for PostgreSQL readiness

**Usage:**

```typescript
import {
  checkCommand,
  checkDockerDaemon,
  waitForPostgres,
} from "../lib/common.ts";

await checkCommand("docker");
await checkDockerDaemon();
await waitForPostgres("localhost", 5432, "postgres", 60);
```

---

### test/ - Test Scripts

#### `test-build.ts [image-tag]`

Builds Docker image and verifies extensions are functional.

**What it tests:**

- Image build process (via buildx)
- PostgreSQL version
- Auto-config entrypoint presence
- Extension creation (vector, pg_trgm, pg_cron, pgaudit, etc.)
- Extension functionality (vector types, similarity, cron jobs)

**Usage:**

```bash
bun scripts/test/test-build.ts                # Default tag: aza-pg:pg18
bun scripts/test/test-build.ts my-custom:tag  # Custom tag
```

**Dependencies:** `docker`, `buildx`

**Output:** Comprehensive test report with extension verification

---

#### `test-auto-config.ts [image-tag]`

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
bun scripts/test/test-auto-config.ts                # Default tag: aza-pg:pg18
bun scripts/test/test-auto-config.ts my-custom:tag  # Custom tag
```

**Dependencies:** `docker`

**Output:** 7 test cases validating auto-config behavior

---

#### `run-extension-smoke.ts [image-tag]`

Tests extension loading in dependency order using manifest.

**What it tests:**

- Topological sort of extension dependencies
- CREATE EXTENSION for all extensions (excluding tools)
- Dependency resolution accuracy

**Usage:**

```bash
bun scripts/test/run-extension-smoke.ts                # Default tag: aza-pg:test
bun scripts/test/run-extension-smoke.ts my-custom:tag  # Custom tag
```

**Dependencies:** `docker`

**Output:** Dependency-ordered extension creation results

---

#### `test-pgbouncer-healthcheck.ts [stack-dir]`

Validates PgBouncer healthcheck and authentication.

**What it tests:**

- Stack deployment (compose up)
- PostgreSQL readiness
- PgBouncer auth via `pgbouncer_lookup()` function
- Health check connectivity
- Query execution through PgBouncer

**Usage:**

```bash
bun scripts/test/test-pgbouncer-healthcheck.ts                  # Default: stacks/primary
bun scripts/test/test-pgbouncer-healthcheck.ts stacks/primary   # Explicit path
```

**Dependencies:** `docker`, `docker compose`, `psql`

**Output:** PgBouncer authentication and connectivity validation

---

#### `wait-for-postgres.ts [host] [port] [user] [timeout]`

Waits for PostgreSQL to accept connections.

**Usage:**

```bash
bun scripts/test/wait-for-postgres.ts                             # localhost:5432, 60s
bun scripts/test/wait-for-postgres.ts db.example.com 5432 admin   # Remote host
PGHOST=localhost PGPORT=6432 bun scripts/test/wait-for-postgres.ts  # Via PgBouncer
bun scripts/test/wait-for-postgres.ts localhost 5432 postgres 120   # 2min timeout
```

**Dependencies:** `pg_isready`

**Output:** Success when PostgreSQL is ready, error after timeout

---

### tools/ - Operational Scripts

#### `backup-postgres.ts [database] [output-file]`

Creates compressed PostgreSQL backup using `pg_dump`.

**Features:**

- Auto-named backup files with timestamp
- Gzip compression
- Backup validation (file size, gzip integrity)
- Remote host support via `PGHOST`/`PGPORT`/`PGUSER`
- Safe: prevents overwriting existing backups

**Usage:**

```bash
bun scripts/tools/backup-postgres.ts                      # Backup 'postgres' db
bun scripts/tools/backup-postgres.ts mydb                 # Backup 'mydb'
bun scripts/tools/backup-postgres.ts mydb backup.sql.gz   # Custom output file
PGHOST=db.example.com PGUSER=admin bun scripts/tools/backup-postgres.ts mydb
```

**Environment variables:**

- `PGHOST` - PostgreSQL host (default: localhost)
- `PGPORT` - PostgreSQL port (default: 5432)
- `PGUSER` - PostgreSQL user (default: postgres)
- `PGPASSWORD` - PostgreSQL password (required for remote)

**Dependencies:** `pg_dump`, `pg_isready`, `gzip`, `du`

**Output:** Compressed `.sql.gz` backup file

---

#### `restore-postgres.ts <backup-file> [database]`

Restores PostgreSQL database from backup.

**Features:**

- Compressed (.gz) and plain SQL file support
- Backup file validation (existence, readability, gzip integrity)
- Interactive confirmation (destructive operation)
- Database statistics after restore

**Usage:**

```bash
bun scripts/tools/restore-postgres.ts backup.sql.gz           # Restore to 'postgres'
bun scripts/tools/restore-postgres.ts backup.sql.gz mydb      # Restore to 'mydb'
PGHOST=db.example.com bun scripts/tools/restore-postgres.ts backup.sql.gz
```

**Environment variables:** Same as `backup-postgres.ts`

**Dependencies:** `psql`, `pg_isready`, `gunzip`

**Output:** Restored database with statistics

---

#### `promote-replica.ts [OPTIONS]`

Promotes PostgreSQL replica to primary role.

**Features:**

- Verifies replica is in recovery mode
- Optional pre-promotion backup
- Safe promotion using `pg_ctl promote`
- Configuration updates (removes `standby.signal`)
- Post-promotion verification

**Options:**

- `--container NAME` - Container name (default: postgres-replica)
- `--data-dir PATH` - Data directory (default: /var/lib/postgresql/data)
- `--no-backup` - Skip backup before promotion
- `--yes` - Skip confirmation prompt
- `--help` - Show help message

**Usage:**

```bash
bun scripts/tools/promote-replica.ts                     # Interactive promotion
bun scripts/tools/promote-replica.ts --container my-replica --yes    # Skip confirmation
bun scripts/tools/promote-replica.ts --no-backup --yes               # Fast (no backup)
```

**Dependencies:** `docker`

**Output:** Promoted primary with verification steps

**Warnings:**

- One-way operation (cannot revert)
- Ensure old primary is stopped (avoid split-brain)
- Update client connection strings after promotion

---

#### `generate-ssl-certs.ts`

Generates self-signed SSL certificates for PostgreSQL TLS.

**Output:**

- `server.key` - Private key
- `server.crt` - Self-signed certificate

**Usage:**

```bash
bun scripts/tools/generate-ssl-certs.ts
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

---

## Common Patterns

### Error Handling

All scripts follow consistent error handling using Bun TypeScript:

```typescript
import {
  checkCommand,
  checkDockerDaemon,
  dockerCleanup,
} from "./lib/common.ts";

// Prerequisites check
await checkCommand("docker");
await checkDockerDaemon();

// Cleanup handler
process.on("exit", () => {
  dockerCleanup(containerName);
});
```

### Type Safety

All scripts use TypeScript with Bun for type safety:

```typescript
import type { BuildOptions } from "./types.ts";

const options: BuildOptions = {
  multiArch: false,
  push: false,
  tag: "aza-pg:pg18",
};
```

### Logging

Consistent colored logging via `common.ts`:

```typescript
import { logInfo, logSuccess, logWarning, logError } from "./lib/common.ts";

logInfo("Starting operation...");
logSuccess("Operation completed");
logWarning("Non-critical issue detected");
logError("Critical failure");
```

## Testing Workflow

**Recommended test sequence:**

1. **Build verification:**

   ```bash
   bun scripts/test/test-build.ts
   ```

2. **Auto-config validation:**

   ```bash
   bun scripts/test/test-auto-config.ts
   ```

3. **Extension smoke test:**

   ```bash
   bun scripts/test/run-extension-smoke.ts
   ```

4. **PgBouncer integration:**
   ```bash
   bun scripts/test/test-pgbouncer-healthcheck.ts
   ```

## Operational Workflow

**Backup and restore cycle:**

```bash
# Backup production database
PGHOST=prod.db.example.com PGPASSWORD=xxx bun scripts/tools/backup-postgres.ts mydb

# Restore to staging
PGHOST=staging.db.example.com PGPASSWORD=yyy bun scripts/tools/restore-postgres.ts backup_mydb_20250131_120000.sql.gz mydb
```

**Replica promotion (failover):**

```bash
# 1. Stop old primary (critical!)
docker stop postgres-primary

# 2. Promote replica
bun scripts/tools/promote-replica.ts --container postgres-replica

# 3. Verify promotion
docker exec postgres-replica psql -U postgres -c "SELECT pg_is_in_recovery();"  # Should return 'f'

# 4. Update application connection strings to new primary
```

## Dependencies

**Required for all scripts:**

- `bun` 1.3.2+ (install via `curl -fsSL https://bun.sh/install | bash`)
- `docker` (Docker Engine or Docker Desktop)

**Test scripts:**

- `docker buildx` (bundled with Docker Desktop)
- `psql` / `pg_isready` (for PgBouncer test)

**Tool scripts:**

- `pg_dump`, `pg_isready`, `psql` (PostgreSQL client tools)
- `gzip`, `gunzip`, `du` (standard Unix utilities)
- `openssl` (for SSL cert generation)

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

1. **Use common library:** Import from `lib/common.ts` for shared functions
2. **Type safety:** Use TypeScript with proper type annotations
3. **Consistent error handling:** Use try-catch with proper cleanup
4. **Logging:** Use `logInfo()`, `logSuccess()`, etc. from common.ts
5. **Cleanup handlers:** Use `process.on('exit')` pattern
6. **Documentation:** Add JSDoc comments and update this README
7. **Testing:** Verify script works on clean environment

**Example script template:**

```typescript
#!/usr/bin/env bun
/**
 * Script description
 *
 * Usage: bun script.ts [args]
 *
 * Examples:
 *   bun script.ts example1
 *   bun script.ts example2
 */

import {
  checkCommand,
  checkDockerDaemon,
  dockerCleanup,
  logInfo,
  logSuccess,
  logError,
} from "./lib/common.ts";

const CONTAINER_NAME = "my-container";

// Cleanup handler
process.on("exit", () => {
  dockerCleanup(CONTAINER_NAME);
});

async function main() {
  try {
    // Check prerequisites
    await checkCommand("docker");
    await checkDockerDaemon();

    // Main logic
    logInfo("Starting operation...");
    // ... implementation ...
    logSuccess("Operation complete");
  } catch (error) {
    logError(`Operation failed: ${error}`);
    process.exit(1);
  }
}

main();
```

## License

Same as parent project (aza-pg).
