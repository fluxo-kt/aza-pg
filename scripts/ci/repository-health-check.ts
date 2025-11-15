#!/usr/bin/env bun

/**
 * Repository Health Check
 *
 * Verifies that all required files and directories exist in the repository.
 * This is used as a sanity check before builds to catch missing files early.
 *
 * Usage:
 *   bun scripts/ci/repository-health-check.ts [OPTIONS]
 *
 * Options:
 *   --verbose    Show detailed output for each check
 *   --help       Show this help message
 *
 * Examples:
 *   bun scripts/ci/repository-health-check.ts
 *   bun scripts/ci/repository-health-check.ts --verbose
 *
 * Exit codes:
 *   0 - All required files and directories exist
 *   1 - One or more required items are missing
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { error, success, info } from "../utils/logger";

interface Options {
  verbose: boolean;
}

interface CheckItem {
  type: "file" | "directory";
  path: string;
  description: string;
}

// Required files and directories for aza-pg repository
const REQUIRED_ITEMS: CheckItem[] = [
  // Core configuration files
  {
    type: "file",
    path: "docker/postgres/Dockerfile",
    description: "PostgreSQL Docker image definition",
  },
  {
    type: "file",
    path: "docker/postgres/extensions.manifest.json",
    description: "Extensions manifest (single source of truth)",
  },
  {
    type: "file",
    path: "package.json",
    description: "Node.js package configuration",
  },
  {
    type: "file",
    path: ".tool-versions",
    description: "Tool versions for asdf/mise",
  },

  // Stack directories
  {
    type: "directory",
    path: "stacks/primary",
    description: "Primary stack deployment configuration",
  },
  {
    type: "directory",
    path: "stacks/replica",
    description: "Replica stack deployment configuration",
  },
  {
    type: "directory",
    path: "stacks/single",
    description: "Single-node stack deployment configuration",
  },

  // Scripts directory
  {
    type: "directory",
    path: "scripts",
    description: "Build and utility scripts",
  },

  // Docker build context files
  {
    type: "file",
    path: "docker/postgres/build-extensions.ts",
    description: "Extension build script (run inside Docker)",
  },
  {
    type: "file",
    path: "docker/postgres/docker-auto-config-entrypoint.sh",
    description: "PostgreSQL auto-configuration entrypoint",
  },

  // Documentation
  {
    type: "file",
    path: "README.md",
    description: "Repository README",
  },
];

function printHelp(): void {
  const helpText = `
Repository Health Check - Verify required files and directories

Usage:
  bun scripts/ci/repository-health-check.ts [OPTIONS]

Options:
  --verbose    Show detailed output for each check
  --help       Show this help message

Examples:
  bun scripts/ci/repository-health-check.ts
  bun scripts/ci/repository-health-check.ts --verbose
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

function checkItem(repoRoot: string, item: CheckItem, verbose: boolean): boolean {
  const fullPath = join(repoRoot, item.path);
  const exists = existsSync(fullPath);

  if (verbose) {
    const status = exists ? "✅" : "❌";
    const typeLabel = item.type === "file" ? "File" : "Dir ";
    console.log(`${status} [${typeLabel}] ${item.path.padEnd(45)} ${item.description}`);
  }

  if (!exists) {
    // Output GitHub Actions error annotation if in CI
    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.log(`::error::Missing ${item.type}: ${item.path} (${item.description})`);
    }
  }

  return exists;
}

function main(): void {
  const options = parseArgs();

  // Determine repository root (script is in scripts/ci/)
  const repoRoot = join(import.meta.dir, "../..");

  if (options.verbose) {
    info("Running repository health checks...");
    console.log();
  } else {
    info("🔍 Running repository health checks...");
  }

  const results = REQUIRED_ITEMS.map((item) => checkItem(repoRoot, item, options.verbose));

  const allPassed = results.every((r) => r === true);
  const failedCount = results.filter((r) => !r).length;

  console.log(); // Blank line

  if (allPassed) {
    success("✅ Repository health check passed");
    process.exit(0);
  } else {
    error(`❌ Repository health check failed: ${failedCount} missing item(s)`);
    console.log();
    console.log("Missing items:");
    REQUIRED_ITEMS.forEach((item, index) => {
      if (!results[index]) {
        console.log(`  - ${item.type}: ${item.path}`);
      }
    });
    process.exit(1);
  }
}

main();
