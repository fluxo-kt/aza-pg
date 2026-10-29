# Version Management Guide

**How to update PostgreSQL, extensions and tools in the aza-pg codebase.**

This guide is for **updating version declarations** in the source code. For runtime upgrade procedures (production deployments), see [UPGRADING.md](UPGRADING.md). The `/update` command (`.claude/commands/update.md`) walks a full update round.

---

## Where Versions Live

| What                                       | File                                  | Field                                         |
| ------------------------------------------ | ------------------------------------- | --------------------------------------------- |
| nixpkgs (PostgreSQL, glibc, every library) | `flake.lock`                          | `nodes.nixpkgs.locked.rev`                    |
| PostgreSQL version label                   | `manifest-data.ts`                    | `MANIFEST_METADATA.pgVersion`                 |
| Extension and tool sources                 | `manifest-data.ts`                    | Entry's `source.tag` or `source.ref`          |
| cargo-pgrx releases nixpkgs lacks          | `flake.nix` + `flake.lock`            | `pgrx-<version>` inputs                       |
| Bun                                        | `.tool-versions` + `manifest-data.ts` | `bun X.Y.Z` + `MANIFEST_METADATA.bunImageSha` |

`scripts/extensions/manifest-data.ts` is the single source for extension versions. `bun run generate` writes `docker/postgres/extensions.manifest.json` from it, resolving each tag to a commit once (the generated file is the lock), and `nix/extensions.nix` builds every entry from that commit. Any copy of manifest data drifts unnoticed, so generators, validators and the Nix build read the manifest, never a side table.

**After ANY manifest change:** run `bun run generate`, then commit the edited and regenerated files with the `CHANGELOG.md` `[Unreleased]` entry.

**Source types:**

- `type: "git"` with `tag: "v1.2.3"` - stable releases (preferred)
- `type: "git-ref"` with `ref: "abc123..."` - a commit, for unreleased fixes
- `type: "builtin"` - PostgreSQL built-in modules (no source)

---

## Procedure 1: Update nixpkgs and PostgreSQL

nixpkgs supplies the server, glibc and every library, so a PostgreSQL minor release, and security fixes to any library, arrive by bumping `flake.lock`.

```bash
# Moves flake.lock to nixpkgs-unstable's newest revision
bun scripts/nix/nix.ts flake update nixpkgs

# flake.nix refuses to build when pgVersion differs from nixpkgs' server version and names the one it found:
# set MANIFEST_METADATA.pgVersion to it, then
bun run generate
bun run build
bun run test
```

When the bump changes glibc, run `bun scripts/nix/compare-en-us-order.ts <old image> <new image>` before release: "same" adds the new version to the `same` list in the entrypoint's glibc migration; otherwise the first start on the new image rebuilds libc-collated indexes, which the `CHANGELOG.md` entry must say ([UPGRADING.md](UPGRADING.md)).

---

## Procedure 2: Update an Extension (Git Tag)

**Example:** Update pgmq from v1.13.0 to v1.14.0

1. Find the tag: the upstream releases page, or `git ls-remote --tags https://github.com/tembo-io/pgmq.git`. Keep the repository's own prefix (`v`, `ver_`, `REL`).
2. Set `source.tag` on the entry in `scripts/extensions/manifest-data.ts`.
3. `bun run generate` resolves the tag to a commit; check it with `jq '.entries[] | select(.name=="pgmq") | .source' docker/postgres/extensions.manifest.json`.
4. Refresh patches if the entry has any: `build.patches` lists unified-diff files in `docker/postgres/patches/`, applied to the fetched source; one that no longer applies fails the build, so regenerate it against the new tag.
5. `bun run build`, then `bun run test`.

An entry with `nix.package` reuses that nixpkgs recipe with our source swapped in; when upstream changed its build system or dependencies, the recipe may need overriding in `nix/extensions.nix`.

---

## Procedure 3: Update a cargo-pgrx Extension

Entries with `build.type: "cargo-pgrx"` (wrappers, pg_jsonschema, vectorscale) build with the cargo-pgrx release that equals the pgrx crate their `Cargo.lock` pins. `nix/extensions.nix` takes it from nixpkgs when nixpkgs packages that release; otherwise evaluation stops and prints the `pgrx-<version>` input to add to `flake.nix` (reason at the inputs there). Then `bun scripts/nix/nix.ts flake lock` pins it. Drop an input once nixpkgs packages its release.

The new tag's pgrx must support the PostgreSQL major. Follow Procedure 2 for the tag bump.

---

## Procedure 4: Update vectorscale (patched cargo-pgrx)

