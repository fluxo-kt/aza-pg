export type StackType = "primary" | "replica" | "single";

export interface PostgreSQLSettings {
  // Connection Settings
  listenAddresses: string;
  port: number;
  maxConnections?: number; // Overridden by auto-config
  maxWorkerProcesses?: number; // Min 8 for background workers (TimescaleDB, pg_cron, etc.)
  sharedPreloadLibraries: string[];
  idleSessionTimeout?: string;

  // Async I/O (PostgreSQL 18)
  ioMethod: string;
  ioCombineLimit: number;

  // Logging
  logDestination: string;
  loggingCollector: "on" | "off";
  logMinDurationStatement: number;
  logLinePrefix: string;
  logLockWaits: "on" | "off";
  logTempFiles: number;
  logTimezone: string;
  logCheckpoints?: "on" | "off";
  logConnections?: "on" | "off";
  logDisconnections?: "on" | "off";
  logAutovacuumMinDuration?: number;
  logReplicationCommands?: "on" | "off";

  // Locale and Timezone
  timezone: string;
  lcMessages: string;
  lcMonetary: string;
  lcNumeric: string;
  lcTime: string;
  defaultTextSearchConfig: string;

  // Character Encoding
  clientEncoding: string;

  // pg_stat_statements
  pgStatStatementsMax: number;
  pgStatStatementsTrack: string;
  timescaledbTelemetryLevel?: string;

  // auto_explain
  autoExplainLogMinDuration: string;
  autoExplainLogAnalyze: "on" | "off";
  autoExplainLogBuffers: "on" | "off";
  autoExplainLogNestedStatements: "on" | "off";
  autoExplainLogTiming?: "on" | "off";

  // Autovacuum
  autovacuum: "on" | "off";
  autovacuumNaptime: string;
  autovacuumVacuumCostDelay: string;
  autovacuumVacuumCostLimit: number;
  autovacuumVacuumScaleFactor?: number;
  autovacuumAnalyzeScaleFactor?: number;
  autovacuumFreezeMaxAge?: number;

  // Checkpoints
  checkpointCompletionTarget: number;

  // Query Planner (SSD optimizations)
  randomPageCost?: number;
  effectiveIoConcurrency?: number;

  // WAL Settings
  walLevel: "minimal" | "replica" | "logical";
  walCompression: "off" | "lz4" | "pglz";
  maxWalSize?: string;
  minWalSize?: string;
  maxWalSenders?: number;
  walKeepSize?: string;
  archiveMode?: "on" | "off";
  archiveCommand?: string;

  // Replication
  synchronousCommit?: "on" | "off" | "remote_apply" | "remote_write" | "local";
  synchronousStandbyNames?: string;
  maxReplicationSlots?: number;
  idleReplicationSlotTimeout?: string;
  walSenderTimeout?: string;
  hotStandby?: "on" | "off";
  maxStandbyArchiveDelay?: string;
  maxStandbyStreamingDelay?: string;
  hotStandbyFeedback?: "on" | "off";
  walReceiverStatusInterval?: string;

  // pg_cron
  cronDatabaseName?: string;
  cronLogRun?: "on" | "off";
  cronLogStatement?: "on" | "off";

  // pgAudit
  pgAuditLog?: string;
  pgAuditLogStatementOnce?: "on" | "off";
  pgAuditLogLevel?: string;
  pgAuditLogRelation?: "on" | "off";
}

export interface PgHbaRule {
  type: "local" | "host" | "hostssl" | "hostnossl";
  database: string;
  user: string;
  address?: string;
  method: "trust" | "reject" | "scram-sha-256" | "md5" | "peer";
  comment?: string;
  stackSpecific?: StackType[];
}

export interface ComposeService {
  image?: string;
  container_name?: string;
  build?: {
    context: string;
    dockerfile: string;
  };
  environment?: Record<string, string>;
  volumes?: string[];
  ports?: string[];
  networks?: string[];
  depends_on?: Record<string, { condition: string }>;
  healthcheck?: {
    test: string[];
    interval: string;
    timeout: string;
    retries: number;
    start_period: string;
  };
  command?: string | string[];
  restart?: string;
}

/**
 * Docker Compose network configuration
 */
export interface ComposeNetwork {
  driver?: string;
  driver_opts?: Record<string, string>;
  external?: boolean;
  name?: string;
}

/**
 * Docker Compose volume configuration
 */
export interface ComposeVolume {
  driver?: string;
  driver_opts?: Record<string, string>;
  external?: boolean;
  name?: string;
}

export interface ComposeConfig {
  name: string;
  services: Record<string, ComposeService>;
  networks?: Record<string, ComposeNetwork>;
  volumes?: Record<string, ComposeVolume>;
}

export interface StackConfig {
  type: StackType;
  postgres: PostgreSQLSettings;
  pgHbaRules: PgHbaRule[];
  compose: ComposeConfig;
}

export interface BaseConfig {
  // Settings common to all stacks
  common: PostgreSQLSettings;
  // Stack-specific overrides
  stacks: {
    primary: Partial<PostgreSQLSettings>;
    replica: Partial<PostgreSQLSettings>;
    single: Partial<PostgreSQLSettings>;
  };
  // pg_hba rules (with stack-specific flags)
  pgHbaRules: PgHbaRule[];
}
