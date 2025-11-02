# Logical Replication Guide

Logical replication in PostgreSQL 18 - selective, flexible, multi-directional data sync.

## What is Logical Replication?

**Logical Replication:** Table-level replication using logical decoding of WAL. Replicates INSERT/UPDATE/DELETE operations as SQL statements.

**Physical Replication:** Block-level replication using WAL shipping. Replicates exact byte-for-byte copies of entire database cluster.

### Key Differences

| Feature | Logical | Physical |
|---------|---------|----------|
| **Granularity** | Table/schema level | Cluster-wide |
| **Direction** | Multi-directional | One-way (primary → replica) |
| **PostgreSQL versions** | Can differ | Must match major version |
| **DDL replication** | No (manual sync needed) | Yes |
| **Partial replication** | Yes (specific tables/columns) | No |
| **Write to replica** | Yes | No (read-only) |
| **Use cases** | Multi-region, migrations, partial sync | HA, disaster recovery, read scaling |
| **Performance overhead** | Higher CPU (logical decoding) | Lower (binary WAL) |

## Use Cases

1. **Multi-Region Deployments:** Replicate specific tables to regional databases (e.g., user table to all regions, orders table to origin region only)

2. **Database Migrations:** Replicate from old database to new (different major version, different schema structure, gradual cutover)

3. **Data Warehousing:** Replicate transactional tables to analytics database (filter sensitive columns, aggregate data)

4. **Microservices Data Sync:** Share specific tables between services (e.g., users table replicated to auth service and billing service)

5. **Bi-Directional Sync:** Two primaries with conflict resolution (advanced, requires careful design)

6. **Zero-Downtime Upgrades:** Replicate to new major version → switch over → no downtime

## Prerequisites

### On Publisher (Source)

```sql
-- Enable logical replication
ALTER SYSTEM SET wal_level = 'logical';
ALTER SYSTEM SET max_replication_slots = 10;  -- Default: 10, increase if needed
ALTER SYSTEM SET max_wal_senders = 10;        -- Default: 10

-- Restart required for wal_level change
-- docker compose restart postgres
```

Or in `postgresql.conf`:

```ini
wal_level = logical                  # Default in aza-pg: replica (change to logical)
max_replication_slots = 10           # Default: 10
max_wal_senders = 10                 # Default: 10
```

### On Subscriber (Destination)

```sql
-- Enable subscription workers
ALTER SYSTEM SET max_logical_replication_workers = 8;  -- Default: 4
ALTER SYSTEM SET max_worker_processes = 16;            -- Default: 8 (increase if needed)

-- Restart required
-- docker compose restart postgres
```

## Setting Up Logical Replication

### Step 1: Create Publication (Publisher)

A **publication** defines which tables to replicate.

```sql
-- Connect to publisher database
\c publisher_db

-- Create publication for specific tables
CREATE PUBLICATION my_publication FOR TABLE users, orders;

-- Or for all tables in database
CREATE PUBLICATION my_publication FOR ALL TABLES;

-- Or for specific columns only (PostgreSQL 15+)
CREATE PUBLICATION sensitive_data FOR TABLE users (id, email, created_at);  -- Excludes password column

-- Or for tables matching pattern (PostgreSQL 15+)
CREATE PUBLICATION analytics_pub FOR TABLES IN SCHEMA public;

-- Verify publication
SELECT * FROM pg_publication;

-- List published tables
SELECT * FROM pg_publication_tables WHERE pubname = 'my_publication';
```

**Publication Options:**

```sql
-- Default: replicate INSERT, UPDATE, DELETE (not TRUNCATE)
CREATE PUBLICATION my_pub FOR TABLE users;

-- Replicate only specific operations
CREATE PUBLICATION my_pub FOR TABLE users WITH (publish = 'insert, update');

-- Include TRUNCATE (careful: removes all data on subscriber)
CREATE PUBLICATION my_pub FOR TABLE users WITH (publish = 'insert, update, delete, truncate');
```

### Step 2: Create Replication User (Publisher)

