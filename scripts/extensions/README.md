# Extension Manifest Validation

## Overview

The `validate-manifest.ts` script performs comprehensive validation of `docker/postgres/extensions.manifest.json` to ensure consistency across the codebase.

## Validations

### 1. Count Validation

Ensures the manifest contains exactly:

- **Total catalog entries**: 38 extensions (37 enabled by default, 1 disabled)
- **Builtin**: 6 (PostgreSQL core extensions)
- **PGDG**: 14 (pre-compiled from apt.postgresql.org)
- **Compiled**: 18 (built from source)

### 2. defaultEnable Consistency

For extensions with `runtime.defaultEnable=true`, verifies they are either:

- Listed in `01-extensions.sql` baseline (CREATE EXTENSION statements), OR
- Included in `DEFAULT_SHARED_PRELOAD_LIBRARIES` in `docker-auto-config-entrypoint.sh`

**Special case**: `plpgsql` is always available and doesn't require explicit creation.

### 3. PGDG Consistency

For all extensions with `install_via: "pgdg"`, verifies:

- Corresponding `postgresql-${PG_MAJOR}-<name>=<version>` entry exists in Dockerfile
- Package name mappings are handled (e.g., `vector` → `pgvector`)

### 4. Runtime Spec Completeness

Warns if `kind: "tool"` entries are missing `runtime` object.

### 5. Dependency Validation

Ensures all `dependencies` reference valid extension names in the manifest.

## Usage

### Standalone

```bash
bun run scripts/extensions/validate-manifest.ts
```

### Integrated in Build

The script automatically runs as a preflight check in `scripts/build.sh`:

```bash
./scripts/build.sh  # Validation runs before Docker build
```

## Exit Codes

- **0**: Validation passed (or passed with warnings only)
- **1**: Validation failed with errors

## Output Format

```
=== MANIFEST VALIDATION ===

[COUNT VALIDATION]
  Total extensions: 38 (expected: 38)
  Builtin: 6 (expected: 6)
  PGDG: 14 (expected: 14)
  Compiled: 18 (expected: 18)

[DEFAULT ENABLE VALIDATION]
  Baseline extensions in 01-extensions.sql: pg_stat_statements, pg_trgm, pgaudit, pg_cron, vector
  Default preload libraries: pg_stat_statements, auto_explain, pg_cron, pgaudit

[PGDG CONSISTENCY VALIDATION]
  PGDG packages in Dockerfile: cron, pgaudit, pgvector, ...

[RUNTIME SPEC VALIDATION]

[DEPENDENCY VALIDATION]

=== VALIDATION RESULTS ===

✅ Manifest validation passed (38 total catalog entries, 37 enabled: 6 builtin + 14 PGDG + 18 compiled)
```

## Error Examples

### Count Mismatch

```
ERROR: Total extension count mismatch: got 37, expected 38
```

### defaultEnable Inconsistency

```
ERROR: Extension 'foo' has defaultEnable=true but is NOT in 01-extensions.sql baseline
       OR DEFAULT_SHARED_PRELOAD_LIBRARIES
```

### PGDG Missing

```
ERROR: Extension 'bar' has install_via="pgdg" but is NOT installed in Dockerfile
       (expected package: postgresql-${PG_MAJOR}-bar)
```

### Invalid Dependency

```
ERROR: Extension 'baz' has dependency on 'missing_ext' which does NOT exist in manifest
```

## Maintenance

### Updating Expected Counts

If you add/remove extensions, update `EXPECTED_COUNTS` in `validate-manifest.ts`:

```typescript
const EXPECTED_COUNTS = {
  total: 38, // Total extensions
  builtin: 6, // kind: "builtin"
  pgdg: 14, // install_via: "pgdg"
  compiled: 18, // Source-built (neither builtin nor PGDG)
};
```

### Adding New Validations

Add new validation functions following the pattern:

```typescript
function validateNewCheck(manifest: Manifest): void {
  console.log(`\n${colors.blue}[NEW CHECK VALIDATION]${colors.reset}`);

  for (const entry of manifest.entries) {
    // Validation logic
    if (somethingWrong) {
      error(`Extension '${entry.name}' has issue...`);
    }
  }
}

// Add to main():
validateCounts(manifest);
validateDefaultEnable(manifest);
validatePgdgConsistency(manifest);
validateRuntimeSpec(manifest);
validateDependencies(manifest);
validateNewCheck(manifest); // Add here
```

## Package Name Mappings

Some extensions have different Dockerfile package names:

| Manifest Name   | Dockerfile Package                     |
| --------------- | -------------------------------------- |
| `vector`        | `postgresql-${PG_MAJOR}-pgvector`      |
| `postgis`       | `postgresql-${PG_MAJOR}-postgis-3`     |
| `pg_partman`    | `postgresql-${PG_MAJOR}-partman`       |
| `plpgsql_check` | `postgresql-${PG_MAJOR}-plpgsql-check` |
| `pg_repack`     | `postgresql-${PG_MAJOR}-repack`        |
| `pgrouting`     | `postgresql-${PG_MAJOR}-pgrouting`     |
| `set_user`      | `postgresql-${PG_MAJOR}-set-user`      |
| `pg_cron`       | `postgresql-${PG_MAJOR}-cron`          |

These mappings are defined in `getDockerfilePackageName()` function.

## Integration Points

The validator cross-references:

1. **Manifest**: `docker/postgres/extensions.manifest.json`
2. **Dockerfile**: `docker/postgres/Dockerfile` (PGDG packages)
3. **Init SQL**: `docker/postgres/docker-entrypoint-initdb.d/01-extensions.sql` (baseline extensions)
4. **Entrypoint**: `docker/postgres/docker-auto-config-entrypoint.sh` (preload libraries)

## Troubleshooting

### Validation Fails During Build

```bash
# Run standalone to see detailed error messages
bun run scripts/extensions/validate-manifest.ts

# Check exit code
echo $?  # 0 = success, 1 = failure
```

### Bun Not Installed

```bash
# Install Bun (https://bun.sh)
curl -fsSL https://bun.sh/install | bash

# Or use Node.js with tsx
npx tsx scripts/extensions/validate-manifest.ts
```

### False Positives

If validation fails incorrectly:

1. Check package name mappings in `getDockerfilePackageName()`
2. Verify baseline extension list parsing regex
3. Check for case sensitivity issues (manifest uses lowercase, SQL might differ)

## Design Decisions

### Why TypeScript/Bun?

- Type safety for manifest structure
- Fast execution (Bun native JSON parsing)
- Consistent with config-generator tooling

### Why Preflight vs Post-Build?

- Catch errors BEFORE 12-minute Docker build
- Immediate feedback loop
- Prevents CI/CD failures late in pipeline

### Why Not JSON Schema?

- Need cross-file validation (Dockerfile, SQL, entrypoint)
- Custom logic for package name mappings
- Detailed error messages with context

## Future Enhancements

Potential improvements:

- [ ] Validate extension version consistency (ARG vs manifest)
- [ ] Check for SHA256 commit hash format
- [ ] Verify build type compatibility (cargo-pgrx vs pgxs)
- [ ] Lint SQL in init scripts
- [ ] Auto-generate Dockerfile extension install block from manifest
