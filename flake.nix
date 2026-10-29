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
    # our entrypoint sources; the Debian image gets it from its postgres base image.
    docker-library-postgres = { url = "github:docker-library/postgres"; flake = false; };
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
                });
              })
            ];
          };
          # nixpkgs' recipe already builds for release (-O2, LTO, stripped binaries, debug info split off). Each feature
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
          postgresql = pkgs."postgresql_${nixpkgs.lib.versions.major manifest.metadata.pgVersion}".override {
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
          };
          extensions = import ./nix/extensions.nix { inherit pkgs postgresql manifest inputs; inherit (pkgs) lib; };
          server = postgresql.withPackages (_: builtins.attrValues extensions);
        in
        {
          inherit extensions;
          postgresql = server;
          # A script that streams the image tarball: scripts/nix/build-image.ts pipes it into `docker load`.
          image = import ./nix/image.nix {
            inherit pkgs manifest;
            inherit (pkgs) lib;
            postgresql = server;
            upstreamEntrypoint = "${inputs.docker-library-postgres}/${nixpkgs.lib.versions.major manifest.metadata.pgVersion}/trixie/docker-entrypoint.sh";
          };
        };
    in
    {
      packages = nixpkgs.lib.genAttrs systems (s: let r = perSystem s; in { inherit (r) postgresql image; } // r.extensions);
    };
}
