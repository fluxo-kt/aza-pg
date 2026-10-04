/**
 * The pgflow version shipped in the image, derived from the manifest entry's git tag (`pgflow@X.Y.Z`).
 * The tag is the only place the version is written, so a pgflow bump is one manifest edit followed by
 * `bun scripts/pgflow/generate-schema.ts`; everything else (fixture header, client pins check, tests) reads it here.
 */

import { MANIFEST_ENTRIES } from "../extensions/manifest-data";

function manifestPgflowTag(): string {
  const source = MANIFEST_ENTRIES.find((entry) => entry.name === "pgflow")?.source;
  if (source?.type !== "git" || !source.tag.startsWith("pgflow@")) {
    throw new Error(
      "manifest-data.ts: the pgflow entry must have a git source tagged pgflow@X.Y.Z"
    );
  }
  return source.tag;
}

export const PGFLOW_TAG = manifestPgflowTag();
export const PGFLOW_VERSION = PGFLOW_TAG.slice("pgflow@".length);
