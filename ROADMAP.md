# Roadmap

Known defects and missing work, most severe first. Each entry says why it matters and what fixing it takes. **Needs a decision** marks an entry that waits on a maintainer choice, not on effort. Remove an entry in the commit that fixes it. Only work outside the current task belongs here: work a task needs or uncovers (an `/update` round's bumps, migrations, tests) is finished in that task, never parked here.

## High

### Build the final image with Nix, not Debian

Goal: the image holds only what PostgreSQL and our extensions need at runtime, each at its latest patched version, with no language runtime we can avoid. These are the goals in Karakuri's `docs/architecture.md` ("Choose responsibilities independently"); they cover container images too.

Why not Debian: it cannot get there. Perl stays because `debconf`, `adduser` and `postgresql-common` need it, and the package manager and base tools stay with them. Why not musl (Alpine): switching libc changes collations, and with them the sort order of existing text indexes.

We own every component's updates instead of waiting for a distribution. When a kept component lags its upstream's patched release, we override it from that upstream. When a well-maintained, widely used Rust (or Go) tool does the same job as a C one, we take the Rust one.

Evidence (nixpkgs `31ecbac`, read 2026-10-29): the nixpkgs-built server closure has no Perl or Python; Bash is the only interpreter. Karakuri measured nixpkgs security fixes a median of 1 day after Debian's (`docs/foundation-selection.md`).

Work:

- Trim ncurses' terminfo database (11.6 MB, every terminal type) to the types a container's interactive `psql` meets (xterm*, screen*, tmux*, linux, vt100, dumb): the only data file in the closure without a consumer. Overriding nixpkgs' `ncurses` rebuilds everything above it, so give readline a trimmed copy instead. Every other store path names its consumer (`nix/image.nix`, or the package referencing it); `/update` repeats that review each round.
- Swap a tool the image's scripts call (coreutils, grep, sed, gawk, findutils, diffutils) only for a widely used Rust tool that is a drop-in for how the scripts call it; the scripts stay. Rejected: rewriting the scripts as one Rust binary of ours. It is a large new codebase to own, and bash stays anyway for operators' `*.sh` files in `/docker-entrypoint-initdb.d`.

## Medium

### Major upgrades are not automatic yet

A data directory from an older PostgreSQL major must be upgraded at the first start on a new-major image, with no operator step (AGENTS.md "Data directories made by older images…"); `docs/UPGRADING.md` Option A still describes a manual path whose two-major image does not exist. Build this before the next major, then make Option A say "pull the new image".

Rejected: a two-major image ships a second server that serves nothing after the upgrade, and every extension must build for both majors, so the slowest one gates every release; dump/restore needs downtime proportional to data size (it stays the documented fallback).

**Mechanism: `pg_upgrade` with the old server borrowed from our previous published image.** A Nix image is self-contained under `/nix/store` and store paths are named by content hash, so the old image's paths never collide with the new ones, and the old extension libraries keep the exact ABI of the old cluster. The server runs as `postgres`, which cannot write the root-owned `/nix/store`, and the old binaries' loader and library paths are absolute `/nix/store` paths, so they cannot run from elsewhere. So the new image ships, built in, one symlink `/nix/store/<old path>` → `/var/lib/postgresql/.aza-old-store/<old path>` per path of the previous image's server closure (names known at build time from the pin); step 2 fills that directory, and nothing writes `/nix/store` at runtime. Measured: the 18.7 `postgres` and `initdb` run through such a symlink into the data volume.

1. **Pin.** `MANIFEST_METADATA` names the previous image: the last release of the old major, `tag@digest`. `bun run generate` resolves its per-arch layer digests (Bun does the registry and JSON work) into a small file baked into the image, so the entrypoint needs no JSON or platform logic. `/update` sets the pin in the round that bumps the major.
2. **Old store, one interface, a fallback ladder.** Everything after this step reads the old closure in `/var/lib/postgresql/.aza-old-store/` (same volume as the data, so it costs no extra mount and goes with the cluster). Sources, in order: the layers fetched by digest from the pin's registry (or the mirror `AZA_PG_PREVIOUS_IMAGE` names), each checked with `sha256sum` before extraction; then the previous image itself copying its closure into the same data volume (`docker run --rm -v <data volume>:/var/lib/postgresql <previous image>` with a copy command the stop message prints). The host has just pulled the new image from that registry, so the network rung almost always works. When every rung fails, the start stops before touching data and prints the volume command. The image carries whatever this step runs: an HTTP client (on the libcurl it already ships for pg_net and http) and tar are new; zstd (the layers' compression) and sha256sum ship already. The major-upgrade feature is their runtime consumer. Measured on 18.7: GHCR serves it anonymously (token endpoint, as `docker pull` does); arm64 is 81 zstd layers, 109 MB, so fetch every layer and extract only the pinned closure's paths rather than selecting layers.
3. **Upgrade.** With the old binaries: allow connections to `template1` (`postgres --single`; older aza-pg data refuses them and `pg_upgrade --check` stops on that), run `pg_upgrade --check`, then `--clone` where the filesystem supports it, else `--link`, into `/var/lib/postgresql/<new major>/docker` in the same volume. Then start the new server, run the existing first-start extension updates, `vacuumdb --all --analyze-in-stages`, and `pgbackrest stanza-upgrade` when a stanza exists (backups to the old stanza fail after a major change). Remove the old cluster directory and the borrowed store paths only after all of that succeeded.
4. **Data safety.** Any failure before the new server's first start restores the old cluster (pg_upgrade renamed its `pg_control` to `pg_control.old`) and stops, naming the cause, so the previous image still starts on the volume. Proving a backup first is the consumer's procedure (Karakuri's recovery skill), never a step the image fakes.
5. **Library parity.** `pg_upgrade --check` fails when a library the old cluster references is missing from the new image, and some libraries carry their version in the file name (`timescaledb-<version>.so`; the image ships only its own). So a major bump ships as two releases: a last old-major release whose extension versions equal the new major's, then the major. A check compares the two images' extension library names and fails the release that breaks parity.
6. **Standbys** are not upgraded: the entrypoint refuses older-major standby data and names the re-clone from the upgraded primary, which the replica stack already does on an empty volume.
7. **Proof.** A suite creates a database on the pinned previous release (every default extension, pgflow, a TimescaleDB hypertable with compressed chunks, a pgsodium/Vault secret, a pgBackRest stanza), starts the new image on it, and checks rows, extension versions, decryption and a backup; plus the stop when no rung yields the store, the restore after a failure injected after linking, and the parity check refusing a mismatched pair.

The PostgreSQL 19 round starts when every shipped extension has a tagged release that builds on 19. TimescaleDB 2.32.1 refuses PostgreSQL above 18 (its main branch supports 19); nixpkgs packages `postgresql_19`, and pgrx 0.20 builds `pg19`.

## Low

### Two replica containers cloning onto one empty volume at once

The entrypoint's data-directory lock is taken after `stacks/replica/scripts/replica-entrypoint.sh` has cloned with `pg_basebackup`, so two replica containers started together on one empty volume can both clone into it (one started later stops: `pg_basebackup` refuses a non-empty directory). Fix: take the same `flock` on the data directory in the replica script before cloning and keep it through the handover; prove with two replica containers started together on one volume.

### Report an unavailable image size check as skipped

With no `aza-pg:pg18` image present, `validate:all` prints that size regression was skipped but counts it as passed and reports zero skipped checks. Propagate the missing-image result through the existing validation summary so command success does not imply size coverage.

### Auto-config leaves memory unused below 2 GB

The memory fit charges a busy session about 11 MB at `work_mem` 1 MB; `test-memory-fit --all` measured about 8.4 MB, and peak anon + shmem stayed near 55% of a 1 GB limit (36 connections). 53 busy sessions at 1 GB were OOM-killed, so the safe count lies between. Calibrate `BUSY_SESSION_MB` and `MEMORY_HEADROOM_PERCENT` from repeated runs at 1 and 1.5 GB (variance, not one run), keeping zero OOM kills; dirty temp-file pages also need room.

### Explain memory fitting in generated release configuration

`scripts/generate-release-notes.ts` presents fixed workload connection counts and describes only RAM-tier reductions, although the released entrypoint also lowers them to fit its shared connection/query-memory budget. The v18.6-202610312251 notes therefore list `mixed` as 120 connections while their own change section gives 36 at 1 GB. Label these as workload targets, explain the additional memory fit, and expose `POSTGRES_ACTIVE_CONNECTIONS_PERCENT` and `-c`/`ALTER SYSTEM` precedence through the existing README auto-config reference; avoid copying its formulas into the generator.

### Match SBOM verification to the documented signer

`scripts/release/verify-sbom.ts` promises this repository's workflow but passes only `--owner`, accepting the organization's identity rather than the specific repository and workflow. Scope verification to the source repository and signer workflow, including attestations promoted from the testing image. GitHub CLI provides `--repo` and `--signer-workflow`; use those native checks rather than another verifier.

### Keep tool counts out of extension labels

The published OCI index description says "36 extensions", while `docs/.generated/docs-data.json` separates 32 extensions/modules from 4 tools. Derive extension descriptions from those existing kind counts so registry metadata agrees with the release notes; keep the total catalog count distinct.

### Unmeasured speed: `-O3` per component, Rust CPU baseline, slow suites

Speed waits for correctness. The server at `-O3` measured no faster (reason at `flake.nix`'s -O comment); extension `-O3` candidates still need a measurement. Rust profiles need nothing: pg_jsonschema, timescaledb_toolkit and vectorscale release with fat LTO and `codegen-units=1` (wrappers, unshipped until an FDW is chosen, with 16 units: network-bound). Rust code still targets the generic CPU; adding the baseline must keep each crate's own `.cargo/config` rustflags (vectorscale's `+avx2,+fma`), which an env `RUSTFLAGS` replaces, and needs a speed measurement to justify the rebuild. Several Docker suites run past 30 s (backup-restore, pgbouncer-healthcheck and pgflow-upgrade longest), mostly container and stack start-up.

### A replica on an unsupported CPU dies without the named error

`stacks/replica/scripts/replica-entrypoint.sh` runs `pg_basebackup` before the image entrypoint's CPU check, so on a CPU below the baseline a fresh replica stops with "illegal instruction" instead of naming the missing feature. Fix by running the image's check first, without copying it (one implementation).

### arm64 BTI is off; restore it before running on Armv8.5+ hosts

BTI does nothing on current hosts (Hetzner CAX: Ampere Altra, Armv8.2, which treats `bti` as a no-op), so it waits until a host enforces it (AWS Graviton 3+, Azure Cobalt, Google Axion). The linker marks a binary only if every object in it is marked, and only the C startup files block that. gcc's `crtbegin*.o`/`crtend*.o` have no landing pads at all: forcing the mark (`-z force-bti`) would crash the server at start, since `.init_array` calls them indirectly, so they must be recompiled (compiler-rt's `crtbegin.c`/`crtend.c` with `-mbranch-protection=standard` compile in seconds). glibc's `crt1.o`/`Scrt1.o` already have their landing pads and only lack the mark: `ld -r -z force-bti` adds it. Pass `-mbranch-protection=standard` in `NIX_CFLAGS_COMPILE` and `-B<those files>` in `NIX_CFLAGS_COMPILE_BEFORE` (cc-wrapper's own `-B` leads `NIX_CFLAGS_COMPILE`, and the first `-B` holding a file wins); never `-z force-bti` on final links, which would hide an unmarked static library. Done that way, contrib modules and most tools come out marked, but `postgres`, `psql`, `initdb`, the `pg_basebackup` family and most third-party C modules do not: some further input is unmarked. Find it by relinking one of them with `-z force-bti -z bti-report=warning`, which names every unmarked input. The server builds with nixpkgs' LLVM stdenv (clang, LLD, `-flto`), extensions with gcc and `ld.bfd`. Ship it with an image check reading each ELF file's `PT_GNU_PROPERTY` note, since losing the mark breaks no build. Rust extensions stay unmarked (precompiled std), as do nixpkgs' shared libraries; the kernel enforces BTI per object, so they keep working. Prove it where BTI is enforced: an arm64 CI runner whose `/proc/cpuinfo` lists `bti` (checked first), or locally under user-mode `qemu-aarch64 -cpu max` (a force-marked binary without landing pads dies there with SIGILL and runs natively; Docker Desktop's VM hides the host's BTI even on Apple M4). `initdb` execs `postgres` outside qemu, so run the server as `postgres --single` under it.

### Layer order makes hosts re-unpack unchanged layers

Docker reuses a downloaded layer by digest wherever it sits, but it unpacks each layer on top of the ones below it, so a changed layer makes every layer above it unpack again (download size is unaffected). `streamLayeredImage` orders layers by how many store paths reference them, which leaves often-changing extensions under the large stable ones (the JIT layer, ICU, Groonga). On a release that bumps one extension and not nixpkgs, putting extensions and `aza-pg-files` on top cuts the re-unpacked bytes from most of the image to the changed layers (measured on v18.6-202610311330: 423 MB to about 29 MB). A nixpkgs bump changes every layer whatever the order. Waits on nixpkgs: the only control is `layeringPipeline`, which its own code marks highly experimental and subject to change; adopt it once nixpkgs declares it stable.
