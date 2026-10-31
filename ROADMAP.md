# Roadmap

Known defects and missing work, most severe first. Each entry says why it matters and what fixing it takes. **Needs a decision** marks an entry that waits on a maintainer choice, not on effort. Remove an entry in the commit that fixes it.

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

### The `pg_upgrade` path needs an image holding both majors

Option A in `docs/UPGRADING.md` needs the old and new PostgreSQL binaries, and every extension built for both, in one image; none is built. Needed before the next major upgrade.

## Low

### Unmeasured speed: `-O3` per component, Rust CPU baseline, slow suites

Speed waits for correctness. Candidates for `-O3` (rule in AGENTS.md) need a pgbench or own-workload measurement. Rust profiles need nothing: pg_jsonschema, timescaledb_toolkit and vectorscale release with fat LTO and `codegen-units=1`, wrappers (network-bound) with 16 units. Rust code still targets the generic CPU; adding the baseline must keep each crate's own `.cargo/config` rustflags (vectorscale's `+avx2,+fma`), which an env `RUSTFLAGS` replaces, and needs a speed measurement to justify the rebuild. Several Docker suites run past 30 s (backup-restore, pgbouncer-healthcheck and pgflow-upgrade longest), mostly container and stack start-up.

### A replica on an unsupported CPU dies without the named error

`stacks/replica/scripts/replica-entrypoint.sh` runs `pg_basebackup` before the image entrypoint's CPU check, so on a CPU below the baseline a fresh replica stops with "illegal instruction" instead of naming the missing feature. Fix by running the image's check first, without copying it (one implementation).

### arm64 BTI is off; restore it before running on Armv8.5+ hosts

BTI does nothing on current hosts (Hetzner CAX: Ampere Altra, Armv8.2, which treats `bti` as a no-op), so it waits until a host enforces it (AWS Graviton 3+, Azure Cobalt, Google Axion). The linker marks a binary only if every object in it is marked, and only the C startup files block that. gcc's `crtbegin*.o`/`crtend*.o` have no landing pads at all: forcing the mark (`-z force-bti`) would crash the server at start, since `.init_array` calls them indirectly, so they must be recompiled (compiler-rt's `crtbegin.c`/`crtend.c` with `-mbranch-protection=standard` compile in seconds). glibc's `crt1.o`/`Scrt1.o` already have their landing pads and only lack the mark: `ld -r -z force-bti` adds it. Link the server and C extensions with `-mbranch-protection=standard -B<those files>` and never use `-z force-bti` on final links, which would hide an unmarked static library. Rust extensions stay unmarked (precompiled std), as do nixpkgs' shared libraries; the kernel enforces BTI per object, so they keep working. Prove it where BTI is enforced: an arm64 CI runner whose `/proc/cpuinfo` lists `bti` (checked first), or locally under user-mode `qemu-aarch64 -cpu max`, which enforces landing pads in marked binaries (Docker Desktop's VM hides the host's BTI even on Apple M4).
