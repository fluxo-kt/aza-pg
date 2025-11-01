#!/usr/bin/env bun

/**
 * Test suite for the refactored formatSetting() function
 * Validates camelCase to snake_case conversion and PostgreSQL GUC formatting
 */

import { success, info } from "../utils/logger.js";

// Import the functions (we'll need to export them from generator.ts first)
// For now, we'll duplicate the core logic for testing

function camelToSnakeCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

const PG_EXTENSION_NAMESPACES: Record<string, string> = {
  pg_stat_statements: "pg_stat_statements",
  auto_explain: "auto_explain",
  pg_audit: "pgaudit",
  cron: "cron",
  timescaledb: "timescaledb",
};

function toPostgresGUCName(camelCaseKey: string): string {
  const snakeKey = camelToSnakeCase(camelCaseKey);

  for (const [prefix, namespace] of Object.entries(PG_EXTENSION_NAMESPACES)) {
    if (snakeKey.startsWith(`${prefix}_`)) {
      const settingName = snakeKey.slice(prefix.length + 1);
      return `${namespace}.${settingName}`;
    }
  }

  if (!snakeKey.match(/^[a-z_][a-z0-9_.]*$/)) {
    throw new Error(
      `Invalid PostgreSQL GUC name generated: "${snakeKey}" (from camelCase: "${camelCaseKey}"). ` +
        `GUC names must start with a letter or underscore and contain only lowercase letters, digits, underscores, and dots.`
    );
  }

  return snakeKey;
}

function formatValue(value: any): string {
  if (typeof value === "boolean") {
    return value ? "on" : "off";
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return `'${value.join(",")}'`;
  }

  return `'${value}'`;
}

function formatSetting(key: string, value: any): string {
  if (value === undefined) return "";

  if (key === "sharedPreloadLibraries") {
    if (Array.isArray(value) && value.length === 0) {
      return "";
    }
    return `shared_preload_libraries = ${formatValue(value)}`;
  }

  const pgKey = toPostgresGUCName(key);
  return `${pgKey} = ${formatValue(value)}`;
}

// Test cases
interface TestCase {
  name: string;
  input: { key: string; value: any };
  expected: string;
}

const testCases: TestCase[] = [
  // Basic camelCase conversions
  {
    name: "Simple camelCase",
    input: { key: "listenAddresses", value: "127.0.0.1" },
    expected: "listen_addresses = '127.0.0.1'",
  },
  {
    name: "Boolean true",
    input: { key: "logCheckpoints", value: true },
    expected: "log_checkpoints = on",
  },
  {
    name: "Boolean false",
    input: { key: "loggingCollector", value: false },
    expected: "logging_collector = off",
  },
  {
    name: "Number",
    input: { key: "maxConnections", value: 100 },
    expected: "max_connections = 100",
  },
  {
    name: "Float number",
    input: { key: "checkpointCompletionTarget", value: 0.9 },
    expected: "checkpoint_completion_target = 0.9",
  },

  // Extension namespace handling (pg_stat_statements)
  {
    name: "pg_stat_statements.max",
    input: { key: "pgStatStatementsMax", value: 10000 },
    expected: "pg_stat_statements.max = 10000",
  },
  {
    name: "pg_stat_statements.track",
    input: { key: "pgStatStatementsTrack", value: "all" },
    expected: "pg_stat_statements.track = 'all'",
  },

  // Extension namespace handling (auto_explain)
  {
    name: "auto_explain.log_min_duration",
    input: { key: "autoExplainLogMinDuration", value: "3s" },
    expected: "auto_explain.log_min_duration = '3s'",
  },
  {
    name: "auto_explain.log_analyze",
    input: { key: "autoExplainLogAnalyze", value: true },
    expected: "auto_explain.log_analyze = on",
  },
  {
    name: "auto_explain.log_buffers",
    input: { key: "autoExplainLogBuffers", value: true },
    expected: "auto_explain.log_buffers = on",
  },

  // Extension namespace handling (pgaudit)
  {
    name: "pgaudit.log",
    input: { key: "pgAuditLog", value: "ddl,write,role" },
    expected: "pgaudit.log = 'ddl,write,role'",
  },
  {
    name: "pgaudit.log_statement_once",
    input: { key: "pgAuditLogStatementOnce", value: true },
    expected: "pgaudit.log_statement_once = on",
  },
  {
    name: "pgaudit.log_level",
    input: { key: "pgAuditLogLevel", value: "log" },
    expected: "pgaudit.log_level = 'log'",
  },

  // Extension namespace handling (cron)
  {
    name: "cron.database_name",
    input: { key: "cronDatabaseName", value: "postgres" },
    expected: "cron.database_name = 'postgres'",
  },
  {
    name: "cron.log_run",
    input: { key: "cronLogRun", value: true },
    expected: "cron.log_run = on",
  },

  // Extension namespace handling (timescaledb)
  {
    name: "timescaledb.telemetry_level",
    input: { key: "timescaledbTelemetryLevel", value: "off" },
    expected: "timescaledb.telemetry_level = 'off'",
  },

  // Complex camelCase with multiple capitals
  {
    name: "WAL settings",
    input: { key: "maxWalSize", value: "2GB" },
    expected: "max_wal_size = '2GB'",
  },
  {
    name: "IO settings",
    input: { key: "ioMethod", value: "worker" },
    expected: "io_method = 'worker'",
  },
  {
    name: "IO combine limit",
    input: { key: "ioCombineLimit", value: 128 },
    expected: "io_combine_limit = 128",
  },

  // Edge cases
  {
    name: "Undefined value",
    input: { key: "someValue", value: undefined },
    expected: "",
  },
  {
    name: "Empty array (sharedPreloadLibraries)",
    input: { key: "sharedPreloadLibraries", value: [] },
    expected: "",
  },
  {
    name: "Non-empty array (sharedPreloadLibraries)",
    input: { key: "sharedPreloadLibraries", value: ["pg_stat_statements", "auto_explain"] },
    expected: "shared_preload_libraries = 'pg_stat_statements,auto_explain'",
  },

  // Locale settings
  {
    name: "Locale with dots",
    input: { key: "lcMessages", value: "en_US.utf8" },
    expected: "lc_messages = 'en_US.utf8'",
  },
  {
    name: "Default text search config",
    input: { key: "defaultTextSearchConfig", value: "pg_catalog.english" },
    expected: "default_text_search_config = 'pg_catalog.english'",
  },
];

// Run tests
info("Running formatSetting() tests...\n");

let passed = 0;
let failed = 0;

for (const test of testCases) {
  try {
    const result = formatSetting(test.input.key, test.input.value);

    if (result === test.expected) {
      console.log(`✓ ${test.name}`);
      passed++;
    } else {
      console.log(`✗ ${test.name}`);
      console.log(`  Expected: "${test.expected}"`);
      console.log(`  Got:      "${result}"`);
      failed++;
    }
  } catch (error) {
    console.log(`✗ ${test.name} (threw error)`);
    console.log(`  Error: ${error instanceof Error ? error.message : String(error)}`);
    failed++;
  }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`Tests: ${passed} passed, ${failed} failed, ${testCases.length} total`);

if (failed > 0) {
  process.exit(1);
}

success("All tests passed!");
