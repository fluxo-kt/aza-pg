# Grafana Dashboards for PostgreSQL

## Recommended Dashboards

### PostgreSQL Dashboard (community)

Import dashboard ID **9628** from Grafana.com:

- **Name**: PostgreSQL Database
- **ID**: 9628
- **URL**: https://grafana.com/grafana/dashboards/9628
- **Data Source**: Prometheus (postgres_exporter)
- **Features**: Connections, transactions, locks, replication, cache hit ratio

### Import Steps

1. Open Grafana → Dashboards → Import
2. Enter dashboard ID: `9628`
3. Select your Prometheus data source
4. Click "Import"

## Custom Panels to Add

### Connection Pool Status (PgBouncer)

```promql
# Active client connections
sum(pgbouncer_pools_client_active_connections) by (database)

# Server connections
sum(pgbouncer_pools_server_active_connections) by (database)

# Waiting clients
sum(pgbouncer_pools_client_waiting_connections) by (database)
```

### Replication Lag

This and the auto-config metrics below come from the custom queries in `docker/postgres/configs/postgres_exporter_queries.yaml`, which the stacks mount into postgres_exporter.

```promql
# Lag in seconds
pg_replication_lag_lag_seconds
```

### Dead Tuples Ratio

```promql
# Dead tuple percentage per table
(pg_stat_user_tables_n_dead_tup / (pg_stat_user_tables_n_live_tup + pg_stat_user_tables_n_dead_tup)) * 100
```

### Cache Hit Ratio

```promql
# Buffer cache hit ratio (should be >99%)
rate(pg_stat_database_blks_hit[5m]) / (rate(pg_stat_database_blks_hit[5m]) + rate(pg_stat_database_blks_read[5m])) * 100
```

### Auto-Config Detection

```promql
# Current shared_buffers setting
pg_memory_settings_value_bytes{ name="shared_buffers" } / 1024 / 1024

# Max connections
pg_connection_usage_max_conn
```

## Alternative Dashboards

- **ID 455**: Postgres Overview

## Data Source Configuration

Add Prometheus data source in Grafana:

```yaml
Name: Prometheus
Type: Prometheus
URL: http://prometheus:9090
Access: Server (default)
```

## Alerts

Configure alerts for:

- PostgreSQL instance down
- High connection count (>80% of max_connections)
- Replication lag >5 minutes
- Low cache hit ratio (<95%)
- Dead tuples accumulation

See `../prometheus/alerts.yml` for alert rules.
