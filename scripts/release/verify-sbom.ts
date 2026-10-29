#!/usr/bin/env bun
/**
 * Verifies a public image has a signed SPDX SBOM attestation for every runnable platform:
 * `bun scripts/release/verify-sbom.ts --image ghcr.io/OWNER/IMAGE@sha256:...`
 *
 * publish.yml's build job attests each platform image with an SBOM of its exact Nix closure (sbomnix, via
 * actions/attest-sbom). `gh attestation verify` checks the Sigstore signature and that the signer is this
 * repository's workflow, so a missing, unsigned or foreign SBOM fails. Attestations are keyed by digest, so the
 * testing image's attestations cover the promoted production tags too.
 */

import { $ } from "bun";
import { error, info, success } from "../utils/logger";
import { getErrorMessage } from "../utils/errors";

export interface ManifestEntry {
  digest: string;
  platform?: { os: string; architecture: string };
}

const SPDX_PREDICATE_TYPE = "https://spdx.dev/Document/v2.3";

/** Platform images of an index; "unknown/unknown" entries are attestation manifests, not runnable images. */
export function runnablePlatforms(index: { manifests?: ManifestEntry[] }): ManifestEntry[] {
  const runnable = (index.manifests ?? []).filter(
    (m) => m.platform && m.platform.os !== "unknown" && m.platform.architecture !== "unknown"
  );
  if (runnable.length === 0) throw new Error("Image index has no runnable platform manifests");
  return runnable;
}

async function main(): Promise<void> {
  const [flag, image] = Bun.argv.slice(2);
  if (flag !== "--image" || !image?.includes("@sha256:")) {
    throw new Error("Usage: verify-sbom.ts --image ghcr.io/OWNER/IMAGE@sha256:...");
  }
  const repository = image.slice(0, image.indexOf("@"));
  const owner = repository.split("/")[1];
  const raw = await $`docker buildx imagetools inspect --raw ${image}`.nothrow().quiet();
  if (raw.exitCode !== 0)
    throw new Error(`Unable to inspect ${image}: ${raw.stderr.toString().trim()}`);

  const platforms = runnablePlatforms(JSON.parse(raw.stdout.toString()));
  for (const { digest, platform } of platforms) {
    const ref = `oci://${repository}@${digest}`;
    const verify =
      await $`gh attestation verify ${ref} --owner ${owner} --predicate-type ${SPDX_PREDICATE_TYPE}`
        .nothrow()
        .quiet();
    if (verify.exitCode !== 0) {
      throw new Error(
        `No verified SPDX SBOM for ${platform!.os}/${platform!.architecture} (${digest}): ${verify.stderr.toString().trim()}`
      );
    }
    success(`SBOM verified for ${platform!.os}/${platform!.architecture}: ${digest}`);
  }
  info(`Verified ${platforms.length} platform SBOM attestation(s) for ${image}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    error(getErrorMessage(err));
    process.exit(1);
  }
}
