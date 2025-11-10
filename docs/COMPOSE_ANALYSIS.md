# Docker Compose Consistency Analysis

## Files Analyzed

1. `/opt/apps/art/infra/aza-pg/stacks/primary/compose.yml`
2. `/opt/apps/art/infra/aza-pg/stacks/primary/compose.dev.yml`
3. `/opt/apps/art/infra/aza-pg/stacks/replica/compose.yml`
4. `/opt/apps/art/infra/aza-pg/stacks/single/compose.yml`
5. `/opt/apps/art/infra/aza-pg/examples/backup/compose.yml`

---

## CRITICAL INCONSISTENCIES FOUND

### 1. SERVICE NAMING PATTERNS ⚠️

#### Inconsistency: Primary Service Names

- **Primary Stack**: Uses `postgres` (line 2)
- **Replica Stack**: Uses `postgres-replica` (line 6)
- **Single Stack**: Uses `postgres` (line 6)
- **Backup Example**: Uses `pgbackrest` (line 15)

**Issue**: Inconsistent naming convention. Primary and single both use `postgres`, while replica uses `postgres-replica`. This breaks consistency for service references.

#### Inconsistency: Container Names

- **Primary**: `${COMPOSE_PROJECT_NAME:-aza-pg}-postgres-primary` (line 6)
- **Replica**: `${COMPOSE_PROJECT_NAME:-aza-pg}-postgres-replica` (line 8)
- **Single**: `${COMPOSE_PROJECT_NAME:-aza-pg}-postgres-single` (line 8)
- **Backup**: `pgbackrest` (line 17) - NO PROJECT NAME PREFIX

**Issue**: Backup container naming doesn't follow the naming convention (no project prefix).

---

### 2. PORT BINDING PATTERNS ⚠️

#### Inconsistency: PostgreSQL Port Assignments

- **Primary**: `5432` (standard, line 32)
- **Replica**: `5433` (non-standard, line 24)
- **Single**: `5432` (standard, line 20)
- **Dev Override**: `5433` (line 9)

**Issue**: Replica uses port 5433 by default, while primary/single use 5432. This is unusual and inconsistent.

#### Inconsistency: PgBouncer Port Assignments

- **Primary**: `6432` (standard, line 63)
- **Dev Override**: `6433` (line 13)
- **Replica**: NO PGBOUNCER SERVICE (intentional but inconsistent design)
- **Single**: NO PGBOUNCER SERVICE (intentional but inconsistent design)

**Issue**: Primary has pgbouncer, but replica and single don't. This is an architectural inconsistency.

#### Inconsistency: Postgres Exporter Port Assignments

- **Primary**: `9187` (line 104)
- **Replica**: `9188` (line 70)
- **Single**: `9189` (line 67)
- **Dev Override**: `9188` (line 17)

**Issue**: All three stacks use different ports (9187, 9188, 9189). No clear pattern or centralized port allocation strategy.

#### Inconsistency: PgBouncer Exporter Port Assignments

- **Primary**: `9127` (line 135)
- **Replica**: NO SERVICE
- **Single**: NO SERVICE

**Issue**: Only primary has pgbouncer exporter, others don't.

---

### 3. NETWORK NAMING PATTERNS ⚠️

#### Inconsistency: Network Names (Critical)

- **Primary**: `${POSTGRES_NETWORK_NAME:-postgres-primary-net}` (line 152)
- **Replica**: `${POSTGRES_NETWORK_NAME:-postgres-primary-net}` (line 87) - SAME AS PRIMARY
- **Single**: `${POSTGRES_NETWORK_NAME:-postgres-single-net}` (line 84)
- **Dev Override**: `postgres-replication` (line 21) - HARDCODED, DIFFERENT

**Issues**:

1. Replica references the PRIMARY network name by default (should be `postgres-replica-net`)
2. Single uses `postgres-single-net` (inconsistent pattern)
3. Dev override hardcodes `postgres-replication` instead of using env var
4. No centralized network naming convention

#### Network Attachment

- **Primary**: Creates `postgres_net` bridge + external `monitoring`
- **Replica**: `postgres_net` is EXTERNAL (requires primary to exist first)
- **Single**: Creates `postgres_net` bridge + external `monitoring`
- **Backup**: External networks only

