# Roadmap

Known defects and missing work, most severe first. Each entry says why it matters and what fixing it takes. **Needs a decision** marks an entry that waits on a maintainer choice, not on effort. Remove an entry in the commit that fixes it.

## High

### Build the final image with Nix, not Debian

Goal: the image holds only what PostgreSQL and our extensions need at runtime, each at its latest patched version, with no language runtime we can avoid. These are the goals in Karakuri's `docs/architecture.md` ("Choose responsibilities independently"); they cover container images too.

Why not Debian: it cannot get there. Perl stays because `debconf`, `adduser` and `postgresql-common` need it, and the package manager and base tools stay with them. Why not musl (Alpine): switching libc changes collations, and with them the sort order of existing text indexes.

We own every component's updates instead of waiting for a distribution. When a kept component lags its upstream's patched release, we override it from that upstream. When a well-maintained, widely used Rust (or Go) tool does the same job as a C one, we take the Rust one.

Evidence (nixpkgs `31ecbac`, read 2026-10-29): the nixpkgs-built server closure has no Perl or Python; Bash is the only interpreter. Karakuri measured nixpkgs security fixes a median of 1 day after Debian's (`docs/foundation-selection.md`).

Work:

- Review the whole closure as Karakuri's `server:review` does, before the first Nix release and in every update round: each store path, binary, library, interpreter and data file names the shipped feature that needs it or goes; each kept one is on its newest stable version. The kernel comes from the host, so this covers userland only.
- Replace every script the image runs with one Rust binary of ours, as Karakuri does: subcommands for the entrypoint (auto-config, then the upstream `docker-entrypoint.sh` flow: initdb, `POSTGRES_*` variables, init files), the healthcheck, `pgsodium_getkey`, `pgflow-upgrade`, the `pg_repack` wrapper and the shipped init scripts. One static, optimised executable brings no runtime, and its logic gets unit tests that shell cannot have. bash, coreutils, grep, sed, gawk, findutils, diffutils, getent and su-exec then leave the image. Open before the rewrite: operators' own `*.sh` files in `/docker-entrypoint-initdb.d` need a shell; decide whether the image keeps one for them.
- Prove `ci.yml` and `publish.yml` on GitHub (native amd64/arm64 runners, `.github/actions/setup-nix` store cache, sbomnix SBOM attestation): only a CI run does, and the first one needs Art's push.

## Medium

### The `pg_upgrade` path needs an image holding both majors

Option A in `docs/UPGRADING.md` needs the old and new PostgreSQL binaries, and every extension built for both, in one image; none is built. Needed before the next major upgrade.

## Low

### Docker suites carry their own psql wrapper

Several Docker suites declare their own psql helper although `scripts/docker/test-image-lib.ts` exports `psql` and `sqlOk`, so a fix to one (quoting, session handling, error reporting) misses the others.

### pg_partman sits in `public` beside an empty `partman` schema

`docker/postgres/docker-entrypoint-initdb.d/04-pg_partman-init.sh` creates the extension in `public` and also creates an empty `partman` schema; upstream installs into `partman`. **Needs a decision:** moving it breaks operators who call `public.create_parent`, and dropping the empty schema is visible to them too.
