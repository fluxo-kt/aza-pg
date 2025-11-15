#!/usr/bin/env bun

/**
 * Generate OCI image annotations JSON file for multi-arch manifests
 *
 * This script creates a JSON file with standardized OCI image annotations,
 * following the OCI Image Spec (https://github.com/opencontainers/image-spec/blob/main/annotations.md).
 * Output file is consumed by scripts/docker/create-manifest.ts --annotations flag.
 *
 * Usage:
 *   bun scripts/ci/generate-oci-annotations.ts --output <file> [OPTIONS]
 *
 * Required Options:
 *   --output <file>         Output JSON file path
 *
 * OCI Standard Annotations:
 *   --version <v>           Image version tag (org.opencontainers.image.version)
 *   --revision <sha>        Git commit SHA (org.opencontainers.image.revision)
 *   --source <url>          Source repository URL (org.opencontainers.image.source)
 *   --created <iso>         Creation timestamp ISO 8601 (org.opencontainers.image.created)
 *   --url <url>             Image URL (org.opencontainers.image.url)
 *   --description <text>    Image description (org.opencontainers.image.description)
 *   --title <text>          Image title (org.opencontainers.image.title)
 *   --authors <text>        Image authors (org.opencontainers.image.authors)
 *   --licenses <text>       License(s) (org.opencontainers.image.licenses)
 *
 * Custom Annotations:
 *   --custom <key=value>    Custom annotation (repeatable, for non-OCI annotations)
 *
 * Other Options:
 *   --help                  Show this help message
 *
 * Examples:
 *   # Basic usage with version + revision + source
 *   bun scripts/ci/generate-oci-annotations.ts \
 *     --output annotations.json \
 *     --version "18.1-202511142330-single-node" \
 *     --revision "abc123def456" \
 *     --source "https://github.com/fluxo-kt/aza-pg"
 *
 *   # Full OCI annotations
 *   bun scripts/ci/generate-oci-annotations.ts \
 *     --output annotations.json \
 *     --created "2025-11-14T23:30:00Z" \
 *     --version "18.1-202511142330-single-node" \
 *     --revision "abc123def456" \
 *     --source "https://github.com/fluxo-kt/aza-pg" \
 *     --url "https://github.com/fluxo-kt/aza-pg/pkgs/container/aza-pg" \
 *     --description "PostgreSQL 18 with curated extensions" \
 *     --title "aza-pg" \
 *     --authors "Fluxo KT" \
 *     --licenses "MIT"
 *
 *   # Custom annotations
 *   bun scripts/ci/generate-oci-annotations.ts \
 *     --output annotations.json \
 *     --version "18.1-202511142330-single-node" \
 *     --custom "com.example.foo=bar" \
 *     --custom "com.example.build-id=12345"
 *
 *   # Usage in publish.yml workflow
 *   - name: Generate OCI annotations
 *     run: |
 *       bun scripts/ci/generate-oci-annotations.ts \
 *         --output annotations.json \
 *         --created "${{ steps.metadata.outputs.timestamp }}" \
 *         --version "${{ steps.metadata.outputs.version }}" \
 *         --revision "${{ github.sha }}" \
 *         --source "${{ github.repositoryUrl }}"
 *
 * Exit codes:
 *   0 - Success
 *   1 - Validation or I/O failure
 */

import { success, error, info } from "../utils/logger.js";
import { getErrorMessage } from "../utils/errors.js";

interface Options {
  output: string;
  version?: string;
  revision?: string;
  source?: string;
  created?: string;
  url?: string;
  description?: string;
  title?: string;
  authors?: string;
  licenses?: string;
  custom: Array<{ key: string; value: string }>;
}

