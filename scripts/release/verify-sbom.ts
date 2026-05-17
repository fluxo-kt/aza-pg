#!/usr/bin/env bun
/**
 * Verifies a public image has BuildKit SPDX SBOM attestations for every runnable platform.
 */

import { $ } from "bun";
import { error, info, success } from "../utils/logger";
import { getErrorMessage } from "../utils/errors";

interface Options {
  image: string;
}

export interface Platform {
  os: string;
  architecture: string;
}

export interface ManifestEntry {
  mediaType?: string;
  digest: string;
  size?: number;
  annotations?: Record<string, string>;
  platform?: Platform;
}

export interface ImageIndex {
  manifests?: ManifestEntry[];
}

export interface ImageManifest {
  layers?: ManifestEntry[];
}

export interface SbomAttestation {
  platform: string;
  digest: string;
}

const ATTESTATION_TYPE = "attestation-manifest";
const IN_TOTO_MEDIA_TYPE = "application/vnd.in-toto+json";
const SPDX_PREDICATE_TYPE = "https://spdx.dev/Document";

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

function formatPlatform(platform: Platform): string {
  return `${platform.os}/${platform.architecture}`;
}

function isRunnablePlatform(entry: ManifestEntry): entry is ManifestEntry & { platform: Platform } {
  return Boolean(
    entry.platform && entry.platform.os !== "unknown" && entry.platform.architecture !== "unknown"
  );
}

function isAttestationManifest(entry: ManifestEntry): boolean {
  return entry.annotations?.["vnd.docker.reference.type"] === ATTESTATION_TYPE;
}

function isSpdxLayer(layer: ManifestEntry): boolean {
  return (
    layer.mediaType === IN_TOTO_MEDIA_TYPE &&
    layer.annotations?.["in-toto.io/predicate-type"] === SPDX_PREDICATE_TYPE &&
    /^sha256:[a-f0-9]{64}$/.test(layer.digest) &&
    (layer.size ?? 0) > 0
  );
}

async function inspectRaw(ref: string): Promise<string> {
  const result = await $`docker buildx imagetools inspect --raw ${ref}`.nothrow().quiet();
  if (result.exitCode !== 0) {
    throw new Error(`Unable to inspect ${ref}: ${result.stderr.toString().trim()}`);
  }

  return result.stdout.toString();
}

export function findSbomAttestations(index: ImageIndex): SbomAttestation[] {
  const runnable = (index.manifests ?? []).filter(isRunnablePlatform);
  if (runnable.length === 0) throw new Error("Image index has no runnable platform manifests");

  return runnable.map((platformManifest) => {
    const attestation = (index.manifests ?? []).find(
      (entry) =>
        isAttestationManifest(entry) &&
        entry.annotations?.["vnd.docker.reference.digest"] === platformManifest.digest
    );

    if (!attestation) {
      throw new Error(
        `Missing BuildKit SBOM attestation for ${formatPlatform(platformManifest.platform)}`
      );
    }

    return {
      platform: formatPlatform(platformManifest.platform),
      digest: attestation.digest,
    };
  });
}

export function validateSbomAttestationManifest(manifest: ImageManifest, ref: string): void {
  if (!(manifest.layers ?? []).some(isSpdxLayer)) {
    throw new Error(`${ref} has no non-empty SPDX in-toto SBOM layer`);
  }
}

async function verifyBuildKitSboms(image: string): Promise<void> {
  const repository = imageRepository(image);
  const index = JSON.parse(await inspectRaw(image)) as ImageIndex;
  const attestations = findSbomAttestations(index);

  for (const attestation of attestations) {
    const ref = `${repository}@${attestation.digest}`;
    const manifest = JSON.parse(await inspectRaw(ref)) as ImageManifest;
    validateSbomAttestationManifest(manifest, ref);
    success(`SBOM attestation verified for ${attestation.platform}: ${attestation.digest}`);
  }

  info(`Verified ${attestations.length} platform SBOM attestation(s) for ${image}`);
}

async function main(): Promise<void> {
  const options = parseArgs();
  await verifyBuildKitSboms(options.image);
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    error(getErrorMessage(err));
    process.exit(1);
  }
}
