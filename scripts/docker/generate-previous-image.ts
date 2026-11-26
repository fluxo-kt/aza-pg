#!/usr/bin/env bun
/**
 * Records which layers and store paths make up MANIFEST_METADATA.previousImage, per architecture, in
 * docker/postgres/previous-image.json.
 *
 * Why: a data directory from an older PostgreSQL major is upgraded by pg_upgrade, which needs the old server. The image
 * build turns these store paths into symlinks /nix/store/<path> -> /var/lib/postgresql/.aza-old-store/<path> (the
 * server runs as postgres and cannot write the root-owned store, and the old binaries only run from their own
 * absolute paths), and the entrypoint fetches the listed layers at first start to fill that directory.
 *
 * Source: the registry alone, three small documents per architecture (index, manifest, config). Nix's layered image
 * records each layer's store paths in its config history ("store paths: [...]"), one entry per layer in layer order;
 * any other shape fails here rather than producing a list that does not match the layers.
 * Network only when the pin changes: an output already naming the pinned image is kept, as extension commits are.
 */
import path from "node:path";
import { MANIFEST_METADATA } from "../extensions/manifest-data";

const OUT = path.resolve(import.meta.dir, "../../docker/postgres/previous-image.json");
const ARCHES = ["amd64", "arm64"] as const;
type Layer = { digest: string; paths: string[] };
type Recorded = { image: string; platforms: Record<(typeof ARCHES)[number], Layer[]> };

const pin = MANIFEST_METADATA.previousImage;
const existing = Bun.file(OUT);
if ((await existing.exists()) && ((await existing.json()) as Recorded).image === pin)
  process.exit(0);

const ref = /^([^/]+)\/([^:@]+)(?::[^@]+)?@(sha256:[0-9a-f]{64})$/.exec(pin);
if (!ref)
  throw new Error(`previousImage must be <registry>/<repo>[:tag]@sha256:<digest>, got ${pin}`);
const [, registry, repo, indexDigest] = ref;

const token = (
  (await (await fetch(`https://${registry}/token?scope=repository:${repo}:pull`)).json()) as {
    token: string;
  }
).token;
const accept = "application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json";
async function get<T>(kind: "manifests" | "blobs", digest: string): Promise<T> {
  const res = await fetch(`https://${registry}/v2/${repo}/${kind}/${digest}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: accept },
  });
  if (!res.ok) throw new Error(`${registry}/${repo} ${kind}/${digest}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

const index = await get<{ manifests: { digest: string; platform?: { architecture: string } }[] }>(
  "manifests",
  indexDigest!
);
const platforms = {} as Recorded["platforms"];
for (const arch of ARCHES) {
  const entry = index.manifests.find((m) => m.platform?.architecture === arch);
  if (!entry) throw new Error(`${pin} has no ${arch} image`);
  const manifest = await get<{ config: { digest: string }; layers: { digest: string }[] }>(
    "manifests",
    entry.digest
  );
  const config = await get<{ history: { comment?: string }[] }>("blobs", manifest.config.digest);
  if (config.history.length !== manifest.layers.length) {
    throw new Error(
      `${arch}: ${config.history.length} history entries for ${manifest.layers.length} layers`
    );
  }
  platforms[arch] = manifest.layers.map((layer, i) => {
    const comment = config.history[i]!.comment ?? "";
    if (!comment.startsWith("store paths: "))
      throw new Error(`${arch} layer ${i}: no store paths in "${comment}"`);
    // The customisation layer carries the image's root files (/etc, /usr/local/bin), not a store path the old server
    // runs from; recording it would fetch it at every upgrade and leave a dangling symlink.
    const paths = [...comment.matchAll(/'\/nix\/store\/([^'/]+)'/g)]
      .map((m) => m[1]!)
      .filter((p) => !p.endsWith("-customisation-layer"));
    return { digest: layer.digest, paths };
  });
}
await Bun.write(OUT, JSON.stringify({ image: pin, platforms } satisfies Recorded, null, 2) + "\n");
