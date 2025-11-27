#!/usr/bin/env bun

/**
 * Merge multi-platform manifest and verify format
 *
 * Creates a multi-platform Docker manifest from individual platform digests
 * and verifies the manifest format (OCI vs Docker manifest list).
 *
 * Usage:
 *   bun scripts/ci/merge-multi-platform-manifest.ts --registry=ghcr.io --repository=owner/repo --tag=my-tag --digests-dir=/path/to/digests
 *
 * Arguments:
 *   --registry      Container registry (e.g., "ghcr.io") (required)
 *   --repository    Repository name (e.g., "owner/repo") (required)
 *   --tag           Tag name (e.g., "dev-main") (required)
 *   --digests-dir   Directory containing digest files (required)
 *   --sha           Git SHA for additional tag (optional)
 *   --github-output Write digest to GITHUB_OUTPUT (optional)
 *
 * Exit codes:
 *   0 - Manifest created and verified successfully
 *   1 - Manifest creation or verification failed
 */

// Empty export makes this file a module (enables top-level await)
export {};

import { $ } from "bun";
import { readdir } from "node:fs/promises";
import { stat } from "node:fs/promises";

interface MergeOptions {
  registry: string;
  repository: string;
  tag: string;
  digestsDir: string;
  sha?: string;
  githubOutput?: boolean;
}

interface ManifestInspect {
  manifest?: {
    digest?: string;
    mediaType?: string;
  };
}

async function getDigestFiles(digestsDir: string): Promise<string[]> {
  const files = await readdir(digestsDir);
  return files.filter((f) => f.length === 64); // SHA256 hashes are 64 chars
}

async function verifyDigestCount(digestsDir: string, expected: number): Promise<void> {
  const dirStat = await stat(digestsDir);
  if (!dirStat.isDirectory()) {
    throw new Error(`Not a directory: ${digestsDir}`);
  }

  const digestFiles = await getDigestFiles(digestsDir);
  const count = digestFiles.length;

  console.log(`Digest files found: ${count}`);
  for (const file of digestFiles) {
    console.log(`  - ${file}`);
  }

  if (count !== expected) {
    throw new Error(`Expected ${expected} digest files (amd64 + arm64), found ${count}`);
  }

  console.log(`✅ Confirmed ${expected} platform digests present`);
}

async function createManifest(options: MergeOptions): Promise<string> {
  const { registry, repository, digestsDir, tag, sha } = options;
  const fullImage = `${registry}/${repository}`;

  console.log("\n=== Creating Multi-Arch Manifest ===");

  // Read digest files and build source list
  const digestFiles = await getDigestFiles(digestsDir);
  const sources = digestFiles.map((digest) => `${fullImage}@sha256:${digest}`).join(" ");

  // Create tags
  const tags = [`${fullImage}:${tag}`];
  if (sha) {
    tags.push(`${fullImage}:${tag}-${sha}`);
  }

  // Build imagetools command
  const tagArgs = tags.map((t) => `-t ${t}`).join(" ");

  // Create manifest
  await $`docker buildx imagetools create ${tagArgs.split(" ")} ${sources.split(" ")}`;

  console.log(`✅ Multi-platform manifest created for tags:`);
  for (const t of tags) {
    console.log(`  - ${t}`);
  }

  const primaryTag = tags[0];
  if (!primaryTag) {
    throw new Error("No primary tag created");
  }
  return primaryTag; // Return primary tag for inspection
}

async function extractManifestDigest(imageRef: string): Promise<string> {
  console.log("\n=== Extracting Manifest Digest ===");

  // Inspect manifest once and extract digest
  const inspectJson =
    await $`docker buildx imagetools inspect ${imageRef} --format '{{json .}}'`.text();

  const inspect: ManifestInspect = JSON.parse(inspectJson.trim());

  const manifestDigest = inspect.manifest?.digest;
  if (!manifestDigest) {
    throw new Error("Failed to extract manifest digest");
  }

  console.log(`✅ Multi-platform manifest digest: ${manifestDigest}`);
  return manifestDigest;
}

