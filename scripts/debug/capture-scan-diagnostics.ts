#!/usr/bin/env bun

/**
 * Capture Security Scan Diagnostics
 *
 * Collects comprehensive Trivy security scan diagnostics for workflow failure debugging.
 * This script mirrors the diagnostic collection performed in build-postgres-image.yml
 * but can be run locally for troubleshooting security scan failures.
 *
 * Usage:
 *   bun scripts/debug/capture-scan-diagnostics.ts --image <ref> --output-dir <path> [OPTIONS]
 *
 * Required Options:
 *   --image <ref>        Image reference to scan (e.g., "aza-pg:latest", "ghcr.io/org/image:tag")
 *   --output-dir <path>  Directory for diagnostic files (will be created if missing)
 *
 * Optional:
 *   --cache-dir <path>   Trivy cache directory (default: .trivy-cache)
 *   --help              Show this help message
 *
 * Examples:
 *   # Scan local image
 *   bun scripts/debug/capture-scan-diagnostics.ts \
 *     --image aza-pg:pg18 \
 *     --output-dir /tmp/scan-diagnostics
 *
 *   # Scan remote image with custom cache
 *   bun scripts/debug/capture-scan-diagnostics.ts \
 *     --image ghcr.io/fluxo-kt/aza-pg:18.1-202511142330-single-node \
 *     --output-dir ./diagnostics \
 *     --cache-dir /tmp/trivy-cache
 *
 * Output Files:
 *   - trivy-full.txt         Full Trivy scan output (table format, all severities)
 *   - trivy-results.json     Trivy scan results in JSON format (for analysis)
 *   - image-metadata.txt     Docker image metadata (layers, digest, platform)
 *   - trivy-results.sarif    SARIF file (if exists in current directory)
 *
 * Exit codes:
 *   0 - Diagnostics captured successfully
 *   1 - Failure (missing options, command errors, etc.)
 *
 * Reference:
 *   Based on .github/workflows/build-postgres-image.yml:585-621
 */

import { $ } from "bun";
import { join, resolve } from "node:path";
import { statSync } from "node:fs";
import { error, success, warning, info, section } from "../utils/logger";
import { getErrorMessage } from "../utils/errors";

interface Options {
  image: string;
  outputDir: string;
  cacheDir: string;
}

function printHelp(): void {
  const helpText = `
Capture Security Scan Diagnostics - Collect Trivy scan diagnostics for debugging

Usage:
  bun scripts/debug/capture-scan-diagnostics.ts --image <ref> --output-dir <path> [OPTIONS]

Required Options:
  --image <ref>        Image reference to scan (e.g., "aza-pg:latest")
  --output-dir <path>  Directory for diagnostic files (will be created if missing)

Optional:
  --cache-dir <path>   Trivy cache directory (default: .trivy-cache)
  --help              Show this help message

Examples:
  # Scan local image
  bun scripts/debug/capture-scan-diagnostics.ts \\
    --image aza-pg:pg18 \\
    --output-dir /tmp/scan-diagnostics

  # Scan remote image with custom cache
  bun scripts/debug/capture-scan-diagnostics.ts \\
    --image ghcr.io/fluxo-kt/aza-pg:18.1-202511142330-single-node \\
    --output-dir ./diagnostics \\
    --cache-dir /tmp/trivy-cache

Output Files:
  - trivy-full.txt         Full Trivy scan (table format, all severities)
  - trivy-results.json     Trivy scan (JSON format for analysis)
  - image-metadata.txt     Docker image metadata (layers, digest, platform)
  - trivy-results.sarif    SARIF file (if exists in current directory)

Exit codes:
  0 - Diagnostics captured successfully
  1 - Failure (missing options, command errors, etc.)
`;
  console.log(helpText.trim());
}

