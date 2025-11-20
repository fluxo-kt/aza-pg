#!/usr/bin/env bun
/**
 * Capture Test Failure Logs & Diagnostics
 *
 * Consolidates diagnostic capture logic for test failures.
 * Captures container logs, state, and test artifacts.
 *
 * Usage:
 *   bun scripts/debug/capture-test-failure-logs.ts \
 *     --test-type smoke \
 *     --output-dir /tmp/smoke-logs \
 *     --containers "container1,container2"
 *
 *   With optional test results:
 *     bun scripts/debug/capture-test-failure-logs.ts \
 *       --test-type pgflow \
 *       --output-dir ${{ runner.temp }}/pgflow-logs \
 *       --containers "publish-pgflow-test,publish-pgflow-v072-test" \
 *       --test-results ./test-results.json
 *
 * Exit Codes:
 *   0 - Diagnostics captured successfully
 *   1 - Failed to capture diagnostics
 */

import { $ } from "bun";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { info, section, success, warning, error } from "../utils/logger";

interface CaptureOptions {
  testType: string;
  outputDir: string;
  containers?: string[]; // Optional when allContainers is true
  allContainers: boolean; // Capture all running/stopped containers
  testResults?: string;
}

/**
 * Capture container logs and state
 */
async function captureContainerDiagnostics(container: string, outputDir: string): Promise<void> {
  // Check if container exists
  const exists = await $`docker ps -a --filter name=${container} --format "{{.Names}}"`
    .nothrow()
    .text();

  if (!exists.includes(container)) {
    warning(`Container ${container} not found, skipping`);
    return;
  }

  info(`Capturing logs for: ${container}`);

  try {
    // Container logs (stdout + stderr)
    const logs = await $`docker logs ${container}`.nothrow();
    await Bun.write(
      `${outputDir}/${container}.log`,
      `=== STDOUT ===\n${logs.stdout}\n\n=== STDERR ===\n${logs.stderr}`
    );

    // Container state (JSON)
    const state = await $`docker inspect ${container} --format "{{json .State}}"`.nothrow().text();
    await Bun.write(`${outputDir}/${container}-state.json`, state);

    // Container config (JSON)
    const config = await $`docker inspect ${container} --format "{{json .Config}}"`
      .nothrow()
      .text();
    await Bun.write(`${outputDir}/${container}-config.json`, config);

    // Health check status (if exists)
    const health = await $`docker inspect ${container} --format "{{json .State.Health}}"`
      .nothrow()
      .text();
    if (health && health.trim() !== "null" && health.trim() !== "<no value>") {
      await Bun.write(`${outputDir}/${container}-health.json`, health);
    }

    success(`✓ Captured diagnostics for ${container}`);
  } catch (err) {
    warning(
      `Failed to capture diagnostics for ${container}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Capture test results file
 */
async function captureTestResults(testResults: string, outputDir: string): Promise<void> {
  if (!existsSync(testResults)) {
    warning(`Test results file not found: ${testResults}`);
    return;
  }

  try {
    const content = await Bun.file(testResults).text();
    await Bun.write(`${outputDir}/test-results.json`, content);
    success(`✓ Captured test results from ${testResults}`);
  } catch (err) {
    warning(`Failed to capture test results: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Create diagnostic summary
 */
async function createSummary(
  options: CaptureOptions,
  capturedContainers: string[],
  outputDir: string
): Promise<void> {
  const summary = [
    `Test Type: ${options.testType}`,
    `Timestamp: ${new Date().toISOString()}`,
    `Containers: ${capturedContainers.join(", ")}`,
    `Capture Mode: ${options.allContainers ? "All containers" : "Specific containers"}`,
    ``,
    `Files Captured:`,
  ];

  // List all files in output dir
  try {
    const files = await Array.fromAsync(
      new Bun.Glob("*").scan({ cwd: outputDir, onlyFiles: true })
    );
    files.sort().forEach((file) => {
      summary.push(`  - ${file}`);
    });
  } catch {
    summary.push("  (unable to list files)");
  }

  summary.push("");
  summary.push("Use these files to diagnose test failures.");

  await Bun.write(`${outputDir}/README.txt`, summary.join("\n"));
}

/**
 * Main capture function
 */
async function captureTestFailureLogs(options: CaptureOptions): Promise<number> {
  section(`Capturing ${options.testType} Test Failure Diagnostics`);
  info(`Output directory: ${options.outputDir}`);

  try {
    // Create output directory
    await mkdir(options.outputDir, { recursive: true });

    // Determine which containers to capture
    let containersToCapture: string[] = [];

    if (options.allContainers) {
      info("Capturing all running/stopped containers...");
      const allContainersOutput = await $`docker ps -a --format "{{.Names}}"`.nothrow().text();
      containersToCapture = allContainersOutput
        .split("\n")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);

      if (containersToCapture.length === 0) {
        warning("No containers found to capture");
        return 0;
      }

      info(`Found ${containersToCapture.length} containers`);
    } else {
      containersToCapture = options.containers ?? [];

      if (containersToCapture.length === 0) {
        error("No containers specified and --all-containers not set");
        return 1;
      }
    }

    // Capture container diagnostics
    for (const container of containersToCapture) {
      await captureContainerDiagnostics(container, options.outputDir);
    }

    // Capture test results if provided
    if (options.testResults) {
      await captureTestResults(options.testResults, options.outputDir);
    }

    // Create summary
    await createSummary(options, containersToCapture, options.outputDir);

    success(`✅ Diagnostics captured to: ${options.outputDir}`);
    return 0;
  } catch (err) {
    error(`Failed to capture diagnostics: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// Main execution
if (import.meta.main) {
  // Handle --help before parseArgs
  if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
    console.log(
      `
Capture Test Failure Logs & Diagnostics

Usage:
  bun scripts/debug/capture-test-failure-logs.ts \\
    --test-type TYPE --output-dir DIR [--containers CONTAINERS | --all-containers] [OPTIONS]

Required Options:
  --test-type TYPE        Test type (e.g., smoke, pgflow, extensions)
  --output-dir DIR        Output directory for diagnostics

Container Selection (choose one):
  --containers CONTAINERS Comma-separated container names
  --all-containers        Capture all running/stopped containers

Optional Options:
  --test-results PATH     Path to test results JSON file
  --help, -h              Show this help message

Examples:
  # Capture specific containers
  bun scripts/debug/capture-test-failure-logs.ts \\
    --test-type smoke \\
    --output-dir /tmp/smoke-logs \\
    --containers "container1,container2"

  # Capture all containers
  bun scripts/debug/capture-test-failure-logs.ts \\
    --test-type extensions \\
    --output-dir /tmp/extension-logs \\
    --all-containers

  # With test results
  bun scripts/debug/capture-test-failure-logs.ts \\
    --test-type pgflow \\
    --output-dir \${{ runner.temp }}/pgflow-logs \\
    --containers "publish-pgflow-test,publish-pgflow-v072-test" \\
    --test-results ./test-results.json

Exit Codes:
  0 - Diagnostics captured successfully
  1 - Failed to capture diagnostics
    `.trim()
    );
    process.exit(0);
  }

  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "test-type": { type: "string" },
      "output-dir": { type: "string" },
      containers: { type: "string" }, // comma-separated (optional if --all-containers is set)
      "all-containers": { type: "boolean", default: false },
      "test-results": { type: "string" }, // optional path to test results file
    },
  });

  if (!values["test-type"] || !values["output-dir"]) {
    error("Missing required arguments");
    console.log("\nUsage:");
    console.log("  bun scripts/debug/capture-test-failure-logs.ts \\");
    console.log("    --test-type <type> \\");
    console.log("    --output-dir <dir> \\");
    console.log("    [--containers <container1,container2,...> | --all-containers] \\");
    console.log("    [--test-results <path>]");
    process.exit(1);
  }

  const allContainers = values["all-containers"] ?? false;

  // Validate that either containers or all-containers is provided
  if (!allContainers && !values.containers) {
    error("Must specify either --containers or --all-containers");
    console.log("\nUsage:");
    console.log("  bun scripts/debug/capture-test-failure-logs.ts \\");
    console.log("    --test-type <type> \\");
    console.log("    --output-dir <dir> \\");
    console.log("    [--containers <container1,container2,...> | --all-containers] \\");
    console.log("    [--test-results <path>]");
    process.exit(1);
  }

  const options: CaptureOptions = {
    testType: values["test-type"]!,
    outputDir: values["output-dir"]!,
    containers: values.containers ? values.containers.split(",").map((c) => c.trim()) : undefined,
    allContainers,
    testResults: values["test-results"],
  };

  process.exit(await captureTestFailureLogs(options));
}
