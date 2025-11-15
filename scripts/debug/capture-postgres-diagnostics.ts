#!/usr/bin/env bun

/**
 * Capture PostgreSQL container diagnostics for debugging workflow failures
 *
 * This script collects comprehensive diagnostic information from a running PostgreSQL
 * container, including logs, configuration, extensions, and version info. Designed for
 * CI/CD failure debugging and local troubleshooting.
 *
 * Usage:
 *   bun scripts/debug/capture-postgres-diagnostics.ts --container <name> --output-dir <path> [OPTIONS]
 *
 * Options:
 *   --container <name>       PostgreSQL container name (required)
 *   --output-dir <path>      Directory for diagnostic files (required)
 *   --include-stack-logs     Also capture docker compose logs from current directory
 *   --stack-tail <n>         Number of stack log lines (default: 200)
 *   --help                   Show this help message
 *
 * Examples:
 *   # Basic diagnostic capture
 *   bun scripts/debug/capture-postgres-diagnostics.ts \
 *     --container pg-ext-test \
 *     --output-dir /tmp/diagnostics
 *
 *   # Include docker compose logs from stack
 *   cd stacks/primary
 *   bun ../../scripts/debug/capture-postgres-diagnostics.ts \
 *     --container postgres-primary \
 *     --output-dir /tmp/diagnostics \
 *     --include-stack-logs
 *
 *   # Custom stack log tail size
 *   bun scripts/debug/capture-postgres-diagnostics.ts \
 *     --container pg-test \
 *     --output-dir ./diag \
 *     --include-stack-logs \
 *     --stack-tail 500
 *
 * What gets collected:
 *   1. Container logs (docker logs)
 *   2. PostgreSQL configuration (SHOW ALL)
 *   3. Shared preload libraries (SHOW shared_preload_libraries)
 *   4. Extension catalog (pg_available_extensions)
 *   5. Version info (/etc/postgresql/version-info.txt)
 *   6. Stack logs (docker compose logs, if --include-stack-logs)
 *
 * Exit codes:
 *   0 - Success (all diagnostics captured)
 *   1 - Failure (missing requirements, container not running, etc.)
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { error, success, info, warning, section } from "../utils/logger.js";
import { getErrorMessage } from "../utils/errors.js";

interface Options {
  container: string;
  outputDir: string;
  includeStackLogs: boolean;
  stackTail: number;
}

function printHelp(): void {
  const helpText = `
Capture PostgreSQL container diagnostics for debugging

Usage:
  bun scripts/debug/capture-postgres-diagnostics.ts --container <name> --output-dir <path> [OPTIONS]

Required Options:
  --container <name>       PostgreSQL container name
  --output-dir <path>      Directory for diagnostic files

Optional Flags:
  --include-stack-logs     Also capture docker compose logs
  --stack-tail <n>         Number of stack log lines (default: 200)
  --help                   Show this help message

Examples:
  # Basic capture
  bun scripts/debug/capture-postgres-diagnostics.ts \\
    --container pg-ext-test \\
    --output-dir /tmp/diagnostics

  # With docker compose logs
  cd stacks/primary
  bun ../../scripts/debug/capture-postgres-diagnostics.ts \\
    --container postgres-primary \\
    --output-dir /tmp/diagnostics \\
    --include-stack-logs

What gets collected:
  - Container logs
  - PostgreSQL configuration (SHOW ALL)
  - Shared preload libraries
  - Extension catalog
  - Image version info
  - Stack logs (if --include-stack-logs)
`;
  console.log(helpText.trim());
}

function parseArgs(): Options | null {
  const args = Bun.argv.slice(2);

  if (args.length === 0) {
    error("No arguments provided");
    printHelp();
    return null;
  }

  const options: Partial<Options> = {
    includeStackLogs: false,
    stackTail: 200,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;

      case "--container":
        if (i + 1 >= args.length) {
          error("--container requires a container name");
          return null;
        }
        options.container = args[i + 1];
        i++;
        break;

      case "--output-dir":
        if (i + 1 >= args.length) {
          error("--output-dir requires a path argument");
          return null;
        }
        options.outputDir = args[i + 1];
        i++;
        break;

      case "--include-stack-logs":
        options.includeStackLogs = true;
        break;

      case "--stack-tail":
        if (i + 1 >= args.length) {
          error("--stack-tail requires a number");
          return null;
        }
        const tailArg = args[i + 1];
        if (!tailArg) {
          error("--stack-tail requires a non-empty number");
          return null;
        }
        const tail = parseInt(tailArg, 10);
        if (isNaN(tail) || tail <= 0) {
          error("--stack-tail must be a positive number");
          return null;
        }
        options.stackTail = tail;
        i++;
        break;

      default:
        error(`Unknown option: ${arg}`);
        printHelp();
        return null;
    }
  }

  // Validate required options
  if (!options.container) {
    error("Missing required option: --container");
    printHelp();
    return null;
  }

  if (!options.outputDir) {
    error("Missing required option: --output-dir");
    printHelp();
    return null;
  }

  return options as Options;
}

/**
 * Execute a shell command and capture output
 * Returns stdout+stderr combined, or null on failure
 */
