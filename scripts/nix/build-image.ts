#!/usr/bin/env bun
/**
 * Builds the Nix image and loads it into the host's Docker: `bun scripts/nix/build-image.ts [--tag <ref> | --push <ref>]`.
 *
 * flake.nix's `image` is a script that streams the image tarball (dockerTools.streamLayeredImage), so no tarball is
 * ever written to the store or the disk: the script runs where nix.ts runs Nix (natively or in its container), its stdout piped
 * straight into `docker load`. The default tag is aza-pg:pg<major>, the
 * image the suites test by default; --tag retags it after loading. --push (publish.yml) sends the stream to the
 * registry instead and prints the pushed digest: `docker load` keeps the tarball's Docker media types, and an index
 * of Docker manifests is a Docker manifest list, which cannot carry the annotations publish.yml adds, so skopeo (from
 * the locked nixpkgs) writes OCI ones, gzip-compressed before the push (reason at the push). It needs native Nix,
 * since the registry login lives on the host.
 * A rebuilt tag leaves the previous image dangling, so the build removes dangling aza-pg images, and collects the store volume (reason at GC_ROOTS).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reclaimDanglingAzaImages } from "../docker/cleanup-artifacts";
import { native, nixCommand, nixPlatform } from "./nix";

const flagValue = (flag: string) => {
  const i = Bun.argv.indexOf(flag);
  return i === -1 ? undefined : (Bun.argv[i + 1] ?? "");
};
const retag = flagValue("--tag");
const push = flagValue("--push");
if (retag === "" || push === "" || (retag && push) || (push && !native)) {
  console.error(
    "Usage: bun scripts/nix/build-image.ts [--tag <image-ref> | --push <image-ref>] (--push needs native Nix)"
  );
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

if (push) {
  const scratch = await mkdtemp(path.join(Bun.env.RUNNER_TEMP ?? tmpdir(), "aza-pg-push-"));
  const digestFile = path.join(scratch, "digest");
  // Two copies, both proven against a registry seeded with raw layer blobs:
  // 1. stream -> local OCI layout, gzip level 9. The stream's layers are raw tar, and pushing them directly lets skopeo
  //    reuse a raw blob the registry already holds under that digest and still declare it
  //    gzip, so pulls fetch the image uncompressed under a false media type. Compressing first makes every digest a gzip
  //    one. Level 9 costs push CPU only; gzip decompresses at the same speed at any level.
  // 2. layout -> registry with gzip forced, which stops skopeo's blob cache swapping a gzip layer for its raw twin.
  // One shell script, because skopeo opens /dev/stdin by path and Bun hands a child's stdin over as a socket, which
  // cannot be opened. --insecure-policy: the trust policy vets signatures on the image read, our own build here, and
  // skopeo refuses to run without a policy.json, which a runner need not have.
  const script = [
    'skopeo() { nix run --inputs-from . nixpkgs#skopeo -- --insecure-policy copy "$@"; }',
    '"$0" | skopeo --dest-compress-format gzip --dest-compress-level 9 docker-archive:/dev/stdin "oci:$1:image" &&',
    'skopeo --format oci --dest-compress-format gzip --dest-force-compress-format --digestfile "$2" "oci:$1:image" "docker://$3"',
  ].join("\n");
  const copy = Bun.spawn(
    nixCommand([
      "bash",
      "-o",
      "pipefail",
      "-c",
      script,
      streamScript,
      `${scratch}/oci`,
      digestFile,
      push,
    ]),
    { cwd: path.resolve(import.meta.dir, "../.."), stdout: "ignore", stderr: "inherit" }
  );
  const copyExit = await copy.exited;
  const digest = copyExit === 0 ? (await Bun.file(digestFile).text()).trim() : "";
  await rm(scratch, { recursive: true, force: true });
  if (!digest) {
    console.error(`pushing the image failed (exit ${copyExit})`);
    process.exit(1);
  }
  // Read back what the registry now serves: a layer declared compressed whose digest is its own uncompressed diff_id
  // is raw tar under a false media type (a gzip blob never hashes to its contents' digest), the failure the two
  // copies above prevent. Checked here, before publish.yml indexes and signs the image.
  const pushed = `docker://${push.replace(/:[^/:]*$/, "")}@${digest}`;
  const inspect = async (flag: string) => {
    const p = Bun.spawn(
      nixCommand([
        "nix",
        "run",
        "--inputs-from",
        ".",
        "nixpkgs#skopeo",
        "--",
        "inspect",
        flag,
        pushed,
      ]),
      { cwd: path.resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "inherit" }
    );
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    if (code !== 0) throw new Error(`skopeo inspect ${flag} ${pushed} failed (exit ${code})`);
    return JSON.parse(out);
  };
  const [manifest, config] = await Promise.all([inspect("--raw"), inspect("--config")]);
  const diffIds = new Set<string>(config.rootfs.diff_ids);
  const raw = (manifest.layers as { digest: string; mediaType: string }[]).filter(
    (l) => !l.mediaType.endsWith(".tar") && diffIds.has(l.digest)
  );
  if (raw.length > 0) {
    console.error(
      `${pushed}: ${raw.length} layer(s) are uncompressed tar declared as ${raw[0]?.mediaType} (digest equals the ` +
        `layer's diff_id), e.g. ${raw[0]?.digest}. skopeo reused raw blobs already in the registry; the push must ` +
        `compress before copying (oci layout step above) and force the format.`
    );
    process.exit(1);
  }
  console.log(digest);
  process.exit(0);
}

// The stream script is self-contained (its interpreter and inputs are store paths): it runs wherever the store is.
const stream = Bun.spawn(nixCommand([streamScript]), { stdout: "pipe", stderr: "inherit" });
// The stream's pipe stays open in this process, so a reader that dies leaves the stream blocked on a full pipe for
// ever instead of failing; kill it so the failure surfaces.
const stopStreamOnFailure = async (reader: { exited: Promise<number> }) => {
  const code = await reader.exited;
  if (code !== 0) stream.kill();
  return code;
};
const load = Bun.spawn(["docker", "load"], {
  stdin: stream.stdout,
  stdout: "pipe",
  stderr: "inherit",
});
const [loaded, streamExit, loadExit] = await Promise.all([
  new Response(load.stdout).text(),
  stream.exited,
  stopStreamOnFailure(load),
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
