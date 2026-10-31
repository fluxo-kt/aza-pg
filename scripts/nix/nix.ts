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
 * The container builds in Nix's sandbox, as CI and Hydra do (--privileged: Nix needs mount and user namespaces;
 * SYS_ADMIN alone is not enough). Unsandboxed, a build sees the container's /usr/bin/env and the like, so a source
 * relying on them passes here and fails in CI (pgBackRest 2.60's "#!/usr/bin/env python3" build script did), and
 * builds outside /build leave debug-info paths in PostgreSQL's JIT bitcode that its output check rejects.
 * sandbox-fallback = false: Nix otherwise drops the sandbox silently when namespaces are missing.
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
    "--privileged",
    "-i",
    "--name",
    container,
    "--platform",
    nixPlatform,
    "-e",
    `NIX_CONFIG=filter-syscalls = false\nsandbox = true\nsandbox-fallback = false\n${FLAGS}`,
    "-v",
    `aza-pg-nix-${arch}:/nix`,
    // builtins.fetchGit (every source in nix/extensions.nix) caches its clones here, outside the store; without the
    // volume each run re-clones every extension repository before evaluation can finish.
    "-v",
    `aza-pg-nix-${arch}-cache:/root/.cache/nix`,
    // Writable only so `nix flake lock` can write flake.lock; builds write to the store volume.
    "-v",
    `${path.resolve(import.meta.dir, "../..")}:/src`,
    "-w",
    "/src",
    // CI's Nix: the tag is the nix_version that setup-nix's cachix/install-nix-action pin installs (its
    // install-nix.sh), so a local build runs the same Nix. Bump both together.
    "nixos/nix:2.35.4@sha256:f159a58f390677f41e8e900a74b6e2f9c7f27b364122ae6acf7a652ce6c551c0",
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