**Issue**: Primary and single both create `postgres_net`, but replica expects it external. If both are run together, they'll create separate networks.

---

### 4. VOLUME NAMING PATTERNS ⚠️

#### Inconsistency: Data Volume Names

- **Primary**: `${POSTGRES_DATA_VOLUME:-postgres-primary-data}` (line 160)
- **Replica**: `postgres-replica-data` (hardcoded, line 93)
- **Single**: `postgres_data` (line 90) - NO ENV VAR SUPPORT
- **Backup**: `${POSTGRES_DATA_VOLUME:-postgres-primary-data}` (line 60) - references primary

**Issues**:

1. Single doesn't use env var for data volume (hardcoded)
2. Replica hardcodes volume name without env var
3. Inconsistent naming format: `postgres-primary-data` vs `postgres-replica-data` vs `postgres_data`
4. Backup references primary data volume externally

#### Inconsistency: Backup Volume Names

- **Primary**: `${POSTGRES_BACKUP_VOLUME:-postgres-primary-backup}` (line 162)
- **Replica**: NO BACKUP VOLUME
- **Single**: NO BACKUP VOLUME
- **Backup Example**:
  - `pgbackrest_repo` (line 54)
  - `wal_archive` (line 56)

**Issue**: No consistent backup storage strategy. Different stacks use different approaches.

#### Inconsistency: Volume Mount Paths

- **Primary**:
  - Data: `${POSTGRES_DATA_VOLUME:-postgres_data}` (line 18) - INCONSISTENT: uses `postgres_data` not `postgres-primary-data`
  - Backup: `${POSTGRES_BACKUP_VOLUME:-postgres_backup}` (line 19) - INCONSISTENT
- **Replica**: `postgres-replica-data:/var/lib/postgresql` (line 27)
- **Single**: `postgres_data:/var/lib/postgresql` (line 23)

**Issue**: Primary's mount uses `postgres_data` and `postgres_backup` as defaults, but the volume definitions use `postgres-primary-data` and `postgres-primary-backup`. MISMATCH!

---

### 5. ENVIRONMENT VARIABLE PATTERNS ⚠️

#### Inconsistency: POSTGRES_USER Quoting

- **Primary**: Unquoted - `POSTGRES_USER: ${POSTGRES_USER:-postgres}` (line 10)
- **Replica**: Quoted - `POSTGRES_USER: ${POSTGRES_USER:-postgres}` (line 16)
- **Single**: Quoted - `POSTGRES_USER: ${POSTGRES_USER:-postgres}` (line 16)

**Issue**: Inconsistent quoting style for env vars.

#### Inconsistency: POSTGRES_PASSWORD Quoting

- **Primary**: Unquoted - `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?...}` (line 11)
- **Replica**: Quoted - `POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?...}"` (line 17)
- **Single**: Quoted - `POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"` (line 17)

**Issue**: Inconsistent quoting for security-sensitive variables.

#### Inconsistency: Replica-Specific Variables

- **Primary**:
  - `REPLICATION_SLOT_NAME: ${REPLICATION_SLOT_NAME:-replica_slot_1}` (line 15)
- **Replica**:
  - `PG_REPLICATION_USER: ${PG_REPLICATION_USER:-replicator}` (line 18)
  - `PG_REPLICATION_PASSWORD: "${PG_REPLICATION_PASSWORD:?...}"` (line 19)
  - `PRIMARY_HOST: ${PRIMARY_HOST:?PRIMARY_HOST is required}` (line 20)
  - `PRIMARY_PORT: ${PRIMARY_PORT:-5432}` (line 21)

**Issue**: Replication variable naming inconsistent between primary and replica (`REPLICATION_SLOT_NAME` vs `PG_REPLICATION_*`).

#### Inconsistency: Exporter Password References

- **Primary Postgres Exporter**: Uses `${POSTGRES_PASSWORD:?...}` directly (line 90)
- **Primary PgBouncer Exporter**: Uses `${PGBOUNCER_AUTH_PASS:?...}` directly (line 128)
- **Replica Postgres Exporter**: Uses `"${POSTGRES_PASSWORD}"` without required check (line 56)
- **Single Postgres Exporter**: Uses `"${POSTGRES_PASSWORD}"` without required check (line 53)

