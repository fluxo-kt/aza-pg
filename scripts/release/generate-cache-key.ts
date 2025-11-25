#!/usr/bin/env bun

/**
 * Generate cache key for Docker build caching
 *
 * Usage:
 *   bun scripts/release/generate-cache-key.ts --branch=release --content-hash=abc123 [--github-output]
 *
 * Arguments:
 *   --branch        Git branch name (e.g., "release", "main")
 *   --content-hash  Content hash from hashFiles() or SHA
 *   --github-output Output to GITHUB_OUTPUT file (GitHub Actions)
 *
 * Output:
 *   key=publish-cache-release-abc123
 *   content_hash=abc123
 */

// Empty export makes this file a module (enables top-level await)
export {};

interface CacheKey {
  key: string;
  contentHash: string;
}

function generateCacheKey(branch: string, contentHash: string): CacheKey {
  const key = `publish-cache-${branch}-${contentHash}`;
  return { key, contentHash };
}

async function writeGitHubOutput(cacheKey: CacheKey): Promise<void> {
  const outputFile = Bun.env.GITHUB_OUTPUT;
  if (!outputFile) {
    console.error("Error: GITHUB_OUTPUT environment variable not set");
    process.exit(1);
  }

  const output = [`key=${cacheKey.key}`, `content_hash=${cacheKey.contentHash}`].join("\n");

  const file = Bun.file(outputFile);
  const existing = (await file.exists()) ? await file.text() : "";
  await Bun.write(outputFile, existing + output + "\n");

  console.log(`Generated cache key: ${cacheKey.key}`);
}

function printConsoleOutput(cacheKey: CacheKey): void {
  console.log(`key=${cacheKey.key}`);
  console.log(`content_hash=${cacheKey.contentHash}`);
}

// Parse CLI arguments
const args = Bun.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Generate cache key for Docker build caching

Usage:
  bun scripts/release/generate-cache-key.ts --branch=release --content-hash=abc123 [--github-output]

Arguments:
  --branch        Git branch name (required)
  --content-hash  Content hash from hashFiles() (required)
  --github-output Output to GITHUB_OUTPUT file
  --help, -h      Show this help message

Examples:
  bun scripts/release/generate-cache-key.ts --branch=release --content-hash=abc123
  bun scripts/release/generate-cache-key.ts --branch=main --content-hash=def456 --github-output
`);
  process.exit(0);
}

const branch = args.find((arg) => arg.startsWith("--branch="))?.split("=")[1];
const contentHash = args.find((arg) => arg.startsWith("--content-hash="))?.split("=")[1];
const githubOutput = args.includes("--github-output");

if (!branch) {
  console.error("Error: --branch argument is required");
  process.exit(1);
}

if (!contentHash) {
  console.error("Error: --content-hash argument is required");
  process.exit(1);
}

const cacheKey = generateCacheKey(branch, contentHash);

if (githubOutput) {
  await writeGitHubOutput(cacheKey);
} else {
  printConsoleOutput(cacheKey);
}
