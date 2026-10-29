{
  description = "aza-pg: PostgreSQL with the manifest's extensions, built with Nix";

  # nixos-unstable: security fixes land there first; flake.lock pins the exact revision and every /update round bumps it.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "aarch64-linux" "x86_64-linux" ];
      manifest = builtins.fromJSON (builtins.readFile ./docker/postgres/extensions.manifest.json);
      perSystem = system:
        let
          # TimescaleDB's TSL edition (compression, continuous aggregates) is licensed "unfree" in nixpkgs' terms.
          pkgs = import nixpkgs { inherit system; config.allowUnfreePredicate = p: nixpkgs.lib.getName p == "timescaledb"; };
          postgresql = pkgs."postgresql_${nixpkgs.lib.versions.major manifest.metadata.pgVersion}";
          extensions = import ./nix/extensions.nix { inherit pkgs postgresql manifest; inherit (pkgs) lib; };
        in
        {
          inherit extensions;
          postgresql = postgresql.withPackages (_: builtins.attrValues extensions);
        };
    in
    {
      packages = nixpkgs.lib.genAttrs systems (s: let r = perSystem s; in { inherit (r) postgresql; } // r.extensions);
    };
}
