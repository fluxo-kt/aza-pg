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
/** The flake's system name for nixPlatform: `.#packages.${nixSystem}.<output>`. */
export const nixSystem = nixPlatform.endsWith("arm64") ? "aarch64-linux" : "x86_64-linux";

// Nix resolves github: inputs through GitHub's API, whose anonymous limit (60 requests an hour per IP) one update
// round's other lookups exhaust; `flake update` then fails with HTTP 403. The container authenticates with
// GITHUB_TOKEN or the local `gh` login. Read once per process: build-image.ts runs several containers.
let githubToken: string | null | undefined;
function readGithubToken(): string | null {
  if (githubToken !== undefined) return githubToken;
  const gh = Bun.env.GITHUB_TOKEN
    ? null
    : Bun.spawnSync(["gh", "auth", "token"], { stderr: "ignore" });
  githubToken =
    Bun.env.GITHUB_TOKEN || (gh?.exitCode === 0 ? gh.stdout.toString().trim() : "") || null;
  return githubToken;
}

/**
 * Environment every nixCommand argv must be spawned with (spawnNix does). The
 * container gets NIX_CONFIG by name (`-e NIX_CONFIG`) so the token never sits in a command line `ps` shows; Bun.spawn
 * passes children the process's startup environment unless `env` is given, so setting Bun.env would not reach it.
 */
function nixEnv(): Record<string, string | undefined> {
  if (native) return Bun.env;
  const token = readGithubToken();
  const auth = token ? `\naccess-tokens = github.com=${token}` : "";
  return {
    ...Bun.env,
    NIX_CONFIG: `filter-syscalls = false\nsandbox = true\nsandbox-fallback = false\n${FLAGS}${auth}`,
  };
}

/**
 * argv that runs `command` (a nix invocation, or a store path such as the image's stream script) where the store is.
 * `dockerArgs` reach only the container (e.g. the Docker socket a scanner needs); natively the host already has them.
 */
export function nixCommand(
  command: string[],
  container = `aza-pg-nix-${process.pid}`,
  dockerArgs: string[] = []
): string[] {
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
    "NIX_CONFIG",
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
    "-v",
    `${path.resolve(import.meta.dir, "container.gitconfig")}:/etc/gitconfig:ro`,
    ...dockerArgs,
    // CI's Nix: the tag is the nix_version that setup-nix's cachix/install-nix-action pin installs (its
    // install-nix.sh), so a local build runs the same Nix. Bump both together.
    "nixos/nix:2.35.6@sha256:b49cb33f3a7e5cf3933ad8774529de0e3807ec5cf54987aa7ccdfb49f2fc55ed",
    ...command,
  ];
}

let storeReady = native;

/**
 * Docker fills an empty named volume from the image on first mount, and two containers mounting it at once both copy:
 * the losers fail ("mkdir …/store: file exists", or exit 127 on a half-copied store; validate:all starts two checker
 * processes together on a fresh runner). So each process first runs one blocking container under a name shared by
 * all processes: Docker gives a name to one container only, which makes it a lock. A process refused the name
 * ("Conflict") tries again until its own run succeeds, which happens only after the holder is gone (`--rm`) and so
 * the volume is filled: Docker copies only into an empty volume. The retry cannot block on the holder instead: during
 * the copy its name is taken while `docker wait` and `inspect` cannot see it yet.
 */
function ensureStore() {
  const lock = `aza-pg-nix-${nixPlatform.replace("linux/", "")}-init`;
  while (!storeReady) {
    const run = Bun.spawnSync(nixCommand(["true"], lock), { stdout: "ignore", stderr: "pipe" });
    storeReady = run.exitCode === 0;
    if (storeReady) return;
    const err = run.stderr.toString();
    // Any other failure is the next Nix run's to report; this only orders the first fill.
    if (!err.includes("Conflict")) return void process.stderr.write(err);
    Bun.sleepSync(200);
  }
}

let spawns = 0;

/**
 * Spawns `command` (a nix invocation, or a store path) with the cwd and environment nixCommand needs: the only way
 * scripts start Nix, so none can forget NIX_CONFIG (flakes would be off, the GitHub token missing). Each spawn gets
 * its own container name: one process may run several at once. `dockerArgs` as for nixCommand.
 */
export function spawnNix(
  command: string[],
  options: {
    dockerArgs?: string[];
    stdout?: "inherit" | "pipe" | "ignore";
    stderr?: "inherit" | "pipe" | "ignore";
  } = {}
) {
  ensureStore();
  return Bun.spawn(
    nixCommand(command, `aza-pg-nix-${process.pid}-${spawns++}`, options.dockerArgs),
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: nixEnv(),
      stdin: "ignore",
      stdout: options.stdout ?? "inherit",
      stderr: options.stderr ?? "inherit",
    }
  );
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
  ensureStore();
  const proc = Bun.spawn(nixCommand(["nix", ...args], container), {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: nixEnv(),
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
