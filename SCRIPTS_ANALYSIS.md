# AZA-PG Scripts and Configuration Analysis Report

## Executive Summary

This repository is a **production-ready PostgreSQL 18 infrastructure stack** with 38 extensions. It uses a modern toolchain combining **Bash, TypeScript, Docker, and Bun** with comprehensive linting and testing. However, several critical gaps exist in script validation coverage.

---

## 1. SCRIPTS INVENTORY

### 1.1 Core Build & Infrastructure Scripts

#### Bash Scripts (1,020 LOC total)

| Script                             | Location           | Purpose                                                                         | LOC | Status         |
| ---------------------------------- | ------------------ | ------------------------------------------------------------------------------- | --- | -------------- |
| `build-extensions.sh`              | `docker/postgres/` | Multi-stage extension builder (pgxs, cargo-pgrx, cmake, meson, make, autotools) | 589 | **No linting** |
| `build.sh`                         | `scripts/`         | Docker buildx orchestrator with multi-arch support (amd64, arm64)               | 178 | **No linting** |
| `docker-auto-config-entrypoint.sh` | `docker/postgres/` | Auto-detection of RAM/CPU, dynamic PostgreSQL config scaling                    | 253 | **No linting** |
| `common.sh`                        | `scripts/lib/`     | Shared logging & Docker utilities (docker_cleanup, wait_for_postgres)           | 131 | **No linting** |
| `generate-configs.sh`              | `scripts/`         | Wrapper calling Bun-based config generator                                      | 18  | **No linting** |

#### Docker Init Scripts (entrypoint hooks)

| Script                    | Location                                      | Purpose                            | Status         |
| ------------------------- | --------------------------------------------- | ---------------------------------- | -------------- |
| `02-replication.sh`       | `docker/postgres/docker-entrypoint-initdb.d/` | Replication slot setup             | **No linting** |
| `03-pgsodium-init.sh`     | `docker/postgres/docker-entrypoint-initdb.d/` | Encryption key initialization      | **No linting** |
| `03-pgbouncer-auth.sh`    | `stacks/primary/configs/initdb/`              | PgBouncer auth user creation       | **No linting** |
| `pgbouncer-entrypoint.sh` | `stacks/primary/scripts/`                     | PgBouncer configuration entrypoint | **No linting** |

#### Test Scripts (Bash, 89 LOC)

| Script                          | Purpose                                        | Uses                     | Status         |
| ------------------------------- | ---------------------------------------------- | ------------------------ | -------------- |
| `test-build.sh`                 | Validates Docker image build                   | Docker, curl             | **No linting** |
| `test-single-stack.sh`          | Single-instance PostgreSQL deployment test     | Docker compose           | **No linting** |
| `test-replica-stack.sh`         | Replication setup functional test              | Docker compose, pg tools | **No linting** |
| `test-auto-config.sh`           | Memory/CPU auto-detection test (11 test cases) | Docker, psql             | **No linting** |
| `test-disabled-extensions.sh`   | Tests disabled extension handling              | Docker, psql             | **No linting** |
| `test-hook-extensions.sh`       | Tests extension hooks (pg_cron jobs, etc.)     | Docker, psql             | **No linting** |
| `test-pgbouncer-failures.sh`    | Tests PgBouncer failure scenarios              | Docker compose           | **No linting** |
| `test-pgbouncer-healthcheck.sh` | Tests PgBouncer healthcheck logic              | Docker, curl             | **No linting** |
| `run-extension-smoke.sh`        | Smoke test for all 38 extensions               | Docker, psql             | **No linting** |
| `wait-for-postgres.sh`          | Wait utility with timeout logic                | pg_isready               | **No linting** |

#### Utility/Tool Scripts

| Script                  | Purpose                                | Status         |
| ----------------------- | -------------------------------------- | -------------- |
| `backup-postgres.sh`    | pg_dump wrapper with encryption        | **No linting** |
| `restore-postgres.sh`   | Restore from backup file               | **No linting** |
| `generate-ssl-certs.sh` | Self-signed certificate generation     | **No linting** |
| `promote-replica.sh`    | Replica to primary failover automation | **No linting** |

**Summary:** 20 bash scripts totaling ~1,500 lines of code across build, test, and operational utilities.

---

### 1.2 TypeScript Scripts (Bun-based)

#### Configuration Generation (workspace: `scripts/config-generator/`)

