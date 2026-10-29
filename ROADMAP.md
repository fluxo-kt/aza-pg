# Roadmap

Known defects and missing work, most severe first. Each entry says why it matters and what fixing it takes. **Needs a decision** marks an entry that waits on a maintainer choice, not on effort. Remove an entry in the commit that fixes it.

## High

### Build the final image with Nix, not Debian

Goal: the image holds only what PostgreSQL and our extensions need at runtime, each at its latest patched version, with no language runtime we can avoid. These are the goals in Karakuri's `docs/architecture.md` ("Choose responsibilities independently"); they cover container images too.

Why not Debian: it cannot get there. Perl stays because `debconf`, `adduser` and `postgresql-common` need it, and the package manager and base tools stay with them. Why not musl (Alpine): switching libc changes collations, and with them the sort order of existing text indexes.

We own every component's updates instead of waiting for a distribution. When a kept component lags its upstream's patched release, we override it from that upstream. When a well-maintained, widely used Rust (or Go) tool does the same job as a C one, we take the Rust one.

Evidence (nixpkgs `31ecbac`, read 2026-10-29): PostgreSQL 18 built with the 19 of our components that nixpkgs already packages has a runtime closure of 69 store paths and 439 MiB, with no Perl or Python; Bash is the only interpreter. PGroonga's tokenizer data (kytea, mecab dictionary) is 175 MiB of that. Karakuri measured nixpkgs security fixes a median of 1 day after Debian's (`docs/foundation-selection.md`).

Work:

- Package what nixpkgs lacks: index_advisor, supautils, wrappers, supabase_vault, pg_jsonschema, pg_hashids, pgflow, pg_stat_monitor, pg_plan_filter, set_user; TimescaleDB's TSL edition (nixpkgs' free attribute is the Apache edition); override versions nixpkgs trails. Versions keep coming from `manifest-data.ts`: generate the Nix expression from it, as the Dockerfile is generated today.
- Review the whole closure as Karakuri's `server:review` does, before the first Nix release and in every update round: each store path, binary, library, interpreter and data file names the shipped feature that needs it or goes; each kept one is on its newest stable version. The kernel comes from the host, so this covers userland only.
- Drop PGroonga tokenizer data (kytea, mecab dictionary) unless a shipped feature needs it.
- Keep the Debian image publishing until the Nix image passes every suite; then switch `publish.yml` and delete the Debian path.
- Breaking for existing databases: glibc 2.41 → 2.44 changes libc collations, so text indexes need `REINDEX` after the upgrade; say so in the CHANGELOG under Breaking. Clusters created with the builtin collation (the default for new clusters) are unaffected.
- Ship only the glibc locales in `MANIFEST_METADATA.locales` (`glibcLocales.override`), not all 223 MB of them.
- Judge each CVE finding instead of uploading every scanner hit (vulnix, as Karakuri does): fixed upstream ⇒ upgrade; not affected ⇒ whitelist with evidence; no fix ⇒ accept with an expiry date.

## Medium

### The `pg_upgrade` path needs an image holding both majors

Option A in `docs/UPGRADING.md` needs the old and new PostgreSQL binaries, and every extension built for both, in one image; none is built. Needed before the next major upgrade.

## Low

### Docker suites carry their own psql wrapper

Several Docker suites declare their own psql helper although `scripts/docker/test-image-lib.ts` exports `psql` and `sqlOk`, so a fix to one (quoting, session handling, error reporting) misses the others.

### pg_partman sits in `public` beside an empty `partman` schema

`docker/postgres/docker-entrypoint-initdb.d/04-pg_partman-init.sh` creates the extension in `public` and also creates an empty `partman` schema; upstream installs into `partman`. **Needs a decision:** moving it breaks operators who call `public.create_parent`, and dropping the empty schema is visible to them too.
