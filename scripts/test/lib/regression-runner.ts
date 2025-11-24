/**
 * Core PostgreSQL regression test execution logic.
 *
 * Executes SQL test files via psql, compares output against expected results,
 * and generates diffs for failures.
 */

import { $ } from "bun";
import { cleanPsqlOutput, normalizeRegressionOutput } from "./output-normalizer.ts";

/**
 * Result of running a single regression test
 */
export interface TestResult {
  /** Test name */
  testName: string;

  /** Whether test passed (output matches expected) */
  passed: boolean;

  /** Actual output from psql execution */
  actualOutput: string;

  /** Expected output from official test file */
  expectedOutput: string;

  /** Diff between expected and actual (null if passed) */
  diff: string | null;

  /** Test execution duration in milliseconds */
  duration: number;

  /** Error message if execution failed (SQL error, connection error, etc.) */
  error: string | null;

  /** Exit code from psql command */
  exitCode: number;
}

/**
 * PostgreSQL connection configuration
 */
export interface ConnectionConfig {
  /** Connection string (postgresql://user:pass@host:port/database) */
  connectionString?: string;

  /** Alternative: individual connection parameters */
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;

  /**
   * Optional container name for running psql via docker exec.
   * When provided, psql runs inside the container instead of from the host.
   * This avoids the need for psql to be installed on the host machine.
   */
  containerName?: string;
}

/**
 * Run a single PostgreSQL regression test.
 *
 * Executes SQL file via psql, captures output, compares against expected results,
 * and generates diff if outputs don't match.
 *
 * @param testName Test name (e.g., "boolean", "int2")
 * @param sqlFile Path to SQL test file
 * @param expectedFile Path to expected output file
 * @param connection Connection configuration
 * @returns Test result
 */
