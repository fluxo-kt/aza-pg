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
          };
          postgresql = pkgs."postgresql_${nixpkgs.lib.versions.major manifest.metadata.pgVersion}";
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
