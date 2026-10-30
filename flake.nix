{
  description = "aza-pg: PostgreSQL with the manifest's extensions, built with Nix";

  inputs = {
    # nixos-unstable: security fixes land there first; flake.lock pins the exact revision and every /update round bumps it.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # cargo-pgrx releases nixpkgs does not package, named pgrx-<version with _>. cargo-pgrx must equal the pgrx crate an
    # extension locks (nix/extensions.nix picks nixpkgs' attribute first); a pure build fetches only pinned sources,
    # so each missing release is an input that flake.lock pins. Drop one once nixpkgs packages it.
    pgrx-0_18_1 = { url = "github:pgcentralfoundation/pgrx/v0.18.1"; flake = false; };
    pgrx-0_19_2 = { url = "github:pgcentralfoundation/pgrx/v0.19.2"; flake = false; };
    # The official image's docker-entrypoint.sh (initdb, POSTGRES_* variables, /docker-entrypoint-initdb.d), which
    # our entrypoint sources.
    docker-library-postgres = { url = "github:docker-library/postgres"; flake = false; };
    # publish.yml's SBOM generator, at a release tag and with its own lock: nixpkgs' sbomnix breaks whenever one of
    # its many Python dependencies moves (typepy 2.0 broke it), and upstream tests only its own lock. Build-only:
    # nothing it brings enters the image. /update bumps the tag to the latest release.
    sbomnix.url = "github:tiiuae/sbomnix/v1.9.0";
  };

  outputs = { nixpkgs, ... }@inputs:
    let
      systems = [ "aarch64-linux" "x86_64-linux" ];
      manifest = builtins.fromJSON (builtins.readFile ./docker/postgres/extensions.manifest.json);
      perSystem = system:
        let
          # TimescaleDB's TSL edition (compression, continuous aggregates) and its toolkit are "unfree" in nixpkgs' terms.
          pkgs = import nixpkgs {
            inherit system;
            config.allowUnfreePredicate = p: builtins.elem (nixpkgs.lib.getName p) [ "timescaledb" "timescaledb_toolkit" ];
            # Groonga builds its Japanese morphological tokenizers (TokenKytea, TokenMecab) whenever KyTea and MeCab are
            # present, and they bring 175 MB of models and dictionaries. Nothing using this image tokenizes Japanese
            # morphologically, and a dictionary other than the one an index was built with would silently split words
            # differently; without the plugins, an index naming TokenMecab fails loudly instead. To restore one, drop it
            # from the lists below (nixpkgs' MeCab bundles IPAdic; Debian's packages used naist-jdic, so indexes built
            # there need a REINDEX).
            overlays = [
              (final: prev: {
                groonga = prev.groonga.overrideAttrs (o: {
                  buildInputs = nixpkgs.lib.subtractLists [ prev.kytea prev.mecab ] o.buildInputs;
                  nativeBuildInputs = nixpkgs.lib.remove prev.mecab o.nativeBuildInputs;
                  # share/groonga/html is the admin UI of Groonga's own HTTP server, which PGroonga never runs; it
                  # bundles jquery-ui 1.12.1, whose CVEs the image scan would report.
                  postInstall = (o.postInstall or "") + "\nrm -r $out/share/groonga/html\n";
                });
              })
            ];
          };
          # nixpkgs' recipe builds for release (-O2, LTO, stripped binaries, debug info split off). Each feature
          # below is on there; off here because nothing in a container of this image can use it, and each links more
          # libraries into every server process. To restore one, set it to true (and record its consumer here):
          #   systemd  sd_notify needs NOTIFY_SOCKET, which Docker and Podman (conmon notifies) never give PostgreSQL
          #   pam      needs /etc/pam.d and PAM modules the image does not ship; deployments authenticate with SCRAM
          #   curl     PG18 OAuth needs a validator library the image does not ship (pg_net and http link curl themselves)
          #   gss      Kerberos: no deployment uses it, and it needs a mounted keytab
          #   uring    auto-config runs io_method=worker; with io_method=io_uring the server refuses to start under
          #            Docker's default seccomp profile ("could not setup io_uring queue: Operation not permitted")
          #   numa     PG18 uses libnuma only for views reporting which NUMA node holds shared memory (no placement
          #            policy). NUMA is per machine (memory banks per CPU socket): a VPS, primary or replica alike,
          #            has one node and nothing to report
          #   perl, python, tcl  build PL languages the image does not ship (their outputs never reach it)
          # JIT is on: measured 3.9x on a 5M-row GROUP BY with five aggregates and 1.8x on a filtered count, single
          # worker; TimescaleDB-style aggregation is this image's workload.
          # Newest stable LLVM, not the release nixpkgs pins PostgreSQL to: we own its updates.
          llvmPackages = pkgs.llvmPackages_latest;
          # Added to nixpkgs' default hardening (fortify3, stack protector and clash protection, RELRO/BIND_NOW, PIE)
          # for the server and every extension's C code, which parse untrusted SQL and wire input. pacret signs return
          # addresses on arm64 CPUs with pointer authentication (Graviton 3+), as Debian's builds did; elsewhere its
          # instructions are no-ops. Left out: arm64 BTI, because the linker marks a binary only when every object in
          # it is marked, and nixpkgs' gcc (crtbegin.o) and glibc (crt1.o) start files are not; getting it means rebuilding
          # the toolchain, so all of nixpkgs. Also left out: amd64 shadowstack, which glibc enforces only on request. The
          # server and extensions are rebuilt from source anyway, so pacret costs no rebuild of its own.
          hardeningEnable = [ "pacret" ];
          # The -O level stays each upstream's own release level (AGENTS.md); targetCpu adds only the CPU baseline to
          # every C compile of the server and extensions. A recipe sets NIX_CFLAGS_COMPILE either top-level or under env,
          # and nixpkgs refuses a derivation setting both, so it appends to the recipe's form. The CPU baseline must rise
          # as far as the VPSes we run on (Hetzner first) and other common clouds all support. amd64 x86-64-v3 (AVX2, BMI2, FMA, MOVBE): every Hetzner x86 line (Skylake Xeon, EPYC
          # Rome, Milan, Genoa) has it; v4 (AVX-512) does not, Rome and Milan lack it. arm64 Armv8.2-A with dot
          # product, AES and SHA2: Hetzner CAX's Neoverse N1 (Ampere Altra), as on Graviton2 and every newer arm64
          # cloud CPU. Dropped: pre-2013 x86 and Armv8.0 cores (Graviton1, Raspberry Pi 4). The entrypoint checks the
          # host CPU first, so a missing feature is named instead of crashing with an illegal instruction: changing the
          # baseline means changing that check's feature list too (docker-auto-config-entrypoint.sh.template).
          baseline = if pkgs.stdenv.hostPlatform.isx86_64 then "-march=x86-64-v3" else "-march=armv8.2-a+dotprod+aes+sha2";
          targetCpu = o: if (o.env or { }) ? NIX_CFLAGS_COMPILE
            then { env = o.env // { NIX_CFLAGS_COMPILE = "${o.env.NIX_CFLAGS_COMPILE} ${baseline}"; }; }
            else { NIX_CFLAGS_COMPILE = "${toString (o.NIX_CFLAGS_COMPILE or "")} ${baseline}"; };
          postgresql = (pkgs."postgresql_${nixpkgs.lib.versions.major manifest.metadata.pgVersion}".override {
            inherit llvmPackages;
            jitSupport = true;
            systemdSupport = false;
            pamSupport = false;
            curlSupport = false;
            gssSupport = false;
            uringSupport = false;
            numaSupport = false;
            perlSupport = false;
            pythonSupport = false;
            tclSupport = false;
          }).overrideAttrs (o: { hardeningEnable = (o.hardeningEnable or [ ]) ++ hardeningEnable; } // targetCpu o);
          # The manifest's pgVersion names the release (tags, labels, PG_VERSION); the server is nixpkgs'. A nixpkgs bump
          # that moves the minor must update the manifest in the same change, or the image would claim a version it lacks.
          extensions = assert postgresql.version == manifest.metadata.pgVersion
            || throw "nixpkgs ships PostgreSQL ${postgresql.version}, manifest-data.ts says ${manifest.metadata.pgVersion}: set pgVersion to nixpkgs' version";
            import ./nix/extensions.nix { inherit pkgs postgresql manifest inputs hardeningEnable targetCpu; inherit (pkgs) lib; };
          # jit is a separate output (llvmjit.so plus bitcode) that withPackages leaves out; without it jit=on does nothing.
          # llvmjit.so's RPATH names llvm's whole lib output, ~360 MB of it static archives no process loads; this copy
          # points llvmjit.so (and libLLVM's own RPATH) at a store path holding libLLVM.so alone.
          jit = pkgs.runCommand "postgresql-jit-${postgresql.version}" { nativeBuildInputs = [ pkgs.patchelf ]; } ''
            cp -r --no-preserve=mode ${postgresql.jit} $out
            mkdir -p $out/llvm
            cp -L ${llvmPackages.llvm.lib}/lib/libLLVM.so.* $out/llvm/
            for f in $out/lib/llvmjit.so $out/llvm/libLLVM.so.*; do
              patchelf --set-rpath "$(patchelf --print-rpath "$f" | sed "s|${llvmPackages.llvm.lib}/lib|$out/llvm|g")" "$f"
            done
            if grep -rlF ${builtins.baseNameOf llvmPackages.llvm.lib} $out; then echo "llvm lib output still referenced"; exit 1; fi
          '';
          # withPackages also links postgresql.man for desktop installs; a container has no man reader. The env is
          # symlinks, so dropping the link drops the store reference (buildEnv keeps `paths` out of overrideAttrs' reach).
          server = (postgresql.withPackages (_: [ jit ] ++ builtins.attrValues extensions)).overrideAttrs (o: {
            postBuild = (o.postBuild or "") + "\nrm $out/share/man\n";
          });
        in
        rec {
          inherit extensions;
          postgresql = server;
          # A script that streams the image tarball: scripts/nix/build-image.ts pipes it into `docker load`.
          image = import ./nix/image.nix {
            inherit pkgs manifest;
            source = inputs.self;
            inherit (pkgs) lib;
            postgresql = server;
            upstreamEntrypoint = "${inputs.docker-library-postgres}/${nixpkgs.lib.versions.major manifest.metadata.pgVersion}/trixie/docker-entrypoint.sh";
          };
          # What the image ships, as one store path whose closure vulnix-gate.ts and publish.yml's SBOM read: the image
          # config references every layer's store paths, the ones only Env names (the locales) included. `image`
          # itself is the stream script, whose closure adds the Python streamer that never ships.
          contents = image.conf;
          # The scanner: vulnix 1.12.5 fails its NVD update when NVD serves only the .json.zip feed; upstream PR 183
          # falls back to it and keeps an older feed from replacing newer cached data. Drop the patch once nixpkgs'
          # vulnix includes commit 4b14b4b.
          vulnix = pkgs.vulnix.overrideAttrs (old: {
            patches = (old.patches or [ ]) ++ [
              (pkgs.fetchurl {
                url = "https://github.com/nix-community/vulnix/commit/4b14b4bf3e627946a162ca8ae4a6b406c77a7aa2.patch";
                hash = "sha256-pN1zFCvTMgHACC0DKkWu98qMu/GpB8ilKUvp5tjyG7Q=";
              })
            ];
          });
        };
    in
    {
      packages = nixpkgs.lib.genAttrs systems (s: let r = perSystem s; in { inherit (r) postgresql image contents vulnix; } // r.extensions);
    };
}