```sql
-- Create user with replication privilege
CREATE ROLE logical_replicator WITH REPLICATION LOGIN PASSWORD 'secure_password';

-- Grant read access to published tables
GRANT SELECT ON users, orders TO logical_replicator;

-- Or grant on entire schema
GRANT SELECT ON ALL TABLES IN SCHEMA public TO logical_replicator;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO logical_replicator;
```

### Step 3: Configure pg_hba.conf (Publisher)

Allow subscriber to connect for replication:

```conf
# TYPE  DATABASE        USER                ADDRESS                 METHOD
host    publisher_db    logical_replicator  10.0.0.0/8              scram-sha-256
host    publisher_db    logical_replicator  172.16.0.0/12           scram-sha-256
```

Reload configuration:

```bash
docker exec postgres-primary psql -U postgres -c "SELECT pg_reload_conf();"
```

### Step 4: Create Table Schema (Subscriber)

**CRITICAL:** Table schema must exist on subscriber before creating subscription.

```sql
-- Connect to subscriber database
\c subscriber_db

-- Create tables with SAME schema as publisher
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    amount DECIMAL(10,2),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes/constraints can differ, but column names/types must match
```

### Step 5: Create Subscription (Subscriber)

A **subscription** connects to publication and starts replication.

```sql
-- Connect to subscriber database
\c subscriber_db

-- Create subscription
CREATE SUBSCRIPTION my_subscription
    CONNECTION 'host=publisher-host port=5432 dbname=publisher_db user=logical_replicator password=secure_password'
    PUBLICATION my_publication;

-- Verify subscription
SELECT * FROM pg_subscription;

-- Check replication status
SELECT * FROM pg_stat_subscription;
```

**Subscription Options:**

```sql
-- Default: copy existing data + replicate changes
CREATE SUBSCRIPTION my_sub
    CONNECTION 'host=publisher port=5432 dbname=publisher_db user=logical_replicator password=pass'
    PUBLICATION my_pub;

-- Skip initial data copy (only replicate new changes)
CREATE SUBSCRIPTION my_sub
    CONNECTION 'host=publisher port=5432 dbname=publisher_db user=logical_replicator password=pass'
    PUBLICATION my_pub
    WITH (copy_data = false);

-- Disable subscription initially (enable later)
CREATE SUBSCRIPTION my_sub
    CONNECTION 'host=publisher port=5432 dbname=publisher_db user=logical_replicator password=pass'
    PUBLICATION my_pub
    WITH (enabled = false);

-- Enable disabled subscription
ALTER SUBSCRIPTION my_sub ENABLE;
```

## Managing Logical Replication

### Monitor Replication Lag

```sql
-- On subscriber
SELECT
    subname,
    received_lsn,
    latest_end_lsn,
    latest_end_time,
    NOW() - latest_end_time AS lag
FROM pg_stat_subscription;

-- On publisher
SELECT
    slot_name,
    database,
    active,
    pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
FROM pg_replication_slots
WHERE slot_type = 'logical';
```

### Add Table to Existing Publication

```sql
-- On publisher
ALTER PUBLICATION my_publication ADD TABLE new_table;

-- On subscriber, refresh subscription to pick up new table
ALTER SUBSCRIPTION my_subscription REFRESH PUBLICATION;
```

### Remove Table from Publication

```sql
-- On publisher
ALTER PUBLICATION my_publication DROP TABLE old_table;

-- On subscriber
ALTER SUBSCRIPTION my_subscription REFRESH PUBLICATION;
```

### Disable/Enable Subscription

```sql
-- Stop replication (keep subscription definition)
ALTER SUBSCRIPTION my_subscription DISABLE;

-- Resume replication
ALTER SUBSCRIPTION my_subscription ENABLE;

-- Refresh subscription (re-sync table list from publication)
ALTER SUBSCRIPTION my_subscription REFRESH PUBLICATION;
```

### Drop Subscription

```sql
-- On subscriber (will also drop replication slot on publisher)
DROP SUBSCRIPTION my_subscription;

-- If publisher is unreachable, drop without cleanup
ALTER SUBSCRIPTION my_subscription SET (slot_name = NONE);
DROP SUBSCRIPTION my_subscription;

-- Then manually drop slot on publisher
SELECT pg_drop_replication_slot('my_subscription');
```

