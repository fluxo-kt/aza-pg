# pgflow Schema Update Process

**Purpose**: Document how to update the pgflow test schema and verify compatibility with aza-pg.

## Architecture Change (v0.8.1)

**Important**: As of v0.8.1, pgflow is NO LONGER bundled in the Docker image.

| Before               | After                    |
| -------------------- | ------------------------ |
| Bundled in initdb.d  | Per-project installation |
| Auto-installed       | Manual installation      |
| Single shared schema | Isolated per database    |

See `docs/PGFLOW-SETUP.md` for user installation instructions.

## Test Schema Location

The pgflow schema is maintained in test fixtures for validation:

```
tests/fixtures/pgflow/
├── schema-v0.8.1.sql   # Combined schema for testing
├── install.ts          # Installation helper
└── README.md           # Update instructions
```

## Update Workflow

### 1. Check for New pgflow Version

```bash
# Check npm for latest version
npm view @pgflow/dsl version
npm view @pgflow/client version

# Or check GitHub releases
open https://github.com/pgflow-dev/pgflow/releases
```

### 2. Download Schema Files

pgflow uses 21 numbered SQL files in `pkgs/core/schemas/`:

```bash
VERSION="0.9.0"  # Update to target version
BASE_URL="https://raw.githubusercontent.com/pgflow-dev/pgflow/pgflow%40${VERSION}/pkgs/core/schemas"

# Create combined schema
echo "-- pgflow v${VERSION} Schema" > tests/fixtures/pgflow/schema-v${VERSION}.sql
echo "-- Source: https://github.com/pgflow-dev/pgflow/tree/pgflow@${VERSION}/pkgs/core/schemas/" >> tests/fixtures/pgflow/schema-v${VERSION}.sql

FILES=(
  0010_extensions.sql
  0020_schemas.sql
  0030_utilities.sql
  0040_types.sql
  0050_tables_definitions.sql
  0055_tables_workers.sql
  0060_tables_runtime.sql
  0090_function_poll_for_tasks.sql
  0100_function_add_step.sql
  0100_function_cascade_complete_taskless_steps.sql
  0100_function_complete_task.sql
  0100_function_create_flow.sql
  0100_function_fail_task.sql
  0100_function_maybe_complete_run.sql
  0100_function_start_flow.sql
  0100_function_start_ready_steps.sql
  0105_function_get_run_with_states.sql
  0110_function_set_vt_batch.sql
  0110_function_start_flow_with_states.sql
  0120_function_start_tasks.sql
  0200_grants_and_revokes.sql
)

for file in "${FILES[@]}"; do
  echo -e "\n-- ============================================================================" >> tests/fixtures/pgflow/schema-v${VERSION}.sql
  echo "-- Source: ${file}" >> tests/fixtures/pgflow/schema-v${VERSION}.sql
  echo -e "-- ============================================================================\n" >> tests/fixtures/pgflow/schema-v${VERSION}.sql
  curl -sS "${BASE_URL}/${file}" >> tests/fixtures/pgflow/schema-v${VERSION}.sql
done
```

### 3. Update References

Update these files:

1. **`tests/fixtures/pgflow/install.ts`**:
   - Update `PGFLOW_VERSION` constant
   - Update schema file path if version changed

2. **`scripts/extensions/manifest-data.ts`**:
   - Update `tag: "pgflow@X.Y.Z"`

3. **`examples/pgflow/10-pgflow.sql`**:
   - Copy new schema for documentation

4. **npm packages** (if using):
   ```bash
   bun add -d @pgflow/dsl@X.Y.Z @pgflow/client@X.Y.Z
   ```

### 4. Run Tests

```bash
# Validate schema completeness
bun scripts/test/test-pgflow-schema.ts --image=aza-pg:latest

# Full functional tests
bun scripts/test/test-pgflow-v081.ts --image=aza-pg:latest

# Multi-project isolation
bun scripts/test/test-pgflow-multiproject.ts --image=aza-pg:latest
```

### 5. Update Documentation

- `docs/PGFLOW-SETUP.md` - Version compatibility table
- `tests/fixtures/pgflow/README.md` - Schema file list

### 6. Commit Changes

```bash
git add tests/fixtures/pgflow/ scripts/extensions/manifest-data.ts examples/pgflow/
git commit -m "feat(pgflow): update test schema to v${VERSION}

Update pgflow test fixtures to v${VERSION}.

Changes:
- Download and combine 21 schema files from pgflow@${VERSION}
- Update manifest version reference
- Verify all tests pass

Source: https://github.com/pgflow-dev/pgflow/releases/tag/pgflow@${VERSION}

Co-Authored-By: Claude <noreply@anthropic.com>"
```

## Version Compatibility

| pgflow | pgmq Required | PostgreSQL | aza-pg Support |
| ------ | ------------- | ---------- | -------------- |
| 0.8.1  | 1.5.0+        | 17+        | ✅ Full        |
| 0.7.2  | 1.4.x         | 14+        | ⚠️ Legacy      |

## Breaking Changes Log

### v0.8.0 → v0.8.1

- Fixed Supabase CLI version requirement (2.50.3+)
- No schema changes

### v0.7.x → v0.8.0

- **BREAKING**: Requires pgmq 1.5.0+ (was 1.4.x)
- **BREAKING**: Requires PostgreSQL 17+ (was 14+)
- Added `step_type` column for map steps
- Added `task_index` for parallel processing
- Removed deprecated `read_with_poll()` function

## Maintenance Notes

**Last Updated**: 2025-11-26
**Current Version**: v0.8.1
**Schema Location**: `tests/fixtures/pgflow/schema-v0.8.1.sql`

## Resources

- [pgflow Documentation](https://pgflow.dev)
- [pgflow GitHub](https://github.com/pgflow-dev/pgflow)
- [pgflow Schemas](https://github.com/pgflow-dev/pgflow/tree/main/pkgs/core/schemas)
- [Installation Guide](./PGFLOW-SETUP.md)