async function verifyManifestFormat(imageRef: string): Promise<void> {
  console.log("\n=== Manifest Format Check ===");

  const inspectJson =
    await $`docker buildx imagetools inspect ${imageRef} --format '{{json .}}'`.text();
  const inspect: ManifestInspect = JSON.parse(inspectJson.trim());

  const mediaType = inspect.manifest?.mediaType;

  if (!mediaType) {
    console.log("⚠️  WARNING: Could not determine manifest media type");
    console.log("   Manifest inspection may have failed or returned unexpected format");
    return;
  }

  if (mediaType === "application/vnd.oci.image.index.v1+json") {
    console.log("✅ OCI Image Index v1 format (annotations supported)");
  } else if (mediaType === "application/vnd.docker.distribution.manifest.list.v2+json") {
    console.log("⚠️  Docker manifest list v2 format (annotations NOT supported)");
    console.log("   Note: Dev builds may lack OCI annotations - this is informational only");
  } else {
    console.log(`⚠️  Unexpected manifest format: ${mediaType}`);
  }
}

async function writeGitHubOutput(digest: string): Promise<void> {
  const outputFile = Bun.env.GITHUB_OUTPUT;
  if (!outputFile) {
    console.warn("Warning: GITHUB_OUTPUT not set, skipping output");
    return;
  }

  const output = `digest=${digest}\n`;
  const file = Bun.file(outputFile);
  const existing = (await file.exists()) ? await file.text() : "";
  await Bun.write(outputFile, existing + output);

  console.log(`\n✅ Digest written to GITHUB_OUTPUT`);
}

async function mergeManifest(options: MergeOptions): Promise<void> {
  // Pre-merge validation
  console.log("=== Pre-merge Validation ===");
  await verifyDigestCount(options.digestsDir, 2);

  // Create manifest
  const imageRef = await createManifest(options);

  // Extract digest
  const digest = await extractManifestDigest(imageRef);

  // Verify format (informational)
  await verifyManifestFormat(imageRef);

  // Write output if requested
  if (options.githubOutput) {
    await writeGitHubOutput(digest);
  }

  console.log("\n✅ Manifest merge complete");
}

// Parse CLI arguments
const args = Bun.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Merge multi-platform manifest and verify format

Usage:
  bun scripts/ci/merge-multi-platform-manifest.ts --registry=ghcr.io --repository=owner/repo --tag=my-tag --digests-dir=/path/to/digests

Arguments:
  --registry      Container registry (required)
  --repository    Repository name (required)
  --tag           Tag name (required)
  --digests-dir   Directory containing digest files (required)
  --sha           Git SHA for additional tag (optional)
  --github-output Write digest to GITHUB_OUTPUT (optional)
  --help, -h      Show this help message

Examples:
  bun scripts/ci/merge-multi-platform-manifest.ts \\
    --registry=ghcr.io \\
    --repository=fluxo-kt/aza-pg-testing \\
    --tag=dev-main \\
    --digests-dir=/tmp/digests
`);
  process.exit(0);
}

const registry = args.find((arg) => arg.startsWith("--registry="))?.split("=")[1];
const repository = args.find((arg) => arg.startsWith("--repository="))?.split("=")[1];
const tag = args.find((arg) => arg.startsWith("--tag="))?.split("=")[1];
const digestsDir = args.find((arg) => arg.startsWith("--digests-dir="))?.split("=")[1];
const sha = args.find((arg) => arg.startsWith("--sha="))?.split("=")[1];
const githubOutput = args.includes("--github-output");

if (!registry) {
  console.error("Error: --registry argument is required");
  process.exit(1);
}

if (!repository) {
  console.error("Error: --repository argument is required");
  process.exit(1);
}

if (!tag) {
  console.error("Error: --tag argument is required");
  process.exit(1);
}

if (!digestsDir) {
  console.error("Error: --digests-dir argument is required");
  process.exit(1);
}

try {
  await mergeManifest({
    registry,
    repository,
    tag,
    digestsDir,
    sha,
    githubOutput,
  });
} catch (error) {
  console.error("❌ Manifest merge failed:", error);
  process.exit(1);
}
