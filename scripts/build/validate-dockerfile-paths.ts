#!/usr/bin/env bun

/**
 * Validate Dockerfile COPY Paths
 *
 * Validates that all source paths referenced in Dockerfile COPY instructions exist
 * in the build context. This catches missing files early before Docker build fails.
 *
 * Usage:
 *   bun scripts/build/validate-dockerfile-paths.ts [OPTIONS]
 *
 * Options:
 *   --verbose    Show detailed output for each path check
 *   --help       Show this help message
 *
 * Examples:
 *   bun scripts/build/validate-dockerfile-paths.ts
 *   bun scripts/build/validate-dockerfile-paths.ts --verbose
 *
 * Exit codes:
 *   0 - All required paths exist
 *   1 - One or more required paths are missing
 *
 * Note:
 *   This script validates paths referenced in Dockerfile COPY instructions.
 *   Paths are relative to the repository root (build context).
 */

import { join } from "node:path";
import { error, success, info, warning } from "../utils/logger";
import { getErrorMessage } from "../utils/errors";

interface Options {
  verbose: boolean;
}

interface PathCheck {
  path: string;
  description: string;
}

/**
 * Required paths referenced in Dockerfile COPY instructions
 * These paths are relative to the repository root (build context)
 */
const REQUIRED_PATHS: PathCheck[] = [
  // Builder stage - extensions build
  {
    path: "docker/postgres/extensions.manifest.json",
    description: "Extensions manifest (single source of truth)",
  },
  {
    path: "docker/postgres/extensions.build-packages.txt",
    description: "Build-time package dependencies list",
  },
  {
    path: "docker/postgres/build-extensions.ts",
    description: "Extension build script (TypeScript)",
  },

  // Runtime stage - package dependencies
  {
    path: "docker/postgres/extensions.runtime-packages.txt",
    description: "Runtime package dependencies list",
  },

  // Final stage - entrypoint and configuration
  {
    path: "docker/postgres/docker-auto-config-entrypoint.sh",
    description: "PostgreSQL auto-configuration entrypoint script",
  },
  {
    path: "docker/postgres/docker-entrypoint-initdb.d",
    description: "Initialization scripts directory",
  },
  {
    path: "docker/postgres/configs/postgresql-base.conf",
    description: "Base PostgreSQL configuration file",
  },
];

function printHelp(): void {
  const helpText = `
Validate Dockerfile COPY Paths - Verify build context files exist

Usage:
  bun scripts/build/validate-dockerfile-paths.ts [OPTIONS]

Options:
  --verbose    Show detailed output for each path check
  --help       Show this help message

Examples:
  # Basic validation
  bun scripts/build/validate-dockerfile-paths.ts

  # Verbose output with details for each path
  bun scripts/build/validate-dockerfile-paths.ts --verbose

Description:
  Validates that all source paths referenced in Dockerfile COPY instructions
  exist in the build context. This prevents Docker build failures due to
  missing files and provides early feedback during CI/CD workflows.

  Checks:
    - Extension manifest and build scripts
    - Package dependency lists (build and runtime)
    - Entrypoint scripts and configuration files
    - Initialization scripts directory

Exit Codes:
  0 - All required paths exist
  1 - One or more required paths are missing
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
 * Check if a path exists (file or directory)
 * @param repoRoot - Repository root directory
 * @param pathCheck - Path to check with description
 * @param verbose - Show detailed output
 * @returns true if path exists, false otherwise
 */
async function checkPath(
  repoRoot: string,
  pathCheck: PathCheck,
  verbose: boolean
): Promise<boolean> {
  const fullPath = join(repoRoot, pathCheck.path);

  try {
    // Try as file first using Bun.file().exists()
    const file = Bun.file(fullPath);
    let exists = await file.exists();

    // If file check fails, try as directory using Bun.$
    if (!exists) {
      const result = await Bun.$`test -d ${fullPath}`.quiet().nothrow();
      exists = result.exitCode === 0;
    }

    if (verbose) {
      const status = exists ? "✅" : "❌";
      console.log(`${status} ${pathCheck.path.padEnd(55)} ${pathCheck.description}`);
    }

    if (!exists) {
      // Output GitHub Actions error annotation if in CI
      if (Bun.env.GITHUB_ACTIONS === "true") {
        console.log(`::error::Missing path: ${pathCheck.path} (${pathCheck.description})`);
      }
    }

    return exists;
  } catch (err) {
    // If both checks fail, the path definitely doesn't exist
    if (verbose) {
      console.log(`❌ ${pathCheck.path.padEnd(55)} ${pathCheck.description}`);
      warning(`  Error checking path: ${getErrorMessage(err)}`);
    }

    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.log(
        `::error::Missing path: ${pathCheck.path} (${pathCheck.description}) - ${getErrorMessage(err)}`
      );
    }

    return false;
  }
}

async function main(): Promise<void> {
  const options = parseArgs();

  // Determine repository root (script is in scripts/build/)
  const repoRoot = join(import.meta.dir, "../..");

  if (options.verbose) {
    info("Validating Dockerfile COPY paths exist in build context...");
    console.log();
  } else {
    info("🔍 Validating Dockerfile COPY paths...");
  }

  // Check all paths in parallel for better performance
  const results = await Promise.all(
    REQUIRED_PATHS.map((pathCheck) => checkPath(repoRoot, pathCheck, options.verbose))
  );

  const allPassed = results.every((r) => r === true);
  const failedCount = results.filter((r) => !r).length;

  if (!options.verbose) {
    console.log(); // Blank line for spacing
  }

  if (allPassed) {
    success("✅ All Dockerfile COPY paths validated");
    process.exit(0);
  } else {
    error(`❌ Validation failed: ${failedCount} missing path(s)`);
    console.log();
    console.log("Missing paths:");
    REQUIRED_PATHS.forEach((pathCheck, index) => {
      if (!results[index]) {
        console.log(`  - ${pathCheck.path}`);
        console.log(`    (${pathCheck.description})`);
      }
    });

    console.log();
    console.log("Fix:");
    console.log("  Ensure all required files exist before building the Docker image.");
    console.log("  These paths are referenced in Dockerfile COPY instructions.");

    process.exit(1);
  }
}

main().catch((err) => {
  error("Fatal error during validation", err);
  process.exit(1);
});
