#!/usr/bin/env bun
/**
 * Fails when a CVE that vulnix-whitelist.toml does not clear affects a package the image ships:
 * `bun scripts/security/vulnix-gate.ts [FLAKE]` (the host's architecture, or NIX_PLATFORM's). FLAKE defaults to this
 * checkout; cve-scan.ts passes `path:<dir>` holding another revision's tree, a path relative to the repo root (the
 * container sees only the repo).
 *
 * Trivy reads OS package databases, and a Nix image has none, so it sees only Rust crates and bundled JS; glibc,
 * OpenSSL, curl and every other C library would go unscanned. vulnix matches each store path of the image's
 * runtime closure (flake output `contents`) against NVD. vulnix is the flake's `vulnix` output and NVD's feeds
 * are live, so a run checks the revision against today's CVEs. vulnix sees only CVEs NVD has matched to a package
 * name: /update still checks PostgreSQL, OpenSSL and glibc against their own security pages. The first run downloads the NVD feeds; later ones update
 * them from vulnix's cache.
 *
 * Exit: 0 clean, 1 a CVE to fix or triage (vulnix names it), 2 the scan itself failed.
 */

import path from "node:path";
import { native, nixCommand, nixPlatform } from "../nix/nix";

const root = path.resolve(import.meta.dir, "../..");
const system = nixPlatform === "linux/arm64" ? "aarch64-linux" : "x86_64-linux";

const build = Bun.spawn(
  nixCommand([
    "nix",
    "build",
    `${Bun.argv[2] ?? "."}#packages.${system}.contents`,
    "--no-link",
    "--print-out-paths",
  ]),
  { cwd: root, stdout: "pipe", stderr: "inherit" }
);
const [contents, buildExit] = await Promise.all([new Response(build.stdout).text(), build.exited]);
if (buildExit !== 0) {
  console.error(`vulnix-gate: building the image contents failed (exit ${buildExit})`);
  process.exit(2);
}

const scan = Bun.spawn(
  nixCommand([
    "nix",
    "shell",
    // This checkout's scanner (patched, see flake.nix), whatever revision FLAKE is.
    `.#packages.${system}.vulnix`,
    "--command",
    "vulnix",
    // In the container only the cache volume outlives the run; natively vulnix's default cache already persists.
    ...(native ? [] : ["--cache-dir", "/root/.cache/nix/vulnix"]),
    "--whitelist",
    "scripts/security/vulnix-whitelist.toml",
    "--closure",
    contents.trim(),
  ]),
  { cwd: root, stdout: "inherit", stderr: "inherit" }
);
const scanExit = await scan.exited;
// vulnix exits 2 when it reports a vulnerability, 0 when none remains after the whitelist, anything else on error.
if (scanExit === 0) console.error("vulnix-gate: no CVE outside the whitelist");
else if (scanExit === 2)
  console.error(
    "vulnix-gate: upgrade the package, or triage the CVE into scripts/security/vulnix-whitelist.toml"
  );
process.exit(scanExit === 0 ? 0 : scanExit === 2 ? 1 : 2);
