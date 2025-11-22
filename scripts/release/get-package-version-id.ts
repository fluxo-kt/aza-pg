#!/usr/bin/env bun

/**
 * Get GitHub Container Registry package version ID for a specific tag
 *
 * This script queries the GitHub Packages API to find the numeric version ID
 * for a given image tag. This ID is used in GHCR package URLs.
 *
 * Usage:
 *   bun scripts/release/get-package-version-id.ts --repository REPO --tag TAG [OPTIONS]
 *
 * Required options:
 *   --repository REPO     Repository path (e.g., "fluxo-kt/aza-pg")
 *   --tag TAG             Image tag to find (e.g., "18.1-202511221903-single-node")
 *
 * Optional flags:
 *   --help                Show this help message
 *
 * Environment variables:
 *   GITHUB_TOKEN          Required for API authentication (gh CLI uses this)
 *
 * Examples:
 *   # Get version ID for a specific tag
 *   bun scripts/release/get-package-version-id.ts \
 *     --repository fluxo-kt/aza-pg \
 *     --tag 18.1-202511221903-single-node
 *
 *   # Use in workflow
 *   VERSION_ID=$(bun scripts/release/get-package-version-id.ts \
 *     --repository fluxo-kt/aza-pg \
 *     --tag ${{ steps.tags.outputs.image_tag }})
 *
 * Exit codes:
 *   0 - Version ID found and printed to stdout
 *   1 - Error (tag not found, API failure, etc.)
 *
 * API Details:
 *   - List versions: GET /orgs/{org}/packages/container/{package}/versions
 *   - Version ID extracted from response: versions[].id
 */

import { $ } from "bun";
import { error, success, info } from "../utils/logger";
import { getErrorMessage } from "../utils/errors";

interface Options {
  repository: string;
  tag: string;
}

interface PackageVersion {
  id: number;
  name: string;
  metadata: {
    container: {
      tags: string[];
    };
  };
}

function printHelp(): void {
  const helpText = `
Get GitHub Container Registry package version ID for a specific tag

Usage:
  bun scripts/release/get-package-version-id.ts --repository REPO --tag TAG

Required options:
  --repository REPO     Repository path (e.g., "fluxo-kt/aza-pg")
  --tag TAG             Image tag to find (e.g., "18.1-202511221903-single-node")

Optional flags:
  --help                Show this help message

Environment:
  GITHUB_TOKEN          Required for API authentication

Examples:
  # Get version ID for a specific tag
  bun scripts/release/get-package-version-id.ts \\
    --repository fluxo-kt/aza-pg \\
    --tag 18.1-202511221903-single-node

  # Use in workflow
  VERSION_ID=$(bun scripts/release/get-package-version-id.ts \\
    --repository fluxo-kt/aza-pg \\
    --tag \${{ steps.tags.outputs.image_tag }})

Exit codes:
  0 - Version ID found and printed to stdout
  1 - Error (tag not found, API failure, etc.)
`;
  console.log(helpText.trim());
}

function parseArgs(): Options {
  const args = Bun.argv.slice(2);

  const options: Options = {
    repository: "",
    tag: "",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;

      case "--repository":
        if (i + 1 >= args.length) {
          error("--repository requires an argument");
          process.exit(1);
        }
        {
          const value = args[i + 1];
          if (!value) {
            error("--repository requires an argument");
            process.exit(1);
          }
          options.repository = value;
        }
        i++;
        break;

      case "--tag":
        if (i + 1 >= args.length) {
          error("--tag requires an argument");
          process.exit(1);
        }
        {
          const value = args[i + 1];
          if (!value) {
            error("--tag requires an argument");
            process.exit(1);
          }
          options.tag = value;
        }
        i++;
        break;

      default:
        error(`Unknown option: ${arg}`);
        printHelp();
        process.exit(1);
    }
  }

  // Validate required options
  if (!options.repository) {
    error("--repository is required");
    printHelp();
    process.exit(1);
  }

  if (!options.tag) {
    error("--tag is required");
    printHelp();
    process.exit(1);
  }

  return options;
}

function parseRepository(repo: string): { org: string; package: string } {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    error(`Invalid repository format: ${repo} (expected "owner/repo")`);
    process.exit(1);
  }
  return { org: parts[0], package: parts[1] };
}

async function checkGhCliAvailable(): Promise<void> {
  try {
    const result = await $`gh --version`.nothrow().quiet();
    if (result.exitCode !== 0) {
      error("GitHub CLI (gh) is not available");
      process.exit(1);
    }
  } catch (err) {
    error(`Failed to check gh CLI availability: ${getErrorMessage(err)}`);
    process.exit(1);
  }
}

async function checkGhAuthentication(): Promise<void> {
  try {
    const result = await $`gh auth status`.nothrow().quiet();
    if (result.exitCode !== 0) {
      error("GitHub CLI is not authenticated. Run 'gh auth login' or set GITHUB_TOKEN");
      process.exit(1);
    }
  } catch (err) {
    error(`Failed to check gh authentication: ${getErrorMessage(err)}`);
    process.exit(1);
  }
}

async function fetchPackageVersions(org: string, packageName: string): Promise<PackageVersion[]> {
  try {
    const apiPath = `/orgs/${org}/packages/container/${packageName}/versions`;
    const result = await $`gh api -H "Accept: application/vnd.github+json" ${apiPath}`
      .nothrow()
      .quiet();

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim();

      // Handle rate limiting (HTTP 429)
      if (stderr.includes("429") || stderr.includes("rate limit")) {
        throw new Error("GitHub API rate limit exceeded. Try again later.");
      }

      // Handle not found (HTTP 404)
      if (stderr.includes("404") || stderr.includes("Not Found")) {
        throw new Error(`Package not found: ${org}/${packageName}`);
      }

      throw new Error(`GitHub API request failed: ${stderr}`);
    }

    const versions = JSON.parse(result.stdout.toString()) as PackageVersion[];
    return versions;
  } catch (err) {
    throw new Error(`Failed to fetch package versions: ${getErrorMessage(err)}`);
  }
}

function findVersionIdByTag(versions: PackageVersion[], tag: string): number | null {
  for (const version of versions) {
    if (version.metadata?.container?.tags?.includes(tag)) {
      return version.id;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const options = parseArgs();
  const { org, package: packageName } = parseRepository(options.repository);

  // Pre-flight checks
  await checkGhCliAvailable();
  await checkGhAuthentication();

  info(`Querying package versions for ${org}/${packageName}...`);

  // Fetch all package versions
  const versions = await fetchPackageVersions(org, packageName);
  info(`Found ${versions.length} package versions`);

  // Find version ID by tag
  const versionId = findVersionIdByTag(versions, options.tag);

  if (versionId === null) {
    error(`Tag not found: ${options.tag}`);
    error(
      `Available tags: ${versions.flatMap((v) => v.metadata?.container?.tags || []).join(", ")}`
    );
    process.exit(1);
  }

  success(`Found version ID for tag ${options.tag}: ${versionId}`);

  // Output just the version ID to stdout for easy capture
  console.log(versionId);
}

main().catch((err) => {
  error(`Fatal error: ${getErrorMessage(err)}`);
  process.exit(1);
});