function printHelp(): void {
  const helpText = `
Generate OCI image annotations JSON file for multi-arch manifests

Usage:
  bun scripts/ci/generate-oci-annotations.ts --output <file> [OPTIONS]

Required Options:
  --output <file>         Output JSON file path

OCI Standard Annotations:
  --version <v>           Image version tag (org.opencontainers.image.version)
  --revision <sha>        Git commit SHA (org.opencontainers.image.revision)
  --source <url>          Source repository URL (org.opencontainers.image.source)
  --created <iso>         Creation timestamp ISO 8601 (org.opencontainers.image.created)
  --url <url>             Image URL (org.opencontainers.image.url)
  --description <text>    Image description (org.opencontainers.image.description)
  --title <text>          Image title (org.opencontainers.image.title)
  --authors <text>        Image authors (org.opencontainers.image.authors)
  --licenses <text>       License(s) SPDX (org.opencontainers.image.licenses)

Custom Annotations:
  --custom <key=value>    Custom annotation (repeatable, for non-OCI annotations)

Other Options:
  --help                  Show this help message

Examples:
  # Basic usage with version + revision + source
  bun scripts/ci/generate-oci-annotations.ts \\
    --output annotations.json \\
    --version "18.1-202511142330-single-node" \\
    --revision "abc123def456" \\
    --source "https://github.com/fluxo-kt/aza-pg"

  # Full OCI annotations
  bun scripts/ci/generate-oci-annotations.ts \\
    --output annotations.json \\
    --created "2025-11-14T23:30:00Z" \\
    --version "18.1-202511142330-single-node" \\
    --revision "abc123def456" \\
    --source "https://github.com/fluxo-kt/aza-pg" \\
    --url "https://github.com/fluxo-kt/aza-pg/pkgs/container/aza-pg" \\
    --description "PostgreSQL 18 with curated extensions" \\
    --title "aza-pg" \\
    --authors "Fluxo KT" \\
    --licenses "MIT"

  # Custom annotations
  bun scripts/ci/generate-oci-annotations.ts \\
    --output annotations.json \\
    --version "18.1-202511142330-single-node" \\
    --custom "com.example.foo=bar" \\
    --custom "com.example.build-id=12345"

OCI Spec Reference:
  https://github.com/opencontainers/image-spec/blob/main/annotations.md

Exit codes:
  0 - Success
  1 - Validation or I/O failure
`;
  console.log(helpText.trim());
}

function parseArgs(): Options {
  const args = Bun.argv.slice(2);

  const options: Options = {
    output: "",
    custom: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;

      case "--output":
        if (i + 1 >= args.length) {
          error("--output requires a file path argument");
          process.exit(1);
        }
        const outputValue = args[i + 1];
        if (!outputValue) {
          error("--output requires a file path argument");
          process.exit(1);
        }
        options.output = outputValue;
        i++; // Skip next arg
        break;

      case "--version":
        if (i + 1 >= args.length) {
          error("--version requires a value argument");
          process.exit(1);
        }
        const versionValue = args[i + 1];
        if (!versionValue) {
          error("--version requires a value argument");
          process.exit(1);
        }
        options.version = versionValue;
        i++;
        break;

      case "--revision":
        if (i + 1 >= args.length) {
          error("--revision requires a value argument");
          process.exit(1);
        }
        const revisionValue = args[i + 1];
        if (!revisionValue) {
          error("--revision requires a value argument");
          process.exit(1);
        }
        options.revision = revisionValue;
        i++;
        break;

      case "--source":
        if (i + 1 >= args.length) {
          error("--source requires a value argument");
          process.exit(1);
        }
        options.source = args[i + 1];
        i++;
        break;

      case "--created":
        if (i + 1 >= args.length) {
          error("--created requires a value argument");
          process.exit(1);
        }
        options.created = args[i + 1];
        i++;
        break;

      case "--url":
        if (i + 1 >= args.length) {
          error("--url requires a value argument");
          process.exit(1);
        }
        options.url = args[i + 1];
        i++;
        break;

      case "--description":
        if (i + 1 >= args.length) {
          error("--description requires a value argument");
          process.exit(1);
        }
        options.description = args[i + 1];
        i++;
        break;

      case "--title":
        if (i + 1 >= args.length) {
          error("--title requires a value argument");
          process.exit(1);
        }
        options.title = args[i + 1];
        i++;
        break;

      case "--authors":
        if (i + 1 >= args.length) {
          error("--authors requires a value argument");
          process.exit(1);
        }
        options.authors = args[i + 1];
        i++;
        break;

      case "--licenses":
        if (i + 1 >= args.length) {
          error("--licenses requires a value argument");
          process.exit(1);
        }
        options.licenses = args[i + 1];
        i++;
        break;

      case "--custom":
        if (i + 1 >= args.length) {
          error("--custom requires a key=value argument");
          process.exit(1);
        }
        const customArg = args[i + 1];
        if (!customArg) {
          error("--custom requires a key=value argument");
          process.exit(1);
        }
        const customParts = customArg.split("=");
        if (customParts.length < 2 || !customParts[0] || !customParts[1]) {
          error(`Invalid --custom format: "${customArg}". Expected key=value`);
          process.exit(1);
        }
        // Rejoin in case value contains '='
        const key = customParts[0];
        const value = customParts.slice(1).join("=");
        options.custom.push({ key, value });
        i++;
        break;

      default:
        error(`Unknown option: ${arg}`);
        printHelp();
        process.exit(1);
    }
  }

  return options;
}