| Script                | Purpose                                                | Status                       |
| --------------------- | ------------------------------------------------------ | ---------------------------- |
| `generator.ts`        | Main config generator (postgresql.conf, pgbouncer.ini) | Type-checked, **No linting** |
| `base-config.ts`      | Default PostgreSQL & PgBouncer settings                | Type-checked, **No linting** |
| `validate-configs.ts` | Schema validation for generated configs                | Type-checked, **No linting** |
| `types.ts`            | TypeScript interfaces for configs                      | Type-checked                 |
| `test-formatter.ts`   | Config formatting test suite                           | Type-checked                 |

#### Extension Management

| Script                 | Purpose                                       | Status                       |
| ---------------------- | --------------------------------------------- | ---------------------------- |
| `validate-manifest.ts` | Validates extensions.manifest.json            | Type-checked, **No linting** |
| `generate-manifest.ts` | Generates manifest from TOML                  | Type-checked, **No linting** |
| `manifest-schema.ts`   | Zod schema for manifest validation            | Type-checked, **No linting** |
| `manifest-data.ts`     | Generated manifest export                     | Generated file               |
| `fetch-latest.ts`      | Fetches latest extension versions from GitHub | Type-checked, **No linting** |
| `render-markdown.ts`   | Renders extension docs to markdown            | Type-checked, **No linting** |

#### Test Suites (TypeScript, 50+ KB)

| Test File                                    | Purpose                                              | Status                |
| -------------------------------------------- | ---------------------------------------------------- | --------------------- |
| `test-all-extensions-functional.ts`          | Comprehensive functional tests for all 38 extensions | **No oxlint linting** |
| `test-extension-performance.ts`              | Performance benchmarking for extensions              | **No linting**        |
| `test-extensions.ts`                         | Dynamic extension creation tests                     | **No linting**        |
| `test-pgflow-functional.ts`                  | pgFlow extension tests                               | **No linting**        |
| `test-pgflow-functional-v072.ts`             | pgFlow 0.7.2 variant tests                           | **No linting**        |
| `test-pgq-functional.ts`                     | pgq extension tests                                  | **No linting**        |
| `test-integration-extension-combinations.ts` | Extension compatibility matrix tests                 | **No linting**        |
| `test-utils.ts`                              | Shared test utilities                                | **No linting**        |

#### Utilities

| Script             | Purpose                                              |
| ------------------ | ---------------------------------------------------- |
| `guc-formatter.ts` | Formats PostgreSQL GUC (Grand Unified Config) values |
| `logger.ts`        | Centralized logging for scripts                      |

**Summary:** 18 TypeScript files using Bun, with strict TypeScript mode enabled but **minimal linting**.

---

### 1.3 Docker & Container Configuration

#### Dockerfile(s)

| File                         | Purpose                           | Lines | Status          |
| ---------------------------- | --------------------------------- | ----- | --------------- |
| `docker/postgres/Dockerfile` | Multi-stage PostgreSQL 18 builder | 190   | **No hadolint** |

**Structure:**

- `builder-base`: Build tools installation
- `builder-pgxs`: PGXS/autotools/cmake/meson extensions
- `builder-cargo`: Rust-based extensions (via cargo-pgrx)
- `final`: Runtime image assembly

#### Docker Compose Files (372 LOC total)

| File                             | Purpose                                    | Services | Status            |
| -------------------------------- | ------------------------------------------ | -------- | ----------------- |
| `stacks/primary/compose.yml`     | Primary PostgreSQL + PgBouncer + exporters | 5        | **No validation** |
| `stacks/primary/compose.dev.yml` | Development overrides                      | -        | **No validation** |
| `stacks/replica/compose.yml`     | Replica stack for HA setup                 | 6        | **No validation** |
| `stacks/single/compose.yml`      | Standalone PostgreSQL                      | 4        | **No validation** |
| `examples/backup/compose.yml`    | Backup utility stack                       | 2        | **No validation** |

**Services:**

- `postgres`: Main database
- `pgbouncer`: Connection pooling
- `postgres_exporter`: Prometheus metrics
- `pgbouncer_exporter`: PgBouncer metrics

---

### 1.4 Configuration Files

#### YAML/YML Files (198 LOC)