export async function runRegressionTest(
  testName: string,
  sqlFile: string,
  expectedFile: string,
  connection: ConnectionConfig
): Promise<TestResult> {
  const startTime = performance.now();

  // Read expected output
  let expectedOutput: string;
  try {
    expectedOutput = await Bun.file(expectedFile).text();
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      testName,
      passed: false,
      actualOutput: "",
      expectedOutput: "",
      diff: null,
      duration: performance.now() - startTime,
      error: `Failed to read expected output file: ${errorMsg}`,
      exitCode: -1,
    };
  }

  // Execute SQL file via psql
  let actualOutput = "";
  let exitCode = 0;
  let executionError: string | null = null;

  try {
    if (connection.containerName) {
      // Run psql inside container via docker exec
      // Copy SQL file to container first
      const containerPath = `/tmp/${testName}.sql`;
      const cpResult =
        await $`docker cp ${sqlFile} ${connection.containerName}:${containerPath}`.nothrow();

      if (cpResult.exitCode !== 0) {
        const stderr = cpResult.stderr.toString();
        executionError = `Failed to copy SQL file to container: ${stderr}`;
        exitCode = cpResult.exitCode;
      } else {
        // Fix file permissions (docker cp creates files as root, need to make readable)
        await $`docker exec --user root ${connection.containerName} chmod 644 ${containerPath}`.nothrow();

        // Run psql with options:
        // -X: Don't read .psqlrc (ensures clean environment)
        // -a: Echo all input (shows SQL commands in output, matching official tests)
        // -q: Quiet mode (suppress extra messages)
        // -f: Read commands from file
        // 2>&1: Merge stderr into stdout (ERROR messages need to be in output)
        // PGOPTIONS: Set session defaults to match pg_regress expectations
        // Note: Postgres,MDY has no space - PostgreSQL parses this correctly
        // lc_monetary=C prevents currency symbols in to_char() L format
        const dbName = connection.database || "postgres";
        const user = connection.user || "postgres";
        const result =
          await $`docker exec ${connection.containerName} sh -c 'PGOPTIONS="-c datestyle=Postgres,MDY -c timezone=PST8PDT -c intervalstyle=postgres_verbose -c lc_monetary=C" psql -X -a -q -U ${user} -d ${dbName} -f ${containerPath} 2>&1'`.nothrow();

        exitCode = result.exitCode;
        actualOutput = result.stdout.toString();

        // Cleanup temporary file (as root via docker exec with --user)
        await $`docker exec --user root ${connection.containerName} rm -f ${containerPath}`.nothrow();

        // Capture stderr if command failed (exit code 2+ indicates true error, not SQL errors)
        // Exit code 1 is normal for regression tests that test error conditions
        if (exitCode >= 2) {
          const stderr = result.stderr.toString();
          executionError = stderr || `psql exited with code ${exitCode}`;
        }
      }
    } else {
      // Run psql from host
      const connString = connection.connectionString || buildConnectionString(connection);

      // Run psql with options:
      // -X: Don't read .psqlrc (ensures clean environment)
      // -a: Echo all input (shows SQL commands in output, matching official tests)
      // -q: Quiet mode (suppress extra messages)
      // -f: Read commands from file
      // 2>&1: Merge stderr into stdout (ERROR messages need to be in output)
      // PGOPTIONS: Set session defaults to match pg_regress expectations
      // Note: Postgres,MDY has no space - PostgreSQL parses this correctly
      // lc_monetary=C prevents currency symbols in to_char() L format
      const result =
        await $`sh -c 'PGOPTIONS="-c datestyle=Postgres,MDY -c timezone=PST8PDT -c intervalstyle=postgres_verbose -c lc_monetary=C" psql -X -a -q ${connString} -f ${sqlFile} 2>&1'`.nothrow();

      exitCode = result.exitCode;
      actualOutput = result.stdout.toString();

      // Capture stderr if command failed (exit code 2+ indicates true error, not SQL errors)
      // Exit code 1 is normal for regression tests that test error conditions
      if (exitCode >= 2) {
        const stderr = result.stderr.toString();
        executionError = stderr || `psql exited with code ${exitCode}`;
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    executionError = `Failed to execute psql: ${errorMsg}`;
    exitCode = -1;
  }

  const duration = performance.now() - startTime;

  // If execution failed, return error result
  if (executionError) {
    return {
      testName,
      passed: false,
      actualOutput,
      expectedOutput,
      diff: null,
      duration,
      error: executionError,
      exitCode,
    };
  }

  // Normalize outputs for comparison
  const normalizedExpected = normalizeRegressionOutput(expectedOutput);
  const normalizedActual = cleanPsqlOutput(actualOutput);

  // Compare outputs
  const passed = normalizedExpected === normalizedActual;

  // Generate diff if outputs don't match
  let diff: string | null = null;
  if (!passed) {
    diff = await generateDiff(normalizedExpected, normalizedActual, testName);
  }

  return {
    testName,
    passed,
    actualOutput: normalizedActual,
    expectedOutput: normalizedExpected,
    diff,
    duration,
    error: null,
    exitCode,
  };
}

/**
 * Build PostgreSQL connection string from individual parameters.
 *
 * @param config Connection configuration
 * @returns PostgreSQL connection string
 */
function buildConnectionString(config: ConnectionConfig): string {
  const host = config.host || "localhost";
  const port = config.port || 5432;
  const database = config.database || "postgres";
  const user = config.user || "postgres";
  const password = config.password || "";

  if (password) {
    return `postgresql://${user}:${password}@${host}:${port}/${database}`;
  } else {
    return `postgresql://${user}@${host}:${port}/${database}`;
  }
}

/**
 * Generate unified diff between expected and actual output.
 *
 * Uses diff -c (context diff) format for readability.
 *
 * @param expected Expected output
 * @param actual Actual output
 * @param testName Test name (for diff header)
 * @returns Diff string or null if diff command fails
 */
async function generateDiff(
  expected: string,
  actual: string,
  testName: string
): Promise<string | null> {
  try {
    // Write expected and actual to temporary files
    const tmpDir = "/tmp/pg-regression";
    await $`mkdir -p ${tmpDir}`.quiet();

    const expectedPath = `${tmpDir}/${testName}.expected`;
    const actualPath = `${tmpDir}/${testName}.actual`;

    await Bun.write(expectedPath, expected);
    await Bun.write(actualPath, actual);

    // Generate context diff (-c flag)
    // Use nothrow() because diff returns exit code 1 when files differ
    const result = await $`diff -c ${expectedPath} ${actualPath}`.nothrow();

    // diff exit codes:
    // 0 = files identical (shouldn't happen here)
    // 1 = files differ (expected)
    // 2 = error
    if (result.exitCode === 2) {
      return null; // Error generating diff
    }

    return result.stdout.toString();
  } catch (error) {
    // diff command not available or other error
    console.warn(`Warning: Could not generate diff for ${testName}: ${error}`);
    return null;
  }
}

/**
 * Generate regression.diffs file in PostgreSQL format.
 *
 * This matches the format used by PostgreSQL's official regression tests
 * for easier comparison and debugging.
 *
 * @param results Array of test results
 * @param outputPath Path to write regression.diffs file
 */
export async function generateRegressionDiffs(
  results: TestResult[],
  outputPath: string
): Promise<void> {
  const failedTests = results.filter((r) => !r.passed);

  if (failedTests.length === 0) {
    // No failures, don't create file
    return;
  }

  let content = "";

  for (const result of failedTests) {
    content += "==============================================\n";
    content += `REGRESSION: ${result.testName}\n`;
    content += "==============================================\n\n";

    if (result.error) {
      content += `ERROR: ${result.error}\n\n`;
    } else if (result.diff) {
      content += result.diff;
      content += "\n\n";
    } else {
      content += "Output mismatch (diff not available)\n\n";
    }
  }

  await Bun.write(outputPath, content);
}

/**
 * Execute multiple regression tests in sequence.
 *
 * @param tests Array of test configurations
 * @param connection Connection configuration
 * @param onProgress Optional progress callback
 * @returns Array of test results
 */
export async function runRegressionTests(
  tests: Array<{ testName: string; sqlFile: string; expectedFile: string }>,
  connection: ConnectionConfig,
  onProgress?: (testName: string, index: number, total: number) => void
): Promise<TestResult[]> {
  const results: TestResult[] = [];

  for (let i = 0; i < tests.length; i++) {
    const test = tests[i];
    if (!test) continue;

    if (onProgress) {
      onProgress(test.testName, i + 1, tests.length);
    }

    const result = await runRegressionTest(
      test.testName,
      test.sqlFile,
      test.expectedFile,
      connection
    );
    results.push(result);
  }

  return results;
}

/**
 * Result of running a setup phase
 */
export interface SetupResult {
  /** Whether setup succeeded */
  success: boolean;

  /** Actual output from psql execution */
  actualOutput: string;

  /** Expected output (if expectedFile provided) */
  expectedOutput: string;

  /** Diff between expected and actual (null if passed or no expected file) */
  diff: string | null;

  /** Setup execution duration in milliseconds */
  duration: number;

  /** Error message if execution failed */
  error: string | null;

  /** Exit code from psql command */
  exitCode: number;
}

/**
 * Run a setup script (minimal_setup.sql or test_setup.sql) to prepare
 * the database for regression tests.
 *
 * @param setupName Name of the setup (e.g., "minimal_setup", "test_setup")
 * @param sqlFile Path to setup SQL file
 * @param expectedFile Path to expected output file (optional)
 * @param connection Connection configuration
 * @returns Setup result
 */
export async function runSetupPhase(
  setupName: string,
  sqlFile: string,
  expectedFile: string | null,
  connection: ConnectionConfig
): Promise<SetupResult> {
  const startTime = performance.now();

  // Read expected output if provided
  let expectedOutput = "";
  if (expectedFile) {
    try {
      expectedOutput = await Bun.file(expectedFile).text();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        actualOutput: "",
        expectedOutput: "",
        diff: null,
        duration: performance.now() - startTime,
        error: `Failed to read expected output file: ${errorMsg}`,
        exitCode: -1,
      };
    }
  }

  // Execute setup script via psql
  let actualOutput = "";
  let exitCode = 0;
  let executionError: string | null = null;

  try {
    if (connection.containerName) {
      // Run psql inside container via docker exec
      const containerPath = `/tmp/${setupName}.sql`;
      const cpResult =
        await $`docker cp ${sqlFile} ${connection.containerName}:${containerPath}`.nothrow();

      if (cpResult.exitCode !== 0) {
        const stderr = cpResult.stderr.toString();
        executionError = `Failed to copy setup file to container: ${stderr}`;
        exitCode = cpResult.exitCode;
      } else {
        // Fix file permissions (docker cp creates files as root, need to make readable)
        await $`docker exec --user root ${connection.containerName} chmod 644 ${containerPath}`.nothrow();

        // Run setup with same flags as tests
        // PGOPTIONS: Set session defaults to match pg_regress expectations
        // Note: Postgres,MDY has no space - PostgreSQL parses this correctly
        // lc_monetary=C prevents currency symbols in to_char() L format
        const dbName = connection.database || "postgres";
        const user = connection.user || "postgres";
        const result =
          await $`docker exec ${connection.containerName} sh -c 'PGOPTIONS="-c datestyle=Postgres,MDY -c timezone=PST8PDT -c intervalstyle=postgres_verbose -c lc_monetary=C" psql -X -a -q -U ${user} -d ${dbName} -f ${containerPath} 2>&1'`.nothrow();

        exitCode = result.exitCode;
        actualOutput = result.stdout.toString();

        // Cleanup temporary file (as root via docker exec with --user)
        await $`docker exec --user root ${connection.containerName} rm -f ${containerPath}`.nothrow();

        // For setup, any exit code other than 0 indicates failure
        // (unlike tests where exit code 1 is normal for error condition tests)
        if (exitCode !== 0) {
          const stderr = result.stderr.toString();
          executionError = stderr || `psql exited with code ${exitCode}`;
        }
      }
    } else {
      // Run psql from host
      const connString = connection.connectionString || buildConnectionString(connection);
      // PGOPTIONS: Set session defaults to match pg_regress expectations
      // Note: Postgres,MDY has no space - PostgreSQL parses this correctly
      // lc_monetary=C prevents currency symbols in to_char() L format
      const result =
        await $`sh -c 'PGOPTIONS="-c datestyle=Postgres,MDY -c timezone=PST8PDT -c intervalstyle=postgres_verbose -c lc_monetary=C" psql -X -a -q ${connString} -f ${sqlFile} 2>&1'`.nothrow();

      exitCode = result.exitCode;
      actualOutput = result.stdout.toString();

      if (exitCode !== 0) {
        const stderr = result.stderr.toString();
        executionError = stderr || `psql exited with code ${exitCode}`;
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    executionError = `Failed to execute setup: ${errorMsg}`;
    exitCode = -1;
  }

  const duration = performance.now() - startTime;

  // Normalize outputs for comparison
  const normalizedExpected = expectedFile ? normalizeRegressionOutput(expectedOutput) : "";
  const normalizedActual = cleanPsqlOutput(actualOutput);

  // Compare outputs if expected file provided
  let diff: string | null = null;
  let outputMatches = true;

  if (expectedFile && normalizedExpected) {
    outputMatches = normalizedExpected === normalizedActual;
    if (!outputMatches) {
      diff = await generateDiff(normalizedExpected, normalizedActual, setupName);
    }
  }

  // Setup succeeds if no execution error AND output matches (if expected)
  const success = !executionError && outputMatches;

  return {
    success,
    actualOutput: normalizedActual,
    expectedOutput: normalizedExpected,
    diff,
    duration,
    error: executionError,
    exitCode,
  };
}

/**
 * Run regression tests with an optional setup phase.
 *
 * If setup is provided, it runs once before all tests.
 * If setup fails, an error is returned and no tests are run.
 *
 * @param tests Array of test configurations
 * @param connection Connection configuration
 * @param setup Optional setup configuration
 * @param onProgress Optional progress callback
 * @returns Object with setup result (if any) and test results
 */
export async function runRegressionTestsWithSetup(
  tests: Array<{ testName: string; sqlFile: string; expectedFile: string }>,
  connection: ConnectionConfig,
  setup?: {
    setupName: string;
    sqlFile: string;
    expectedFile: string | null;
  },
  onProgress?: (testName: string, index: number, total: number) => void
): Promise<{
  setupResult: SetupResult | null;
  testResults: TestResult[];
}> {
  // Run setup phase if provided
  let setupResult: SetupResult | null = null;

  if (setup) {
    setupResult = await runSetupPhase(
      setup.setupName,
      setup.sqlFile,
      setup.expectedFile,
      connection
    );

    // If setup failed, return early with no test results
    if (!setupResult.success) {
      return {
        setupResult,
        testResults: [],
      };
    }
  }

  // Run tests
  const testResults = await runRegressionTests(tests, connection, onProgress);

  return {
    setupResult,
    testResults,
  };
}
