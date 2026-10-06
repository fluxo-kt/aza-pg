# Regression Testing

How the extension regression suites run and how to maintain their expected outputs.

## Overview

Two suites check extension behaviour against the image:

- **Tier 2** (`scripts/test/test-extension-regression.ts`): each extension's SQL against its expected output.
- **Tier 3** (`scripts/test/test-extension-interactions.ts`): the executor-hook preloads all see the same statement.

Both suites run only extensions whose manifest entry is enabled; an `enabled: false` extension never runs, in either mode.

- **Production mode**: the image's own default preload list.
- **Regression mode**: the server starts with optional preload libraries added (each suite's header names its list).

## Quick Start

```bash
# Both suites in parallel, production mode (CI's regression lane)
bun scripts/test-all.ts --group regression

# One suite
bun scripts/test/test-extension-regression.ts    # Tier 2: extension SQL vs expected output
bun scripts/test/test-extension-interactions.ts  # Tier 3: extension interactions

# Regression mode (optional preloads added), as the nightly run does
bun scripts/test-all.ts --group nightly
```

Each suite takes `--mode=production|regression`; see [Test Mode Selection](#test-mode-selection).

## Test Modes

### Production Mode

Tests exact release image behavior: the container starts with the image's default preload list.

- Image: `aza-pg:pg18` by default (`DEFAULT_TEST_IMAGE` in `scripts/test/image-resolver.ts`); pass another as the first argument

**Use cases:**

- Pre-release validation
- CI/CD fast feedback
- Release candidate testing

**Activation:**

```bash
bun scripts/test-all.ts --group regression
```

### Regression Mode

Adds optional preload libraries to the default list; the set of extensions tested is the same as in production mode. It runs on the release image: the suite starts the server with `POSTGRES_SHARED_PRELOAD_LIBRARIES` set to the longer list.

**Activation:**

```bash
bun scripts/test-all.ts --group nightly
```

## Test Tiers

PostgreSQL's own regression suite is not run: the image copies PGDG's server binary unchanged, so no image defect could fail it.

### Tier 2: Extension Regression

Extension-specific functionality tests.

**Coverage:** every directory under `tests/regression/extensions/` whose manifest entry is not `enabled: false`; a directory matching no manifest entry fails the run. Writing and updating a test: [tests/regression/extensions/README.md](../tests/regression/extensions/README.md).

**Runner:** `scripts/test/test-extension-regression.ts`

**Usage:**

```bash
# Run all extension tests
bun scripts/test/test-extension-regression.ts

# Run specific extensions
bun scripts/test/test-extension-regression.ts --extensions=hll,pg_partman

# Generate expected outputs
bun scripts/test/test-extension-regression.ts --generate-expected

# Verbose mode
bun scripts/test/test-extension-regression.ts --verbose
```

**Test Structure:**

```
tests/regression/extensions/{extension}/
├── sql/
│   └── basic.sql           # Extension test SQL
└── expected/
    └── basic.out           # Expected output
```

### Tier 3: Extension Interaction Tests

pgaudit, pg_stat_statements and pg_stat_monitor each hook the executor and must call the previous hook; one that breaks the chain silently starves the others while every extension still loads. One tagged statement must therefore produce a pgaudit log line, a pg_stat_statements row and a pg_stat_monitor row in a server running the mode's full preload list.

**Runner:** `scripts/test/test-extension-interactions.ts`

**Usage:**

```bash
bun scripts/test/test-extension-interactions.ts [image] [--mode=production|regression]
```

## CI/CD Integration

The runner is `scripts/test-all.ts`, which owns which suites each group holds.

- **`regression` group** (production mode, release image): `ci.yml` on every push and PR, `publish.yml` before every release, and `regression-tests.yml` on demand against any image reference.
- **`nightly` group** (regression mode, release image): `nightly-regression.yml`, weekly.

## Test Mode Selection

Each suite takes its mode from `--mode=production|regression`, then the `TEST_MODE` environment variable of the process running the suite, else production (`detectTestMode` in `scripts/test/lib/test-mode.ts`).

## Test Output Normalization

Regression tests handle platform-specific output variations.

**Normalizations:**

- Line endings (CRLF → LF)
- psql connection headers and prompts
- Trailing whitespace and trailing empty lines
- Minor floating-point display variations

Data values, errors and row counts are never normalized, so a real difference still fails.

**Implementation:** `scripts/test/lib/output-normalizer.ts`

## Generating Expected Outputs

Extension tests require expected output files for comparison.

**Generate for all extensions:**

```bash
bun scripts/test/test-extension-regression.ts --generate-expected
```

**Generate for specific extensions:**

```bash
bun scripts/test/test-extension-regression.ts --extensions=hll,pg_partman --generate-expected
```

**Process:**

1. Start production image container
2. Run extension test SQL
3. Capture normalized output
4. Write to `tests/regression/extensions/{ext}/expected/basic.out`

## Debugging Test Failures

### View Detailed Output

```bash
# Verbose mode
bun scripts/test/test-extension-regression.ts --verbose
```

### Test Locally

```bash
# Start container with test image
docker run --name pg-test -d -e POSTGRES_PASSWORD=postgres aza-pg:pg18

# Run one extension's SQL by hand (the files live in the repository, not the image)
docker exec -i pg-test psql -X -U postgres < tests/regression/extensions/hll/sql/basic.sql

# Or run the suite against the already-running container
bun scripts/test/test-extension-regression.ts --container=pg-test --extensions=hll --verbose

# Cleanup
docker rm -f -v pg-test
```

### Common Issues

**Extension not available:**

- Verify extension enabled in manifest
- Regenerate Dockerfile: `bun run generate`

**Output mismatch:**

- Platform-specific output (locale, timezone)
- Regenerate expected outputs: `--generate-expected`
- Check output normalizer coverage

**Container startup failure:**

- Check Docker resources (memory, CPU)
- Review container logs: `docker logs <container>`
- Verify image built correctly: `docker images | grep aza-pg`

## Best Practices

### Test Development

1. **Test isolation**: all files share one server's `postgres` database, so each creates uniquely named objects and drops them at the end
2. **Deterministic data**: Use fixed timestamps, sorted results
3. **No versions in expected output**: `scripts/test/test-extension-versions.ts` owns versions

### Maintenance

1. **Update expected outputs**: After PostgreSQL version upgrades
2. **Add new tests**: When adding extensions or features
3. **Review failures**: Investigate all regression test failures immediately
4. **Keep tests fast**: Optimize slow tests, use minimal data sets

## References

- [PostgreSQL Regression Tests](https://www.postgresql.org/docs/current/regress.html)
- [Testing Best Practices](https://wiki.postgresql.org/wiki/Testing)

## Architecture Decisions

### One Image for Both Modes

**Decision:** Regression mode runs on the release image; there is no separate regression image.

**Rationale:**

- The modes differ only in the preload list, which the suite sets when it starts the container
- A second Dockerfile copies the build and drifts from it, so it fails on its own defects instead of the release image's

### Dual-Mode Testing

**Decision:** Single test codebase adapts to production/regression modes.

**Rationale:**

- The mode changes only the preload list, so one suite covers both without duplicated assertions

### Two Test Tiers

**Decision:** Tier 2 (each extension's SQL against its expected output) and Tier 3 (extension interactions); no Tier 1, because the image copies PGDG's server binary unchanged, so no image defect could fail PostgreSQL's own suite.
