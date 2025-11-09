#!/usr/bin/env bun

/**
 * Validation script for generated PostgreSQL configs
 * Checks that all GUC names are valid and all expected settings are present
 */

import { readFileSync } from "fs";
import { join } from "path";
import { success, info, error, warning } from "../utils/logger.js";

const REPO_ROOT = join(import.meta.dir, "../..");

interface ValidationResult {
  file: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
  settings: string[];
}

/**
 * Valid PostgreSQL GUC name regex
 * Must start with letter or underscore, contain only lowercase letters, digits, underscores, and dots
 */
const GUC_NAME_REGEX = /^[a-z_][a-z0-9_.]*$/;

/**
 * Parse a PostgreSQL config file and extract all settings
 */
function parseConfig(filePath: string): ValidationResult {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  const result: ValidationResult = {
    file: filePath,
    valid: true,
    errors: [],
    warnings: [],
    settings: [],
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine) continue;
    const line = rawLine.trim();
    const lineNum = i + 1;

    // Skip comments and empty lines
    if (line.startsWith("#") || line === "") {
      continue;
    }

    // Check for include directives
    if (line.startsWith("include =") || line.startsWith("include_if_exists =")) {
      continue;
    }

    // Parse setting line: "key = value"
    const match = line.match(/^([a-z_][a-z0-9_.]*)\s*=\s*(.+)$/);
    if (!match) {
      result.errors.push(`Line ${lineNum}: Invalid setting format: "${line}"`);
      result.valid = false;
      continue;
    }

    const [, key, value] = match;

    // Check for undefined key/value from regex match
    if (!key || !value) {
      result.errors.push(`Line ${lineNum}: Invalid setting format: "${line}"`);
      result.valid = false;
      continue;
    }

    // Validate GUC name
    if (!GUC_NAME_REGEX.test(key)) {
      result.errors.push(`Line ${lineNum}: Invalid GUC name: "${key}"`);
      result.valid = false;
    }

    // Validate value format
    if (value.trim() === "") {
      result.errors.push(`Line ${lineNum}: Empty value for "${key}"`);
      result.valid = false;
    }

    // Check for common mistakes
    if (key.includes("_pg_")) {
      result.warnings.push(`Line ${lineNum}: Suspicious GUC name "${key}" (contains _pg_)`);
    }

    if (key.includes("__")) {
      result.warnings.push(
        `Line ${lineNum}: Suspicious GUC name "${key}" (contains double underscore)`
      );
    }

    result.settings.push(key);
  }

  return result;
}

/**
 * Validate that extension settings use correct namespace (dot notation)
 */
function validateExtensionNamespaces(result: ValidationResult): void {
  const extensionPrefixes = [
    "pg_stat_statements",
    "auto_explain",
    "pgaudit",
    "cron",
    "timescaledb",
  ];

  for (const setting of result.settings) {
    // Check if setting should be using dot notation
    for (const prefix of extensionPrefixes) {
      // If setting starts with prefix and has underscore after (e.g., pg_stat_statements_max),
      // it should use dot notation instead (e.g., pg_stat_statements.max)
      if (setting.startsWith(`${prefix}_`) && !setting.includes(".")) {
        result.errors.push(
          `Invalid extension setting "${setting}": should use dot notation (e.g., "${prefix}.${setting.slice(prefix.length + 1)}")`
        );
        result.valid = false;
      }
    }
  }
}

/**
 * Check for required settings in base config
 */
function validateBaseConfig(result: ValidationResult): void {
  const requiredSettings = [
    "listen_addresses",
    "io_method",
    "io_combine_limit",
    "log_destination",
    "timezone",
    "pg_stat_statements.max",
    "pg_stat_statements.track",
    "auto_explain.log_min_duration",
    "wal_compression",
  ];

  for (const required of requiredSettings) {
    if (!result.settings.includes(required)) {
      result.errors.push(`Missing required setting: "${required}"`);
      result.valid = false;
    }
  }
}

/**
 * Check for required settings in primary stack
 */
function validatePrimaryConfig(result: ValidationResult): void {
  const requiredSettings = [
    "synchronous_commit",
    "max_wal_senders",
    "max_replication_slots",
    "wal_level",
    "cron.database_name",
    "pgaudit.log",
  ];

  for (const required of requiredSettings) {
    if (!result.settings.includes(required)) {
      result.errors.push(`Missing required setting: "${required}"`);
      result.valid = false;
    }
  }
}

/**
 * Check for required settings in replica stack
 */
function validateReplicaConfig(result: ValidationResult): void {
  const requiredSettings = [
    "hot_standby",
    "max_standby_archive_delay",
    "max_standby_streaming_delay",
    "hot_standby_feedback",
    "wal_receiver_status_interval",
    "log_replication_commands",
  ];

  for (const required of requiredSettings) {
    if (!result.settings.includes(required)) {
      result.errors.push(`Missing required setting: "${required}"`);
      result.valid = false;
    }
  }
}

// Run validations
info("Validating PostgreSQL configurations...\n");

const configs = [
  {
    path: "docker/postgres/configs/postgresql-base.conf",
    validator: validateBaseConfig,
  },
  {
    path: "stacks/primary/configs/postgresql-primary.conf",
    validator: validatePrimaryConfig,
  },
  {
    path: "stacks/replica/configs/postgresql-replica.conf",
    validator: validateReplicaConfig,
  },
  {
    path: "stacks/single/configs/postgresql.conf",
    validator: null, // Minimal validation, no specific requirements
  },
];

let allValid = true;

for (const config of configs) {
  const fullPath = join(REPO_ROOT, config.path);
  info(config.path);

  const result = parseConfig(fullPath);
  validateExtensionNamespaces(result);

  if (config.validator) {
    config.validator(result);
  }

  if (result.errors.length > 0) {
    error("Errors:");
    for (const err of result.errors) {
      console.log(`      ${err}`);
    }
    allValid = false;
  }

  if (result.warnings.length > 0) {
    warning("Warnings:");
    for (const warn of result.warnings) {
      console.log(`      ${warn}`);
    }
  }

  if (result.valid && result.errors.length === 0) {
    success(`Valid (${result.settings.length} settings)`);
  }

  console.log("");
}

console.log("=".repeat(50));

if (allValid) {
  success("All configurations are valid!\n");
  process.exit(0);
} else {
  error("Some configurations have errors!\n");
  process.exit(1);
}
