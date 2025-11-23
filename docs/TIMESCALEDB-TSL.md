# TimescaleDB TSL Build Configuration

## Overview

This document explains the TimescaleDB Timescale License (TSL) build configuration in aza-pg and why it's enabled.

## What is TSL?

TimescaleDB has a dual-license structure:

1. **Apache 2.0 License**: Core hypertable functionality (open source)
2. **Timescale License (TSL)**: Additional enterprise features including:
   - **Compression**: Columnar compression for reduced storage and faster analytics
   - **Continuous Aggregates**: Materialized views that automatically refresh
   - **Data retention policies**: Automated chunk dropping
   - **Reordering**: Optimize chunk ordering for query performance

## TSL Licensing Terms

**TSL is FREE for self-hosted use**, including:

- Self-hosted production deployments
- Self-hosted SaaS applications
- Internal/private use

TSL only requires a commercial license for:

- Offering TimescaleDB as a managed cloud service to external customers
- Competing directly with Timescale's cloud offerings

Reference: [Timescale License](https://github.com/timescale/timescaledb/blob/main/tsl/LICENSE-TIMESCALE)

## Build Configuration

### CMake Flag: APACHE_ONLY

TimescaleDB uses the `APACHE_ONLY` CMake flag to control TSL inclusion:

- `APACHE_ONLY=ON`: Builds only Apache-licensed core (no compression, no continuous aggregates)
- `APACHE_ONLY=OFF` (default): Builds full TimescaleDB with TSL features

### Our Configuration

**File**: `docker/postgres/build-extensions.ts` (line 333)

```typescript
await $`cd ${dir} && ./bootstrap -DAPACHE_ONLY=OFF -DREGRESS_CHECKS=OFF -DGENERATE_DOWNGRADE_SCRIPT=ON`;
```

**Rationale**:

1. **Feature completeness**: Compression and continuous aggregates are core time-series capabilities
2. **Free for our use case**: Self-hosted deployment falls under TSL's free tier
3. **Storage efficiency**: Compression can achieve 10-20x storage reduction for time-series data
4. **Query performance**: Continuous aggregates enable real-time analytics without expensive recomputation
5. **Industry standard**: Most TimescaleDB users expect these features to be available

## Verification

### Testing TSL Features

Use the provided test script to verify TSL features are available:

```bash
bun scripts/test/verify-timescaledb-tsl.ts
```

The script tests:

1. Extension loads successfully
2. Compression can be enabled on hypertables
3. Continuous aggregates can be created
4. License information (if available)

### Manual Verification

```sql
-- Create a test hypertable
CREATE TABLE test_metrics (
    time TIMESTAMPTZ NOT NULL,
    device_id TEXT,
    value DOUBLE PRECISION
);

SELECT create_hypertable('test_metrics', 'time');

-- Test compression (TSL feature)
ALTER TABLE test_metrics SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'device_id'
);

-- Test continuous aggregates (TSL feature)
CREATE MATERIALIZED VIEW test_cagg
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', time) AS bucket,
       device_id,
       AVG(value) AS avg_value
FROM test_metrics
GROUP BY bucket, device_id;

-- Cleanup
DROP MATERIALIZED VIEW test_cagg;
DROP TABLE test_metrics;
```

If these commands succeed, TSL is properly enabled.

## Build Architecture

### Source Code Organization

TimescaleDB repository structure:

```
timescaledb/
├── src/              # Apache-licensed core
│   ├── chunk.c
│   ├── hypertable.c
│   └── ...
└── tsl/              # Timescale-licensed features
    ├── src/
    │   ├── compression/
    │   ├── continuous_aggs/
    │   └── ...
    └── LICENSE-TIMESCALE
```

When `APACHE_ONLY=OFF`, the build system includes the `tsl/` directory, compiling both core and TSL features into a single extension.

### Build Process

1. **Bootstrap phase**: `./bootstrap -DAPACHE_ONLY=OFF` generates CMake configuration
2. **CMake configuration**: Includes `tsl/CMakeLists.txt` subdirectory
3. **Compilation**: Builds unified `timescaledb.so` with TSL features
4. **Installation**: Installs extension with full feature set

## Alternative: Apache-Only Build

If you need to build Apache-only (no TSL):

```typescript
// In build-extensions.ts:
await $`cd ${dir} && ./bootstrap -DAPACHE_ONLY=ON -DREGRESS_CHECKS=OFF -DGENERATE_DOWNGRADE_SCRIPT=ON`;
```

**Limitations**:

- No compression (columnar storage)
- No continuous aggregates
- No data retention policies
- No reordering
- No multi-node (distributed hypertables)

## References

- [TimescaleDB Licensing](https://www.timescale.com/legal/licenses)
- [TSL License Text](https://github.com/timescale/timescaledb/blob/main/tsl/LICENSE-TIMESCALE)
- [Compression Documentation](https://docs.timescale.com/use-timescale/latest/compression/)
- [Continuous Aggregates Documentation](https://docs.timescale.com/use-timescale/latest/continuous-aggregates/)
- [TimescaleDB GitHub Issues on APACHE_ONLY](https://github.com/timescale/timescaledb/issues?q=APACHE_ONLY)

## Change History

- **2025-11-23**: Explicitly set `-DAPACHE_ONLY=OFF` for clarity (was default behavior)
  - Added inline comments explaining TSL licensing
  - Created verification script
  - Documented build configuration rationale
