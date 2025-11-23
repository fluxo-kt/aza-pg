# pgflow SQL Update Process

**Purpose**: Document how to update vendored pgflow SQL files and ensure they pass our SQL quality checks.

## Context

We vendor pgflow SQL schema files from `@pgflow/core` package:

- `docker/postgres/docker-entrypoint-initdb.d/05-pgflow.sql` (production init script)
- `examples/pgflow/10-pgflow.sql` (example/documentation)

These files must pass our SQL linting (sql-formatter + Squawk) without warnings.

## Update Workflow

### 1. Fetch New pgflow Version

```bash
# Check latest version
npm view @pgflow/core version

# pgflow uses multiple schema files in pkgs/core/schemas/ directory
# Download all schema files from the version tag or commit
# Example for v0.7.2:
curl -O https://raw.githubusercontent.com/pgflow-dev/pgflow/main/pkgs/core/schemas/0050_tables_definitions.sql
curl -O https://raw.githubusercontent.com/pgflow-dev/pgflow/main/pkgs/core/schemas/0060_tables_runtime.sql
# (continue for all numbered schema files in the schemas/ directory)

# Or clone the repository and extract schema files:
git clone --depth 1 --branch v0.7.2 https://github.com/pgflow-dev/pgflow.git
cat pgflow/pkgs/core/schemas/*.sql > combined-schema.sql
```

### 2. Apply Our Modifications

Run these fixes on the downloaded SQL:

```bash
# Make executable
chmod +x scripts/apply-pgflow-fixes.sh

# Apply fixes
./scripts/apply-pgflow-fixes.sh schema.sql
```

The script applies:

1. **IF NOT EXISTS to CREATE statements** (idempotency)
2. **CREATE OR REPLACE for functions** (idempotency)
3. **Migration section documentation** (context for warnings)
4. **DO NOT add IF NOT EXISTS to CREATE TYPE** (PostgreSQL doesn't support it for composite types)

### 3. Verify SQL Quality

```bash
# Format SQL (auto-fix)
bun run format:sql:fix

# Lint SQL (custom checks + Squawk)
bun run lint:sql
# Should show: "Found 0 issues in 3 files 🎉"

# Full validation
bun run validate
```

### 4. Update Version References

Update these files with new version:

- Header comment in `05-pgflow.sql` (e.g., `-- VERSION: v0.7.3`)
- `package.json` if pgflow is a dependency
- This document's date

### 5. Test SQL Loads

```bash
# Test SQL can be loaded into PostgreSQL
docker run --rm -v "$(pwd)/docker/postgres/docker-entrypoint-initdb.d:/docker-entrypoint-initdb.d:ro" \
  -e POSTGRES_PASSWORD=test \
  postgres:18-trixie

# Check logs for errors
```

### 6. Commit Changes

```bash
git add docker/postgres/docker-entrypoint-initdb.d/05-pgflow.sql examples/pgflow/10-pgflow.sql
git commit -m "chore(pgflow): update to v0.7.x

Update vendored pgflow SQL schema to v0.7.x.

Changes:
- Update pgflow schema from @pgflow/core@0.7.x
- Apply idempotency fixes (IF NOT EXISTS, CREATE OR REPLACE)
- Verify zero Squawk warnings
- Test SQL loads successfully

Source: https://github.com/pgflow-dev/pgflow/releases/tag/v0.7.x"
```

## Common Issues

### Issue: Squawk Syntax Errors

**Cause**: `IF NOT EXISTS` added to unsupported statements

**Fix**: PostgreSQL doesn't support IF NOT EXISTS for:

- CREATE TYPE (composite types)
- ALTER TABLE statements
- Some constraint operations

Remove IF NOT EXISTS from these cases.

### Issue: Migration Section Warnings

**Cause**: ALTER TABLE operations in migration sections

**Fix**: These are expected. Migration sections are for upgrades only.
Fresh installations create tables correctly from the start.
Warnings are documented in migration section comments.

### Issue: Foreign Key Constraint Warnings

**Cause**: Squawk warns about FK constraints blocking writes

**Fix**: Already excluded in `.squawk.toml` as `adding-foreign-key-constraint`.
Init scripts run on empty databases - no live traffic to block.

## Squawk Configuration

Our `.squawk.toml` is tailored for initialization scripts:

```toml
# Init scripts run on empty databases during container startup
assume_in_transaction = true

excluded_rules = [
  "require-concurrent-index-creation",  # No live traffic
  "prefer-bigint-over-int",            # Not all ints need 64-bit
  "constraint-missing-not-valid",      # Empty tables
  "require-timeout-settings",          # Short-lived init
  "adding-foreign-key-constraint",     # No live traffic
]
```

Do NOT exclude rules globally without documenting why in this file.

## Maintenance Notes

**Last Updated**: 2025-11-23
**Current pgflow Version**: v0.7.2
**Maintainer**: Check git log for recent contributors

## Sources

- [pgflow Repository](https://github.com/pgflow-dev/pgflow)
- [pgflow Core Schemas](https://github.com/pgflow-dev/pgflow/tree/main/pkgs/core/schemas) (SQL schema files location)
- [Squawk Documentation](https://squawkhq.com/docs/rules)
- [PostgreSQL IF NOT EXISTS Support](https://www.postgresql.org/docs/current/sql-commands.html)

## Repository Structure Notes

**Important**: pgflow repository structure (as of v0.7.2+):

- **Correct path**: `pkgs/core/schemas/*.sql` (multiple numbered schema files)
- **NOT**: `packages/core/sql/schema.sql` (outdated structure)
- Schema files are numbered (0050_tables_definitions.sql, 0060_tables_runtime.sql, etc.)
- Must be combined in order to create complete schema
