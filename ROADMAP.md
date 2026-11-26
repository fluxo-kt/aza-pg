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

### The PgBouncer suites failed once in a full run, cause unknown

`test-pgbouncer-healthcheck.ts` and `test-pgbouncer-failures.ts` both failed in one full `test-all` run (b953fd4, host load ~29 from another project's processes). They passed alone, as their `stacks` group in parallel, and in the next full run. Their error output was not kept. A flaky suite teaches readers to rerun instead of read. Fix: on the next failure, keep the run's whole output (`test-all` prints each failed suite's errors) and find the cause before rerunning.

### PostgreSQL 19 waits for its stable release and for TimescaleDB support

The upgrade from 18 is built and proven every round (`test-major-upgrade.ts`); the 19 round itself follows `/update` "PG MAJOR version bump". TimescaleDB 2.32.1's CMake stops with "TimescaleDB only supports PostgreSQL 15, 16, 17 and 18" unless built `EXPERIMENTAL`, although its `src/compat/compat.h` already accepts 19, and its release notes name 18.7 as the newest compatible server, beside the PostgreSQL announcement of 19 RC 2 (read 2026-11-26). The round starts once PostgreSQL 19 is a stable release (we ship only stable ones); if TimescaleDB still has no release that builds on it then, its main-branch support ships as `build.patches` per root `AGENTS.md` "Latest stable versions everywhere". nixpkgs packages `postgresql_19`, and pgrx 0.20 builds `pg19`.

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
