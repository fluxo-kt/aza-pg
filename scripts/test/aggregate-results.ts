#!/usr/bin/env bun
/**
 * Aggregate test results from multiple test runs
 *
 * This script reads all JSON Lines (.jsonl) files from a specified directory,
 * combines the test results, calculates aggregate statistics, and exports
 * the combined results in either JSON Lines or JUnit XML format.
 *
 * Usage:
 *   bun scripts/test/aggregate-results.ts <output-dir> [--format json|junit]
 *
 * Examples:
 *   bun scripts/test/aggregate-results.ts ./test-results --format json
 *   bun scripts/test/aggregate-results.ts ./test-results --format junit
 *
 * Options:
 *   --format     - Output format: 'json' (JSON Lines) or 'junit' (JUnit XML). Default: json
 *
 * Output:
 *   The aggregated results are written to:
 *   - <output-dir>/aggregated-results.jsonl (for JSON format)
 *   - <output-dir>/aggregated-results.xml (for JUnit format)
 */

import { join } from "node:path";
import { readdirSync, existsSync, statSync } from "node:fs";
import { error, info, success, section, exportJsonLines, exportJunitXml } from "../utils/logger";
import type { TestResult } from "../utils/logger";

/**
 * Extended test result with suite information
 */
type ExtendedTestResult = TestResult & {
  suite: string;
  timestamp?: string;
};

/**
 * Parse command line arguments
 */
function parseArgs(): { outputDir: string; format: "json" | "junit" } {
  const args = Bun.argv.slice(2);

  if (args.length === 0 || (args[0] && args[0].startsWith("--"))) {
    error("Missing required argument: output-dir");
    console.log(
      "\nUsage: bun scripts/test/aggregate-results.ts <output-dir> [--format json|junit]"
    );
    process.exit(1);
  }

  const outputDir = args[0]!;

  // Parse format flag
  const formatIdx = args.indexOf("--format");
  const formatArg = formatIdx !== -1 && args[formatIdx + 1] ? args[formatIdx + 1] : "json";

  if (formatArg !== "json" && formatArg !== "junit") {
    error(`Invalid format: ${formatArg}. Must be 'json' or 'junit'`);
    process.exit(1);
  }

  return { outputDir, format: formatArg as "json" | "junit" };
}

/**
 * Read and parse all JSON Lines files from a directory
 */
async function readJsonLinesFiles(dir: string): Promise<ExtendedTestResult[]> {
  if (!existsSync(dir)) {
    error(`Directory does not exist: ${dir}`);
    process.exit(1);
  }

  if (!statSync(dir).isDirectory()) {
    error(`Not a directory: ${dir}`);
    process.exit(1);
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));

  if (files.length === 0) {
    error(`No .jsonl files found in directory: ${dir}`);
    process.exit(1);
  }

  info(`Found ${files.length} JSON Lines file(s)`);

  const allResults: ExtendedTestResult[] = [];

  for (const file of files) {
    const filePath = join(dir, file);
    info(`Reading: ${file}`);

    try {
      const fileContent = await Bun.file(filePath).text();
      const lines = fileContent.trim().split("\n");

      for (const line of lines) {
        if (line.trim() === "") continue;

        try {
          const record = JSON.parse(line) as ExtendedTestResult;
          allResults.push(record);
        } catch (parseErr) {
          error(
            `Failed to parse JSON line in ${file}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
          );
        }
      }
    } catch (readErr) {
      error(
        `Failed to read file ${file}: ${readErr instanceof Error ? readErr.message : String(readErr)}`
      );
    }
  }

  return allResults;
}

/**
 * Calculate and print aggregate statistics
 */
function printStatistics(results: ExtendedTestResult[]): void {
  section("Aggregate Statistics");

  const totalTests = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalDuration = results.reduce((sum, r) => sum + (r.duration ?? 0), 0);

  // Group by suite
  const suites = new Map<string, ExtendedTestResult[]>();
  for (const result of results) {
    const suiteName = result.suite;
    if (!suites.has(suiteName)) {
      suites.set(suiteName, []);
    }
    suites.get(suiteName)!.push(result);
  }

  console.log(`Total tests: ${totalTests}`);
  console.log(`Passed: ${passed} (${((passed / totalTests) * 100).toFixed(1)}%)`);
  console.log(`Failed: ${failed} (${((failed / totalTests) * 100).toFixed(1)}%)`);
  console.log(`Total duration: ${(totalDuration / 1000).toFixed(2)}s`);
  console.log("");

  console.log("By suite:");
  for (const [suiteName, suiteResults] of suites) {
    const suitePassed = suiteResults.filter((r) => r.passed).length;
    const suiteFailed = suiteResults.filter((r) => !r.passed).length;
    console.log(
      `  ${suiteName}: ${suiteResults.length} tests (${suitePassed} passed, ${suiteFailed} failed)`
    );
  }
  console.log("");
}

/**
 * Main execution function
 */
async function main(): Promise<void> {
  section("Test Result Aggregation");

  const { outputDir, format } = parseArgs();

  info(`Output directory: ${outputDir}`);
  info(`Output format: ${format}`);
  console.log("");

  // Read all JSON Lines files
  const results = await readJsonLinesFiles(outputDir);
  success(`Loaded ${results.length} test result(s)`);
  console.log("");

  // Print statistics
  printStatistics(results);

  // Convert to TestResult format (remove suite field for export)
  const testResults: TestResult[] = results.map((r) => ({
    name: `[${r.suite}] ${r.name}`,
    passed: r.passed,
    duration: r.duration,
    error: r.error,
  }));

  // Export aggregated results
  const outputFile =
    format === "json"
      ? join(outputDir, "aggregated-results.jsonl")
      : join(outputDir, "aggregated-results.xml");

  section("Exporting Aggregated Results");
  info(`Writing to: ${outputFile}`);

  try {
    if (format === "json") {
      await exportJsonLines(testResults, outputFile, "aggregated");
    } else {
      await exportJunitXml(testResults, outputFile, "aggregated");
    }
    success(`Successfully exported ${results.length} test result(s) to ${outputFile}`);
  } catch (err) {
    error(`Failed to export results: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// Main execution
if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