function validateOptions(options: Options): void {
  if (!options.output) {
    error("--output is required");
    printHelp();
    process.exit(1);
  }
}

function buildAnnotations(options: Options): Record<string, string> {
  const annotations: Record<string, string> = {};

  // OCI standard annotations (only include if provided)
  if (options.created !== undefined) {
    annotations["org.opencontainers.image.created"] = options.created;
  }
  if (options.authors !== undefined) {
    annotations["org.opencontainers.image.authors"] = options.authors;
  }
  if (options.url !== undefined) {
    annotations["org.opencontainers.image.url"] = options.url;
  }
  if (options.source !== undefined) {
    annotations["org.opencontainers.image.source"] = options.source;
  }
  if (options.version !== undefined) {
    annotations["org.opencontainers.image.version"] = options.version;
  }
  if (options.revision !== undefined) {
    annotations["org.opencontainers.image.revision"] = options.revision;
  }
  if (options.licenses !== undefined) {
    annotations["org.opencontainers.image.licenses"] = options.licenses;
  }
  if (options.title !== undefined) {
    annotations["org.opencontainers.image.title"] = options.title;
  }
  if (options.description !== undefined) {
    annotations["org.opencontainers.image.description"] = options.description;
  }

  // Custom annotations
  for (const { key, value } of options.custom) {
    annotations[key] = value;
  }

  return annotations;
}

async function generateAnnotationsFile(
  annotations: Record<string, string>,
  outputPath: string
): Promise<void> {
  // Sort keys for deterministic output
  const sortedAnnotations: Record<string, string> = {};
  const sortedKeys = Object.keys(annotations).sort();
  for (const key of sortedKeys) {
    const value = annotations[key];
    if (value !== undefined) {
      sortedAnnotations[key] = value;
    }
  }

  // Pretty-print JSON with 2-space indent
  const json = JSON.stringify(sortedAnnotations, null, 2);

  try {
    await Bun.write(outputPath, json + "\n");
  } catch (err) {
    throw new Error(`Failed to write annotations file: ${getErrorMessage(err)}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs();
  validateOptions(options);

  try {
    const annotations = buildAnnotations(options);
    const annotationCount = Object.keys(annotations).length;

    if (annotationCount === 0) {
      info("No annotations provided, generating empty annotations file");
    } else {
      info(`Generating ${annotationCount} annotation(s)`);
    }

    await generateAnnotationsFile(annotations, options.output);

    // GitHub Actions annotation (if running in CI)
    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.log(`::notice::Generated OCI annotations file: ${options.output}`);
    }

    success(`Annotations file written to ${options.output}`);
  } catch (err) {
    error(getErrorMessage(err));
    process.exit(1);
  }
}

main();
