#!/usr/bin/env bun
/**
 * Runs one Nix command against the repo flake in a container: `bun scripts/nix/nix.ts <nix args…>` (e.g. `build .#image`).
 *
 * The Mac has no Nix, so every evaluation and build runs in nixos/nix with the repo mounted at /src. One store volume
 * per architecture keeps built paths between runs; a volume first filled by the other architecture would hide them.
 * The platform is the host's (an arm64 Mac builds the arm64 image); NIX_PLATFORM=linux/amd64 builds amd64 under
 * emulation, where the kernel rejects Nix's seccomp filter — hence filter-syscalls = false, which guards only builds
 * inside this throwaway container.
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
    "NIX_CONFIG=filter-syscalls = false\nexperimental-features = nix-command flakes\nkeep-outputs = true\nwarn-dirty = false",
    "-v",
    `aza-pg-nix-${platform.replace("linux/", "")}:/nix`,
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
