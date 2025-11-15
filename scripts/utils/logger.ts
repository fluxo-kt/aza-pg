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
