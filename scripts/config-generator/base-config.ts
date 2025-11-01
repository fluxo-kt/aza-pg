import type { BaseConfig } from "./types.js";

// ============================================================================
// I/O and Performance Constants
// ============================================================================

/**
 * PostgreSQL 18 async I/O combine limit for batching operations.
 * This setting controls how many I/O operations can be combined in a single batch.
 * Default: 128 (PostgreSQL 18+ feature for improved I/O performance on modern SSDs)
 */
const IO_COMBINE_LIMIT = 128;

/**
 * Effective I/O concurrency for SSD optimization.
 * Represents the number of concurrent disk I/O operations PostgreSQL should assume
 * the storage system can handle efficiently.
 * Default: 200 (optimized for modern NVMe SSDs with high IOPS capacity)
 */
const EFFECTIVE_IO_CONCURRENCY = 200;

/**
 * Random page cost for SSD optimization.
 * Ratio of random page access cost to sequential page access cost.
 * Default: 1.1 (near-sequential performance on SSDs, vs 4.0 default for HDDs)
 */
const RANDOM_PAGE_COST = 1.1;

/**
 * Checkpoint completion target.
 * Fraction of checkpoint interval to complete checkpoint writes.
 * Default: 0.9 (spread checkpoint I/O over 90% of interval to reduce I/O spikes)
 */
const CHECKPOINT_COMPLETION_TARGET = 0.9;

// ============================================================================
// Logging Constants
// ============================================================================

/**
 * Minimum query duration (in milliseconds) to log.
 * Queries taking longer than this threshold will be logged for analysis.
 * Default: 1000ms (1 second) - catches slow queries without excessive logging
 */
const LOG_MIN_DURATION_MS = 1000;

/**
 * Log temporary file size threshold (in bytes).
 * Log all temporary files created during query execution.
 * Default: 0 (log all temp files to track sort/hash operations spilling to disk)
 */
const LOG_TEMP_FILES_BYTES = 0;

/**
 * Log autovacuum minimum duration (in milliseconds).
 * Log all autovacuum operations to monitor vacuum performance.
 * Default: 0 (log all autovacuum runs to track maintenance operations)
 */
const LOG_AUTOVACUUM_MIN_DURATION_MS = 0;

// ============================================================================
// Extension Settings Constants
// ============================================================================

/**
 * Maximum number of statements tracked by pg_stat_statements extension.
 * This controls the size of the shared memory hash table for tracking query statistics.
 * Default: 10000 (sufficient for most workloads without excessive memory usage)
 */
const PG_STAT_STATEMENTS_MAX = 10000;

// ============================================================================
// Autovacuum Constants (SSD-Optimized)
// ============================================================================

/**
 * Autovacuum vacuum cost limit for aggressive SSD-optimized cleanup.
 * Higher values allow autovacuum to work more aggressively without throttling.
 * Default: 2000 (vs 200 default - SSDs can handle much higher I/O rates)
 */
const AUTOVACUUM_VACUUM_COST_LIMIT = 2000;

/**
 * Autovacuum freeze maximum age in transactions.
 * Maximum age (in transactions) before forcing a vacuum to prevent transaction ID wraparound.
 * Default: 200000000 (200M transactions - default PostgreSQL value for safety)
 */
const AUTOVACUUM_FREEZE_MAX_AGE = 200000000;

/**
 * Autovacuum vacuum scale factor.
 * Fraction of table size that triggers autovacuum when combined with threshold.
 * Default: 0.1 (10% of table - more aggressive than 20% default)
 */
const AUTOVACUUM_VACUUM_SCALE_FACTOR = 0.1;

/**
 * Autovacuum analyze scale factor.
 * Fraction of table size that triggers auto-analyze for statistics updates.
 * Default: 0.05 (5% of table - more aggressive than 10% default for fresher stats)
 */
const AUTOVACUUM_ANALYZE_SCALE_FACTOR = 0.05;

// ============================================================================
// Replication Constants
// ============================================================================

/**
 * Maximum WAL senders for primary server.
 * Number of concurrent connections allowed for streaming replication.
 * Default: 10 (supports multiple replicas and backup connections)
 */
const MAX_WAL_SENDERS_PRIMARY = 10;

/**
 * Maximum WAL senders for replica server.
 * Replicas may cascade to other replicas in complex topologies.
 * Default: 5 (fewer than primary, sufficient for cascading replication)
 */
const MAX_WAL_SENDERS_REPLICA = 5;

/**
 * Maximum replication slots for primary server.
 * Number of replication slots for guaranteed WAL retention.
 * Default: 10 (matches max_wal_senders for primary)
 */