### Drop Publication

```sql
-- On publisher (ensure no subscriptions exist first)
DROP PUBLICATION my_publication;
```

## Example Configurations

### Example 1: Multi-Region User Replication

**Scenario:** Replicate users table to all regions, orders table only to origin region.

**Publisher (US Region):**

```sql
-- Create publication for users (global)
CREATE PUBLICATION global_users FOR TABLE users;

-- Create publication for orders (US only, not replicated)
CREATE PUBLICATION us_orders FOR TABLE orders;
```

**Subscriber (EU Region):**

```sql
-- Replicate only users table
CREATE SUBSCRIPTION eu_users_sub
    CONNECTION 'host=us-publisher port=5432 dbname=app user=logical_replicator password=pass'
    PUBLICATION global_users;
```

**Subscriber (APAC Region):**

```sql
-- Replicate only users table
CREATE SUBSCRIPTION apac_users_sub
    CONNECTION 'host=us-publisher port=5432 dbname=app user=logical_replicator password=pass'
    PUBLICATION global_users;
```

### Example 2: Sensitive Data Filtering

**Scenario:** Replicate users table to analytics DB, but exclude password column.

**Publisher:**

```sql
-- Create publication with specific columns only (PostgreSQL 15+)
CREATE PUBLICATION analytics_pub FOR TABLE users (id, email, created_at, country);
-- Excludes: password_hash, ssn, credit_card
```

**Subscriber (Analytics DB):**

```sql
-- Create table with only public columns
CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email VARCHAR(255),
    created_at TIMESTAMP,
    country VARCHAR(2)
);

CREATE SUBSCRIPTION analytics_sub
    CONNECTION 'host=prod-db port=5432 dbname=app user=logical_replicator password=pass'
    PUBLICATION analytics_pub;
```

### Example 3: Database Migration (PostgreSQL 15 → 18)

**Scenario:** Migrate from PostgreSQL 15 to 18 with zero downtime.

**Source (PostgreSQL 15):**

```sql
-- Enable logical replication
ALTER SYSTEM SET wal_level = 'logical';
-- Restart required

-- Create publication
CREATE PUBLICATION migration_pub FOR ALL TABLES;

-- Create replication user
CREATE ROLE migrator WITH REPLICATION LOGIN PASSWORD 'migrate_pass';
GRANT SELECT ON ALL TABLES IN SCHEMA public TO migrator;
```

**Destination (PostgreSQL 18 - aza-pg):**

```sql
-- Create schema (use pg_dump from source)
-- pg_dump -h source -U postgres -s app_db | psql -h dest -U postgres app_db

-- Create subscription (disable initial copy if restoring from backup)
CREATE SUBSCRIPTION migration_sub
    CONNECTION 'host=pg15-source port=5432 dbname=app_db user=migrator password=migrate_pass'
    PUBLICATION migration_pub
    WITH (copy_data = true);  -- Set false if using pg_restore

-- Monitor lag
SELECT NOW() - latest_end_time AS lag FROM pg_stat_subscription;

-- When lag < 1 second, switch application to new database
-- Then drop subscription
DROP SUBSCRIPTION migration_sub;
```

### Example 4: Bi-Directional Replication (Advanced)

**Scenario:** Two primaries with conflict resolution (last-write-wins).

**CAUTION:** Requires careful design. No built-in conflict resolution in PostgreSQL. Consider using BDR or Citus for production bi-directional sync.

**Database A:**

```sql
-- Create publication
CREATE PUBLICATION db_a_pub FOR TABLE shared_table;

-- Create subscription to Database B
CREATE SUBSCRIPTION db_a_sub
    CONNECTION 'host=db-b port=5432 dbname=app user=logical_replicator password=pass'
    PUBLICATION db_b_pub
    WITH (copy_data = false);  -- Avoid circular copy
```

**Database B:**

```sql
-- Create publication
CREATE PUBLICATION db_b_pub FOR TABLE shared_table;

-- Create subscription to Database A
CREATE SUBSCRIPTION db_b_sub
    CONNECTION 'host=db-a port=5432 dbname=app user=logical_replicator password=pass'
    PUBLICATION db_a_pub
    WITH (copy_data = false);  -- Avoid circular copy
```

