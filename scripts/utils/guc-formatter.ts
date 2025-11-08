/**
 * PostgreSQL GUC (Grand Unified Configuration) Formatter Utilities
 *
 * Shared utilities for converting TypeScript configuration objects to PostgreSQL config format.
 * Used by both config generator and test utilities.
 *
 * @module guc-formatter
 */

/**
 * Type representing PostgreSQL configuration values
 */
export type PostgreSQLValue = boolean | number | string | string[];

/**
 * Convert camelCase to snake_case using proper regex patterns
 * Handles consecutive capitals and acronyms correctly
 *
 * @example
 * camelToSnakeCase("listenAddresses") // "listen_addresses"
 * camelToSnakeCase("maxWalSizeGB") // "max_wal_size_gb"
 * camelToSnakeCase("XMLParser") // "xml_parser"
 */
export function camelToSnakeCase(str: string): string {
  return (
    str
      // Insert underscore between lowercase and uppercase: camelCase -> camel_Case
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      // Insert underscore between consecutive capitals and lowercase: XMLParser -> XML_Parser
      .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
      // Convert to lowercase
      .toLowerCase()
  );
}

/**
 * Map of PostgreSQL-specific naming patterns that require dot notation
 * Key: snake_case prefix (e.g., "pg_stat_statements")
 * Value: PostgreSQL namespace (e.g., "pg_stat_statements")
 */
export const PG_EXTENSION_NAMESPACES: Record<string, string> = {
  pg_stat_statements: "pg_stat_statements",
  auto_explain: "auto_explain",
  pg_audit: "pgaudit", // Note: pgaudit uses lowercase namespace
  cron: "cron",
  timescaledb: "timescaledb",
} as const;

/**
 * Convert a configuration key to proper PostgreSQL GUC (Grand Unified Configuration) format
 * Handles extension namespaces with dot notation (e.g., pg_stat_statements.max)
 *
 * @param camelCaseKey - Configuration key in camelCase format
 * @returns PostgreSQL GUC name in snake_case (or namespace.setting format)
 * @throws {Error} If the generated GUC name doesn't match PostgreSQL naming rules
 *
 * @example
 * toPostgresGUCName("maxConnections") // "max_connections"
 * toPostgresGUCName("pgStatStatementsMax") // "pg_stat_statements.max"
 * toPostgresGUCName("pgAuditLog") // "pgaudit.log"
 */
export function toPostgresGUCName(camelCaseKey: string): string {
  const snakeKey = camelToSnakeCase(camelCaseKey);

  // Check if this key belongs to an extension namespace
  for (const [prefix, namespace] of Object.entries(PG_EXTENSION_NAMESPACES)) {
    if (snakeKey.startsWith(`${prefix}_`)) {
      // Extract the setting name after the prefix
      const settingName = snakeKey.slice(prefix.length + 1);
      return `${namespace}.${settingName}`;
    }
  }

  // Validate PostgreSQL GUC naming rules
  // Must start with letter or underscore, contain only lowercase letters, digits, underscores, and dots
  if (!snakeKey.match(/^[a-z_][a-z0-9_.]*$/)) {
    throw new Error(
      `Invalid PostgreSQL GUC name generated: "${snakeKey}" (from camelCase: "${camelCaseKey}"). ` +
        `GUC names must start with a letter or underscore and contain only lowercase letters, digits, underscores, and dots.`
    );
  }

  return snakeKey;
}

/**
 * Format a configuration value for PostgreSQL
 * Handles booleans (on/off), numbers, strings, and arrays
 *
 * @param value - Configuration value to format
 * @returns Formatted value as PostgreSQL expects it
 *
 * @example
 * formatValue(true) // "on"
 * formatValue(100) // "100"
 * formatValue("localhost") // "'localhost'"
 * formatValue(["pg_stat_statements", "auto_explain"]) // "'pg_stat_statements,auto_explain'"
 */
export function formatValue(value: PostgreSQLValue): string {
  if (typeof value === "boolean") {
    return value ? "on" : "off";
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return `'${value.join(",")}'`;
  }

  // String values get quoted
  return `'${value}'`;
}

/**
 * Format a single configuration setting as a PostgreSQL GUC line
 * Returns empty string for undefined values
 *
 * @param key - Configuration key in camelCase format
 * @param value - Configuration value
 * @returns Formatted PostgreSQL configuration line
 *
 * @example
 * formatSetting("maxConnections", 100) // "max_connections = 100"
 * formatSetting("listenAddresses", "*") // "listen_addresses = '*'"
 * formatSetting("sharedPreloadLibraries", ["pg_stat_statements"]) // "shared_preload_libraries = 'pg_stat_statements'"
 * formatSetting("optionalSetting", undefined) // ""
 */
export function formatSetting(key: string, value: PostgreSQLValue | undefined): string {
  if (value === undefined) return "";

  // Special case: sharedPreloadLibraries has a custom comment in configs
  // Handle it specially to maintain existing behavior
  if (key === "sharedPreloadLibraries") {
    if (Array.isArray(value) && value.length === 0) {
      // Empty array means runtime-controlled, don't emit
      return "";
    }
    return `shared_preload_libraries = ${formatValue(value)}`;
  }

  const pgKey = toPostgresGUCName(key);
  return `${pgKey} = ${formatValue(value)}`;
}