| File                                                     | Purpose                                | Status                  |
| -------------------------------------------------------- | -------------------------------------- | ----------------------- |
| `docker/postgres/configs/postgres_exporter_queries.yaml` | Prometheus exporter metric definitions | **No yamllint**         |
| `examples/prometheus/prometheus.yml`                     | Prometheus server configuration        | **No yamllint**         |
| `examples/prometheus/alerts.yml`                         | Prometheus alerting rules              | **No yamllint**         |
| `.github/workflows/build-postgres-image.yml`             | CI/CD GitHub Actions workflow          | **No action-validator** |
| `.github/dependabot.yml`                                 | Dependabot configuration               | **No validation**       |

#### JSON Configuration

| File                                       | Purpose                                           | Status      |
| ------------------------------------------ | ------------------------------------------------- | ----------- |
| `tsconfig.json`                            | TypeScript compiler options (strict mode enabled) | ✓ Present   |
| `.oxlintrc.json`                           | JavaScript/TypeScript linter config               | ✓ Present   |
| `.prettierrc.json`                         | Code formatter config                             | ✓ Present   |
| `docker/postgres/extensions.manifest.json` | Extension metadata and build instructions         | **Dynamic** |

#### Other Config Files

| File                  | Purpose                              |
| --------------------- | ------------------------------------ |
| `.dockerignore`       | Docker build context exclusions      |
| `.prettierignore`     | Prettier exclusions                  |
| `.tool-versions`      | asdf tool versions (Bun, Node, etc.) |
| `git-hooks.config.ts` | Pre-commit hook configuration        |

---

## 2. CURRENT LINTING & VALIDATION STATUS

### Enabled

| Tool                   | Type                    | Coverage                 | Config             |
| ---------------------- | ----------------------- | ------------------------ | ------------------ |
| **TypeScript (`tsc`)** | Type-checking           | All `.ts` files          | `tsconfig.json`    |
| **Oxlint**             | JS/TS linting           | All `.ts` files          | `.oxlintrc.json`   |
| **Prettier**           | Code formatting         | JS/TS/JSON/YAML/MD       | `.prettierrc.json` |
| **Bun**                | Runtime/Package manager | All TypeScript execution | `package.json`     |

**Package.json Scripts:**

```json
{
  "lint": "oxlint .",
  "lint:fix": "oxlint --fix .",
  "format": "prettier --write .",
  "format:check": "prettier --check .",
  "type-check": "tsc --noEmit",
  "validate": "bun run lint && bun run format:check && bun run type-check"
}
```

### **MISSING (Critical Gaps)**

| Tool                         | Type                      | Should Cover                | Current Gap |
| ---------------------------- | ------------------------- | --------------------------- | ----------- |
| **shellcheck**               | Bash linting              | 20 bash scripts, 1,500+ LOC | ❌ MISSING  |
| **hadolint**                 | Dockerfile linting        | Dockerfile (190 lines)      | ❌ MISSING  |
| **yamllint**                 | YAML validation           | 5 compose/config YAML files | ❌ MISSING  |
| **action-validator**         | GitHub Actions validation | 1 workflow file             | ❌ MISSING  |
| **docker-compose validator** | Compose schema            | 5 compose files             | ❌ MISSING  |

---

## 3. CI/CD PIPELINE ANALYSIS

### GitHub Actions Workflow

**Location:** `.github/workflows/build-postgres-image.yml`

**Jobs:**

1. **`build`**: Multi-platform Docker image (amd64, arm64)
   - No Dockerfile linting step
   - No shellcheck for build-extensions.sh
2. **`test`**: Extension and stack testing
   - Uses Bun to run TypeScript tests
   - Tests 38 extensions functionally
   - Tests auto-config with memory limits
3. **`test-replica-stack`**: Replication tests
   - Runs bash test scripts (no pre-linting)
4. **`test-single-stack`**: Single-stack tests
   - Runs bash test scripts (no pre-linting)

**Missing CI Checks:**

- No `shellcheck` step for bash scripts
- No `hadolint` step for Dockerfile
- No `yamllint` for compose/config files
- No `action-validator` for workflow itself

---

## 4. SCRIPT CLASSIFICATION BY RUNTIME

### Bash Scripts (20)

**Pure Bash:**

- `build.sh` - Docker Buildx orchestration
- `build-extensions.sh` - Extension compilation
- `docker-auto-config-entrypoint.sh` - Auto-configuration
- `common.sh` - Shared utilities
- `generate-configs.sh` - Wrapper to Bun generator
- 10 test scripts
- 4 utility/tool scripts

**Bash Dependencies:**

