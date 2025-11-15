#!/usr/bin/env bun

/**
 * Parse Bun version from .tool-versions file
 *
 * This script reads the .tool-versions file and extracts the Bun version,
 * outputting it in a format suitable for GitHub Actions or direct use.
 *
 * Usage:
 *   bun scripts/ci/parse-bun-version.ts [--github-output] [--file PATH]
 *
 * Options:
 *   --github-output    Output in GitHub Actions format (key=value to GITHUB_OUTPUT)
 *   --file PATH        Path to .tool-versions file (default: .tool-versions)
 *   --help             Show this help message
 *
 * Examples:
 *   # Print version to stdout
 *   bun scripts/ci/parse-bun-version.ts
 *   # Output: 1.1.38
 *
 *   # GitHub Actions format
 *   bun scripts/ci/parse-bun-version.ts --github-output
 *   # Appends to $GITHUB_OUTPUT: version=1.1.38
 *
 * Exit codes:
 *   0 - Success
 *   1 - .tool-versions file not found or Bun version not found
 */

import { join } from "node:path";
import { error } from "../utils/logger.js";
import { getErrorMessage } from "../utils/errors.js";

interface Options {
  githubOutput: boolean;
  toolVersionsFile: string;
}

function printHelp(): void {
  const helpText = `
Parse Bun version from .tool-versions file

Usage:
  bun scripts/ci/parse-bun-version.ts [OPTIONS]

Options:
  --github-output    Output in GitHub Actions format
  --file PATH        Path to .tool-versions file (default: .tool-versions)
  --help             Show this help message

Examples:
  bun scripts/ci/parse-bun-version.ts
  bun scripts/ci/parse-bun-version.ts --github-output
  bun scripts/ci/parse-bun-version.ts --file /path/to/.tool-versions
`;
  console.log(helpText.trim());
}

function parseArgs(): Options {
  const args = Bun.argv.slice(2);

  const options: Options = {
    githubOutput: false,
    toolVersionsFile: ".tool-versions",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;

      case "--github-output":
        options.githubOutput = true;
        break;

      case "--file":
        if (i + 1 >= args.length) {
          error("--file requires a path argument");
          process.exit(1);
        }
        options.toolVersionsFile = args[i + 1];
        i++; // Skip next arg
        break;

      default:
        error(`Unknown option: ${arg}`);
        printHelp();
        process.exit(1);
    }
  }

  return options;
}

async function parseBunVersion(toolVersionsPath: string): Promise<string> {
  // Read .tool-versions file
  let content: string;
  try {
    content = await Bun.file(toolVersionsPath).text();
  } catch (err) {
    throw new Error(
      `.tool-versions file not found at ${toolVersionsPath}: ${getErrorMessage(err)}`
    );
  }

  // Find line starting with "bun " and extract version
  // Format: "bun 1.1.38" → extract "1.1.38"
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("bun ")) {
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) {
        const version = parts[1];
        if (version) {
          return version;
        }
      }
    }
  }

  throw new Error(
    `Bun version not found in ${toolVersionsPath}. Expected line format: "bun X.Y.Z"`
  );
}

async function main(): Promise<void> {
  const options = parseArgs();

  // Resolve path relative to repo root
  const repoRoot = join(import.meta.dir, "../..");
  const toolVersionsPath = join(repoRoot, options.toolVersionsFile);

  try {
    const version = await parseBunVersion(toolVersionsPath);

    if (options.githubOutput) {
      // GitHub Actions output format
      const githubOutput = Bun.env.GITHUB_OUTPUT;
      if (!githubOutput) {
        error("GITHUB_OUTPUT environment variable not set. Running outside GitHub Actions?");
        process.exit(1);
      }

      // Append to GITHUB_OUTPUT file
      const outputLine = `version=${version}\n`;
      await Bun.write(githubOutput, outputLine, { append: true });

      console.log(`✅ Bun version ${version} written to GITHUB_OUTPUT`);
    } else {
      // Direct output for local use
      console.log(version);
    }
  } catch (err) {
    error(getErrorMessage(err));
    process.exit(1);
  }
}

main();