**Issue**: Inconsistent error handling - primary enforces required, replica/single don't.

---

### 6. RESOURCE LIMIT PATTERNS ⚠️

#### Inconsistency: PostgreSQL Memory Allocation

- **Primary**: `2048m` limit / `1024m` reservation (lines 34-35)
- **Replica**: `512m` limit / `256m` reservation (lines 32-33)
- **Single**: `512m` limit / `256m` reservation (lines 27-28)
- **Dev Override**: `2000m` limit / `512m` reservation (lines 5-6)

**Issue**: No consistent pattern. Dev override uses `2000m` not `2048m`.

#### Inconsistency: PostgreSQL CPU Allocation

- **Primary**: `2` CPUs (line 36)
- **Replica**: `0.5` CPUs (line 35)
- **Single**: `0.5` CPUs (line 42)

**Issue**: CPU limit location inconsistent (line 36 vs 35/42).

#### Inconsistency: Exporter Memory Allocation

- **Primary Postgres Exporter**: `64m` limit / `32m` reservation (lines 106-107)
- **Primary PgBouncer Exporter**: `32m` limit / `16m` reservation (lines 137-138)
- **Replica Postgres Exporter**: `64m` limit / `32m` reservation (lines 72-73)
- **Single Postgres Exporter**: `64m` limit / `32m` reservation (lines 69-70)

**Issue**: Consistent for exporters but different from PgBouncer exporter.

#### Inconsistency: PgBouncer Memory Allocation

- **Primary**: `200m` limit / `100m` reservation (lines 69-70)
- **Dev Override**: No override (inherits primary)

**Issue**: No standard pattern across all services.

#### Inconsistency: Backup Memory Allocation

- **Backup Example**: Uses `deploy.resources.limits/reservations` format (lines 47-51)
- **All Primary/Replica/Single**: Use `mem_limit` and `mem_reservation` (inconsistent format)

**Issue**: Different memory specification format.

---

### 7. HEALTH CHECK PATTERNS ⚠️

#### Inconsistency: Postgres Health Check

- **Primary**: `start_period: 120s` (line 43)
- **Replica**: `start_period: 120s` (line 45)
- **Single**: `start_period: 120s` (line 40)
- **Dev Override**: No health check (intentional)

**Issue**: Consistent for postgres itself, but no health check in dev.

#### Inconsistency: PgBouncer Health Check

- **Primary**:
  - `interval: 30s` (line 76)
  - `timeout: 10s` (line 77)
  - `retries: 3` (line 78)
  - `start_period: 10s` (line 79)

**Issue**: Different timing than postgres checks (30s interval vs 10s). No standard pattern.

---

### 8. CONFIGURATION FILE MOUNTING ⚠️

#### Inconsistency: PostgreSQL Config File Names

- **Primary**: `postgresql-primary.conf` (line 20)
- **Replica**: `postgresql-replica.conf` (line 28)
- **Single**: `postgresql.conf` (line 24)

**Issue**: Inconsistent naming convention.

#### Inconsistency: PgBouncer Config Files

- **Primary**: `pgbouncer.ini.template` (line 54)
- **Replica**: NO PGBOUNCER
- **Single**: NO PGBOUNCER

**Issue**: Only primary has pgbouncer config.

---

### 9. DEPENDENCY AND SERVICE ORDER ⚠️

#### Inconsistency: Service Dependencies

- **Primary**:
  - PgBouncer depends on postgres healthy (lines 65-67)
  - Exporters depend on their respective services (lines 109-111, 140-142)
- **Replica**:
  - Only exporter depends on postgres-replica (lines 75-77)
- **Single**:
  - Only exporter depends on postgres (lines 72-74)

**Issue**: No consistent dependency chain. Exporters should possibly depend on other infrastructure.

---

### 10. IMAGE PINNING AND VERSIONING ⚠️

#### Inconsistency: Image Versions

