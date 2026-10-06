# TimescaleDB TSL Build Configuration

## Overview

This document explains why the aza-pg image ships TimescaleDB with its Timescale License (TSL) features, and how to check them.

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

## How the Image Gets TSL

The image installs TimescaleDB from Timescale's apt repository (`install_via: "timescale"` on the `timescaledb` entry of `scripts/extensions/manifest-data.ts`). The `timescaledb-2-postgresql-18` package is the full build, so it includes the TSL module; nothing is compiled from source.

**Rationale**:

1. **Feature completeness**: Compression and continuous aggregates are core time-series capabilities
2. **Free for our use case**: Self-hosted deployment falls under TSL's free tier
3. **Storage efficiency**: Compression can achieve 10-20x storage reduction for time-series data
4. **Query performance**: Continuous aggregates enable real-time analytics without expensive recomputation
5. **Industry standard**: Most TimescaleDB users expect these features to be available

## Verification

### Testing TSL Features

`scripts/test/test-timescaledb-tsl.ts` (suite group `extensions`) proves the image ships the TSL module: it compresses chunks, refreshes a continuous aggregate over them and compares its rows with the same aggregate computed directly; any error, including a license error, fails it.

```bash
bun scripts/test/test-timescaledb-tsl.ts [image]
```

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

## Apache-Only Image

An image without TSL code needs a TimescaleDB built with `-DAPACHE_ONLY=ON` in place of the package above; it loses compression, continuous aggregates, retention policies and reordering.

## References

- [TimescaleDB Licensing](https://www.timescale.com/legal/licenses)
- [TSL License Text](https://github.com/timescale/timescaledb/blob/main/tsl/LICENSE-TIMESCALE)
- [Compression Documentation](https://docs.timescale.com/use-timescale/latest/compression/)
- [Continuous Aggregates Documentation](https://docs.timescale.com/use-timescale/latest/continuous-aggregates/)
- [TimescaleDB GitHub Issues on APACHE_ONLY](https://github.com/timescale/timescaledb/issues?q=APACHE_ONLY)
