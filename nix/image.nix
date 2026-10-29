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
#   gzip xz zstd          upstream entrypoint: /docker-entrypoint-initdb.d/*.sql.gz|.xz|.zst
#   su-exec (as gosu)     `--user root`: upstream and ours drop to postgres with `gosu postgres`
#   cacert                pg_net and http make HTTPS requests
#   locales               lc_monetary/lc_numeric/lc_time per session (MANIFEST_METADATA.locales)
{ pkgs, lib, postgresql, manifest, upstreamEntrypoint }:
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

  # The image's own files, at the Debian image's paths.
  files = pkgs.runCommand "aza-pg-files" { } ''
    install -Dm0755 ${src "docker/postgres/docker-auto-config-entrypoint.sh"} $out/usr/local/bin/docker-auto-config-entrypoint.sh
    install -Dm0755 ${upstreamEntrypoint} $out/usr/local/bin/docker-entrypoint.sh
    install -Dm0755 ${src "docker/postgres/healthcheck.sh"} $out/usr/local/bin/healthcheck.sh
    install -Dm0755 ${src "docker/postgres/pgflow/pgflow-upgrade.sh"} $out/usr/local/bin/pgflow-upgrade
    install -Dm0755 ${src "docker/postgres/pg_repack-wrapper.sh"} $out/usr/local/bin/pg_repack
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
  # postgresql.pg_config reports the combined installation's paths (sharedir, pkglibdir), which the entrypoint,
  # the pg_repack wrapper and the image checks read; the server package itself ships no pg_config.
  contents = [ postgresql postgresql.pg_config files pkgs.cacert ] ++ tools;
  # /bin/sh, /bin/bash and /usr/bin/env: script shebangs (ours, operators') and `docker exec … sh -c`.
  extraCommands = ''
    mkdir -p bin usr/bin tmp var/run/postgresql var/lib/postgresql backup
    ln -sf ${pkgs.uutils-coreutils-noprefix}/bin/env usr/bin/env
    ln -sf ${pkgs.bashNonInteractive}/bin/bash bin/bash
    ln -sf ${pkgs.bashNonInteractive}/bin/bash bin/sh
    chmod 1777 tmp
  '';
  fakeRootCommands = ''
    chown -R 999:999 var/run/postgresql var/lib/postgresql backup
    chmod 2775 var/run/postgresql
  '';
  enableFakechroot = false;
  config = {
    User = "postgres";
    Entrypoint = [ "/usr/local/bin/docker-auto-config-entrypoint.sh" ];
    Cmd = [ "postgres" ];
    ExposedPorts."5432/tcp" = { };
    Env = [
      "PATH=/usr/local/bin:${lib.makeBinPath ([ postgresql postgresql.pg_config ] ++ tools)}"
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
    };
  };
}
