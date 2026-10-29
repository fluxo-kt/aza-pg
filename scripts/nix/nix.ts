#!/usr/bin/env bun
/**
 * Runs one Nix command against the repo flake in a container: `bun scripts/nix/nix.ts <nix args…>` (e.g. `build .#image`).
 *
 * The Mac has no Nix, so every evaluation and build runs in nixos/nix with the repo mounted at /src. One store volume
 * per architecture keeps built paths between runs; a volume first filled by the other architecture would hide them.
 * The platform is the host's (an arm64 Mac builds the arm64 image); NIX_PLATFORM=linux/amd64 builds amd64 under
 * emulation, where the kernel rejects Nix's seccomp filter — hence filter-syscalls = false, which guards only builds
 * inside this throwaway container.
 *
 * build-dir = /tmp: unsandboxed Nix builds under /nix/var/nix/builds by default. Clang then records debug-info paths
 * relative to their common prefix /nix ("store/<hash>-…"), which nuke-refs (it matches "/nix/store/<hash>") cannot
 * strip, so PostgreSQL's JIT bitcode keeps references to compilers and headers and fails its own output check.
 * Hydra builds in /build, which shares no prefix with the store; so do we, on an anonymous volume that --rm removes (Nix refuses a world-writable build-dir such as /tmp; a tmpfs would hold Rust build trees in RAM).
 */

import path from "node:path";

const args = Bun.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: bun scripts/nix/nix.ts <nix-arguments...>   (flake.nix at the repo root)");
  process.exit(64);
}
const platform = Bun.env.NIX_PLATFORM ?? (process.arch === "arm64" ? "linux/arm64" : "linux/amd64");
const repo = path.resolve(import.meta.dir, "../..");
const name = `aza-pg-nix-${process.pid}`;

const proc = Bun.spawn(
  [
    "docker",
    "run",
    "--rm",
    "--init",
    "-i",
    "--name",
    name,
    "--platform",
    platform,
    "-e",
    "NIX_CONFIG=filter-syscalls = false\nbuild-dir = /build\nexperimental-features = nix-command flakes\nkeep-outputs = true\nwarn-dirty = false",
    "-v",
    `aza-pg-nix-${platform.replace("linux/", "")}:/nix`,
    "-v",
    "/build",
    // Writable only so `nix flake lock` can write flake.lock; builds write to the store volume.
    "-v",
    `${repo}:/src`,
    "-w",
    "/src",
    "nixos/nix:latest",
    "nix",
    ...args,
  ],
  { stdin: "inherit", stdout: "inherit", stderr: "inherit" }
);
// --rm does not run when the client is killed; remove the container so it stops building.
const stop = () =>
  Bun.spawn(["docker", "rm", "-f", "-v", name], { stdout: "ignore", stderr: "ignore" });
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.exitCode = await proc.exited;