const MAX_REPLICATION_SLOTS_PRIMARY = 10;

/**
 * Maximum replication slots for replica server.
 * Default: 5 (matches max_wal_senders for replica)
 */
const MAX_REPLICATION_SLOTS_REPLICA = 5;

/**
 * WAL sender timeout in seconds.
 * Terminate replication connections longer than this without client response.
 * Default: 60s (1 minute - detects failed replicas while allowing slow networks)
 */
const WAL_SENDER_TIMEOUT_SEC = "60s";

/**
 * WAL receiver status interval in seconds.
 * How often the standby sends information about replication progress to the primary.
 * Default: 10s (frequent updates for monitoring without excessive overhead)
 */
const WAL_RECEIVER_STATUS_INTERVAL_SEC = "10s";

// ============================================================================
// Hot Standby Constants
// ============================================================================

/**
 * Maximum standby archive delay in seconds.
 * Maximum delay before canceling queries when applying archived WAL conflicts with standby queries.
 * Default: 300s (5 minutes - balance between query completion and replication lag)
 */
const MAX_STANDBY_ARCHIVE_DELAY_SEC = "300s";

/**
 * Maximum standby streaming delay in seconds.
 * Maximum delay before canceling queries when applying streamed WAL conflicts with standby queries.
 * Default: 300s (5 minutes - balance between query completion and replication lag)
 */
const MAX_STANDBY_STREAMING_DELAY_SEC = "300s";

