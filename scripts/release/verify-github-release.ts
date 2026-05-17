#!/usr/bin/env bun
/**
 * Verifies the public GitHub Release matches the image that passed CI gates.
 */

import { $ } from "bun";
import { error, success } from "../utils/logger";
import { getErrorMessage } from "../utils/errors";

interface Options {
  repository: string;
  tag: string;
  expectedCommit: string;
  imageTag: string;
  digest: string;
}

interface ReleaseView {
  body: string;
  isDraft: boolean;
  isPrerelease: boolean;
  tagName: string;
  url: string;
}

interface ReleaseListItem {
  isLatest: boolean;
  tagName: string;
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`${flag} requires an argument`);
  }
  return value;
}

function parseArgs(): Options {
  const args = Bun.argv.slice(2);
  const options: Partial<Options> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--repository":
        options.repository = readValue(args, i, arg);
        i++;
        break;
      case "--tag":
        options.tag = readValue(args, i, arg);
        i++;
        break;
      case "--expected-commit":
        options.expectedCommit = readValue(args, i, arg);
        i++;
        break;
      case "--image-tag":
        options.imageTag = readValue(args, i, arg);
        i++;
        break;
      case "--digest":
        options.digest = readValue(args, i, arg);
        i++;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (
    !options.repository ||
    !options.tag ||
    !options.expectedCommit ||
    !options.imageTag ||
    !options.digest
  ) {
    throw new Error(
      "Usage: verify-github-release.ts --repository OWNER/REPO --tag vX --expected-commit SHA --image-tag TAG --digest sha256:..."
    );
  }

  return options as Options;
}

function parseReleaseView(stdout: string): ReleaseView {
  const value = JSON.parse(stdout) as ReleaseView;
  if (
    typeof value.body !== "string" ||
    typeof value.isDraft !== "boolean" ||
    typeof value.isPrerelease !== "boolean" ||
    typeof value.tagName !== "string" ||
    typeof value.url !== "string"
  ) {
    throw new Error("gh release view returned an unexpected JSON shape");
  }
  return value;
}

async function readRelease(options: Options): Promise<ReleaseView> {
  const result =
    await $`gh release view ${options.tag} --repo ${options.repository} --json tagName,isDraft,isPrerelease,body,url`
      .nothrow()
      .quiet();
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || `GitHub Release not found: ${options.tag}`);
  }
  return parseReleaseView(result.stdout.toString());
}

function parseLatestRelease(stdout: string): ReleaseListItem {
  const value = JSON.parse(stdout) as ReleaseListItem[];
  const first = value[0];
  if (!first || typeof first.tagName !== "string" || typeof first.isLatest !== "boolean") {
    throw new Error("gh release list returned an unexpected JSON shape");
  }
  return first;
}

async function readLatestRelease(repository: string): Promise<ReleaseListItem> {
  const result =
    await $`gh release list --repo ${repository} --limit 1 --exclude-drafts --exclude-pre-releases --json tagName,isLatest`
      .nothrow()
      .quiet();
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || "Unable to read latest GitHub Release");
  }
  return parseLatestRelease(result.stdout.toString());
}

async function resolveRemoteTag(repository: string, tag: string): Promise<string> {
  const repoUrl = `https://github.com/${repository}.git`;
  const result = await $`git ls-remote ${repoUrl} refs/tags/${tag} refs/tags/${tag}^{}`
    .nothrow()
    .quiet();
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || `Unable to resolve remote tag ${tag}`);
  }

  const lines = result.stdout.toString().trim().split("\n").filter(Boolean);
  const peeled = lines.find((line) => line.endsWith(`refs/tags/${tag}^{}`));
  const direct = lines.find((line) => line.endsWith(`refs/tags/${tag}`));
  const selected = peeled ?? direct;
  const sha = selected?.split(/\s+/)[0];
  if (!sha) {
    throw new Error(`Remote tag ${tag} does not exist`);
  }
  return sha;
}

function requireBodyContains(body: string, expected: string, label: string): void {
  if (!body.includes(expected)) {
    throw new Error(`Release body is missing ${label}: ${expected}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs();
  const release = await readRelease(options);

  if (release.tagName !== options.tag) {
    throw new Error(`Release tag mismatch: expected ${options.tag}, got ${release.tagName}`);
  }
  if (release.isDraft) {
    throw new Error(`${options.tag} is still a draft release`);
  }
  if (release.isPrerelease) {
    throw new Error(`${options.tag} is marked as a prerelease`);
  }

  const latest = await readLatestRelease(options.repository);
  if (latest.tagName !== options.tag || !latest.isLatest) {
    throw new Error(`${options.tag} is not the latest non-draft, non-prerelease GitHub Release`);
  }

  const tagCommit = await resolveRemoteTag(options.repository, options.tag);
  if (tagCommit !== options.expectedCommit) {
    throw new Error(`Tag commit mismatch: expected ${options.expectedCommit}, got ${tagCommit}`);
  }

  requireBodyContains(release.body, options.imageTag, "published image tag");
  requireBodyContains(release.body, options.digest, "published image digest");

  success(`GitHub Release verified: ${release.url}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    error(getErrorMessage(err));
    process.exit(1);
  }
}
