#!/usr/bin/env bun

/**
 * Generate version tags for container image release
 *
 * Usage:
 *   bun scripts/release/generate-version-tags.ts --pg-version=18.1 --release-sha=<commit> [--github-output]
 *
 * Arguments:
 *   --pg-version    Full PostgreSQL version (e.g., "18.1")
 *   --release-sha   Commit being published; the tag must be unused or already on it
 *   --github-output Output to GITHUB_OUTPUT file (GitHub Actions)
 *
 * The timestamp comes from the newest `## [v…]` CHANGELOG heading, which /release writes into the
 * release commit (scripts/release/changelog.ts explains why).
 *
 * Output:
 *   version_tag=18.1-202511221455            (for releases, no type suffix)
 *   image_tag=18.1-202511221455-single-node  (for containers, with type suffix)
 *   convenience=18.1-single-node,18-single-node,18.1,18
 */

import path from "node:path";
import { newestRelease } from "./changelog";

interface VersionTags {
  versionTag: string; // For releases: 18.1-202511221455
  imageTag: string; // For containers: 18.1-202511221455-single-node
  convenience: string[]; // Convenience tags array
}

function generateTags(pgVersion: string, timestamp: string): VersionTags {
  const parts = pgVersion.split(".");
  const pgMajor = parts[0] ?? pgVersion;

  // Separate version (for releases) from image tag (for containers)
  const versionTag = `${pgVersion}-${timestamp}`; // 18.1-202511221455
  const imageTag = `${pgVersion}-${timestamp}-single-node`; // 18.1-202511221455-single-node

  // Convenience tags
  const convenience: string[] = [
    `${pgVersion}-single-node`,
    `${pgMajor}-single-node`,
    pgVersion,
    pgMajor,
  ];

  return { versionTag, imageTag, convenience };
}

async function writeGitHubOutput(tags: VersionTags): Promise<void> {
  const outputFile = Bun.env.GITHUB_OUTPUT;
  if (!outputFile) {
    console.error("Error: GITHUB_OUTPUT environment variable not set");
    process.exit(1);
  }

  const output = [
    `version_tag=${tags.versionTag}`,
    `timestamp=${timestamp}`,
    `image_tag=${tags.imageTag}`,
    `convenience=${tags.convenience.join(",")}`,
  ].join("\n");

  // Bun-first append: read existing + concatenate + write back
  const file = Bun.file(outputFile);
  const existing = (await file.exists()) ? await file.text() : "";
  await Bun.write(outputFile, existing + output + "\n");

  console.log("Generated version tags:");
  console.log(`  Version tag (for releases): ${tags.versionTag}`);
  console.log(`  Image tag (for containers): ${tags.imageTag}`);
  console.log(`  Convenience tags: ${tags.convenience.join(", ")}`);
}

function printConsoleOutput(tags: VersionTags): void {
  console.log(`version_tag=${tags.versionTag}`);
  console.log(`image_tag=${tags.imageTag}`);
  console.log(`convenience=${tags.convenience.join(",")}`);
}

// Parse CLI arguments
const args = Bun.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Generate version tags for container image release

Usage:
  bun scripts/release/generate-version-tags.ts --pg-version=18.1 --release-sha=<commit> [--github-output]

Arguments:
  --pg-version    Full PostgreSQL version (required)
  --release-sha   Commit being published (required)
  --github-output Output to GITHUB_OUTPUT file
  --help, -h      Show this help message

Examples:
  bun scripts/release/generate-version-tags.ts --pg-version=18.6 --release-sha="$(git rev-parse HEAD)"
`);
  process.exit(0);
}

const pgVersion = args.find((arg) => arg.startsWith("--pg-version="))?.split("=")[1];
const releaseSha = args.find((arg) => arg.startsWith("--release-sha="))?.split("=")[1];
const githubOutput = args.includes("--github-output");

if (!pgVersion || !releaseSha) {
  console.error("Error: --pg-version and --release-sha are required");
  process.exit(1);
}

// The release commit names its own tag in its newest CHANGELOG heading (scripts/release/changelog.ts).
const release = newestRelease(
  await Bun.file(path.join(import.meta.dir, "../../CHANGELOG.md")).text()
);
if (!release) {
  console.error(
    "Error: CHANGELOG.md has no `## [v<pg>-<yyyymmddHHMM>] - <date>` heading. /release Phase 4.4 runs" +
      " `bun scripts/release/date-changelog.ts` to write it into the release commit."
  );
  process.exit(1);
}
if (release.pgVersion !== pgVersion) {
  console.error(
    `Error: CHANGELOG names v${release.version}, but the image is built on PostgreSQL ${pgVersion}.` +
      " Re-run date-changelog.ts after the manifest's pgVersion is final."
  );
  process.exit(1);
}
// A tag already on another commit means this commit reused an old heading (a redone squash without
// re-dating); publishing would attach the release to the wrong commit.
const ls = Bun.spawn(
  [
    "git",
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/v${release.version}^{}`,
    `refs/tags/v${release.version}`,
  ],
  {
    stdout: "pipe",
    stderr: "inherit",
  }
);
const [remote, lsCode] = await Promise.all([new Response(ls.stdout).text(), ls.exited]);
if (lsCode !== 0) {
  console.error("Error: git ls-remote failed; cannot check whether the tag is already used");
  process.exit(1);
}
const shas = remote
  .split("\n")
  .filter(Boolean)
  .map((line) => line.split("\t")[0]);
const tagged = shas.at(-1); // the peeled (^{}) line sorts last when the tag is annotated
if (tagged && tagged !== releaseSha) {
  console.error(
    `Error: v${release.version} already tags ${tagged}, not ${releaseSha}. Redo /release Phase 4.4 so the heading names this commit.`
  );
  process.exit(1);
}
const timestamp = release.timestamp;

const tags = generateTags(pgVersion, timestamp);

if (githubOutput) {
  await writeGitHubOutput(tags);
} else {
  printConsoleOutput(tags);
}