export const BASE_CONFIG: BaseConfig = {
  common: {
    // Connection Settings
    // Default to localhost for security - override in stack configs if network access needed
    listenAddresses: "127.0.0.1",
    port: 5432,
    // NOTE: shared_preload_libraries is intentionally omitted here.
    // It is set at runtime by docker-auto-config-entrypoint.sh via -c flag,
    // which allows dynamic configuration based on deployment needs.
    // Default preload list: pg_stat_statements,auto_explain,pg_cron,pgaudit
    // Override via: POSTGRES_SHARED_PRELOAD_LIBRARIES env var
    sharedPreloadLibraries: [],
    idleSessionTimeout: "0",

    // PostgreSQL 18 Async I/O
    ioMethod: "worker",
    ioCombineLimit: IO_COMBINE_LIMIT,

    // Logging
    logDestination: "stderr",
    loggingCollector: "off",
    logMinDurationStatement: LOG_MIN_DURATION_MS,
    logLinePrefix: "%t [%p]: [%l-1] user=%u,db=%d,app=%a,client=%h ",
    logLockWaits: "on",
    logTempFiles: LOG_TEMP_FILES_BYTES,
    logTimezone: "UTC",
    logCheckpoints: "on",
    logConnections: "on",
    logDisconnections: "on",
    logAutovacuumMinDuration: LOG_AUTOVACUUM_MIN_DURATION_MS,

    // Locale and Timezone
    timezone: "UTC",
    lcMessages: "en_US.utf8",
    lcMonetary: "en_US.utf8",
    lcNumeric: "en_US.utf8",
    lcTime: "en_US.utf8",
    defaultTextSearchConfig: "pg_catalog.english",

    // Extension settings
    pgStatStatementsMax: PG_STAT_STATEMENTS_MAX,
    pgStatStatementsTrack: "all",
    timescaledbTelemetryLevel: "off",

    // auto_explain
    autoExplainLogMinDuration: "3s",
    autoExplainLogAnalyze: "on",
    autoExplainLogBuffers: "on",
    autoExplainLogNestedStatements: "on",

    // Autovacuum (aggressive SSD-optimized)
    autovacuum: "on",
    autovacuumNaptime: "1min",
    autovacuumVacuumCostDelay: "2ms",
    autovacuumVacuumCostLimit: AUTOVACUUM_VACUUM_COST_LIMIT,
    autovacuumVacuumScaleFactor: AUTOVACUUM_VACUUM_SCALE_FACTOR,
    autovacuumAnalyzeScaleFactor: AUTOVACUUM_ANALYZE_SCALE_FACTOR,
    autovacuumFreezeMaxAge: AUTOVACUUM_FREEZE_MAX_AGE,

    // Checkpoints
    checkpointCompletionTarget: CHECKPOINT_COMPLETION_TARGET,

    // Query Planner (SSD optimizations)
    randomPageCost: RANDOM_PAGE_COST,
    effectiveIoConcurrency: EFFECTIVE_IO_CONCURRENCY,

    // WAL
    walLevel: "logical",
    walCompression: "lz4",
    maxWalSize: "2GB",
    minWalSize: "1GB",
  },

  stacks: {
    primary: {
      // WAL
      walLevel: "logical",

      // Replication
      maxWalSenders: MAX_WAL_SENDERS_PRIMARY,
      maxReplicationSlots: MAX_REPLICATION_SLOTS_PRIMARY,
      walKeepSize: "1GB",
      synchronousCommit: "on",
      synchronousStandbyNames: "",
      idleReplicationSlotTimeout: "48h",
      walSenderTimeout: WAL_SENDER_TIMEOUT_SEC,

      // WAL Archiving (commented in actual config)
      archiveMode: "off",
      archiveCommand: "",

      // pg_cron
      cronDatabaseName: "postgres",
      cronLogRun: "on",
      cronLogStatement: "on",

      // pgAudit
      pgAuditLog: "ddl,write,role",
      pgAuditLogStatementOnce: "on",
      pgAuditLogLevel: "log",
      pgAuditLogRelation: "on",
    },

    replica: {
      // WAL
      walLevel: "replica",

      // Hot Standby
      hotStandby: "on",
      maxStandbyArchiveDelay: MAX_STANDBY_ARCHIVE_DELAY_SEC,
      maxStandbyStreamingDelay: MAX_STANDBY_STREAMING_DELAY_SEC,
      hotStandbyFeedback: "on",
      walReceiverStatusInterval: WAL_RECEIVER_STATUS_INTERVAL_SEC,

      // Replication
      maxWalSenders: MAX_WAL_SENDERS_REPLICA,
      maxReplicationSlots: MAX_REPLICATION_SLOTS_REPLICA,

      // Logging
      logReplicationCommands: "on",

      // pg_cron (disabled on read-only replica)
      cronDatabaseName: "",

      // pgAudit (disabled on replica)
      pgAuditLog: "none",

      // auto_explain timing (disabled for performance)
      autoExplainLogTiming: "off",
    },

    single: {
      // Simplified WAL for non-replicated setup
      walLevel: "minimal",
      maxWalSenders: 0,

      // pgAudit (disabled)
      pgAuditLog: "none",

      // auto_explain timing (disabled for performance)
      autoExplainLogTiming: "off",
    },
  },

  pgHbaRules: [
    {
      type: "local",
      database: "all",
      user: "postgres",
      method: "peer",
      comment: "Local postgres user via Unix socket",
    },
    {
      type: "host",
      database: "all",
      user: "all",
      address: "127.0.0.1/32",
      method: "scram-sha-256",
      comment: "IPv4 local connections",
    },
    {
      type: "host",
      database: "all",
      user: "all",
      address: "::1/128",
      method: "scram-sha-256",
      comment: "IPv6 local connections",
    },
    {
      type: "host",
      database: "all",
      user: "all",
      address: "10.0.0.0/8",
      method: "scram-sha-256",
      comment: "Private network (Class A)",
    },
    {
      type: "host",
      database: "all",
      user: "all",
      address: "172.16.0.0/12",
      method: "scram-sha-256",
      comment: "Private network (Class B)",
    },
    {
      type: "host",
      database: "all",
      user: "all",
      address: "192.168.0.0/16",
      method: "scram-sha-256",
      comment: "Private network (Class C)",
    },
    {
      type: "host",
      database: "postgres",
      user: "pgbouncer_auth",
      address: "10.0.0.0/8",
      method: "scram-sha-256",
      comment: "PgBouncer auth query user",
      stackSpecific: ["primary"],
    },
    {
      type: "host",
      database: "postgres",
      user: "pgbouncer_auth",
      address: "172.16.0.0/12",
      method: "scram-sha-256",
      stackSpecific: ["primary"],
    },
    {
      type: "host",
      database: "postgres",
      user: "pgbouncer_auth",
      address: "192.168.0.0/16",
      method: "scram-sha-256",
      stackSpecific: ["primary"],
    },
    {
      type: "host",
      database: "replication",
      user: "replicator",
      address: "10.0.0.0/8",
      method: "scram-sha-256",
      comment: "Replication connections",
      stackSpecific: ["primary"],
    },
    {
      type: "host",
      database: "replication",
      user: "replicator",
      address: "172.16.0.0/12",
      method: "scram-sha-256",
      stackSpecific: ["primary"],
    },
    {
      type: "host",
      database: "replication",
      user: "replicator",
      address: "192.168.0.0/16",
      method: "scram-sha-256",
      stackSpecific: ["primary"],
    },
  ],
};
