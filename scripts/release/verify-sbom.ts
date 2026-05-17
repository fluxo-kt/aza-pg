#!/usr/bin/env bun
/**
 * Verifies a public image has a downloadable JSON SBOM.
 */

import { $ } from "bun";
import { error, info, success, warning } from "../utils/logger";
import { getErrorMessage } from "../utils/errors";

interface Options {
  image: string;
}

interface Platform {
  os: string;
  architecture: string;
}

interface ManifestEntry {
  digest: string;
  platform?: Platform;
}

interface ImageIndex {
  manifests?: ManifestEntry[];
}

function parseArgs(): Options {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--image" || !args[1]) {
    throw new Error("Usage: verify-sbom.ts --image ghcr.io/OWNER/IMAGE@sha256:...");
  }
  return { image: args[1] };
}

function imageRepository(image: string): string {
  const digestIndex = image.indexOf("@");
  if (digestIndex > 0) return image.slice(0, digestIndex);

  const tagIndex = image.lastIndexOf(":");
  const slashIndex = image.lastIndexOf("/");
  if (tagIndex > slashIndex) return image.slice(0, tagIndex);

  return image;
}

function isRunnablePlatform(entry: ManifestEntry): boolean {
  return entry.platform?.os !== "unknown" && entry.platform?.architecture !== "unknown";
}

async function candidateRefs(image: string): Promise<string[]> {
  const result = await $`docker buildx imagetools inspect --raw ${image}`.nothrow().quiet();
  if (result.exitCode !== 0) {
    warning(
      `Unable to inspect manifest descriptors for SBOM fallback: ${result.stderr.toString().trim()}`
    );
    return [image];
  }

  const refs = new Set<string>([image]);
  const repository = imageRepository(image);
  const index = JSON.parse(result.stdout.toString()) as ImageIndex;

  for (const entry of index.manifests ?? []) {
    if (entry.digest && isRunnablePlatform(entry)) {
      refs.add(`${repository}@${entry.digest}`);
    }
  }

  return [...refs];
}

async function hasJsonSbom(ref: string): Promise<boolean> {
  const result = await $`cosign download sbom ${ref}`.nothrow().quiet();
  if (result.exitCode !== 0) {
    info(`No SBOM at ${ref}: ${result.stderr.toString().trim()}`);
    return false;
  }

  const text = result.stdout.toString().trim();
  if (!text) {
    info(`Empty SBOM at ${ref}`);
    return false;
  }

  try {
    JSON.parse(text);
  } catch {
    info(`SBOM at ${ref} is not valid JSON`);
    return false;
  }

  success(`SBOM verified at ${ref}`);
  return true;
}

async function checkCosignAvailable(): Promise<void> {
  const result = await $`cosign version`.nothrow().quiet();
  if (result.exitCode !== 0) {
    throw new Error("cosign is required to verify SBOMs");
  }
}

async function main(): Promise<void> {
  const options = parseArgs();
  await checkCosignAvailable();
  for (const ref of await candidateRefs(options.image)) {
    if (await hasJsonSbom(ref)) return;
  }
  throw new Error(`No downloadable JSON SBOM found for ${options.image}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    error(getErrorMessage(err));
    process.exit(1);
  }
}
