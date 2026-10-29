# The aza-pg container image built from Nix store paths only: PostgreSQL with every manifest entry, the few tools the
# shell scripts call, and the image's own files at the paths the Debian image and its documentation use, so stacks,
# deployments and operators see the same contract. No package manager, no Perl or Python; Bash is the one interpreter.
#
# Runtime userland, each with what needs it; a tool nothing here names has no job in the image:
#   bash                  docker-auto-config-entrypoint.sh, upstream docker-entrypoint.sh, init scripts
#   uutils coreutils      cat/chmod/cut/env/id/mktemp/nproc/od/seq/sort/tr…; Rust drop-in for GNU coreutils
#   gnugrep gnused gawk   entrypoint parsing; no drop-in Rust replacements exist
#   findutils             upstream entrypoint (find on PGDATA ownership), xargs in init scripts
#   diffutils             cmp: is pgsodium_getkey the image's own (entrypoint)
#   getent                upstream entrypoint (is the running uid in /etc/passwd?)
#   mountpoint (ours)     upstream entrypoint; nix/bin/mountpoint, instead of util-linux
#   gzip xz zstd          upstream entrypoint: /docker-entrypoint-initdb.d/*.sql.gz|.xz|.zst
#   su-exec (as gosu)     `--user root`: upstream and ours drop to postgres with `gosu postgres`
#   cacert                pg_net and http make HTTPS requests
#   locales               lc_monetary/lc_numeric/lc_time per session (MANIFEST_METADATA.locales)
{ pkgs, lib, postgresql, manifest, upstreamEntrypoint, source }:
let
  meta = manifest.metadata;
  pgMajor = lib.versions.major meta.pgVersion;
  root = ../.;
  src = p: root + "/${p}";

  # Same command as the Debian image's localedef loop, so both ship the same locales under the same names.
  locales = pkgs.runCommand "aza-pg-locales" { nativeBuildInputs = [ pkgs.glibc.bin ]; } ''
    export I18NPATH=${pkgs.glibc}/share/i18n
    # localedef writes <prefix><glibc's compiled-in locale dir>/locale-archive and creates no directories.
    archive="$TMPDIR/p${pkgs.glibc}/lib/locale"
    mkdir -p "$archive" $out/lib/locale
    for l in ${lib.escapeShellArgs meta.locales}; do
      localedef --prefix="$TMPDIR/p" -i "$l" -c -f UTF-8 "$l.UTF-8"
    done
    mv "$archive/locale-archive" $out/lib/locale/locale-archive
  '';

  # nixpkgs' pg_config sources an env file recording the whole build (CC, CFLAGS, -dev include paths, PERL=…), so
  # shipping it as is pulled the compiler toolchain, headers and docs (about 2.3 GB) into the image. This copy keeps
  # every store path the server's own closure already holds (bindir, sharedir, pkglibdir: what the entrypoint, the
  # pg_repack wrapper and operators ask for) and blanks the rest to Nix's removed-reference form.
  pgConfig = pkgs.runCommand "pg_config" { closure = pkgs.closureInfo { rootPaths = [ postgresql ]; }; } ''
    src=${postgresql.pg_config}/bin/pg_config
    env=$(sed -n 's/^source //p' "$src")
    mkdir -p $out/bin
    awk 'NR == FNR { keep[substr($0, 12, 32)] = 1; next }
      { line = ""
        while (match($0, /\/nix\/store\/[a-z0-9]{32}-/)) {
          h = substr($0, RSTART + 11, 32)
          line = line substr($0, 1, RSTART - 1) "/nix/store/" (h in keep ? h : "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") "-"
          $0 = substr($0, RSTART + RLENGTH)
        }
        print line $0 }' "$closure/store-paths" "$env" > $out/pg_config.env
    { echo "#!${pkgs.bashNonInteractive}/bin/bash"; sed "1d; s|^source .*|source $out/pg_config.env|" "$src"; } > $out/bin/pg_config
    chmod +x $out/bin/pg_config
  '';

  # The image's own files, at the Debian image's paths.
  files = pkgs.runCommand "aza-pg-files" { } ''
    install -Dm0755 ${src "docker/postgres/docker-auto-config-entrypoint.sh"} $out/usr/local/bin/docker-auto-config-entrypoint.sh
    install -Dm0755 ${upstreamEntrypoint} $out/usr/local/bin/docker-entrypoint.sh
    install -Dm0755 ${src "docker/postgres/healthcheck.sh"} $out/usr/local/bin/healthcheck.sh
    install -Dm0755 ${src "docker/postgres/pgflow/pgflow-upgrade.sh"} $out/usr/local/bin/pgflow-upgrade
    install -Dm0755 ${src "docker/postgres/pg_repack-wrapper.sh"} $out/usr/local/bin/pg_repack
    install -Dm0755 ${./bin/mountpoint} $out/usr/local/bin/mountpoint
    ln -s ${pkgs.su-exec}/bin/su-exec $out/usr/local/bin/gosu
    # The documented mount point for an operator's own script (the entrypoint sets pgsodium.getkey_script to it); the
    # second, never-run copy lets the entrypoint tell the image's script from a mounted one.
    install -Dm0755 ${src "docker/postgres/pgsodium_getkey.sh"} $out/usr/share/postgresql/${pgMajor}/extension/pgsodium_getkey
    install -Dm0755 ${src "docker/postgres/pgsodium_getkey.sh"} $out/usr/local/share/aza-pg/pgsodium_getkey

    install -Dm0644 ${src "docker/postgres/configs/postgresql-base.conf"} $out/etc/postgresql/postgresql-base.conf
    install -Dm0644 ${src "docker/postgres/IMAGE-CONTENTS.txt"} $out/etc/postgresql/version-info.txt
    install -Dm0644 ${src "docker/postgres/extensions.manifest.json"} $out/etc/postgresql/extensions.manifest.json

    mkdir -p $out/docker-entrypoint-initdb.d
    cp ${src "docker/postgres/docker-entrypoint-initdb.d"}/* $out/docker-entrypoint-initdb.d/
    chmod 0755 $out/docker-entrypoint-initdb.d/*.sh

    install -Dm0644 ${src "tests/fixtures/pgflow/schema.sql"} $out/opt/pgflow/schema.sql
    install -Dm0644 ${src "docker/postgres/pgflow/security-patches.sql"} $out/opt/pgflow/security-patches.sql
    install -Dm0644 ${src "docker/postgres/pgflow/structure-hash.sql"} $out/opt/pgflow/structure-hash.sql
    install -Dm0644 ${src "docker/postgres/pgflow/legacy-structure.tsv"} $out/opt/pgflow/legacy-structure.tsv
    cp -r ${src "tests/fixtures/pgflow/upgrade"} $out/opt/pgflow/upgrade

    # A tool's binaryPath (manifest) is where operators and the image check find it, e.g. /usr/bin/pgbackrest.
    ${lib.concatMapStrings (e: ''
      mkdir -p $out/$(dirname ${e.binaryPath})
      ln -s ${postgresql}/bin/$(basename ${e.binaryPath}) $out${e.binaryPath}
    '') (builtins.filter (e: (e.enabled or true) && e ? binaryPath) manifest.entries)}

    # PGDG and Debian users carry uid/gid 999, and data directories created by the Debian image are owned by it.
    mkdir -p $out/etc
    echo 'root:x:0:0:root:/root:/bin/bash' > $out/etc/passwd
    echo 'postgres:x:999:999:PostgreSQL:/var/lib/postgresql:/bin/bash' >> $out/etc/passwd
    printf 'root:x:0:\npostgres:x:999:\n' > $out/etc/group
  '';

  # Directories a tool writes by default (manifest postgresOwnedDirs), created postgres:0750 as on Debian so a named
  # volume mounted there starts writable by the server's user.
  ownedDirs = lib.concatMap (e: e.postgresOwnedDirs or [ ])
    (builtins.filter (e: e.enabled or true) manifest.entries);
  relative = map (lib.removePrefix "/") ownedDirs;

  tools = [
    pkgs.bashNonInteractive
    pkgs.uutils-coreutils-noprefix
    pkgs.gnugrep
    pkgs.gnused
    pkgs.gawk
    pkgs.findutils
    pkgs.diffutils
    pkgs.getent
    pkgs.gzip
    pkgs.xz
    pkgs.zstd
  ];
in
pkgs.dockerTools.streamLayeredImage {
  name = "aza-pg";
  tag = "pg${pgMajor}-nix";
  # pgConfig reports the combined installation's paths (sharedir, pkglibdir), which the entrypoint,
  # the pg_repack wrapper and the image checks read; the server package itself ships no pg_config.
  contents = [ postgresql pgConfig files pkgs.cacert ] ++ tools;
  # /bin/sh, /bin/bash and /usr/bin/env: script shebangs (ours, operators') and `docker exec … sh -c`.
  extraCommands = ''
    # /var/run is a link to /run as on Debian: Nix's server defaults its socket to /run/postgresql, the entrypoint
    # and operators use /var/run/postgresql.
    mkdir -p bin usr/bin tmp run/postgresql var/lib/postgresql backup ${lib.escapeShellArgs relative}
    ln -s ../run var/run
    # initdb names the zone it finds here in each new postgresql.conf (log_timezone, timezone): Etc/UTC, as on Debian.
    mkdir -p etc && ln -s ${pkgs.tzdata}/share/zoneinfo/Etc/UTC etc/localtime
    ln -sf ${pkgs.uutils-coreutils-noprefix}/bin/env usr/bin/env
    ln -sf ${pkgs.bashNonInteractive}/bin/bash bin/bash
    ln -sf ${pkgs.bashNonInteractive}/bin/bash bin/sh
    chmod 1777 tmp
  '';
  fakeRootCommands = ''
    chown -R 999:999 run/postgresql var/lib/postgresql backup
    chmod 2775 run/postgresql
    # As the official image: initdb as any uid can create PGDATA here, and a tmpfs mounted over it takes this mode.
    chmod 1777 var/lib/postgresql
    ${lib.optionalString (relative != [ ]) "chown 999:999 ${lib.escapeShellArgs relative} && chmod 0750 ${lib.escapeShellArgs relative}"}
  '';
  enableFakechroot = false;
  config = {
    User = "postgres";
    Entrypoint = [ "/usr/local/bin/docker-auto-config-entrypoint.sh" ];
    Cmd = [ "postgres" ];
    ExposedPorts."5432/tcp" = { };
    Env = [
      "PATH=/usr/local/bin:${lib.makeBinPath ([ postgresql pgConfig ] ++ tools)}"
      "PG_MAJOR=${pgMajor}"
      "PG_VERSION=${meta.pgVersion}"
      "PGDATA=/var/lib/postgresql/${pgMajor}/docker"
      "LANG=en_US.UTF-8"
      # Nix's glibc reads locales from here, not from /usr/lib/locale.
      "LOCALE_ARCHIVE=${locales}/lib/locale/locale-archive"
      "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
    ];
    Volumes."/var/lib/postgresql" = { };
    Healthcheck = {
      Test = [ "CMD" "/usr/local/bin/healthcheck.sh" ];
      Interval = 10000000000;
      Timeout = 5000000000;
      StartPeriod = 120000000000;
      Retries = 3;
    };
    Labels = {
      "org.opencontainers.image.vendor" = "fluxo-kt";
      "org.opencontainers.image.title" = "aza-pg PostgreSQL ${meta.pgVersion}";
      "org.opencontainers.image.version" = meta.pgVersion;
      "org.opencontainers.image.description" = "PostgreSQL ${meta.pgVersion} with curated extension bundle (vector, time-series, search, security, ops)";
      # From the flake's git metadata, not the build clock, so the same commit builds the same image. A dirty tree
      # has no rev: such a build is never a release.
      "org.opencontainers.image.revision" = source.rev or source.dirtyRev or "unknown";
      "org.opencontainers.image.created" =
        let d = source.lastModifiedDate; s = lib.substring; in
        "${s 0 4 d}-${s 4 2 d}-${s 6 2 d}T${s 8 2 d}:${s 10 2 d}:${s 12 2 d}Z";
    };
  };
}
