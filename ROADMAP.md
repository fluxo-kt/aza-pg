# Roadmap

Known defects and missing work, most severe first. Each entry says why it matters and what fixing it takes. **Needs a decision** marks an entry that waits on a maintainer choice, not on effort. Remove an entry in the commit that fixes it.

## Medium

### The build runs unpinned vendor installers as root

The generated Dockerfile downloads `percona-release_latest.generic_all.deb` and pipes Timescale's `script.deb.sh` into bash, so whatever those URLs serve on build day runs as root in the build, unchecked. Fix: commit both repositories' signing keys, verify them by fingerprint, and write the apt sources (`signed-by=`) from the manifest; that also removes the install-then-purge of curl, gnupg and percona-release.

### pgvectorscale builds without a lockfile

Upstream ships no `Cargo.lock`, so its crates resolve on build day while the other Rust extensions build `--locked`: the same pinned commit can compile different code. Fix: generate a lock at the pinned commit with the repository's patch applied, ship it through `docker/postgres/patches/`, and regenerate it on every pgvectorscale bump.

### pgflow-upgrade runs as superuser inside other owners' schemas

Without a database argument it migrates every database's `pgflow` schema as superuser, including schemas a non-superuser created, so functions and triggers that owner controls run with superuser rights during the migration (stated in the header of `docker/postgres/pgflow/pgflow-upgrade.sh`). **Needs a decision:** refuse such databases (changes the command's behaviour) or migrate as the schema owner.

### A logical restore hides real errors among expected ones

Restoring a `pg_dump` into a fresh aza-pg server reports many "already exists" errors, because the init scripts create the pgflow, pg_partman, vault and status objects the dump creates again; a real failure hides among them and `ON_ERROR_STOP` cannot be used. TimescaleDB hypertables also need `timescaledb_pre_restore()` / `timescaledb_post_restore()` around the restore, and `scripts/tools/backup-postgres.ts` dumps with `--no-acl`, so GRANTs are lost (keeping them fails on a server that lacks the roles). **Needs two decisions:** skip image-owned objects in the dump (their data, such as pgflow runs, is then not backed up) or restore into a database without init objects; keep or drop GRANTs.

### The `pg_upgrade` path needs an image holding both majors

Option A in `docs/UPGRADING.md` needs the old and new PostgreSQL binaries, and every extension built for both, in one image; none is built. Needed before the next major upgrade.

## Low

### CI runners move to Ubuntu 26 on 2026-10-19

CI, build and publish run on `ubuntu-latest`, which switches to Ubuntu 26 on that date (actions/runner-images#14748). Run the workflows once on `ubuntu-26.04` before then; Docker, buildx and QEMU versions change with the image.

### Manual image builds fail on branch names containing `/`

`.github/workflows/build-postgres-image.yml` tags images `dev-${{ github.ref_name }}`; a `/` in the branch name makes an invalid image reference and the run fails at the merge step. Fix: compute one sanitised tag in an early step and use it everywhere.

### Scripts redeclare the manifest shape

Several scripts declare their own `ManifestEntry` instead of importing the one in `scripts/extensions/manifest-data.ts`, so a renamed manifest field still compiles there and reads `undefined`. Several Docker suites likewise carry their own psql wrapper although `scripts/docker/test-image-lib.ts` exports `psql` and `sqlOk`.

### Unwired scripts

`scripts/ci/generate-oci-annotations.ts`, `scripts/docker/tag-local-image.ts`, `scripts/ci/load-image-artifact.ts`, `scripts/extensions/fetch-latest.ts`, `scripts/release/get-image-metrics.ts`, `scripts/lint-sql-squawk.ts` (described in `docs/TOOLING.md`, run by nothing) and `scripts/lib/common.ts` are called by no workflow, package script or other script. Wire each into the job it was written for, or delete it.

### pg_partman sits in `public` beside an empty `partman` schema

`docker/postgres/docker-entrypoint-initdb.d/04-pg_partman-init.sh` creates the extension in `public` and also creates an empty `partman` schema; upstream installs into `partman`. **Needs a decision:** moving it breaks operators who call `public.create_parent`, and dropping the empty schema is visible to them too.
