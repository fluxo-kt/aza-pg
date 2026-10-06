#!/usr/bin/env bun
/**
 * The GUC formatter that writes every line of the generated postgresql.conf files.
 *
 * Usage: bun test scripts/test/test-utils.test.ts
 */

import { describe, test, expect } from "bun:test";
import {
  camelToSnakeCase,
  toPostgresGUCName,
  formatValue,
  formatSetting,
} from "../utils/guc-formatter";

describe("GUC names", () => {
  test("camelCase becomes snake_case, acronyms and digits included", () => {
    expect(camelToSnakeCase("maxConnections")).toBe("max_connections");
    expect(camelToSnakeCase("maxWalSizeGB")).toBe("max_wal_size_gb");
    expect(camelToSnakeCase("XMLParser")).toBe("xml_parser");
    expect(camelToSnakeCase("A")).toBe("a");
    expect(camelToSnakeCase("config2Factor")).toBe("config2_factor");
    expect(camelToSnakeCase("maxConnections100")).toBe("max_connections100");
  });

  test("extension settings get their dotted namespace", () => {
    expect(toPostgresGUCName("listenAddresses")).toBe("listen_addresses");
    expect(toPostgresGUCName("pgStatStatementsMax")).toBe("pg_stat_statements.max");
    expect(toPostgresGUCName("autoExplainLogMinDuration")).toBe("auto_explain.log_min_duration");
    expect(toPostgresGUCName("pgAuditLog")).toBe("pgaudit.log");
    expect(toPostgresGUCName("cronDatabaseName")).toBe("cron.database_name");
    expect(toPostgresGUCName("timescaledbTelemetryLevel")).toBe("timescaledb.telemetry_level");
  });

  test("a key that cannot be a GUC name is rejected", () => {
    expect(() => toPostgresGUCName("invalid-name-with-dashes")).toThrow();
  });
});

describe("GUC values", () => {
  test("booleans become on/off and numbers stay bare", () => {
    expect(formatValue(true)).toBe("on");
    expect(formatValue(false)).toBe("off");
    expect(formatValue(0)).toBe("0");
    expect(formatValue(-1)).toBe("-1");
    expect(formatValue(1.5)).toBe("1.5");
  });

  test("strings and lists are single-quoted", () => {
    expect(formatValue("localhost")).toBe("'localhost'");
    expect(formatValue("")).toBe("''");
    expect(formatValue("on")).toBe("'on'");
    expect(formatValue(["pg_stat_statements", "auto_explain"])).toBe(
      "'pg_stat_statements,auto_explain'"
    );
    expect(formatValue([])).toBe("''");
  });

  test("quotes and backslashes are escaped as postgresql.conf reads them", () => {
    // PostgreSQL 18.6 reads 'a''b\\c' as a'b\c; an unescaped ' fails the whole file, an unescaped \ is dropped.
    expect(formatValue("a'b\\c")).toBe("'a''b\\\\c'");
    expect(formatValue("'")).toBe("''''");
    expect(formatValue("x\\")).toBe("'x\\\\'");
    expect(formatValue(["it's", "C:\\x"])).toBe("'it''s,C:\\\\x'");
  });
});

describe("GUC setting lines", () => {
  test("key and value combine into one line", () => {
    expect(formatSetting("maxConnections", 100)).toBe("max_connections = 100");
    expect(formatSetting("pgStatStatementsMax", 10000)).toBe("pg_stat_statements.max = 10000");
    expect(formatSetting("listenAddresses", "*")).toBe("listen_addresses = '*'");
  });

  test("only an undefined value is omitted; 0 and false are written", () => {
    expect(formatSetting("optionalSetting", undefined)).toBe("");
    expect(formatSetting("someValue", 0)).toBe("some_value = 0");
    expect(formatSetting("enableFeature", false)).toBe("enable_feature = off");
  });

  test("an empty shared_preload_libraries is omitted so the runtime value applies", () => {
    expect(formatSetting("sharedPreloadLibraries", [])).toBe("");
    expect(formatSetting("sharedPreloadLibraries", ["pgaudit", "auto_explain"])).toBe(
      "shared_preload_libraries = 'pgaudit,auto_explain'"
    );
  });
});