- **Primary Postgres**: `${POSTGRES_IMAGE:-ghcr.io/fluxo-kt/aza-pg:pg18}` (line 5)
- **Replica Postgres**: `${POSTGRES_IMAGE:-ghcr.io/fluxo-kt/aza-pg:pg18}` (line 7)
- **Single Postgres**: `${POSTGRES_IMAGE:-ghcr.io/fluxo-kt/aza-pg:pg18}` (line 7)
- **Dev Postgres**: `${POSTGRES_IMAGE:-aza-pg:pg18-dev}` (line 3) - DIFFERENT, LOCAL IMAGE

**Issue**: Dev uses local image tag, others use registry. No SHA pinning.

#### Inconsistency: PgBouncer Image Pinning

- **Primary**: SHA pinned - `edoburu/pgbouncer:v1.24.1-p1@sha256:...` (line 46)
- **Replica**: NO PGBOUNCER
- **Single**: NO PGBOUNCER

**Issue**: Only primary has SHA pinning.

#### Inconsistency: Exporter Image Versioning

- **All Postgres Exporters**: `prometheuscommunity/postgres-exporter:v0.18.1` (no SHA pin)
- **All PgBouncer Exporters**: `prometheuscommunity/pgbouncer-exporter:v0.9.0` (no SHA pin)

**Issue**: No SHA pinning for exporters.

---

## SUMMARY TABLE

| Aspect                  | Primary                 | Replica                 | Single              | Backup                | Dev                  |
| ----------------------- | ----------------------- | ----------------------- | ------------------- | --------------------- | -------------------- |
| Postgres Service Name   | `postgres`              | `postgres-replica`      | `postgres`          | N/A                   | `postgres`           |
| PgBouncer               | YES                     | NO                      | NO                  | NO                    | YES                  |
| Network Name (default)  | postgres-primary-net    | postgres-primary-net    | postgres-single-net | postgres-primary-net  | postgres-replication |
| Network Type            | bridge                  | external                | bridge              | external              | bridge               |
| Data Volume (default)   | postgres-primary-data   | postgres-replica-data   | postgres_data       | postgres-primary-data | postgres_data        |
| Postgres Port (default) | 5432                    | 5433                    | 5432                | N/A                   | 5433                 |
| Postgres Exporter Port  | 9187                    | 9188                    | 9189                | N/A                   | 9188                 |
| PgBouncer Exporter Port | 9127                    | N/A                     | N/A                 | N/A                   | N/A                  |
| Postgres Memory         | 2048m / 1024m           | 512m / 256m             | 512m / 256m         | N/A                   | 2000m / 512m         |
| Postgres CPU            | 2                       | 0.5                     | 0.5                 | N/A                   | (inherited)          |
| Postgres Config         | postgresql-primary.conf | postgresql-replica.conf | postgresql.conf     | N/A                   | (inherited)          |

---

## RECOMMENDATIONS

### Priority 1: Critical Fixes

1. **Volume Mount Mismatch**: Fix primary's mount definitions to match volume names
2. **Replica Network**: Change default network name from `postgres-primary-net` to `postgres-replica-net`
3. **Port Allocation**: Create centralized port allocation (e.g., use 5432, 6432, 9187 for primary; 5433, 6433, 9188 for replica; 5434, 6434, 9189 for single)
4. **Service Naming**: Use consistent naming (e.g., `postgres-primary`, `postgres-replica`, `postgres-single`)
5. **Backup Container Naming**: Add project prefix to backup container name

### Priority 2: Standardization

1. **Env Var Quoting**: Standardize quoting across all sensitive variables
2. **Config File Names**: Use consistent naming pattern for postgresql configs
3. **Volume Naming**: Ensure all volumes use env vars with consistent defaults
4. **Resource Limits**: Define standard resource profiles (development, staging, production)
5. **Health Check Timing**: Standardize health check intervals across services

### Priority 3: Enhancement

1. **Image SHA Pinning**: Add SHA256 digests to all external images
2. **Exporter Services**: Consider adding exporter services to replica/single stacks
3. **PgBouncer**: Consider adding PgBouncer to replica stack
4. **Error Handling**: Make password validation consistent (all use `:?` for required vars)
