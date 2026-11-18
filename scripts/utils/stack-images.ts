/**
 * The image each stacks/*\/compose.yml service runs when the operator sets nothing: the default inside its
 * `${VAR:-<ref>}` image line. These defaults are the pins (companion images carry repo:tag@sha256:…, aza-pg's own
 * image its floating major tag, i.e. the latest release), so pin validation reads them from here.
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
