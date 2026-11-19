/**
 * The image each stacks/*\/compose.yml service runs when the operator sets nothing: the default inside its
 * `${VAR:-<ref>}` image line. These defaults are the pins (companion images carry repo:tag@sha256:…, aza-pg's own
 * image its floating major tag, i.e. the latest release), so pin validation reads them from here. pinnedImages below
 * is the one list of every third-party image the repo pins, for the update check and the CVE scan.
 */
import { Glob } from "bun";

/** The released image; the stacks follow its floating major tag on purpose (latest release), so it has no digest pin. */
export const OWN_IMAGE = "ghcr.io/fluxo-kt/aza-pg";

export interface StackImage {
  file: string;
  service: string;
  /** The default reference; null when the image line has no `${VAR:-…}` default. */
  ref: string | null;
  /** The image line as written: what runs when it has no `${VAR:-…}` default (deployments/ pins this way). */
  image: string;
}

/** `pattern` and `cwd` let the CVE scan read every compose file (deployments/ too) from a release's extracted tree. */
export async function stackDefaultImages(
  pattern = "stacks/*/compose.yml",
  cwd = "."
): Promise<StackImage[]> {
  const images: StackImage[] = [];
  for await (const file of new Glob(pattern).scan(cwd)) {
    const compose = Bun.YAML.parse(await Bun.file(`${cwd}/${file}`).text()) as {
      services?: Record<string, { image?: string }>;
    };
    for (const [service, def] of Object.entries(compose.services ?? {})) {
      const image = def.image?.trim();
      if (image === undefined) continue;
      images.push({
        file,
        service,
        ref: image.match(/^\$\{[A-Z0-9_]+:-(.+)\}$/)?.[1] ?? null,
        image,
      });
    }
  }
  return images;
}

export interface PinnedImage {
  /** Registry host; Docker Hub when the reference names none. */
  host: string;
  /** Repository path without the host: the key upstream lookups (IMAGE_SOURCES) use. */
  repo: string;
  /** "" when the reference has no tag: it names no version to compare, so callers report it as uncheckable. */
  tag: string;
  /** The reference as pinned, host and digest included: what a scanner pulls. */
  ref: string;
  files: string[];
}

/**
 * Docker's reference rule (distribution/reference): the first path component names a registry only when it contains
 * "." or ":" or is "localhost"; anything else lives on Docker Hub. A fixed host list instead misfiles every other
 * registry (registry.gitlab.com, quay.io mirrors) as a Docker Hub repository.
 */
function splitRegistry(name: string): { host: string; repo: string } {
  const slash = name.indexOf("/");
  const first = slash > 0 ? name.slice(0, slash) : "";
  return first.includes(".") || first.includes(":") || first === "localhost"
    ? { host: first, repo: name.slice(slash + 1) }
    : { host: "docker.io", repo: name };
}

/**
 * Every third-party image the repo pins, one entry per repo:tag — the one list both the update check and the CVE
 * scan read, so an image one of them follows can never be missing from the other. `files` is the tracked file list
 * (`git ls-files`, or `git ls-tree` of a release), read under `root`:
 * - stacks/ and deployments/ (compose files and the compose snippets in their READMEs): an `image: repo:tag` line,
 *   or a compose default `${…IMAGE:-repo:tag@sha256:…}`, which the stacks write on the line after `image:`;
 * - scripts/ and .github/: the tool images checks and CI run, pinned as repo:tag@sha256:… literals.
 * aza-pg's own image is skipped: the stacks follow its floating major tag on purpose, and its release refs in
 * scripts/ (the upgrade suite's starting points) are fixed history, never updated or rescanned.
 */
export async function pinnedImages(files: string[], root = "."): Promise<PinnedImage[]> {
  const images = new Map<string, PinnedImage>();
  for (const file of files) {
    const tool = file.startsWith("scripts/") || file.startsWith(".github/");
    if (!tool && !file.startsWith("stacks/") && !file.startsWith("deployments/")) continue;
    for (const line of (await Bun.file(`${root}/${file}`).text()).split("\n")) {
      // The tag is optional in both patterns: a reference without one (`repo@sha256:…`, or a compose `image: repo`
      // floating on latest) is kept with tag "" instead of matching nothing and going stale without any row.
      const m = tool
        ? /\b((?:[a-z0-9-]+\.[a-z0-9.-]+\/)?[a-z0-9][a-z0-9._-]*\/[a-z0-9._-]+)(?::([A-Za-z0-9._-]+))?(@sha256:[0-9a-f]{64})/.exec(
            line
          )
        : /(?:^\s*image:\s*|\$\{[A-Z0-9_]*IMAGE:-)([a-z0-9][a-z0-9./_-]*)(?::([A-Za-z0-9._-]+))?(@sha256:[0-9a-f]{64})?/.exec(
            line
          );
      if (!m) continue;
      const { host, repo } = splitRegistry(m[1]!);
      if (repo === "fluxo-kt/aza-pg" || repo === "aza-pg") continue;
      const tag = m[2] ?? "";
      const key = `${host}/${repo}:${tag}`;
      const known = images.get(key) ?? {
        host,
        repo,
        tag,
        ref: `${m[1]}${tag ? `:${tag}` : ""}${m[3] ?? ""}`,
        files: [],
      };
      if (!known.files.includes(file)) known.files.push(file);
      images.set(key, known);
    }
  }
  return [...images.values()];
}
