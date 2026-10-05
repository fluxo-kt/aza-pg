import type { BaseConfig } from "./types";

// ============================================================================
// I/O and Performance Constants
// ============================================================================

/**
 * PostgreSQL 18 async I/O combine limit for batching operations.
 * This setting controls how many I/O operations can be combined in a single batch.
 * Default: 128 (PostgreSQL 18+ feature for improved I/O performance on modern SSDs)
 */
const IO_COMBINE_LIMIT = 128;

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

/** pg_ident.conf map of the stacks' local peer rule: OS user postgres may log in as any role. */
export const LOCAL_PEER_MAP = "local_postgres";

export const BASE_CONFIG: BaseConfig = {
  common: {
    port: 5432,
    // shared_preload_libraries is auto-tuned by docker-auto-config-entrypoint.sh (POSTGRES_SHARED_PRELOAD_LIBRARIES),
    // which outranks this file; validate-configs rejects any auto-tuned setting here.
    sharedPreloadLibraries: [],
    idleSessionTimeout: "0",
    // Min 8 workers for background processes (TimescaleDB, pg_cron, logical replication, etc.)
    // This ensures the init phase has enough workers; auto-config may increase at runtime

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

    // Character Encoding
    clientEncoding: "UTF8",

    // Extension settings
    pgStatStatementsMax: PG_STAT_STATEMENTS_MAX,
    pgStatStatementsTrack: "all",
    timescaledbTelemetryLevel: "off",
    // pg_cron opens a libpq connection per job, to localhost over TCP by default, where the stacks' pg_hba.conf
    // demands a password pg_cron does not have, so every job failed there. The socket is covered by local rules
    // (trust in a plain container, peer in the stacks).
    cronHost: "/var/run/postgresql",

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

    // Query Planner (SSD optimizations)

    // WAL
    walCompression: "lz4",
  },

  stacks: {
    primary: {
      // WAL

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

      // pgAudit (disabled on replica)
      pgAuditLog: "none",

      // auto_explain timing (disabled for performance)
      autoExplainLogTiming: "off",
    },

    single: {
      // Simplified WAL for non-replicated setup
      maxWalSenders: 0,

      // pgAudit (disabled)
      pgAuditLog: "none",

      // auto_explain timing (disabled for performance)
      autoExplainLogTiming: "off",
    },
  },

  pgHbaRules: [
    {
      // Only OS user postgres (the image's USER, owner of the data files) may use the socket, as any role: the
      // superuser is named by POSTGRES_USER, so a rule naming role "postgres" locked init and the healthcheck out of a
      // renamed superuser. Any role adds nothing to what owning the data files already grants.
      type: "local",
      database: "all",
      user: "all",
      method: "peer",
      map: LOCAL_PEER_MAP,
      comment: "OS user postgres via Unix socket, as any role (pg_ident.conf)",
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
