#!/usr/bin/env bun
/**
 * Companion images (pgbouncer, the exporters) have one pin: the `${VAR:-repo:tag@sha256:…}` default in
 * stacks/*\/compose.yml. Every other place that names one of those repositories with a version — .env.example
 * files, docs, test scripts, deployments, the /update skill — must carry that same tag@digest.
 *
 * Why: the pin was hand-copied into each of those places and drifted (docs advertised exporter 0.18.1 while the
 * stacks ran 0.19.1, deployments ran 0.9.0), so an operator copying a doc ran an image nobody tested. The compose
 * default is the pin because it is what a stack runs when the operator sets nothing.
 *
 * Usage: bun scripts/validate/companion-image-pins.ts   (exit 1 lists each drifted file:line with the fix)
 */
import { Glob } from "bun";

// aza-pg's own image is not a companion: stacks default to its floating major tag on purpose (latest release).
const OWN_IMAGE = "ghcr.io/fluxo-kt/aza-pg";
const SCANNED = [
  "stacks/*/.env.example",
  ".env.example",
  "docs/**/*.md",
  "scripts/test/**/*.ts",
  "deployments/**/*",
  ".claude/commands/update.md",
];

interface Pin {
  ref: string; // tag@sha256:…
  source: string;
}

const pins = new Map<string, Pin>(); // repository (registry prefix stripped) → pin
const problems: string[] = [];

// Registries hosting the same image name (quay.io mirrors prometheuscommunity) count as the same repository.
const bareRepo = (repo: string) => repo.replace(/^(docker\.io|quay\.io|ghcr\.io)\//, "");

for await (const file of new Glob("stacks/*/compose.yml").scan(".")) {
  const compose = Bun.YAML.parse(await Bun.file(file).text()) as {
    services?: Record<string, { image?: string }>;
  };
  for (const [service, def] of Object.entries(compose.services ?? {})) {
    const image = def.image?.trim();
    const fallback = image?.match(/^\$\{[A-Z0-9_]+:-(.+)\}$/)?.[1];
    if (!fallback || fallback.startsWith(OWN_IMAGE)) continue;
    const m = fallback.match(/^([^:@\s]+):([^@\s]+)@(sha256:[0-9a-f]{64})$/);
    if (!m) {
      problems.push(
        `${file}: service ${service} default image "${fallback}" is not pinned; write repo:tag@sha256:<digest> (docker buildx imagetools inspect repo:tag prints the digest)`
      );
      continue;
    }
    const repo = bareRepo(m[1]!);
    const ref = `${m[2]}@${m[3]}`;
    const known = pins.get(repo);
    if (known && known.ref !== ref) {
      problems.push(
        `${file}: service ${service} pins ${repo}:${ref}, but ${known.source} pins ${repo}:${known.ref}; every stack must pin the same image`
      );
    } else if (!known) {
      pins.set(repo, { ref, source: `${file} (${service})` });
    }
  }
}
if (pins.size === 0) {
  problems.push(
    "no pinned companion image found in stacks/*/compose.yml; the compose parse or the pattern broke"
  );
}

const tracked = new Set((await Bun.$`git ls-files`.quiet().text()).split("\n"));
const scanned = new Set<string>();
for (const pattern of SCANNED) {
  for await (const file of new Glob(pattern).scan({ cwd: ".", dot: true })) {
    if (tracked.has(file)) scanned.add(file);
  }
}

for (const file of [...scanned].sort()) {
  const lines = (await Bun.file(file).text()).split("\n");
  lines.forEach((line, index) => {
    for (const [repo, pin] of pins) {
      const escaped = repo.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      // A version-shaped tag only: placeholders such as vX.Y.Z or <tag> are instructions, not pins.
      const re = new RegExp(
        `(?:[a-z0-9.-]+\\.[a-z]+/)?${escaped}:(v?[0-9][A-Za-z0-9._-]*)(@sha256:[0-9a-f]{64})?`,
        "g"
      );
      for (const m of line.matchAll(re)) {
        const found = `${m[1]}${m[2] ?? ""}`;
        if (found !== pin.ref) {
          problems.push(
            `${file}:${index + 1}: ${repo}:${found} differs from the pin ${repo}:${pin.ref} in ${pin.source}; write the pinned tag@digest here (or change the pin in every stacks/*/compose.yml first)`
          );
        }
      }
    }
  });
}

if (problems.length > 0) {
  console.error(`Companion image pins drifted:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(
  `Companion image pins consistent: ${[...pins].map(([r, p]) => `${r}:${p.ref.split("@")[0]}`).join(", ")} across ${scanned.size} files`
);
