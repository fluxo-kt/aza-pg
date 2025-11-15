#!/usr/bin/env bun

/**
 * Verify extensions.manifest.json is up-to-date
 *
 * This script ensures that the committed extensions.manifest.json matches the
 * version that would be generated from the current manifest-data.ts source.
 * It excludes the `.generatedAt` timestamp field when comparing.
 *
 * Usage:
 *   bun scripts/ci/verify-manifest-sync.ts [OPTIONS]
 *
 * Options:
 *   --help             Show this help message
 *   --verbose          Show detailed diff output
 *
 * Examples:
 *   # Verify manifest is in sync
 *   bun scripts/ci/verify-manifest-sync.ts
 *
 *   # Verify with detailed diff output
 *   bun scripts/ci/verify-manifest-sync.ts --verbose
 *
 *   # GitHub Actions usage (automatic ::error:: annotations)
 *   CI=true bun scripts/ci/verify-manifest-sync.ts
 *
 * Exit codes:
 *   0 - Manifest is up-to-date
 *   1 - Manifest is out of date or generation failed
 *
 * Process:
 *   1. Generate fresh manifest from manifest-data.ts
 *   2. Read committed version from git HEAD
 *   3. Deep compare JSON (excluding .generatedAt timestamps)
 *   4. Exit with appropriate status code
 */

import { join } from "node:path";
import { error, success, info, warning } from "../utils/logger";
import { getErrorMessage } from "../utils/errors";

interface Options {
  verbose: boolean;
}

function printHelp(): void {
  const helpText = `
Verify extensions.manifest.json is up-to-date

Usage:
  bun scripts/ci/verify-manifest-sync.ts [OPTIONS]

Options:
  --verbose          Show detailed diff output
  --help             Show this help message

Examples:
  bun scripts/ci/verify-manifest-sync.ts
  bun scripts/ci/verify-manifest-sync.ts --verbose
  CI=true bun scripts/ci/verify-manifest-sync.ts

Exit codes:
  0 - Manifest is up-to-date
  1 - Manifest is out of date or generation failed

Process:
  1. Generate fresh manifest from manifest-data.ts
  2. Read committed version from git HEAD
  3. Deep compare JSON (excluding .generatedAt timestamps)
  4. Exit with appropriate status code
`;
  console.log(helpText.trim());
}

function parseArgs(): Options {
  const args = Bun.argv.slice(2);

  const options: Options = {
    verbose: false,
  };

  for (const arg of args) {
    switch (arg) {
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;

      case "--verbose":
      case "-v":
        options.verbose = true;
        break;

      default:
        error(`Unknown option: ${arg}`);
        printHelp();
        process.exit(1);
    }
  }

  return options;
}

/**
 * Generate fresh manifest by running generate-manifest.ts
 */
async function generateFreshManifest(repoRoot: string): Promise<void> {
  const generateScript = join(repoRoot, "scripts/extensions/generate-manifest.ts");

  info("Generating fresh manifest...");

  const proc = Bun.spawn(["bun", generateScript], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(
      `Failed to generate manifest (exit code ${exitCode})${stderr ? `:\n${stderr}` : ""}`
    );
  }

  success("Fresh manifest generated");
}

/**
 * Read committed version of manifest from git HEAD
 */
async function readCommittedManifest(repoRoot: string): Promise<string> {
  const manifestPath = "docker/postgres/extensions.manifest.json";

  info("Reading committed manifest from git HEAD...");

  const proc = Bun.spawn(["git", "show", `HEAD:${manifestPath}`], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(
      `Failed to read committed manifest from git (exit code ${exitCode})${stderr ? `:\n${stderr}` : ""}`
    );
  }

  return stdout;
}

/**
 * Read generated (working tree) version of manifest
 */
async function readGeneratedManifest(repoRoot: string): Promise<string> {
  const manifestPath = join(repoRoot, "docker/postgres/extensions.manifest.json");

  info("Reading generated manifest from working tree...");

  try {
    return await Bun.file(manifestPath).text();
  } catch (err) {
    throw new Error(
      `Failed to read generated manifest at ${manifestPath}: ${getErrorMessage(err)}`
    );
  }
}

/**
 * Parse JSON and remove .generatedAt field for comparison
 */
function parseAndNormalizeJson(jsonText: string): any {
  try {
    const parsed = JSON.parse(jsonText);
    // Remove generatedAt timestamp field (always differs)
    delete parsed.generatedAt;
    return parsed;
  } catch (err) {
    throw new Error(`Failed to parse JSON: ${getErrorMessage(err)}`);
  }
}

/**
 * Deep compare two objects for equality
 */
function deepEqual(a: any, b: any): boolean {
  // Stringify with sorted keys for consistent comparison
  const jsonA = JSON.stringify(a, Object.keys(a).sort());
  const jsonB = JSON.stringify(b, Object.keys(b).sort());
  return jsonA === jsonB;
}

/**
 * Generate a readable diff between two JSON objects
 */
function generateJsonDiff(committed: any, generated: any): string {
  const committedStr = JSON.stringify(committed, null, 2);
  const generatedStr = JSON.stringify(generated, null, 2);

  const committedLines = committedStr.split("\n");
  const generatedLines = generatedStr.split("\n");

  const maxLines = Math.max(committedLines.length, generatedLines.length);
  const diffLines: string[] = [];

  for (let i = 0; i < maxLines; i++) {
    const committedLine = committedLines[i] ?? "";
    const generatedLine = generatedLines[i] ?? "";

    if (committedLine !== generatedLine) {
      if (committedLine) {
        diffLines.push(`- ${committedLine}`);
      }
      if (generatedLine) {
        diffLines.push(`+ ${generatedLine}`);
      }
    }
  }

  return diffLines.join("\n");
}

/**
 * Output GitHub Actions error annotation
 */
function githubError(message: string): void {
  console.error(`::error::${message}`);
}

async function main(): Promise<void> {
  const options = parseArgs();

  // Resolve repo root
  const repoRoot = join(import.meta.dir, "../..");

  try {
    // Step 1: Generate fresh manifest
    await generateFreshManifest(repoRoot);

    // Step 2: Read committed version from git
    const committedText = await readCommittedManifest(repoRoot);

    // Step 3: Read generated version
    const generatedText = await readGeneratedManifest(repoRoot);

    // Step 4: Parse and normalize both versions
    const committedJson = parseAndNormalizeJson(committedText);
    const generatedJson = parseAndNormalizeJson(generatedText);

    // Step 5: Deep compare
    const isEqual = deepEqual(committedJson, generatedJson);

    if (isEqual) {
      success("extensions.manifest.json is up-to-date");
      process.exit(0);
    } else {
      // Manifest is out of date
      const errorMessage = "extensions.manifest.json content is out of date (excluding timestamp).";
      const fixMessage = "Run: bun scripts/extensions/generate-manifest.ts";

      error(errorMessage);
      console.error(fixMessage);

      // GitHub Actions annotation
      if (Bun.env.CI === "true") {
        githubError(errorMessage);
        console.error(`::error::${fixMessage}`);
      }

      // Show diff if verbose
      if (options.verbose) {
        console.error("\nDifferences found:");
        console.error("==================");
        const diff = generateJsonDiff(committedJson, generatedJson);
        console.error(diff);
        console.error("==================\n");
      } else {
        warning("Use --verbose to see detailed diff");
      }

      process.exit(1);
    }
  } catch (err) {
    error(`Verification failed: ${getErrorMessage(err)}`);

    if (Bun.env.CI === "true") {
      githubError(`Manifest verification failed: ${getErrorMessage(err)}`);
    }

    process.exit(1);
  }
}

main();