vectorscale is patched because upstream's release build turns AVX2/FMA on for every function and kills the server (SIGILL) on x86-64 CPUs without them. `docker/postgres/patches/vectorscale-runtime-dispatch.patch` makes it pick AVX2+FMA kernels at runtime instead.

1. Follow Procedure 3 for the tag bump, and set `soFileName` to `vectorscale-<new version>.so`.
2. Check upstream's default features in `pgvectorscale/Cargo.toml` at the new tag; the manifest pins them (`noDefaultFeatures` + `features`) so an upstream default change cannot silently alter the build.
3. If the build stops because `vectorscale-runtime-dispatch.patch` no longer applies, regenerate it: clone the new tag, `git apply --3way` the old patch, resolve, and write `git diff` back to the patch file.
4. Regenerate `docker/postgres/patches/vectorscale-cargo-lock.patch` on every bump: upstream ships no `Cargo.lock`, and the build needs one, because unlocked crates resolve differently from day to day. In a Rust container: clone at the new commit, apply the runtime-dispatch patch, `cargo generate-lockfile` at the workspace root, `git add -f -N Cargo.lock`, and write `git diff -- Cargo.lock` to the patch file.
5. Prove the dispatch on an amd64 CPU without AVX2 (e.g. QEMU `-cpu Nehalem`): `CREATE EXTENSION vectorscale` and a DiskANN index query must succeed there.

---

## Procedure 5: Find Every Pending Update

```bash
# Compares every git tag, git-ref and pinned companion or tool image with upstream
# (exit 1 = an enabled entry has an update, 2 = the check itself failed)
bun scripts/extensions/check-updates.ts --format=table
```

It does not cover `flake.lock` (Procedure 1), Bun packages, the Bun runtime or Actions pins; `/update` covers all of them. Read each release's notes for PostgreSQL compatibility and breaking changes before bumping.

---

## Validation & Testing

| Command                | Runs                                                                        | Use for                                               |
| ---------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------- |
| `bun run validate`     | Manifest and generated-files checks, oxlint, prettier, tsc, SQL, unit tests | Every change (the pre-commit hook runs it)            |
| `bun run validate:all` | The above plus ShellCheck, yamllint, workflow expressions, links, secrets   | Any change touching a `.sh` or YAML file (CI runs it) |
| `bun run build`        | The Nix image, tagged `aza-pg:pg<major>`                                    | Proving a version change still compiles               |
| `bun run test`         | Every suite group of `scripts/test-all.ts` against the built image          | Proving extensions load and work                      |

CI (`.github/workflows/ci.yml`) runs `validate:all`, the image build and every routine suite group on each PR and on pushes to `main`, `dev` and `release`. `publish.yml` runs after CI succeeds on `release`: a native build per architecture, the suites against the testing image, Trivy, Cosign signing, SBOM and provenance attestation, then promotion to `ghcr.io/fluxo-kt/aza-pg` and the git tag `v<pg>-<timestamp>` ([BUILD.md](BUILD.md)).

---

## Common Issues

**`No commits found for <repo> tag <tag>`** from `bun run generate`: the tag does not exist upstream (generate resolves tags with `git ls-remote`). Check the releases page for the exact name, including its prefix.

**`git ls-remote failed for <repo> tag <tag> after <n> attempts`**: a network failure or a missing tag; check with `git ls-remote https://github.com/owner/repo.git refs/tags/<tag>`.

**cargo-pgrx compilation failure**: the pgrx version the extension pins does not support the PostgreSQL major. Move to an extension tag whose pgrx does; a local source fix goes in a unified-diff file under `docker/postgres/patches/`, listed in the entry's `build.patches`.

**`nixpkgs ships PostgreSQL X, manifest-data.ts says Y`**: `flake.lock` moved the server's minor; set `MANIFEST_METADATA.pgVersion` to X (Procedure 1).

---

## Before a Major PostgreSQL Upgrade

- [ ] Every extension's tag supports the new major (and its pgrx, for cargo-pgrx entries)
- [ ] nixpkgs packages `postgresql_<new major>` at the locked revision
- [ ] Test the full upgrade path in staging ([UPGRADING.md](UPGRADING.md))
- [ ] Plan the rollback

---

## Resources

- [PostgreSQL Release Notes](https://www.postgresql.org/docs/current/release.html)
- [nixpkgs PostgreSQL packages](https://github.com/NixOS/nixpkgs/tree/master/pkgs/servers/sql/postgresql)
- [cargo-pgrx](https://github.com/pgcentralfoundation/pgrx)
- [UPGRADING.md](UPGRADING.md), [BUILD.md](BUILD.md), [ARCHITECTURE.md](ARCHITECTURE.md), [AGENTS.md](../AGENTS.md)
