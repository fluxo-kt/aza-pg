#!/usr/bin/env bun
/**
 * Builds the Nix image and loads it into the host's Docker: `bun scripts/nix/build-image.ts [--tag <ref>]`.
 *
 * flake.nix's `image` is a script that streams the image tarball (dockerTools.streamLayeredImage), so no tarball is
 * ever written to the store or the disk: the script runs where nix.ts runs Nix (natively or in its container), its stdout piped
 * straight into `docker load`. The default tag is aza-pg:pg<major>, the
 * image the suites test by default; --tag retags it after loading. A rebuilt tag leaves the previous image dangling,
 * so the build removes dangling aza-pg images, and collects the store volume (reason at GC_ROOTS).
 */

import path from "node:path";
import { reclaimDanglingAzaImages } from "../docker/cleanup-artifacts";
import { native, nixCommand, nixPlatform } from "./nix";

const tagIndex = Bun.argv.indexOf("--tag");
const retag = tagIndex === -1 ? undefined : Bun.argv[tagIndex + 1];
if (tagIndex !== -1 && !retag) {
  console.error("Usage: bun scripts/nix/build-image.ts [--tag <image-ref>]");
  process.exit(64);
}
const system = nixPlatform.endsWith("arm64") ? "aarch64-linux" : "x86_64-linux";
const build = Bun.spawn(
  nixCommand(["nix", "build", `.#packages.${system}.image`, "--no-link", "--print-out-paths"]),
  {
    cwd: path.resolve(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "inherit",
  }
);
const [built, buildExit] = await Promise.all([new Response(build.stdout).text(), build.exited]);
const streamScript = built.trim();
if (buildExit !== 0 || !streamScript.startsWith("/nix/store/")) {
  console.error(`nix build failed (exit ${buildExit}); see the log above.`);
  process.exit(buildExit || 1);
}

// The stream script is self-contained (its interpreter and inputs are store paths): it runs wherever the store is.
const stream = Bun.spawn(nixCommand([streamScript]), { stdout: "pipe", stderr: "inherit" });
const load = Bun.spawn(["docker", "load"], {
  stdin: stream.stdout,
  stdout: "pipe",
  stderr: "inherit",
});
const [loaded, streamExit, loadExit] = await Promise.all([
  new Response(load.stdout).text(),
  stream.exited,
  load.exited,
]);
if (streamExit !== 0 || loadExit !== 0) {
  console.error(
    `streaming the image failed (stream exit ${streamExit}, docker load exit ${loadExit})`
  );
  process.exit(1);
}
const ref = loaded.match(/Loaded image: (\S+)/)?.[1];
if (!ref) {
  console.error(`docker load reported no image:\n${loaded}`);
  process.exit(1);
}
if (retag) {
  const tag = Bun.spawn(["docker", "tag", ref, retag], { stdout: "ignore", stderr: "inherit" });
  if ((await tag.exited) !== 0) process.exit(1);
}
console.error(`Reclaimed ${await reclaimDanglingAzaImages()}`);
// The container's store volume is ours alone and would keep every earlier build's closure forever (tens of GB), so
// each build replaces the roots in GC_ROOTS with this image and the flake's inputs, then collects the rest.
// keep-outputs (nix.ts) plus Nix's default keep-derivations make the image root keep every build input, so an
// unchanged rebuild stays cached; flake inputs (nixpkgs' source) are fetched at evaluation, outside any derivation,
// and need roots of their own or every build downloads them again. Replacing the whole directory drops the previous
// build's roots. A native store is the host's (CI runners are discarded anyway): collecting it would delete the
// host's own paths.
const GC_ROOTS = "/nix/var/nix/gcroots/aza-pg";
const REROOT_AND_COLLECT =
  'set -e; rm -rf "$0"; mkdir "$0"; for p; do ln -s "$p" "$0/${p#/nix/store/}"; done; nix store gc';
type FlakeNode = { path: string; inputs?: Record<string, FlakeNode> };
const inputPaths = (node: FlakeNode): string[] =>
  Object.values(node.inputs ?? {}).flatMap((input) => [input.path, ...inputPaths(input)]);
if (!native) {
  const archive = Bun.spawn(nixCommand(["nix", "flake", "archive", "--json"]), {
    stdout: "pipe",
    stderr: "inherit",
  });
  const [archived, archiveExit] = await Promise.all([
    new Response(archive.stdout).text(),
    archive.exited,
  ]);
  if (archiveExit !== 0) {
    console.error(`nix flake archive failed (exit ${archiveExit}); see the log above.`);
    process.exit(1);
  }
  const roots = [streamScript, ...new Set(inputPaths(JSON.parse(archived) as FlakeNode))];
  const gc = Bun.spawn(nixCommand(["sh", "-c", REROOT_AND_COLLECT, GC_ROOTS, ...roots]), {
    stdout: "pipe",
    stderr: "pipe",
  });
  // stdout holds only the summary ("N store paths deleted, X freed"); stderr lists every deleted path.
  const [summary, gcLog, gcExit] = await Promise.all([
    new Response(gc.stdout).text(),
    new Response(gc.stderr).text(),
    gc.exited,
  ]);
  if (gcExit !== 0) {
    console.error(`collecting the Nix store failed (exit ${gcExit}):\n${gcLog}`);
    process.exit(1);
  }
  console.error(`Nix store: ${summary.trim()}`);
}
console.log(retag ?? ref);