function parseArgs(): Options | null {
  const args = Bun.argv.slice(2);

  const options: Partial<Options> = {
    cacheDir: ".trivy-cache",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;

      case "--image":
        if (i + 1 >= args.length) {
          error("--image requires a value");
          return null;
        }
        options.image = args[++i];
        break;

      case "--output-dir":
        if (i + 1 >= args.length) {
          error("--output-dir requires a value");
          return null;
        }
        options.outputDir = args[++i];
        break;

      case "--cache-dir":
        if (i + 1 >= args.length) {
          error("--cache-dir requires a value");
          return null;
        }
        options.cacheDir = args[++i];
        break;

      default:
        error(`Unknown option: ${arg}`);
        return null;
    }
  }

  // Validate required options
  if (!options.image) {
    error("Missing required option: --image");
    return null;
  }

  if (!options.outputDir) {
    error("Missing required option: --output-dir");
    return null;
  }

  return options as Options;
}

/**
 * Ensure output directory exists
 */
async function ensureOutputDir(outputDir: string): Promise<void> {
  const absPath = resolve(outputDir);

  try {
    const stat = statSync(absPath);
    if (stat.isDirectory()) {
      info(`Using existing output directory: ${absPath}`);
      return;
    }
  } catch {
    // Directory doesn't exist, create it
  }

  info(`Creating output directory: ${absPath}`);
  await $`mkdir -p ${absPath}`;
}

/**
 * Check if Docker is available
 */
async function checkDocker(): Promise<void> {
  try {
    await $`docker --version`.quiet();
  } catch (err) {
    error("Docker is not available", err);
    console.log();
    console.log("Install Docker to use this script:");
    console.log("  https://docs.docker.com/get-docker/");
    throw new Error("Docker not found");
  }
}

/**
 * Check if image exists locally
 */
