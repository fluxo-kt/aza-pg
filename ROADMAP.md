# Roadmap

Known defects and missing work, most severe first. Each entry says why it matters and what fixing it takes. **Needs a decision** marks an entry that waits on a maintainer choice, not on effort. Remove an entry in the commit that fixes it.

## High

### Build the final image with Nix, not Debian

The image must hold only what PostgreSQL and our extensions need at runtime, at their latest patched versions, with no avoidable language runtime: the goals in Karakuri's `docs/architecture.md` ("Choose responsibilities independently"), which apply to container images. Debian cannot reach that: Perl stays for `debconf`/`adduser` and `postgresql-common`, and the package manager and base userland stay with it, so most code-scanning alerts are unfixed Debian CVEs in packages PostgreSQL never uses. Art chose Nix (2026-10-29); musl (Alpine) is out: its collations differ from glibc's. We own every component's update: no waiting on a distribution's fix or release cycle. A kept component lagging its upstream's patched release gets our own override from that upstream; a C library or tool gives way to a Rust (or Go) equivalent when that one is well maintained and widely used.

Evidence (nixpkgs `31ecbac`, read 2026-10-29): `postgresql_18.withPackages` with the 19 of our components nixpkgs packages has a 69-path, 439 MiB runtime closure with no Perl or Python (Bash only); PGroonga's kytea and mecab dictionaries are 175 MiB of it. Karakuri measured nixpkgs security fixes a median of 1 day after Debian's (`docs/foundation-selection.md`).

Work:

- Package what nixpkgs lacks: index_advisor, supautils, wrappers, supabase_vault, pg_jsonschema, pg_hashids, pgflow, pg_stat_monitor, pg_plan_filter, set_user; TimescaleDB's TSL edition (nixpkgs' free attribute is the Apache edition); override versions nixpkgs trails. `manifest-data.ts` stays the one source of versions.
- Review the whole closure as Karakuri's `server:review` does, before the first Nix release and in every update round: each store path, binary, library, interpreter and data file names the shipped feature that needs it or goes; each kept one is on its newest stable version (newer nixpkgs or our own override where nixpkgs lags); prefer a well-maintained memory-safe equivalent where one exists. The kernel comes from the host, so this covers userland only.
- Drop from the image what has no runtime job: pgbadger (Perl; operators run it on exported logs), PGroonga tokenizer data unless a shipped feature needs it, su-exec (run as uid 999).
- Keep the Debian image publishing until the Nix image passes every suite; then switch `publish.yml` and delete the Debian path.
- Breaking for existing databases: glibc 2.41 → 2.44 changes libc collations, so text indexes need `REINDEX` after the upgrade; the CHANGELOG entry states it. Weigh ICU as the default collation provider for new clusters so later glibc moves cannot do this again.
- Replace Trivy's Debian noise with per-finding judgement (vulnix, as Karakuri does): fixed upstream ⇒ upgrade; not affected ⇒ whitelist with evidence; no fix ⇒ accept with an expiry date.

## Medium

### The `pg_upgrade` path needs an image holding both majors

Option A in `docs/UPGRADING.md` needs the old and new PostgreSQL binaries, and every extension built for both, in one image; none is built. Needed before the next major upgrade.

## Low

### Docker suites carry their own psql wrapper

Several Docker suites declare their own psql helper although `scripts/docker/test-image-lib.ts` exports `psql` and `sqlOk`, so a fix to one (quoting, session handling, error reporting) misses the others.

### pg_partman sits in `public` beside an empty `partman` schema

`docker/postgres/docker-entrypoint-initdb.d/04-pg_partman-init.sh` creates the extension in `public` and also creates an empty `partman` schema; upstream installs into `partman`. **Needs a decision:** moving it breaks operators who call `public.create_parent`, and dropping the empty schema is visible to them too.
