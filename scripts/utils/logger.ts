/**
 * Shared logging utilities for scripts and tests
 * Provides consistent colored output formatting across the codebase
 */
import { RED, GREEN, YELLOW, BLUE, RESET } from "./colors";
/**
 * Test result data structure
 */
export type TestResult = {
  name: string;
  passed: boolean;
  duration?: number;
  error?: string;
};

/**
 * Print success message with green ✅ prefix
 */
export function success(msg: string): void {
  console.log(`${GREEN}✅ ${msg}${RESET}`);
}

/**
 * Print error message with red ❌ prefix
 */
export function error(msg: string, err?: any): void {
  const message = `${RED}❌ ${msg}${RESET}`;
  if (err) console.error(message, err);
  else console.error(message);
}

/**
 * Print warning message with yellow ⚠️ prefix
 */
export function warning(msg: string, err?: any): void {
  const message = `${YELLOW}⚠️  ${msg}${RESET}`;
  if (err) console.warn(message, err);
  else console.warn(message);
}

/**
 * Print info message with blue ℹ️ prefix
 */
export function info(msg: string): void {
  console.log(`${BLUE}ℹ️  ${msg}${RESET}`);
}

/**
 * Print section separator with title
 */
export function section(title: string): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("=".repeat(60));
}

/**
 * Print line separator
 * @param char - Character to use for separator (default: "=")
 */
export function separator(char: string = "="): void {
  console.log(char.repeat(60));
}

/**
 * Format and print a test result
 * @param name - Test name
 * @param passed - Whether test passed
 * @param duration - Optional duration in milliseconds
 */
export function testResult(name: string, passed: boolean, duration?: number): void {
  const prefix = passed ? `${GREEN}✅` : `${RED}❌`;
  const durationStr = duration ? ` (${formatDuration(duration)})` : "";
  console.log(`${prefix} ${name}${durationStr}${RESET}`);
}

/**
 * Print formatted test summary table
 * @param results - Array of test results
 */
export function testSummary(results: TestResult[]): void {
  separator();
  console.log("TEST SUMMARY");
  separator("-");

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  results.forEach((result) => {
    testResult(result.name, result.passed, result.duration);
    if (!result.passed && result.error) {
      console.log(`   ${RED}${result.error}${RESET}`);
    }
  });

  separator("-");
  console.log(
    `Total: ${total} | ${GREEN}Passed: ${passed}${RESET} | ${RED}Failed: ${failed}${RESET}`
  );
  separator();

  if (failed > 0) {
    error(`${failed} test${failed !== 1 ? "s" : ""} failed`);
  } else {
    success("All tests passed!");
  }
}

/**
 * Format milliseconds to human-readable duration
 * @param ms - Duration in milliseconds
 * @returns Formatted duration string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms.toFixed(0)}ms`;
  } else if (ms < 60000) {
    return `${(ms / 1000).toFixed(2)}s`;
  } else {
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(0);
    return `${minutes}m ${seconds}s`;
  }
}

/**
 * Format bytes to human-readable memory size
 * @param bytes - Size in bytes
 * @returns Formatted size string (MB/GB)
 */
export function formatMemory(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) {
    return `${mb.toFixed(2)} MB`;
  } else {
    const gb = mb / 1024;
    return `${gb.toFixed(2)} GB`;
  }
}

/**
 * Format throughput as operations per second
 * @param count - Number of operations
 * @param duration - Duration in milliseconds
 * @returns Formatted throughput string
 */
export function formatThroughput(count: number, duration: number): string {
  const opsPerSec = (count / duration) * 1000;
  if (opsPerSec >= 1000000) {
    return `${(opsPerSec / 1000000).toFixed(2)}M ops/sec`;
  } else if (opsPerSec >= 1000) {
    return `${(opsPerSec / 1000).toFixed(2)}K ops/sec`;
  } else {
    return `${opsPerSec.toFixed(2)} ops/sec`;
  }
}

/**
 * Escape XML special characters
 * @param str - String to escape
 * @returns XML-safe string
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Export test results in JSON Lines format (NDJSON)
 * Each line is a complete JSON object for easy streaming and parsing
 *
 * @param results - Array of test results
 * @param outputPath - File path to write JSON Lines output
 * @param suiteName - Name of the test suite (e.g., "image-core", "image-functional-1")
 */
export async function exportJsonLines(
  results: TestResult[],
  outputPath: string,
  suiteName: string
): Promise<void> {
  try {
    const lines = results.map((result) => {
      const record = {
        suite: suiteName,
        name: result.name,
        passed: result.passed,
        duration: result.duration ?? 0,
        timestamp: new Date().toISOString(),
        ...(result.error ? { error: result.error } : {}),
      };
      return JSON.stringify(record);
    });

    const content = lines.join("\n") + "\n";
    await Bun.write(outputPath, content);
  } catch (err) {
    throw new Error(
      `Failed to export JSON Lines: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Export test results in JUnit XML format
 * Standard format for CI/CD integration (GitHub Actions, Jenkins, etc.)
 *
 * @param results - Array of test results
 * @param outputPath - File path to write JUnit XML output
 * @param suiteName - Name of the test suite
 */
export async function exportJunitXml(
  results: TestResult[],
  outputPath: string,
  suiteName: string
): Promise<void> {
  try {
    const totalTests = results.length;
    const failures = results.filter((r) => !r.passed).length;
    const totalTime = results.reduce((sum, r) => sum + (r.duration ?? 0), 0) / 1000; // Convert to seconds
    const timestamp = new Date().toISOString();

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += "<testsuites>\n";
    xml += `  <testsuite name="${escapeXml(suiteName)}" tests="${totalTests}" failures="${failures}" time="${totalTime.toFixed(3)}" timestamp="${timestamp}">\n`;

    for (const result of results) {
      const testTime = ((result.duration ?? 0) / 1000).toFixed(3);
      xml += `    <testcase name="${escapeXml(result.name)}" time="${testTime}"`;

      if (result.passed) {
        xml += "/>\n";
      } else {
        xml += ">\n";
        const errorMsg = result.error ?? "Test failed";
        xml += `      <failure message="${escapeXml(errorMsg)}"/>\n`;
        xml += "    </testcase>\n";
      }
    }

    xml += "  </testsuite>\n";
    xml += "</testsuites>\n";

    await Bun.write(outputPath, xml);
  } catch (err) {
    throw new Error(
      `Failed to export JUnit XML: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