async function checkImageExists(image: string): Promise<boolean> {
  try {
    await $`docker image inspect ${image}`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Capture full Trivy scan output (table format, all severities)
 */
async function captureTrivyFullScan(
  image: string,
  cacheDir: string,
  outputFile: string
): Promise<void> {
  info("Capturing full Trivy scan (table format, all severities)...");

  try {
    // Resolve absolute paths for volume mounting
    const absCacheDir = resolve(cacheDir);
    const absOutputFile = resolve(outputFile);

    // Run Trivy scan with all severities
    const result = await $`docker run --rm \
      -v ${absCacheDir}:/root/.cache/ \
      aquasec/trivy:latest image \
      --format table \
      --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL \
      ${image}`.text();

    // Write output to file
    await Bun.write(absOutputFile, result);
    success(`Saved: ${outputFile}`);
  } catch (err) {
    warning(`Failed to capture full Trivy scan: ${getErrorMessage(err)}`);
    // Continue despite error (best-effort diagnostic collection)
  }
}

/**
 * Capture Trivy scan in JSON format
 */
async function captureTrivyJsonScan(
  image: string,
  cacheDir: string,
  outputFile: string
): Promise<void> {
  info("Capturing Trivy scan (JSON format)...");

  try {
    // Resolve absolute paths for volume mounting
    const absCacheDir = resolve(cacheDir);
    const absOutputFile = resolve(outputFile);

    // Run Trivy scan with JSON output
    const result = await $`docker run --rm \
      -v ${absCacheDir}:/root/.cache/ \
      aquasec/trivy:latest image \
      --format json \
      --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL \
      ${image}`.text();

    // Write output to file
    await Bun.write(absOutputFile, result);
    success(`Saved: ${outputFile}`);
  } catch (err) {
    warning(`Failed to capture JSON Trivy scan: ${getErrorMessage(err)}`);
    // Continue despite error (best-effort diagnostic collection)
  }
}

/**
 * Capture Docker image metadata
 */
async function captureImageMetadata(image: string, outputFile: string): Promise<void> {
  info("Capturing image metadata...");

  try {
    const absOutputFile = resolve(outputFile);

    // Use buildx imagetools inspect for detailed metadata
    const result = await $`docker buildx imagetools inspect ${image}`.text();

    // Write output to file
    await Bun.write(absOutputFile, result);
    success(`Saved: ${outputFile}`);
  } catch (err) {
    warning(`Failed to capture image metadata: ${getErrorMessage(err)}`);
    // Continue despite error (best-effort diagnostic collection)
  }
}

/**
 * Copy SARIF file if it exists
 */
async function copySarifFile(outputDir: string): Promise<void> {
  const sarifPath = "trivy-results.sarif";

  if (await Bun.file(sarifPath).exists()) {
    info("Copying existing SARIF file...");
    try {
      const outputPath = join(outputDir, "trivy-results.sarif");
      const content = await Bun.file(sarifPath).text();
      await Bun.write(outputPath, content);
      success(`Saved: ${outputPath}`);
    } catch (err) {
      warning(`Failed to copy SARIF file: ${getErrorMessage(err)}`);
    }
  } else {
    info("No SARIF file found (trivy-results.sarif)");
  }
}

/**
 * Print summary of captured diagnostics
 */
function printSummary(outputDir: string): void {
  section("Diagnostic Collection Complete");

  console.log();
  console.log("Output directory:");
  console.log(`  ${resolve(outputDir)}`);
  console.log();
  console.log("Captured files:");
  console.log("  - trivy-full.txt         Full Trivy scan (table format)");
  console.log("  - trivy-results.json     Trivy scan results (JSON)");
  console.log("  - image-metadata.txt     Docker image metadata");
  console.log("  - trivy-results.sarif    SARIF file (if available)");
  console.log();
  console.log("Review the diagnostics:");
  console.log(`  cd ${outputDir}`);
  console.log("  cat trivy-full.txt");
  console.log("  cat image-metadata.txt");
  console.log();
}

/**
 * Main execution
 */
async function main(): Promise<void> {
  const options = parseArgs();

  if (!options) {
    printHelp();
    process.exit(1);
  }

  section("Capture Security Scan Diagnostics");

  console.log();
  info(`Image: ${options.image}`);
  info(`Output directory: ${options.outputDir}`);
  info(`Cache directory: ${options.cacheDir}`);
  console.log();

  // Pre-flight checks
  await checkDocker();

  // Check if image exists locally or remotely
  const imageExists = await checkImageExists(options.image);
  if (!imageExists) {
    warning(`Image not found locally: ${options.image} (Trivy will attempt to pull from registry)`);
  }

  // Ensure output directory exists
  ensureOutputDir(options.outputDir);

  // Ensure cache directory exists
  const absCacheDir = resolve(options.cacheDir);
  try {
    const stat = statSync(absCacheDir);
    if (!stat.isDirectory()) {
      info(`Cache path exists but is not a directory, creating: ${absCacheDir}`);
      await $`mkdir -p ${absCacheDir}`;
    }
  } catch {
    info(`Creating cache directory: ${absCacheDir}`);
    await $`mkdir -p ${absCacheDir}`;
  }

  console.log();
  section("Collecting Diagnostics");
  console.log();

  // Capture diagnostics (best-effort, continue on errors)
  await captureTrivyFullScan(
    options.image,
    options.cacheDir,
    join(options.outputDir, "trivy-full.txt")
  );

  await captureTrivyJsonScan(
    options.image,
    options.cacheDir,
    join(options.outputDir, "trivy-results.json")
  );

  await captureImageMetadata(options.image, join(options.outputDir, "image-metadata.txt"));

  await copySarifFile(options.outputDir);

  console.log();
  printSummary(options.outputDir);

  success("Security scan diagnostics captured successfully");
}

// Run main and handle errors
main().catch((err) => {
  console.log();
  error("Failed to capture diagnostics", err);
  console.log();
  console.log("Common issues:");
  console.log("  - Docker is not running");
  console.log("  - Image does not exist and cannot be pulled");
  console.log("  - Network connectivity issues (pulling Trivy image)");
  console.log("  - Insufficient disk space");
  console.log();
  process.exit(1);
});
