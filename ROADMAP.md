# Roadmap

Known defects and missing work, most severe first. Each entry says why it matters and what fixing it takes. **Needs a decision** marks an entry that waits on a maintainer choice, not on effort. Remove an entry in the commit that fixes it.

## Medium

### The `pg_upgrade` path needs an image holding both majors

Option A in `docs/UPGRADING.md` needs the old and new PostgreSQL binaries, and every extension built for both, in one image; none is built. Needed before the next major upgrade.

## Low

### Scripts redeclare the manifest shape

Several scripts declare their own `ManifestEntry` instead of importing the one in `scripts/extensions/manifest-data.ts`, so a renamed manifest field still compiles there and reads `undefined`. Several Docker suites likewise carry their own psql wrapper although `scripts/docker/test-image-lib.ts` exports `psql` and `sqlOk`.

### Unwired scripts

`scripts/ci/generate-oci-annotations.ts`, `scripts/docker/tag-local-image.ts`, `scripts/ci/load-image-artifact.ts`, `scripts/extensions/fetch-latest.ts`, `scripts/release/get-image-metrics.ts`, `scripts/lint-sql-squawk.ts` (described in `docs/TOOLING.md`, run by nothing) and `scripts/lib/common.ts` are called by no workflow, package script or other script. Wire each into the job it was written for, or delete it.

### pg_partman sits in `public` beside an empty `partman` schema

`docker/postgres/docker-entrypoint-initdb.d/04-pg_partman-init.sh` creates the extension in `public` and also creates an empty `partman` schema; upstream installs into `partman`. **Needs a decision:** moving it breaks operators who call `public.create_parent`, and dropping the empty schema is visible to them too.