**Conflict Resolution (Manual):**

```sql
-- Enable timestamp-based conflict resolution
ALTER TABLE shared_table ADD COLUMN updated_at TIMESTAMP DEFAULT NOW();

-- On each database, create trigger to update timestamp
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_timestamp_trigger
    BEFORE UPDATE ON shared_table
    FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- PostgreSQL will use newer timestamp in case of conflict (origin_lsn comparison)
```

## DDL Changes (Schema Evolution)

**CRITICAL:** Logical replication does NOT replicate DDL changes (ALTER TABLE, CREATE INDEX, etc.).

### Manual DDL Sync Workflow

1. **Apply DDL to subscriber first** (backward compatible change)
2. **Apply DDL to publisher**
3. **Refresh subscription** (if table structure changed)

**Example: Adding Column:**

```sql
-- Step 1: Subscriber (add column with default)
ALTER TABLE users ADD COLUMN phone VARCHAR(20) DEFAULT '';

-- Step 2: Publisher (add column)
ALTER TABLE users ADD COLUMN phone VARCHAR(20) DEFAULT '';

-- Step 3: Refresh subscription (optional, if column is in publication)
ALTER SUBSCRIPTION my_sub REFRESH PUBLICATION;
```

**Example: Removing Column:**

```sql
-- Step 1: Publisher (stop sending column in publication)
ALTER PUBLICATION my_pub SET TABLE users (id, email);  -- Exclude phone

-- Step 2: Subscriber (drop column)
ALTER TABLE users DROP COLUMN phone;

-- Step 3: Publisher (drop column)
ALTER TABLE users DROP COLUMN phone;

-- Step 4: Publisher (restore full publication)
ALTER PUBLICATION my_pub SET TABLE users;  -- All columns again
```

## Performance Tuning

### Publisher Optimization

```sql
-- Increase replication slots (if many subscribers)
ALTER SYSTEM SET max_replication_slots = 20;

-- Increase WAL senders
ALTER SYSTEM SET max_wal_senders = 20;

-- Tune WAL retention (prevent slot disk bloat)
ALTER SYSTEM SET max_slot_wal_keep_size = '10GB';  -- PostgreSQL 13+
ALTER SYSTEM SET wal_keep_size = '1GB';            -- Minimum WAL retention

-- Monitor slot disk usage
SELECT slot_name, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
FROM pg_replication_slots
WHERE slot_type = 'logical';
```

### Subscriber Optimization

```sql
-- Increase parallel apply workers (PostgreSQL 16+)
ALTER SYSTEM SET max_parallel_apply_workers_per_subscription = 4;

-- Increase logical replication workers
ALTER SYSTEM SET max_logical_replication_workers = 16;

-- Increase worker processes (must be > total workers needed)
ALTER SYSTEM SET max_worker_processes = 32;

-- Disable synchronous commit on subscriber (faster, small data loss risk)
ALTER SUBSCRIPTION my_sub SET (synchronous_commit = 'off');
```

### Network Tuning

```sql
-- Enable streaming of large transactions (PostgreSQL 14+)
CREATE SUBSCRIPTION my_sub
    CONNECTION 'host=publisher port=5432 dbname=app user=logical_replicator password=pass'
    PUBLICATION my_pub
    WITH (streaming = on);  -- Stream large transactions in chunks

-- Binary transfer mode (faster, same architecture required)
CREATE SUBSCRIPTION my_sub
    CONNECTION 'host=publisher port=5432 dbname=app user=logical_replicator password=pass'
    PUBLICATION my_pub
    WITH (binary = true);
```

## Troubleshooting

### Subscription Not Syncing

```sql
-- Check subscription status
SELECT subname, subenabled, pid, received_lsn, latest_end_lsn
FROM pg_stat_subscription;

-- Check subscription errors
SELECT * FROM pg_stat_subscription WHERE last_msg_send_time IS NULL;

-- Check worker logs
-- docker compose logs postgres | grep "logical replication"

-- Restart subscription worker
ALTER SUBSCRIPTION my_sub DISABLE;
ALTER SUBSCRIPTION my_sub ENABLE;
```

