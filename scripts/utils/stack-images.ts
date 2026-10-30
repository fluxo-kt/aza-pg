/**
 * The image each stacks/*\/compose.yml service runs when the operator sets nothing: the default inside its
 * `${VAR:-<ref>}` image line. These defaults are the pins (companion images carry repo:tag@sha256:…, aza-pg's own
 * image its floating major tag, i.e. the latest release), so pin validation and CVE scans read them from here.
 */
import { Glob } from "bun";

export interface StackImage {
  file: string;
  service: string;
  /** The default reference; null when the image line has no `${VAR:-…}` default. */
  ref: string | null;
}

/** `root`: the tree to read (cve-scan.ts passes another revision's); `file` stays relative to it. */
export async function stackDefaultImages(root = "."): Promise<StackImage[]> {
  const images: StackImage[] = [];
  for await (const file of new Glob("stacks/*/compose.yml").scan(root)) {
    const compose = Bun.YAML.parse(await Bun.file(`${root}/${file}`).text()) as {
      services?: Record<string, { image?: string }>;
    };
    for (const [service, def] of Object.entries(compose.services ?? {})) {
      const image = def.image?.trim();
      if (image === undefined) continue;
      images.push({ file, service, ref: image.match(/^\$\{[A-Z0-9_]+:-(.+)\}$/)?.[1] ?? null });
    }
  }
  return images;
}
