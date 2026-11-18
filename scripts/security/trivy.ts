#!/usr/bin/env bun
/**
 * The one way this repo runs Trivy: `bun scripts/security/trivy.ts <image> [--gate] [trivy image flags…]`, exit code
 * Trivy's.
 *
 * Why one entry point: the release gate (publish.yml), its diagnostics and `security:scan` must run the same scanner
 * version against the same rules, or a release blocks on findings the local check never showed (or the reverse).
 * publish.yml once ran trivy-action, which installs Trivy from GitHub release binaries at its own default version
 * (v0.70.0 while this pin was 0.76.2) — release binaries are what an attacker deleted in the 2026-03-01 compromise,
 * so AGENTS.md forbids them; an image pinned by digest stays pullable and cannot change under us.
 *
 * The DB cache lives in the repo's .trivy-cache (one DB, replaced in place; CI caches the same path).
 * A target already in the local Docker daemon (a local build, or a private image the caller pulled with its own
 * registry login) is read from the daemon, so the scanner never holds registry credentials; the daemon socket is
 * mounted only then. Anything else is fetched by Trivy from its registry anonymously.
 * The working directory is mounted at /work, so `--output <relative path>` lands in the caller's directory.
 */
import path from "node:path";

// Pinned to an immutable post-incident release, run as a container (see above).
export const TRIVY_IMAGE =
  "ghcr.io/aquasecurity/trivy:0.76.2@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb";

/**
 * The release gate, `--gate` on the command line: fixable CRITICAL/HIGH fails. An unfixed CVE has no action, and a
 * fixable MEDIUM is /update work, not a release blocker. publish.yml and security:scan both use it.
 */
export const GATE_FLAGS = [
  "--quiet",
  "--severity",
  "CRITICAL,HIGH",
  "--ignore-unfixed",
  "--exit-code",
  "1",
];

const root = path.resolve(import.meta.dir, "../..");

/** docker argv scanning `image` with the pinned Trivy; `flags` are Trivy `image` flags. */
export function trivyArgv(image: string, flags: string[]): string[] {
  const local =
    Bun.spawnSync(["docker", "image", "inspect", image], { stdout: "ignore", stderr: "ignore" })
      .exitCode === 0;
  return [
    "docker",
    "run",
    "--rm",
    ...(local ? ["-v", "/var/run/docker.sock:/var/run/docker.sock"] : []),
    "-v",
    `${path.join(root, ".trivy-cache")}:/root/.cache/trivy`,
    "-v",
    `${process.cwd()}:/work`,
    "-w",
    "/work",
    TRIVY_IMAGE,
    "image",
    ...(local ? ["--image-src", "docker"] : []),
    // A Nix `*-source` store path is an unpacked source tree (nixos/nix carries all of nixpkgs): its Cargo.lock and
    // package-lock files describe software that is not installed, and once made the nix image fail with 135 findings.
    "--skip-dirs",
    "nix/store/*-source",
    ...flags,
    image,
  ];
}

if (import.meta.main) {
  const [image, ...flags] = Bun.argv.slice(2);
  if (image === undefined || image.startsWith("-")) {
    console.error("usage: bun scripts/security/trivy.ts <image> [trivy image flags…]");
    process.exit(2);
  }
  const expanded = flags.flatMap((f) => (f === "--gate" ? GATE_FLAGS : [f]));
  const proc = Bun.spawn(trivyArgv(image, expanded), { stdout: "inherit", stderr: "inherit" });
  process.exit(await proc.exited);
}