- Docker CLI
- curl
- PostgreSQL CLI tools (psql, pg_dump, pg_isready, pg_config)
- Git
- GNU make, autotools, cmake, meson
- Rust (cargo, cargo-pgrx)
- jq (JSON processing)
- Python3 (used in build-extensions.sh)

### Bun/TypeScript Scripts (18)

**Execution:** `bun run *.ts`

**Dependencies:**

```json
{
  "@types/bun": "^1.3.0",
  "@types/node": "^24.9.1",
  "arktype": "^2.1.25",
  "bun-git-hooks": "^0.3.1",
  "oxlint": "^0.11.0",
  "prettier": "^3.4.1",
  "typescript": "^5.7.2"
}
```

**Features:**

- Strict TypeScript mode enabled
- ArkType validation schemas
- Docker integration via `$ "command"` syntax

---

## 5. DETAILED SCRIPT ANALYSIS

### 5.1 Build Extension Script Complexity

**File:** `docker/postgres/build-extensions.sh` (589 lines)

**Key Features:**

- Multi-build-system support (pgxs, cargo-pgrx, timescaledb, autotools, cmake, meson, make, perl)
- Dependency validation (Gate 1)
- Git URL allowlist for security
- Manifest-driven patch application
- Disabled extension cleanup (Gate 2)
- Core preload extension validation
- Comprehensive error handling

**Risks (needs shellcheck):**

- Array handling (CARGO_PGRX_INIT, DISABLED_EXTENSIONS)
- String interpolation in dynamic commands
- Conditional path construction
- Python3 subprocess for TOML parsing

### 5.2 Auto-Config Entrypoint Script Complexity

**File:** `docker/postgres/docker-auto-config-entrypoint.sh` (253 lines)

**Key Features:**

- Multi-source RAM detection (POSTGRES_MEMORY env, cgroup-v2, /proc/meminfo, default)
- Multi-source CPU detection (cgroup-v2, /proc/cpuinfo)
- Dynamic scaling of: shared_buffers, work_mem, maintenance_work_mem, max_connections
- Shared preload library configuration
- Data checksum management

**Risks (needs shellcheck):**

- Complex arithmetic for memory calculations
- String parsing of memory limits
- Cgroup v1/v2 compatibility logic
- Regex pattern matching for environment validation

---

## 6. EXTENSION BUILD SYSTEM

### 6.1 Build Pipeline (Dockerfile)

**Multi-stage approach:**

1. **builder-base**: Install compile tools, Rust
2. **builder-pgxs**: Build PGXS/autotools/cmake/meson/make extensions
3. **builder-cargo**: Build Rust extensions via cargo-pgrx (optimized for size)
4. **final**: Assemble runtime image with all compiled extensions

**Pre-compiled extensions (14 via PGDG):**

- pg_cron, pgaudit, pgvector, timescaledb, postgis, partman, repack
- plpgsql_check, hll, http, hypopg, pgrouting, rum, set_user

**Compiled extensions (~18):**

- pg_jsonschema, wrappers, pgsodium, vectorscale, pgmoon, etc.

### 6.2 Manifest-Driven Configuration

**File:** `docker/postgres/extensions.manifest.json`

**Structure:**

```json
{
  "entries": [
    {
      "name": "extension_name",
      "kind": "extension|builtin|tool",
      "category": "vector|timeseries|search|security|ops",
      "enabled": true|false,
      "disabledReason": "...",
      "source": { "type": "git|git-ref", "repository": "...", "commit": "..." },
      "build": {
        "type": "pgxs|cargo-pgrx|cmake|autotools|meson|make",
        "subdir": "optional",
        "features": ["feature1"],
        "noDefaultFeatures": false,
        "patches": ["sed expressions"]
      },
      "dependencies": ["dependency_name"],
      "runtime": {
        "sharedPreload": true|false,
        "defaultEnable": true|false
      }
    }
  ]
}
```

---

## 7. GAPS IN LINTING COVERAGE

### Critical Gaps

| Category                            | Count      | Impact                                  | Effort to Fix                        |
| ----------------------------------- | ---------- | --------------------------------------- | ------------------------------------ |
| Bash scripts (build, test, utility) | 20 scripts | High (production infrastructure code)   | Low (add shellcheck to CI)           |
| Dockerfile                          | 1 file     | High (container image base)             | Low (add hadolint to CI)             |
| Docker Compose YAML                 | 5 files    | Medium (deployment configuration)       | Low (add yamllint/compose validator) |
| GitHub Actions workflow             | 1 file     | Medium (CI/CD configuration)            | Low (add action-validator)           |
| Other config YAML                   | 3 files    | Medium (Prometheus, extension metadata) | Low (add yamllint)                   |

