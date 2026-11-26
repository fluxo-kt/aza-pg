/**
 * Refuses to test a local image built from other image inputs than the working tree holds: suites would pass or fail
 * against code that is no longer there.
 *
 * The image's revision label (nix/image.nix) names the commit it was built from, `-dirty` when the tree had
 * uncommitted changes. The image is current when IMAGE_INPUTS in the working tree equal that commit's; tracked files
 * only, as Nix's git fetcher reads them. A dirty build whose inputs differ from its commit cannot be told apart from a
 * stale one, so it is refused too: commit, then `bun run build`. An image whose commit this clone lacks (CI's shallow
 * checkout reusing a cached image, keyed by these same inputs) is not judged. Nor is a pulled image (it has a registry
 * digest; a local build loaded from Nix has none): it is a published artifact named on purpose, and a `Fixed` changelog
 * entry needs its check run against the last release, which this would refuse.
 */

/**
 * Everything the flake reads to build the image. ci.yml's image cache key and setup-nix's store key hash the same
 * paths; image-inputs.test.ts fails when either list drifts from this one.
 */
export const IMAGE_INPUTS = [
  "flake.lock",
  "flake.nix",
  "nix",
  "docker/postgres",
  "scripts/extensions/manifest-data.ts",
];

/** Why `image` must be rebuilt before testing, or null when it is current or cannot be judged. */
export async function staleImageReason(image: string): Promise<string | null> {
  const [digests = "", label = ""] = (
    await Bun.$`docker image inspect --format ${'{{len .RepoDigests}} {{index .Config.Labels "org.opencontainers.image.revision"}}'} ${image}`
      .nothrow()
      .quiet()
      .text()
  )
    .trim()
    .split(" ");
  if (digests !== "0") return null;
  const commit = label.replace(/-dirty$/, "");
  const known = await Bun.$`git cat-file -e ${commit}^{commit}`.nothrow().quiet();
  if (!/^[0-9a-f]{40}$/.test(commit) || known.exitCode !== 0) return null;
  const diff = await Bun.$`git diff --quiet ${commit} -- ${IMAGE_INPUTS}`.nothrow().quiet();
  return diff.exitCode === 0
    ? null
    : `${image} was built from ${label}, and image inputs changed since (\`git diff ${commit.slice(0, 7)} -- ${IMAGE_INPUTS.join(" ")}\`): commit, then \`bun run build\`, or every suite tests the old image`;
}