### Replication Lag

```sql
-- Check lag on subscriber
SELECT subname, NOW() - latest_end_time AS lag
FROM pg_stat_subscription;

-- Check slow queries on subscriber
SELECT pid, query, state, wait_event
FROM pg_stat_activity
WHERE backend_type = 'logical replication worker';

-- Increase workers (if bottleneck is parallelism)
ALTER SYSTEM SET max_logical_replication_workers = 16;
SELECT pg_reload_conf();
```

### WAL Disk Bloat (Publisher)

```sql
-- Check retained WAL size
SELECT slot_name, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
FROM pg_replication_slots
WHERE slot_type = 'logical';

-- Find inactive slots (orphaned from deleted subscriptions)
SELECT slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
FROM pg_replication_slots
WHERE slot_type = 'logical' AND active = false;

-- Drop inactive slot
SELECT pg_drop_replication_slot('inactive_slot_name');

-- Set WAL retention limit (prevents disk full)
ALTER SYSTEM SET max_slot_wal_keep_size = '10GB';
SELECT pg_reload_conf();
```

### Conflict Resolution

**Row-level conflicts (UPDATE/DELETE on non-existent row):**

```sql
-- Check logs for conflict errors
-- docker compose logs postgres | grep "conflict"

-- Default behavior: Skip conflicting row and continue
-- To stop on conflict:
ALTER SUBSCRIPTION my_sub SET (disable_on_error = true);

-- To resolve: Manually sync conflicting rows
-- Then re-enable subscription
ALTER SUBSCRIPTION my_sub ENABLE;
```

## Best Practices

1. **Match table schemas exactly** - Column names, types, and order must match
2. **Create indexes on subscriber** - Replication only replicates data, not indexes
3. **Monitor replication lag** - Alert if lag > 60 seconds
4. **Set max_slot_wal_keep_size** - Prevent disk full from WAL retention
5. **Use streaming mode** - For large transactions (PostgreSQL 14+)
6. **Test DDL changes** - Manual sync required for schema changes
7. **Use publication for subsets** - Don't replicate tables you don't need
8. **Monitor worker processes** - Ensure max_worker_processes > total workers
9. **Backup before dropping subscriptions** - Replication slots are deleted
10. **Use binary mode** - If architectures match (faster transfer)

## Limitations

- **No DDL replication** - Schema changes must be manually synced
- **No sequence replication** - Sequences must be manually synced (use `uuid` PKs for multi-primary)
- **No large object replication** - BLOB/large objects not supported
- **No TRUNCATE replication** - Unless explicitly enabled in publication
- **No temporary table replication** - Only permanent tables
- **No partition root replication** - Must replicate partitions individually (PostgreSQL 13+)
- **Conflict resolution is manual** - No built-in conflict handling (use BDR for production bi-directional)

## Security Considerations

1. **Use strong passwords** - Replication users have read access to all published tables
2. **Limit network access** - pg_hba.conf should restrict by IP
3. **Use SSL/TLS** - Encrypt replication traffic in production
4. **Grant minimal permissions** - Only SELECT on published tables
5. **Monitor replication slots** - Orphaned slots can fill disk
6. **Audit published tables** - Ensure no sensitive data is accidentally replicated
7. **Use column filtering** - Exclude sensitive columns from publications (PostgreSQL 15+)

## Further Reading

- [PostgreSQL Logical Replication Docs](https://www.postgresql.org/docs/18/logical-replication.html)
- [PostgreSQL Publications](https://www.postgresql.org/docs/18/sql-createpublication.html)
- [PostgreSQL Subscriptions](https://www.postgresql.org/docs/18/sql-createsubscription.html)
- [Monitoring Logical Replication](https://www.postgresql.org/docs/18/monitoring-stats.html#MONITORING-PG-STAT-SUBSCRIPTION-VIEW)
- [BDR (Bi-Directional Replication)](https://www.enterprisedb.com/docs/bdr/latest/) - Production-grade bi-directional sync
