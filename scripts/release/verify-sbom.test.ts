import { describe, expect, test } from "bun:test";
import {
  findSbomAttestations,
  validateSbomAttestationManifest,
  type ImageIndex,
  type ImageManifest,
} from "./verify-sbom";

const AMD64 = "sha256:7eadf5035bc5a44ffabfba40c025d7fdfe94d2cdddaa1b257aa6f4683ffbd54f";
const ARM64 = "sha256:43fca73b5abbbe157768fbcdd9647dfceb02770e46c5f607e182fcb548ac5986";
const AMD64_SBOM = "sha256:247bf6f9e4b1d8bab247e9e575cc3950a63ca683c1cdba3f88491ce0b3cb37f5";
const ARM64_SBOM = "sha256:eeea9d52c20f3d550a11f04b512021e1710689dd1acf40f8e74239faf5bf4c29";
const SPDX_LAYER = "sha256:673b46bc62ea9cb03267920711450f5b1acf25a02616569d567431d3d25e198f";

function attestation(digest: string, target: string) {
  return {
    digest,
    annotations: {
      "vnd.docker.reference.digest": target,
      "vnd.docker.reference.type": "attestation-manifest",
    },
    platform: { os: "unknown", architecture: "unknown" },
  };
}

describe("verify-sbom", () => {
  test("finds one BuildKit SBOM attestation per runnable platform", () => {
    const index: ImageIndex = {
      manifests: [
        { digest: AMD64, platform: { os: "linux", architecture: "amd64" } },
        attestation(AMD64_SBOM, AMD64),
        { digest: ARM64, platform: { os: "linux", architecture: "arm64" } },
        attestation(ARM64_SBOM, ARM64),
      ],
    };

    expect(findSbomAttestations(index)).toEqual([
      { platform: "linux/amd64", digest: AMD64_SBOM },
      { platform: "linux/arm64", digest: ARM64_SBOM },
    ]);
  });

  test("fails when any runnable platform lacks an SBOM attestation", () => {
    const index: ImageIndex = {
      manifests: [
        { digest: AMD64, platform: { os: "linux", architecture: "amd64" } },
        attestation(AMD64_SBOM, AMD64),
        { digest: ARM64, platform: { os: "linux", architecture: "arm64" } },
      ],
    };

    expect(() => findSbomAttestations(index)).toThrow("linux/arm64");
  });

  test("accepts only non-empty SPDX in-toto attestation layers", () => {
    const manifest: ImageManifest = {
      layers: [
        {
          digest: SPDX_LAYER,
          mediaType: "application/vnd.in-toto+json",
          size: 5_199_060,
          annotations: { "in-toto.io/predicate-type": "https://spdx.dev/Document" },
        },
      ],
    };

    expect(() => validateSbomAttestationManifest(manifest, "test-ref")).not.toThrow();
  });

  test("rejects provenance attestations and empty SBOM descriptors", () => {
    const manifest: ImageManifest = {
      layers: [
        {
          digest: SPDX_LAYER,
          mediaType: "application/vnd.in-toto+json",
          size: 0,
          annotations: { "in-toto.io/predicate-type": "https://slsa.dev/provenance/v1" },
        },
      ],
    };

    expect(() => validateSbomAttestationManifest(manifest, "test-ref")).toThrow("SPDX");
  });
});
