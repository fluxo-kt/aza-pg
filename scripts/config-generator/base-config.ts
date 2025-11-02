import type { BaseConfig, PgHbaRule } from './types.js';

export const BASE_CONFIG: BaseConfig = {
  common: {
    // Connection Settings
    listenAddresses: '*',
    port: 5432,
    sharedPreloadLibraries: [
      'pg_stat_statements',
      'auto_explain',
      'pg_cron',
      'pgaudit',
    ],
    idleSessionTimeout: '0',

    // PostgreSQL 18 Async I/O
    ioMethod: 'worker',
    ioCombineLimit: 128,

    // Logging
    logDestination: 'stderr',
    loggingCollector: 'off',
    logMinDurationStatement: 1000,
    logLinePrefix: '%t [%p]: [%l-1] user=%u,db=%d,app=%a,client=%h ',
    logLockWaits: 'on',
    logTempFiles: 0,
    logTimezone: 'UTC',
    logCheckpoints: 'on',
    logConnections: 'on',
    logDisconnections: 'on',
    logAutovacuumMinDuration: 0,

    // Locale and Timezone
    timezone: 'UTC',
    lcMessages: 'en_US.utf8',
    lcMonetary: 'en_US.utf8',
    lcNumeric: 'en_US.utf8',
    lcTime: 'en_US.utf8',
    defaultTextSearchConfig: 'pg_catalog.english',

    // pg_stat_statements
    pgStatStatementsMax: 10000,
    pgStatStatementsTrack: 'all',

    // auto_explain
    autoExplainLogMinDuration: '3s',
    autoExplainLogAnalyze: 'on',
    autoExplainLogBuffers: 'on',
    autoExplainLogNestedStatements: 'on',

    // Autovacuum (aggressive SSD-optimized)
    autovacuum: 'on',
    autovacuumNaptime: '1min',
    autovacuumVacuumCostDelay: '2ms',
    autovacuumVacuumCostLimit: 2000,
    autovacuumVacuumScaleFactor: 0.1,
    autovacuumAnalyzeScaleFactor: 0.05,
    autovacuumFreezeMaxAge: 200000000,

    // Checkpoints
    checkpointCompletionTarget: 0.9,

    // WAL Settings
    walLevel: 'replica',
  },

  stacks: {
    primary: {
      // WAL
      walCompression: 'lz4',

      // Replication
      maxWalSenders: 10,
      maxReplicationSlots: 10,
      walKeepSize: '1GB',
      synchronousCommit: 'on',
      synchronousStandbyNames: '',
      idleReplicationSlotTimeout: '48h',
      walSenderTimeout: '60s',

      // WAL Archiving (commented in actual config)
      archiveMode: 'off',
      archiveCommand: '',

      // pg_cron
      cronDatabaseName: 'postgres',
      cronLogRun: 'on',
      cronLogStatement: 'on',

      // pgAudit
      pgAuditLog: 'ddl,write,role',
      pgAuditLogStatementOnce: 'on',
      pgAuditLogLevel: 'log',
      pgAuditLogRelation: 'on',
    },

    replica: {
      // WAL
      walCompression: 'lz4',

      // Hot Standby
      hotStandby: 'on',
      maxStandbyArchiveDelay: '300s',
      maxStandbyStreamingDelay: '300s',
      hotStandbyFeedback: 'on',
      walReceiverStatusInterval: '10s',

      // Replication
      maxWalSenders: 5,
      maxReplicationSlots: 5,

      // Logging
      logReplicationCommands: 'on',

      // pgAudit (disabled on replica)
      pgAuditLog: 'none',

      // auto_explain timing (disabled for performance)
      autoExplainLogTiming: 'off',
    },

    single: {
      // Simplified WAL for non-replicated setup
      walLevel: 'minimal',
      maxWalSenders: 0,

      // pgAudit (disabled)
      pgAuditLog: 'none',

      // auto_explain timing (disabled for performance)
      autoExplainLogTiming: 'off',
    },
  },

  pgHbaRules: [
    {
      type: 'local',
      database: 'all',
      user: 'postgres',
      method: 'peer',
      comment: 'Local postgres user via Unix socket',
    },
    {
      type: 'host',
      database: 'all',
      user: 'all',
      address: '127.0.0.1/32',
      method: 'scram-sha-256',
      comment: 'IPv4 local connections',
    },
    {
      type: 'host',
      database: 'all',
      user: 'all',
      address: '::1/128',
      method: 'scram-sha-256',
      comment: 'IPv6 local connections',
    },
    {
      type: 'host',
      database: 'all',
      user: 'all',
      address: '10.0.0.0/8',
      method: 'scram-sha-256',
      comment: 'Private network (Class A)',
    },
    {
      type: 'host',
      database: 'all',
      user: 'all',
      address: '172.16.0.0/12',
      method: 'scram-sha-256',
      comment: 'Private network (Class B)',
    },
    {
      type: 'host',
      database: 'all',
      user: 'all',
      address: '192.168.0.0/16',
      method: 'scram-sha-256',
      comment: 'Private network (Class C)',
    },
    {
      type: 'host',
      database: 'postgres',
      user: 'pgbouncer_auth',
      address: '10.0.0.0/8',
      method: 'scram-sha-256',
      comment: 'PgBouncer auth query user',
      stackSpecific: ['primary'],
    },
    {
      type: 'host',
      database: 'postgres',
      user: 'pgbouncer_auth',
      address: '172.16.0.0/12',
      method: 'scram-sha-256',
      stackSpecific: ['primary'],
    },
    {
      type: 'host',
      database: 'postgres',
      user: 'pgbouncer_auth',
      address: '192.168.0.0/16',
      method: 'scram-sha-256',
      stackSpecific: ['primary'],
    },
    {
      type: 'host',
      database: 'replication',
      user: 'replicator',
      address: '10.0.0.0/8',
      method: 'scram-sha-256',
      comment: 'Replication connections',
      stackSpecific: ['primary'],
    },
    {
      type: 'host',
      database: 'replication',
      user: 'replicator',
      address: '172.16.0.0/12',
      method: 'scram-sha-256',
      stackSpecific: ['primary'],
    },
    {
      type: 'host',
      database: 'replication',
      user: 'replicator',
      address: '192.168.0.0/16',
      method: 'scram-sha-256',
      stackSpecific: ['primary'],
    },
  ],
};
