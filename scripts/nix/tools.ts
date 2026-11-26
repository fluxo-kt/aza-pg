/**
 * The checkers this repo's scripts run (workflow lint, YAML lint, the CVE scanner), built from the flake.nix outputs
 * of the same names: `runTool("actionlint", args)`. Why flake outputs and not upstream images: reason at those outputs
 * in flake.nix.
 *
 * Each runs where nix.ts runs Nix, with the repo root as working directory (/src in the container): file arguments
 * must be repo-relative, since host paths outside the repo do not exist there, and a relative `--output` lands under
 * the repo root.
 * `repository` and `tagPrefix` name the upstream release tags check-updates.ts compares each built version with.
 */
import { type } from "arktype";
import { nixSystem, spawnNix } from "./nix";

export const TOOLS = {
  actionlint: { repository: "https://github.com/rhysd/actionlint", tagPrefix: "v" },
  trivy: { repository: "https://github.com/aquasecurity/trivy", tagPrefix: "v" },
  yamllint: { repository: "https://github.com/adrienverge/yamllint", tagPrefix: "v" },
} as const;
export type Tool = keyof typeof TOOLS;
export const TOOL_NAMES = Object.keys(TOOLS) as Tool[];

/**
 * Runs `tool args…` from this checkout's flake output; the exit code is the tool's.
 * Parallel runs on the first evaluation after a flake change print `error (ignored): SQLite database … is busy`: both
 * write the fresh eval cache and Nix lets the loser evaluate uncached, which a cold cache does anyway. Harmless; a warm
 * cache never prints it.
 */
export function runTool(tool: Tool, args: string[], options: Parameters<typeof spawnNix>[1] = {}) {
  return spawnNix(
    ["nix", "shell", `.#packages.${nixSystem}.${tool}`, "--command", tool, ...args],
    options
  );
}

const Versions = type({ "[string]": "string" });

/** Each tool's version as `flake` builds it (default this checkout), read by evaluation alone: nothing is built. */
export async function toolVersions(flake = "."): Promise<Record<Tool, string> | string> {
  const proc = spawnNix(
    [
      "nix",
      "eval",
      "--json",
      `${flake}#packages.${nixSystem}`,
      "--apply",
      `p: { ${TOOL_NAMES.map((t) => `${t} = p.${t}.version;`).join(" ")} }`,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) return `nix eval exited ${code}: ${err.trim()}`;
  const versions = Versions(JSON.parse(out));
  if (versions instanceof type.errors) return versions.summary;
  const missing = TOOL_NAMES.filter((t) => versions[t] === undefined);
  return missing.length > 0
    ? `nix eval returned no version for ${missing.join(", ")}`
    : (versions as Record<Tool, string>);
}
