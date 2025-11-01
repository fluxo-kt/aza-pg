/**
 * Shared test utilities for database testing
 * Provides reusable test execution and SQL helpers
 */
import { getErrorMessage } from "../utils/errors.js";

import { $ } from "bun";
import * as logger from "../utils/logger";

// Re-export TestResult type for convenience
export type { TestResult } from "../utils/logger";

/**
 * SQL execution result
 */
export type SQLResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

/**
 * Execute SQL command via docker exec
 * @param sql - SQL query to execute
 * @param containerName - Container name (default: "aza-pg-primary-1")
 * @returns Execution result with stdout, stderr, and exit code
 */
export async function runSQL(
  sql: string,
  containerName: string = "aza-pg-primary-1"
): Promise<SQLResult> {
  try {
    const result = await $`docker exec ${containerName} psql -U postgres -c ${sql}`.nothrow();

    return {
      success: result.exitCode === 0,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      exitCode: result.exitCode,
    };
  } catch (err) {
    const errorMsg = getErrorMessage(err);
    return {
      success: false,
      stdout: "",
      stderr: errorMsg,
      exitCode: 1,
    };
  }
}

/**
 * Run a test function with timing and error handling
 * @param name - Test name
 * @param fn - Async test function to execute
 * @returns Test result with timing information
 */
export async function runTest(name: string, fn: () => Promise<void>): Promise<logger.TestResult> {
  const startTime = performance.now();

  try {
    await fn();
    const duration = performance.now() - startTime;
    return {
      name,
      passed: true,
      duration,
    };
  } catch (err) {
    const duration = performance.now() - startTime;
    const errorMsg = getErrorMessage(err);
    return {
      name,
      passed: false,
      duration,
      error: errorMsg,
    };
  }
}

/**
 * Assert a condition is true, throw error if false
 * @param condition - Condition to check
 * @param message - Error message if assertion fails
 * @throws Error if condition is false
 */
export function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

/**
 * Print formatted test summary using logger utilities
 * @param results - Array of test results
 */
export function printTestSummary(results: logger.TestResult[]): void {
  logger.testSummary(results);
}

/**
 * Wait for database to be ready
 * @param containerName - Container name (default: "aza-pg-primary-1")
 * @param maxRetries - Maximum number of retry attempts (default: 30)
 * @returns True if database is ready, false if timeout
 */
export async function waitForDatabase(
  containerName: string = "aza-pg-primary-1",
  maxRetries: number = 30
): Promise<boolean> {
  logger.info(`Waiting for database in ${containerName}...`);

  for (let i = 0; i < maxRetries; i++) {
    const result = await runSQL("SELECT 1;", containerName);

    if (result.success) {
      logger.success("Database is ready");
      return true;
    }

    // Wait 1 second before retrying
    await Bun.sleep(1000);
  }

  logger.error(`Database not ready after ${maxRetries} attempts`);
  return false;
}