### Medium Gaps

| Issue                 | Current                    | Needed                                       |
| --------------------- | -------------------------- | -------------------------------------------- |
| TypeScript test files | Type-checked only          | Could run oxlint on test files too           |
| Bash in Docker        | No pre-check               | Could validate in Dockerfile COPY statements |
| Generated configs     | No schema validation in CI | Could add pre-commit hooks                   |

---

## 8. RECOMMENDATIONS FOR IMPROVEMENT

### Priority 1: Add Missing Linters (1-2 hours)

#### 1.1 Add Shellcheck to CI/CD

**Installation in GitHub Actions:**

```yaml
- name: Install shellcheck
  run: |
    sudo apt-get update
    sudo apt-get install -y shellcheck

- name: Lint bash scripts
  run: |
    shellcheck scripts/**/*.sh docker/postgres/**/*.sh \
      stacks/*/configs/**/*.sh stacks/*/scripts/**/*.sh
```

**Common issues to fix:**

- Unquoted variables ($var → "$var")
- Using backticks (`` `cmd` `` → $(cmd))
- Unescaped special characters in strings
- Unreachable code detection

**Files to lint:**

```
scripts/build.sh
scripts/generate-configs.sh
scripts/lib/common.sh
scripts/test/test-*.sh
scripts/tools/*.sh
docker/postgres/build-extensions.sh
docker/postgres/docker-auto-config-entrypoint.sh
docker/postgres/docker-entrypoint-initdb.d/*.sh
stacks/*/scripts/*.sh
stacks/*/configs/initdb/*.sh
```

#### 1.2 Add Hadolint to CI/CD

```yaml
- name: Lint Dockerfile
  uses: hadolint/hadolint-action@v3
  with:
    dockerfile: docker/postgres/Dockerfile
    failure-threshold: warning
```

**Common Dockerfile issues to fix:**

- Use of `latest` tags
- Missing HEALTHCHECK
- Inefficient layer ordering
- Unset required arguments

#### 1.3 Add YAML Linting

```yaml
- name: Install yamllint
  run: pip install yamllint

- name: Lint YAML files
  run: |
    yamllint .github/workflows/
    yamllint stacks/*/compose*.yml
    yamllint docker/postgres/configs/*.yaml
    yamllint examples/prometheus/*.yml
```

**Create `.yamllint` config:**

```yaml
rules:
  line-length:
    max: 120
  truthy:
    allowed: ["true", "false"]
  comments-indentation: enable
  comments: enable
```

#### 1.4 Validate GitHub Actions Workflow

```yaml
- name: Validate GitHub Actions workflow
  uses: azohra/shell-linter@latest
  with:
    scandir: ".github/workflows"
```

Or use `action-validator`:

```bash
npm install -g action-validator
action-validator validate .github/workflows/build-postgres-image.yml
```

---

### Priority 2: Enhance TypeScript Linting

**Current:** Type-checked only
**Recommended:** Add oxlint to test files

```bash
# .oxlintrc.json update
{
  "env": {
    "node": true,
    "es2024": true
  },
  "overrides": [
    {
      "files": ["**/*.test.ts", "**/*.spec.ts"],
      "rules": {
        "jest/valid-expect": "error"
      }
    }
  ]
}
```

---

### Priority 3: Pre-commit Hooks

**Current:** Uses `bun-git-hooks`

**Add to `.git-hooks-config.ts`:**

```typescript
export default {
  hooks: {
    "pre-commit": [
      "bun run lint",
      "bun run format:check",
      "shellcheck scripts/**/*.sh",
      "hadolint docker/postgres/Dockerfile",
    ],
  },
};
```

---

### Priority 4: Convert Bash Scripts to Bun/TypeScript

**Candidates (highest ROI):**

| Script                | Reason                       | Effort | Benefit                            |
| --------------------- | ---------------------------- | ------ | ---------------------------------- |
| `build.sh`            | Core infrastructure, 178 LOC | Medium | Better error handling, type safety |
| `generate-configs.sh` | Already calls Bun            | Low    | Eliminate bash wrapper             |
| `common.sh`           | Shared utilities             | Low    | Reusable TS modules                |

**Keep as Bash (necessary for Docker):**

