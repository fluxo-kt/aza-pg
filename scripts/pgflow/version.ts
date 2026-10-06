/**
 * The pgflow version shipped in the image, read from the manifest entry's git tag (`pgflow@X.Y.Z`).
 * A pgflow bump is one manifest edit followed by `bun scripts/pgflow/generate-schema.ts`, which writes the version
 * into the fixture (schema.sql's schema comment, the last line of upgrade/versions.tsv); the image copies those files
 * and never reads this module. schema-fixture.test.ts fails while they differ from the tag, and version.test.ts while
 * the @pgflow/client and @pgflow/dsl pins do.
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
