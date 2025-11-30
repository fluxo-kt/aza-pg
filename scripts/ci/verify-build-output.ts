#!/usr/bin/env bun

/**
 * Verify Docker build output and generate summary
 *
 * Usage:
 *   bun scripts/ci/verify-build-output.ts --image=aza-pg-ci:test --platform=linux/amd64 [--github-summary]
 *
 * Arguments:
 *   --image            Docker image tag to verify (required)
 *   --platform         Platform (e.g., "linux/amd64") (required)
 *   --digest           Image digest (optional, for summary)
 *   --push-image       Whether image was pushed ("true" or "false") (optional)
 *   --github-summary   Append output to GITHUB_STEP_SUMMARY
 *
 * Output:
 *   Prints verification results and optionally appends to GitHub step summary
 */

// Empty export makes this file a module (enables top-level await)
export {};

import { $ } from "bun";

interface VerifyBuildOptions {
  image: string;
  platform: string;
  digest?: string;
  pushImage?: boolean;
  githubSummary?: boolean;
}

async function extractPostgreSQLVersion(dockerfilePath: string): Promise<string> {
  // Extract PostgreSQL version from Dockerfile (hardcoded at generation time)
  const dockerfileContent = await Bun.file(dockerfilePath).text();
  const fromLine = dockerfileContent
    .split("\n")
    .find((line) => line.trim().startsWith("FROM postgres:"));

  if (!fromLine) {
    throw new Error("Could not find FROM postgres: line in Dockerfile");
  }

  const match = fromLine.match(/\d+\.\d+/);
  if (!match) {
    throw new Error("Could not extract PostgreSQL version from Dockerfile");
  }

  return match[0];
}

interface CatalogStats {
  CATALOG_TOTAL: number;
  CATALOG_ENABLED: number;
  CATALOG_DISABLED: number;
  CATALOG_EXTENSIONS: number;
  CATALOG_TOOLS: number;
  CATALOG_BUILTINS: number;
  CATALOG_MODULES: number;
  CATALOG_ENABLED_EXTENSIONS: number;
  CATALOG_ENABLED_TOOLS: number;
  CATALOG_ENABLED_BUILTINS: number;
  CATALOG_ENABLED_MODULES: number;
}

async function getCatalogStats(): Promise<CatalogStats> {
  // Derive catalog statistics dynamically from manifest
  const result = await $`bun scripts/derive-catalog-stats.ts --format=shell`.text();

  const stats: Record<string, number> = {};
  for (const line of result.trim().split("\n")) {
    const [key, value] = line.split("=");
    if (key && value) {
      const envKey = key.replace("export ", "");
      stats[envKey] = Number.parseInt(value, 10);
    }
  }

  // Ensure all required fields are present
  const requiredFields: Array<keyof CatalogStats> = [
    "CATALOG_TOTAL",
    "CATALOG_ENABLED",
    "CATALOG_DISABLED",
    "CATALOG_EXTENSIONS",
    "CATALOG_TOOLS",
    "CATALOG_BUILTINS",
    "CATALOG_MODULES",
    "CATALOG_ENABLED_EXTENSIONS",
    "CATALOG_ENABLED_TOOLS",
    "CATALOG_ENABLED_BUILTINS",
    "CATALOG_ENABLED_MODULES",
  ];

  for (const field of requiredFields) {
    if (stats[field] === undefined) {
      throw new Error(`Missing required catalog stat: ${field}`);
    }
  }

  return stats as unknown as CatalogStats;
}

async function verifyExtensionCount(image: string, expectedMin: number): Promise<number> {
  // Check extension count in the image
  const result =
    await $`docker run --rm ${image} sh -c 'ls -1 /usr/share/postgresql/18/extension/*.control 2>/dev/null'`.text();

  const extensionCount = result.trim().split("\n").filter(Boolean).length;

  if (extensionCount < expectedMin) {
    throw new Error(`Expected at least ${expectedMin} extensions, found ${extensionCount}`);
  }

  return extensionCount;
}

