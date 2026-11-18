#!/usr/bin/env bun
/**
 * The one way this repo runs Trivy: `bun scripts/security/trivy.ts <image> [--gate] [trivy image flags…]`, exit code
 * Trivy's.
 *
 * Why one entry point: the release gate (publish.yml), its diagnostics and `security:scan` must run the same scanner
 * build against the same rules, or a release blocks on findings the local check never showed (or the reverse).
 * publish.yml once ran trivy-action, which installs Trivy from GitHub release binaries at its own default version
 * (v0.70.0 while ours was 0.76.2), and release binaries are what an attacker deleted in the 2026-03-01 compromise.
 * Trivy is flake.nix's `trivy` output: built from source pinned by flake.lock, so it can neither vanish nor change
 * under us, and it carries no distro (upstream's image bundled Alpine git with fixable HIGH CVEs).
 *
 * The DB cache is the repo's .trivy-cache (one DB, replaced in place; publish.yml caches the same path).
 * A target already in the local Docker daemon (a local build, or a private image the caller pulled with its own
 * registry login) is read from the daemon, so the scanner never holds registry credentials; the Nix container gets
 * the daemon socket only then. Anything else Trivy fetches from its registry anonymously.
 * Trivy runs from the repo root (scripts/nix/tools.ts), so a relative `--output` lands there.
 */
import { runTool, spawnNix } from "../nix/tools";
import { nixSystem } from "../nix/nix";

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

// A Nix `*-source` store path is an unpacked source tree (nixos/nix carries all of nixpkgs): its Cargo.lock and
// package-lock files describe software that is not installed, and once made the nix image fail with 135 findings.
const COMMON = ["--cache-dir", ".trivy-cache", "--skip-dirs", "nix/store/*-source"];

type Stdio = "inherit" | "pipe";

/** Scans `image`; `flags` are Trivy `image` flags. */
export function scanImage(image: string, flags: string[], stdio: Stdio = "inherit") {
  const local =
    Bun.spawnSync(["docker", "image", "inspect", image], { stdout: "ignore", stderr: "ignore" })
      .exitCode === 0;
  return runTool(
    "trivy",
    ["image", ...(local ? ["--image-src", "docker"] : []), ...COMMON, ...flags, image],
    {
      dockerArgs: local ? ["-v", "/var/run/docker.sock:/var/run/docker.sock"] : [],
      stdout: stdio,
      stderr: stdio,
    }
  );
}

// Copies the closure into one directory: Trivy scans a single root, and skipping everything else in a shared store
// is not expressible. Hard links would be cheaper but fail across filesystems (the native store vs /tmp). Store paths
// never contain spaces, so ROOTS splits safely; the flags arrive as "$@". The copies keep the store's read-only
// modes, so a non-root user (a native host) could not delete them without the chmod.
const SCAN_CLOSURE =
  'set -eu; d=$(mktemp -d); trap \'chmod -R u+w "$d"; rm -rf "$d"\' EXIT; cp -a $(nix-store -qR $ROOTS) "$d"; trivy rootfs --cache-dir .trivy-cache "$@" "$d"';

/**
 * Scans the runtime closures of `outputs` (flake outputs of `flake`, e.g. the checkers) with the gate flags, for
 * language packages: Go binaries' modules and Python distributions. Their C libraries are vulnix's (vulnix-gate.ts),
 * which Trivy cannot see in a Nix store. Returns Trivy's exit code (2 when the build fails) and the combined output.
 */
export async function scanClosure(
  flake: string,
  outputs: string[]
): Promise<{ code: number; output: string }> {
  const collect = async (proc: ReturnType<typeof spawnNix>) => {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    return { code, out, err };
  };
  const installables = outputs.map((o) => `${flake}#packages.${nixSystem}.${o}`);
  const built = await collect(
    spawnNix(["nix", "build", "--no-link", "--print-out-paths", ...installables], {
      stdout: "pipe",
      stderr: "pipe",
    })
  );
  if (built.code !== 0) return { code: 2, output: `nix build failed:\n${built.err}` };
  const roots = built.out.trim().split("\n").join(" ");
  const scan = await collect(
    spawnNix(
      [
        "nix",
        "shell",
        // This checkout's scanner, whatever revision FLAKE is.
        `.#packages.${nixSystem}.trivy`,
        "--command",
        "env",
        `ROOTS=${roots}`,
        "sh",
        "-c",
        SCAN_CLOSURE,
        "sh",
        ...GATE_FLAGS,
      ],
      { stdout: "pipe", stderr: "pipe" }
    )
  );
  return { code: scan.code, output: scan.out + scan.err };
}

if (import.meta.main) {
  const [image, ...flags] = Bun.argv.slice(2);
  if (image === undefined || image.startsWith("-")) {
    console.error("usage: bun scripts/security/trivy.ts <image> [--gate] [trivy image flags…]");
    process.exit(2);
  }
  const expanded = flags.flatMap((f) => (f === "--gate" ? GATE_FLAGS : [f]));
  process.exit(await scanImage(image, expanded).exited);
}
