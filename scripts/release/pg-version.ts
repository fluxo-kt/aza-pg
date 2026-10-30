#!/usr/bin/env bun
/**
 * Writes the release's PostgreSQL version to GITHUB_OUTPUT as `full=18.6` and `major=18`:
 * `bun scripts/release/pg-version.ts`
 *
 * MANIFEST_METADATA.pgVersion is the one source: flake.nix refuses to build when nixpkgs' server is another version,
 * so tags and labels taken from it always name the PostgreSQL inside the image.
 */

import { MANIFEST_METADATA } from "../extensions/manifest-data";

const full = MANIFEST_METADATA.pgVersion;
const major = full.split(".")[0];
if (!/^\d+\.\d+$/.test(full) || !major) {
  console.error(`MANIFEST_METADATA.pgVersion is "${full}", expected <major>.<minor> such as 18.6`);
  process.exit(1);
}
const output = Bun.env.GITHUB_OUTPUT;
if (!output) {
  console.log(`full=${full}\nmajor=${major}`);
} else {
  const file = Bun.file(output);
  await Bun.write(
    output,
    ((await file.exists()) ? await file.text() : "") + `full=${full}\nmajor=${major}\n`
  );
}
