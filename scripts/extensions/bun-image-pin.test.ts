/**
 * The pg_net test's echo-server image must be the Bun that .tool-versions pins. Docker pulls by the digest and ignores
 * the tag, so a Bun bump that forgets to re-resolve it keeps every run on the old Bun with nothing failing.
 */
import { expect, test } from "bun:test";
import { MANIFEST_METADATA } from "./manifest-data";

test("bunImage names the .tool-versions Bun", async () => {
  const toolVersions = await Bun.file(`${import.meta.dir}/../../.tool-versions`).text();
  const pinned = /^bun (\S+)$/m.exec(toolVersions)?.[1];
  expect(pinned).toBeDefined();
  const tag = `oven/bun:${pinned}-alpine`;
  const expected = `${tag}@sha256:`;
  if (!MANIFEST_METADATA.bunImage.startsWith(expected))
    throw new Error(
      `MANIFEST_METADATA.bunImage is ${MANIFEST_METADATA.bunImage}, but .tool-versions pins bun ${pinned}. ` +
        `Set it to ${expected}<digest> from \`docker buildx imagetools inspect ${tag}\`, then \`bun run generate\`.`
    );
});