async function verifyBuildOutput(options: VerifyBuildOptions): Promise<void> {
  const { image, platform, digest, pushImage, githubSummary } = options;

  console.log(`Verifying build output for ${image} (${platform})...`);

  // Extract PostgreSQL version from Dockerfile
  const pgVersion = await extractPostgreSQLVersion("docker/postgres/Dockerfile");
  console.log(`PostgreSQL version: ${pgVersion}`);

  // Get catalog stats
  const stats = await getCatalogStats();
  const expectedMin = stats.CATALOG_EXTENSIONS + stats.CATALOG_BUILTINS;

  console.log(
    `Catalog: ${stats.CATALOG_ENABLED} enabled (${stats.CATALOG_ENABLED_EXTENSIONS} ext, ${stats.CATALOG_ENABLED_BUILTINS} builtin, ${stats.CATALOG_ENABLED_TOOLS} tools), ${stats.CATALOG_TOTAL} total, ${stats.CATALOG_DISABLED} disabled`
  );

  // Verify extension count (only on amd64 platform)
  if (platform === "linux/amd64") {
    const extensionCount = await verifyExtensionCount(image, expectedMin);
    console.log(
      `Found ${extensionCount} extension control files (expected: ${expectedMin} = ${stats.CATALOG_EXTENSIONS} ext + ${stats.CATALOG_BUILTINS} builtin)`
    );
  }

  // Generate summary if requested
  if (githubSummary && platform === "linux/amd64") {
    await appendGitHubSummary(pgVersion, stats, digest, pushImage);
  }

  console.log("✅ Image verification passed");
}

async function appendGitHubSummary(
  pgVersion: string,
  stats: CatalogStats,
  digest?: string,
  pushImage?: boolean
): Promise<void> {
  const summaryFile = Bun.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) {
    console.warn("Warning: GITHUB_STEP_SUMMARY not set, skipping summary");
    return;
  }

  let summary = "### PostgreSQL Image Built Successfully :rocket:\n\n";

  if (pushImage) {
    summary += "**Build Type:** Multi-platform (amd64 + arm64 native)\n";
    if (digest) {
      summary += `**Image Digest (amd64):** \`${digest}\`\n`;
    }
  } else {
    summary += "**Build Type:** Local single-platform (amd64)\n";
    if (digest) {
      summary += `**Image Digest:** \`${digest}\`\n`;
    }
  }

  summary += `**PostgreSQL Version:** ${pgVersion}\n\n`;
  summary += "**Extensions:**\n";
  summary += `- ${stats.CATALOG_TOTAL} total catalog entries (${stats.CATALOG_ENABLED} enabled, ${stats.CATALOG_DISABLED} disabled)\n`;
  summary += `- ${stats.CATALOG_ENABLED} enabled: ${stats.CATALOG_ENABLED_EXTENSIONS} extensions + ${stats.CATALOG_ENABLED_BUILTINS} builtins + ${stats.CATALOG_ENABLED_TOOLS} tools\n`;
  summary += `- ${stats.CATALOG_EXTENSIONS} extensions total (${stats.CATALOG_ENABLED_EXTENSIONS} enabled, ${stats.CATALOG_EXTENSIONS - stats.CATALOG_ENABLED_EXTENSIONS} on-demand)\n`;
  summary += "- Popular extensions: pgvector, timescaledb, postgis, pg_cron, pgaudit, pgsodium\n";
  summary += "- All versions pinned and managed via extensions.manifest.json\n";

  const file = Bun.file(summaryFile);
  const existing = (await file.exists()) ? await file.text() : "";
  await Bun.write(summaryFile, existing + summary);

  console.log("✅ GitHub summary appended");
}

// Parse CLI arguments
const args = Bun.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Verify Docker build output and generate summary

Usage:
  bun scripts/ci/verify-build-output.ts --image=aza-pg-ci:test --platform=linux/amd64 [--github-summary]

Arguments:
  --image            Docker image tag to verify (required)
  --platform         Platform (e.g., "linux/amd64") (required)
  --digest           Image digest (optional)
  --push-image       Whether image was pushed ("true"/"false") (optional)
  --github-summary   Append output to GITHUB_STEP_SUMMARY
  --help, -h         Show this help message

Examples:
  bun scripts/ci/verify-build-output.ts --image=aza-pg-ci:test --platform=linux/amd64
  bun scripts/ci/verify-build-output.ts --image=aza-pg-ci:test --platform=linux/amd64 --digest=sha256:abc123 --push-image=true --github-summary
`);
  process.exit(0);
}

const image = args.find((arg) => arg.startsWith("--image="))?.split("=")[1];
const platform = args.find((arg) => arg.startsWith("--platform="))?.split("=")[1];
const digest = args.find((arg) => arg.startsWith("--digest="))?.split("=")[1];
const pushImageArg = args.find((arg) => arg.startsWith("--push-image="))?.split("=")[1];
const githubSummary = args.includes("--github-summary");

if (!image) {
  console.error("Error: --image argument is required");
  process.exit(1);
}

if (!platform) {
  console.error("Error: --platform argument is required");
  process.exit(1);
}

const pushImage = pushImageArg === "true";

try {
  await verifyBuildOutput({
    image,
    platform,
    digest,
    pushImage,
    githubSummary,
  });
} catch (error) {
  console.error("❌ Build verification failed:", error);
  process.exit(1);
}
