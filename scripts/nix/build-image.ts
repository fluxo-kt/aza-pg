#!/usr/bin/env bun
/**
 * Builds the Nix image and loads it into the host's Docker: `bun scripts/nix/build-image.ts [--tag <ref>]`.
 *
 * flake.nix's `image` is a script that streams the image tarball (dockerTools.streamLayeredImage), so no tarball is
 * ever written to the store or the disk: the script runs in a container on the same store volume, its stdout piped
 * straight into `docker load`. The default tag is aza-pg:pg<major>-nix, beside the Debian image's aza-pg:pg<major>;
 * --tag retags it after loading.
 */

const tagIndex = Bun.argv.indexOf("--tag");
const retag = tagIndex === -1 ? undefined : Bun.argv[tagIndex + 1];
if (tagIndex !== -1 && !retag) {
  console.error("Usage: bun scripts/nix/build-image.ts [--tag <image-ref>]");
  process.exit(64);
}
const nix = ["bun", `${import.meta.dir}/nix.ts`];
const system = (Bun.env.NIX_PLATFORM ?? `linux/${process.arch}`).endsWith("arm64")
  ? "aarch64-linux"
  : "x86_64-linux";

const build = Bun.spawn(
  [...nix, "build", `.#packages.${system}.image`, "--no-link", "--print-out-paths"],
  {
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

// The stream script is self-contained (its interpreter and inputs are store paths), so any container with the
// store volume mounted can run it; nix.ts only runs `nix`, hence this direct docker run.
const stream = Bun.spawn(
  [
    "docker",
    "run",
    "--rm",
    "-i",
    "-v",
    `aza-pg-nix-${system.startsWith("aarch64") ? "arm64" : "amd64"}:/nix`,
    "nixos/nix:latest",
    streamScript,
  ],
  { stdout: "pipe", stderr: "inherit" }
);
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
console.log(retag ?? ref);
