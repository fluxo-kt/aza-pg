#!/usr/bin/env bun
/**
 * Runs one Nix command against the repo flake: `bun scripts/nix/nix.ts <nix args…>` (e.g. `build .#image`).
 *
 * nixCommand is the one place deciding where Nix runs, so local builds and CI share every other line:
 * - natively on a Linux host with nix on PATH (CI runners), in its own sandbox;
 * - otherwise (the Mac has no Linux Nix) in nixos/nix with the repo mounted at /src. One store volume per
 *   architecture keeps built paths between runs; a volume first filled by the other architecture would hide them.
 *   The platform is the host's (an arm64 Mac builds the arm64 image); NIX_PLATFORM=linux/amd64 builds amd64 under
 *   emulation, where the kernel rejects Nix's seccomp filter — hence filter-syscalls = false, which guards only
 *   builds inside this throwaway container.
 *
 * build-dir = /build in the container: unsandboxed Nix builds under /nix/var/nix/builds by default. Clang then
 * records debug-info paths relative to their common prefix /nix ("store/<hash>-…"), which nuke-refs (it matches
 * "/nix/store/<hash>") cannot strip, so PostgreSQL's JIT bitcode keeps references to compilers and headers and fails
 * its own output check. Hydra's sandbox builds in /build, sharing no prefix with the store; so does the container, on
 * an anonymous volume that --rm removes (Nix refuses a world-writable build-dir such as /tmp; a tmpfs would hold Rust
 * build trees in RAM).
 */

import path from "node:path";

const FLAGS = "experimental-features = nix-command flakes\nkeep-outputs = true\nwarn-dirty = false";
export const native = process.platform === "linux" && Bun.which("nix") !== null;
export const nixPlatform =
  Bun.env.NIX_PLATFORM ?? (process.arch === "arm64" ? "linux/arm64" : "linux/amd64");

/** argv that runs `command` (a nix invocation, or a store path such as the image's stream script) where the store is. */
export function nixCommand(command: string[], container = `aza-pg-nix-${process.pid}`): string[] {
  if (native) return ["env", `NIX_CONFIG=${FLAGS}`, ...command];
  const arch = nixPlatform.replace("linux/", "");
  return [
    "docker",
    "run",
    "--rm",
    "--init",
    "-i",
    "--name",
    container,
    "--platform",
    nixPlatform,
    "-e",
    `NIX_CONFIG=filter-syscalls = false\nbuild-dir = /build\n${FLAGS}`,
    "-v",
    `aza-pg-nix-${arch}:/nix`,
    // builtins.fetchGit (every source in nix/extensions.nix) caches its clones here, outside the store; without the
    // volume each run re-clones every extension repository before evaluation can finish.
    "-v",
    `aza-pg-nix-${arch}-cache:/root/.cache/nix`,
    "-v",
    "/build",
    // Writable only so `nix flake lock` can write flake.lock; builds write to the store volume.
    "-v",
    `${path.resolve(import.meta.dir, "../..")}:/src`,
    "-w",
    "/src",
    "nixos/nix:latest",
    ...command,
  ];
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length === 0) {
    console.error(
      "Usage: bun scripts/nix/nix.ts <nix-arguments...>   (flake.nix at the repo root)"
    );
    process.exit(64);
  }
  const container = `aza-pg-nix-${process.pid}`;
  const proc = Bun.spawn(nixCommand(["nix", ...args], container), {
    cwd: path.resolve(import.meta.dir, "../.."),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  // --rm does not run when the client is killed; remove the container so it stops building.
  const stop = () =>
    Bun.spawn(["docker", "rm", "-f", "-v", container], { stdout: "ignore", stderr: "ignore" });
  if (!native) {
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }
  process.exitCode = await proc.exited;
}