async function execCapture(command: string[], description: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const errOutput = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    // Combine stdout and stderr (like 2>&1)
    const combined = output + errOutput;

    if (exitCode !== 0) {
      warning(`${description} exited with code ${exitCode}`);
      return combined || null;
    }

    return combined;
  } catch (err) {
    warning(`${description} failed: ${getErrorMessage(err)}`);
    return null;
  }
}

/**
 * Write diagnostic output to file with header
 */
async function writeDiagnostic(
  filePath: string,
  header: string,
  content: string | null
): Promise<void> {
  const fullContent = content
    ? `=== ${header} ===\n\n${content}`
    : `=== ${header} ===\n\n[No data available]\n`;

  try {
    await Bun.write(filePath, fullContent);
    success(`Wrote ${header} to ${filePath}`);
  } catch (err) {
    error(`Failed to write ${filePath}: ${getErrorMessage(err)}`);
  }
}

/**
 * Check if docker is available
 */
async function checkDockerAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Check if container exists and is running
 */
async function checkContainerRunning(container: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "inspect", "-f", "{{.State.Running}}", container], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return false;
    }

    return output.trim() === "true";
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  section("PostgreSQL Diagnostics Capture");

  const options = parseArgs();
  if (!options) {
    process.exit(1);
  }

  info(`Container: ${options.container}`);
  info(`Output directory: ${options.outputDir}`);
  info(`Include stack logs: ${options.includeStackLogs}`);

  // Pre-flight checks
  if (!(await checkDockerAvailable())) {
    error("Docker is not available. Please ensure Docker is installed and running.");
    process.exit(1);
  }

  if (!(await checkContainerRunning(options.container))) {
    error(`Container '${options.container}' is not running or does not exist.`);
    info("Run 'docker ps -a' to check container status");
    process.exit(1);
  }

  // Create output directory
  try {
    await mkdir(options.outputDir, { recursive: true });
    success(`Created output directory: ${options.outputDir}`);
  } catch (err) {
    error(`Failed to create output directory: ${getErrorMessage(err)}`);
    process.exit(1);
  }

  section("Collecting Diagnostics");

  // 1. Container logs
  info("Capturing container logs...");
  const containerLogs = await execCapture(
    ["docker", "logs", options.container],
    "Container logs capture"
  );
  await writeDiagnostic(
    join(options.outputDir, "container-logs.txt"),
    "Container Logs",
    containerLogs
  );

  // 2. PostgreSQL configuration (SHOW ALL)
  info("Capturing PostgreSQL configuration...");
  const pgConfig = await execCapture(
    ["docker", "exec", options.container, "psql", "-U", "postgres", "-c", "SHOW ALL;"],
    "PostgreSQL configuration"
  );
  await writeDiagnostic(
    join(options.outputDir, "postgres-config.txt"),
    "PostgreSQL Configuration (SHOW ALL)",
    pgConfig
  );

  // 3. Shared preload libraries
  info("Capturing shared preload libraries...");
  const sharedPreload = await execCapture(
    [
      "docker",
      "exec",
      options.container,
      "psql",
      "-U",
      "postgres",
      "-c",
      "SHOW shared_preload_libraries;",
    ],
    "Shared preload libraries"
  );
  await writeDiagnostic(
    join(options.outputDir, "shared-preload.txt"),
    "Shared Preload Libraries",
    sharedPreload
  );

  // 4. Extension catalog
  info("Capturing extension catalog...");
  const extensions = await execCapture(
    [
      "docker",
      "exec",
      options.container,
      "psql",
      "-U",
      "postgres",
      "-c",
      "SELECT * FROM pg_available_extensions ORDER BY name;",
    ],
    "Extension catalog"
  );
  await writeDiagnostic(
    join(options.outputDir, "extensions.txt"),
    "PostgreSQL Extension Catalog",
    extensions
  );

  // 5. Version info
  info("Capturing version info...");
  const versionInfo = await execCapture(
    ["docker", "exec", options.container, "cat", "/etc/postgresql/version-info.txt"],
    "Version info"
  );
  await writeDiagnostic(
    join(options.outputDir, "version-info.txt"),
    "Image Version Info",
    versionInfo
  );

  // 6. Stack logs (optional)
  if (options.includeStackLogs) {
    info(`Capturing docker compose logs (tail=${options.stackTail})...`);
    const stackLogs = await execCapture(
      ["docker", "compose", "logs", `--tail=${options.stackTail}`],
      "Docker compose logs"
    );
    await writeDiagnostic(
      join(options.outputDir, "stack-logs.txt"),
      `Docker Compose Logs (tail=${options.stackTail})`,
      stackLogs
    );
  }

  section("Diagnostics Complete");
  success(`All diagnostics captured to: ${options.outputDir}`);

  // List captured files
  info("Captured files:");
  const files = [
    "container-logs.txt",
    "postgres-config.txt",
    "shared-preload.txt",
    "extensions.txt",
    "version-info.txt",
  ];

  if (options.includeStackLogs) {
    files.push("stack-logs.txt");
  }

  for (const file of files) {
    console.log(`  - ${join(options.outputDir, file)}`);
  }

  console.log();
}

main();