- `docker-auto-config-entrypoint.sh` (entrypoint must be shell)
- `docker-entrypoint-initdb.d/*.sh` (Docker hook requirement)
- `pgbouncer-entrypoint.sh` (entrypoint requirement)

---

### Priority 5: Enhance Dockerfile

**Improvements:**

1. Add HEALTHCHECK to all services (already done for postgres)
2. Split complex build logic into helper scripts
3. Use BuildKit secrets for sensitive data
4. Add explicit error handling

**Current:**

```dockerfile
HEALTHCHECK --interval=10s --timeout=5s --start-period=120s --retries=3 \
    CMD pg_isready -U postgres -d postgres || exit 1
```

**Good practice.** Consider adding for other services in compose files.

---

## 9. SUMMARY TABLE: Scripts & Linting Status

| Category    | Count | Bash | TS  | Linting                           | CI Check | Priority |
| ----------- | ----- | ---- | --- | --------------------------------- | -------- | -------- |
| Build       | 2     | 2    | -   | ❌ shellcheck                     | ❌ None  | **P1**   |
| Tests       | 10    | 8    | 8   | ❌ shellcheck (bash), oxlint (ts) | ❌ None  | **P1**   |
| Tools       | 4     | 4    | -   | ❌ shellcheck                     | ❌ None  | **P1**   |
| Config Gen  | 5     | 1    | 4   | ✓ Type-check, ⚠ oxlint           | ✓ Yes    | P2       |
| Extensions  | 6     | -    | 6   | ✓ Type-check, ⚠ oxlint           | ✓ Yes    | P2       |
| Docker Init | 4     | 4    | -   | ❌ shellcheck                     | ❌ None  | **P1**   |
| Dockerfiles | 1     | -    | -   | ❌ hadolint                       | ❌ None  | **P1**   |
| Compose     | 5     | -    | -   | ❌ yamllint                       | ❌ None  | **P1**   |
| Config YAML | 3     | -    | -   | ❌ yamllint                       | ❌ None  | **P1**   |
| Workflows   | 2     | -    | -   | ❌ action-validator               | ❌ None  | **P1**   |

---

## 10. IMPLEMENTATION ROADMAP

### Phase 1: Add Linters (1-2 hours)

- [ ] Add shellcheck (20 scripts)
- [ ] Add hadolint (1 Dockerfile)
- [ ] Add yamllint (8 YAML files)
- [ ] Add action-validator (1 workflow)
- [ ] Create `.shellcheckrc`, `.hadolintrc`, `.yamllintrc` configs

### Phase 2: Fix Existing Issues (2-4 hours)

- [ ] Run shellcheck and fix issues
- [ ] Run hadolint and fix issues
- [ ] Run yamllint and fix issues
- [ ] Run action-validator and fix issues

### Phase 3: CI/CD Integration (1 hour)

- [ ] Add shellcheck step to GitHub Actions
- [ ] Add hadolint step to GitHub Actions
- [ ] Add yamllint step to GitHub Actions
- [ ] Add action-validator step to GitHub Actions

### Phase 4: Pre-commit Hooks (30 min)

- [ ] Update git-hooks.config.ts with new linters
- [ ] Test local pre-commit execution

### Phase 5: Documentation (30 min)

- [ ] Document linting setup in CONTRIBUTING.md
- [ ] Document how to run linters locally
- [ ] Add linting to AGENTS.md workflow section

---

## Files to Create/Modify

```
.shellcheckrc                          # New
.hadolintrc                            # New
.yamllint                              # New
.github/workflows/build-postgres-image.yml  # Update
git-hooks.config.ts                    # Update
CONTRIBUTING.md                        # Update (if exists)
AGENTS.md                              # Update
```

---

## Key Findings

1. **Strong TypeScript/Modern JS setup:** Strict mode, oxlint, prettier, Bun runtime
2. **Weak Bash coverage:** 20 scripts, 1,500+ LOC with zero linting
3. **No container/config validation:** Dockerfile and YAML files unvalidated
4. **Good test coverage:** 18 test files, mostly TypeScript
5. **Efficient build system:** Multi-stage Dockerfile, manifest-driven extensions
6. **Missing CI checks:** No pre-check for infrastructure code

---

## Estimated Time to Full Compliance

- **Investigation:** ✓ Complete (this analysis)
- **Configuration:** 1-2 hours
- **Fixing violations:** 2-4 hours
- **CI/CD integration:** 1 hour
- **Testing & validation:** 1-2 hours

**Total: 5-9 hours to achieve comprehensive linting coverage**
