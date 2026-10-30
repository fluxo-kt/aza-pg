# Every enabled manifest entry, built from the exact commit in docker/postgres/extensions.manifest.json (generated from
# scripts/extensions/manifest-data.ts), so versions have one source and we, not nixpkgs, decide when they move.
#
# An entry with `nix.package` reuses that nixpkgs recipe (its configure flags, inputs and install fixes) with our
# source swapped in; nixpkgs' own patches are dropped because they target its version, ours (`build.patches`) apply.
# Without it the entry is built from `build.type`, linking `nix.inputs`. Sources come from builtins.fetchGit at the
# pinned commit, which needs no stored hash: the commit is the content address. Rust crates come from the source's
# own Cargo.lock for the same reason.
{ pkgs, lib, postgresql, manifest, inputs, hardeningEnable }:
let
  ps = postgresql.pkgs;
  # The PGXS builder exists only inside the extension scope, not as an attribute of it.
  postgresqlBuildExtension = ps.callPackage ({ postgresqlBuildExtension }: postgresqlBuildExtension) { };
  root = ../.;

  enabled = builtins.filter
    (e: (e.enabled or true) && e.kind != "builtin" && e.source.type != "builtin")
    manifest.entries;

  # Upstream tags wrap the version in their own prefix ("v0.20.5", "ver_1.5.3", "REL4_2_0", "wal2json_2_7",
  # "release/2.60.0", "pgflow@0.17.2"): the version is the trailing run of digits, dots and underscores. Recipes
  # use it in file names (vectorscale-<version>.so), so it must be the real one. An untagged commit has none.
  versionOf = e:
    if e.source.type == "git-ref" then "unstable-${builtins.substring 0 7 e.source.commit}"
    else
      let m = builtins.match "(.*[^0-9._])?[._]?([0-9][0-9._]*)" e.source.tag;
      in if m == null then throw "${e.name}: no version in tag ${e.source.tag}"
      else lib.replaceStrings [ "_" ] [ "." ] (builtins.elemAt m 1);

  sourceOf = e:
    let
      fetched = builtins.fetchGit {
        url = e.source.repository;
        rev = e.source.commit;
        # A pinned commit may sit off the default branch (a release branch, a moved tag).
        allRefs = true;
        submodules = true;
      } // {
        # Recipes locate their subdirectory as "${src.name}/…" (pgmq); fetchGit's store directory is named "source".
        name = "source";
      };
      patches = map (p: root + "/docker/postgres/patches/${p}") (e.build.patches or [ ]);
    in
    # Patched before evaluation reads Cargo.lock: vectorscale's patch adds that file.
    if patches == [ ] then fetched else pkgs.applyPatches { name = "${e.name}-source"; src = fetched; inherit patches; };

  attrsOf = names: map (n: lib.getAttrFromPath (lib.splitString "." n) pkgs) names;
  inputsOf = e: attrsOf (e.nix.inputs or [ ]);

  # cargo-pgrx must match the pgrx crate the source locks; nixpkgs carries one attribute per pgrx release.
  # A release nixpkgs lacks comes from the flake input pgrx-<version> (reason in flake.nix), built with nixpkgs'
  # cargo-pgrx recipe from the pgrx workspace and its Cargo.lock.
  pgrxFor = src:
    let
      lock = builtins.fromTOML (builtins.readFile (src + "/Cargo.lock"));
      pgrx = lib.findFirst (p: p.name == "pgrx") (throw "no pgrx in ${src}/Cargo.lock") lock.package;
      key = lib.replaceStrings [ "." ] [ "_" ] pgrx.version;
      input = inputs."pgrx-${key}" or (throw
        "cargo-pgrx ${pgrx.version} is in neither nixpkgs nor flake.nix: add input pgrx-${key} = { url = \"github:pgcentralfoundation/pgrx/v${pgrx.version}\"; flake = false; };");
    in
    pkgs."cargo-pgrx_${key}" or (pkgs.cargo-pgrx.overrideAttrs {
      version = pgrx.version;
      src = input;
      cargoDeps = cargoDepsFor input;
      cargoBuildFlags = [ "-p" "cargo-pgrx" ];
      doCheck = false;
    });

  cargoDepsFor = src: pkgs.rustPlatform.importCargoLock {
    lockFile = src + "/Cargo.lock";
    allowBuiltinFetchGit = true;
  };

  pgrxArgs = e: src: {
    cargo-pgrx = pgrxFor src;
    cargoDeps = cargoDepsFor src;
    buildFeatures = e.build.features or [ ];
    buildNoDefaultFeatures = e.build.noDefaultFeatures or false;
    doCheck = false;
  } // lib.optionalAttrs ((e.build or { }) ? subdir) { buildAndTestSubdir = e.build.subdir; };

  # Replace nixpkgs' default libraries in every recipe that takes them. libpq is the server's own, without nixpkgs'
  # Kerberos and OAuth client. curl speaks HTTP(S) only: pg_net and http need nothing more, and each protocol left
  # out (GSSAPI, SCP/SFTP, plus the HTTP/3, brotli and PSL that full curl adds) is parsing code reachable from SQL.
  libraries = { libpq = postgresql; curl = pkgs.curlMinimal.override { gssSupport = false; scpSupport = false; }; };

  fromNixpkgs = e:
    let
      src = sourceOf e;
      recipe = ps.${e.nix.package} or pkgs.${e.nix.package};
      base = recipe.override (lib.intersectAttrs (lib.functionArgs recipe.override) libraries);
    in
    base.overrideAttrs (old: {
      version = versionOf e;
      inherit src;
      patches = [ ];
      cargoPatches = [ ];
      # The recipe targets nixpkgs' version; ours may need more libraries or other build options.
      buildInputs = (old.buildInputs or [ ]) ++ inputsOf e;
      nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ attrsOf (e.nix.nativeInputs or [ ]);
      mesonFlags = (old.mesonFlags or [ ]) ++ (e.nix.mesonFlags or [ ]);
      # nixpkgs' Meson hook builds in ./build, which a source's own build/ directory shadows (pgBackRest 2.60 keeps
      # build/config.yaml there); ignored by recipes that do not use Meson.
      mesonBuildDir = "_meson";
      # A newer source than the recipe's can run its own scripts while building (pgBackRest 2.60's build/build.py,
      # "#!/usr/bin/env python3"); the build sandbox has no /usr/bin/env, so point their interpreters into the store.
      postPatch = (old.postPatch or "") + "\npatchShebangs --build .\n";
    } // (if old ? cargoDeps then pgrxArgs e src
    else lib.optionalAttrs ((e.build or { }) ? subdir) { sourceRoot = "source/${e.build.subdir}"; }
      # Set only when the entry has options: an added attribute, even empty, changes every recipe's derivation.
      // lib.optionalAttrs ((e.build or { }) ? makeOptions) { makeFlags = (old.makeFlags or [ ]) ++ e.build.makeOptions; }));
  generic = e:
    let
      src = sourceOf e;
      # PostgreSQL's server headers include OpenSSL's (libpq-be.h, as this server is built with it), so any extension
      # including them needs its headers. GSSAPI's would be needed too if flake.nix turned gssSupport back on.
      common = { pname = e.name; version = versionOf e; buildInputs = [ pkgs.openssl ] ++ inputsOf e; };
    in
    if e.build.type == "cargo-pgrx" then
      pkgs.buildPgrxExtension (common // pgrxArgs e src // { inherit src postgresql; })
    else if e.build.type == "pgxs" then
      postgresqlBuildExtension (common // {
        src = if (e.build or { }) ? subdir then "${src}/${e.build.subdir}" else src;
        # USE_PGXS selects the out-of-tree build in Makefiles that also support contrib/; OPTFLAGS= drops
        # -march=native that some upstreams add, so the image runs on any CPU of its architecture.
        makeFlags = [ "USE_PGXS=1" "OPTFLAGS=" ] ++ (e.build.makeOptions or [ ]);
      })
    else
      throw "${e.name}: build.type ${e.build.type} has no generic Nix build; set nix.package in manifest-data.ts";

  # SQL-only entries (pgflow) have neither a build nor a recipe; the image installs their files from the repo.
  built = builtins.filter (e: e ? build || (e ? nix && e.nix ? package)) enabled;

  # Only the executables an entry names ship (nix.bin, else its binaryPath): nothing calls the rest, and they pull in
  # interpreters (pg_partman's Python helpers). Every entry also passes here, so it takes the server's extra
  # hardening (flake.nix) too.
  pruneBin = e: drv:
    let keep = e.nix.bin or (lib.optional (e ? binaryPath) (baseNameOf e.binaryPath));
    in drv.overrideAttrs (old: {
      hardeningEnable = (old.hardeningEnable or [ ]) ++ hardeningEnable;
    } // lib.optionalAttrs (!(old ? cargoDeps)) {
      # The last -O on a compile line wins, so an upstream Makefile's -O0 (pgsodium's PG_CPPFLAGS) silently undoes
      # PostgreSQL's optimisation and nothing at runtime shows it. Refuse it in every make build, so each unoptimised
      # build is a recorded decision (build.makeOptions clears the variable). Make and CMake builds are checked; Meson's
      # setup hook sets buildPhase (ninja), so Meson builds are not, and cargo builds (no C compile lines) are excluded.
      preBuild = (old.preBuild or "") + ''
        if [ -z "''${buildPhase:-}" ] && [ -e Makefile -o -e makefile -o -e GNUmakefile ]; then
          planFlags=(); concatTo planFlags makeFlags makeFlagsArray buildFlags buildFlagsArray
          if make -n "''${planFlags[@]}" | awk '{ o = ""; for (i = 1; i <= NF; i++) if ($i ~ /^-O/) o = $i } o == "-O0" { print; bad = 1 } END { exit !bad }'; then
            echo "${e.name}: compiles without optimisation (-O0, lines above); clear the Makefile variable adding it with build.makeOptions in manifest-data.ts" >&2
            exit 1
          fi
        fi
      '';
    } // {
      postInstall = (old.postInstall or "") + ''
        if [ -d "$out/bin" ]; then
          for f in "$out"/bin/*; do
            case " ${lib.concatStringsSep " " keep} " in *" $(basename "$f") "*) ;; *) rm -f "$f" ;; esac
          done
          rmdir --ignore-fail-on-non-empty "$out/bin"
        fi
      '' + lib.optionalString (e.name == "pgsodium") ''
        # pgsodium runs <sharedir>/extension/pgsodium_getkey when pgsodium.getkey_script is unset, as on the
        # entrypoint's temporary init server. nixpkgs installs upstream's sample there, which writes an unchecked key
        # into PGDATA, so the default resolves to the image's documented getkey script.
        ln -sf /usr/share/postgresql/${lib.versions.major postgresql.version}/extension/pgsodium_getkey \
          "$out/share/postgresql/extension/pgsodium_getkey"
        # Upstream's example getkey scripts (AWS, GCP, Doppler, …): nothing runs them, and they pull in a second Bash.
        rm -r "$out/share/pgsodium/getkey_scripts"
      '';
    });
in
lib.listToAttrs (map
  (e: lib.nameValuePair e.name (pruneBin e (if e ? nix && e.nix ? package then fromNixpkgs e else generic e)))
  built)
