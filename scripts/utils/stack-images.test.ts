import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pinnedImages } from "./stack-images";

const root = await mkdtemp(path.join(tmpdir(), "aza-pg-pinned-"));
afterAll(() => rm(root, { recursive: true, force: true }));

const DIGEST = `@sha256:${"a".repeat(64)}`;
await Bun.write(
  path.join(root, "stacks/x/compose.yml"),
  [
    "    image: ${POSTGRES_IMAGE:-ghcr.io/fluxo-kt/aza-pg:18}",
    `      \${POOLER_IMAGE:-ghcr.io/cloudnative-pg/pgbouncer:1.26.1-202611121015-trixie${DIGEST}}`,
    "    image: registry.gitlab.com/group/tool:2.0",
    "    image: floating/latest",
  ].join("\n")
);
await Bun.write(path.join(root, "scripts/a.ts"), `const T = "nixos/nix:2.35.6${DIGEST}";`);
// Not under stacks/, deployments/, scripts/ or .github/: never an image the repo pins.
await Bun.write(path.join(root, "docs/notes.md"), "    image: unrelated/thing:1.0");

const images = await pinnedImages(["stacks/x/compose.yml", "scripts/a.ts", "docs/notes.md"], root);
const byRepo = new Map(images.map((i) => [i.repo, i]));

test("splits the registry by Docker's rule, not a host list", () => {
  expect(byRepo.get("group/tool")?.host).toBe("registry.gitlab.com");
  expect(byRepo.get("cloudnative-pg/pgbouncer")?.host).toBe("ghcr.io");
  expect(byRepo.get("nixos/nix")?.host).toBe("docker.io");
});

test("keeps the pinned reference whole, digest included, for the scanner", () => {
  expect(byRepo.get("cloudnative-pg/pgbouncer")?.ref).toBe(
    `ghcr.io/cloudnative-pg/pgbouncer:1.26.1-202611121015-trixie${DIGEST}`
  );
});

test("reports a tagless pin with tag '' instead of dropping it", () => {
  expect(byRepo.get("floating/latest")?.tag).toBe("");
});

test("skips our own image and files outside the pinning directories", () => {
  expect([...byRepo.keys()].sort()).toEqual([
    "cloudnative-pg/pgbouncer",
    "floating/latest",
    "group/tool",
    "nixos/nix",
  ]);
});
