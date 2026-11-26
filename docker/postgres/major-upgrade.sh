#!/bin/bash
# aza-pg-major-upgrade OLD_PGDATA NEW_PGDATA: upgrades a data directory made by the previous release's PostgreSQL
# major into NEW_PGDATA (empty or absent) with pg_upgrade, run as the server user. Only the entrypoint calls it, when it
# finds an older-major cluster beside an empty PGDATA, passing the server settings it owns (below).
#
# The old server comes from the release pinned in MANIFEST_METADATA.previousImage. Every store path of it that this
# image lacks is a symlink into $STORE (nix/image.nix); this script fills $STORE from that release's layers, so the
# old binaries run from their own absolute /nix/store paths although postgres cannot write the store.
# Data safety: nothing touches OLD_PGDATA until pg_upgrade's consistency checks passed; --clone keeps it intact, and when only
# --link works, a failure after linking restores its pg_control so the previous image still starts on it.
set -Eeuo pipefail # -E: the ERR traps below also fire inside functions

old_data=${1:?usage: aza-pg-major-upgrade OLD_PGDATA NEW_PGDATA}
new_data=${2:?usage: aza-pg-major-upgrade OLD_PGDATA NEW_PGDATA}
STORE=/var/lib/postgresql/.aza-old-store
# Line 1: <registry>/<repo>; line 2: the old server's store path; then "<layer digest> <store path>" (nix/image.nix).
LAYERS=/usr/local/share/aza-pg/previous-layers
superuser=${POSTGRES_USER:-postgres}
# pg_upgrade starts both servers itself; timescaledb and pgaudit refuse to load unless preloaded, and pgsodium needs
# its key script; the entrypoint passes the values the server will run with. Neither server archives: their WAL belongs
# to no backup history, and a carried archive_command fails against the not yet upgraded pgBackRest stanza, its retries
# holding every server stop for about 4 s (measured: four such stops per upgrade).
server_opts="-c shared_preload_libraries=${SHARED_PRELOAD_LIBRARIES:?} -c pgsodium.getkey_script=${PGSODIUM_GETKEY_PATH:?} -c archive_mode=off"
log() { echo "[POSTGRES] [MAJOR-UPGRADE] $*" >&2; }

fetch_old_store() {
  local image ref digest path token tmp
  read -r image <"$LAYERS"
  ref=${image%%@*} && ref=${ref%:*} # registry/repo: the tag and digest dropped
  mkdir -p "$STORE"
  trap 'fetch_failed "$ref" "$image"' ERR
  tmp=$(mktemp -d -p "$STORE")
  trap 'rm -rf "$tmp"' RETURN
  token=$(curl -fsS "https://${ref%%/*}/token?scope=repository:${ref#*/}:pull" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
  while read -r digest path; do
    # A real directory: this image ships the same path. Already in $STORE: fetched by an earlier, interrupted run.
    [ -L "/nix/store/$path" ] && [ ! -e "$STORE/$path" ] || continue
    log "fetching ${path} from ${ref}"
    curl -fsSL -H "Authorization: Bearer $token" -o "$tmp/layer" "https://${ref%%/*}/v2/${ref#*/}/blobs/$digest"
    echo "${digest#sha256:}  $tmp/layer" | sha256sum -c --quiet
    mkdir "$tmp/x"
    zstd -dcq "$tmp/layer" | tar -x -C "$tmp/x" --strip-components=2
    # Store directories arrive read-only (0555); moving a directory rewrites its "..", and cleanup deletes inside it.
    chmod -R u+w "$tmp/x/$path"
    mv "$tmp/x/$path" "$STORE/$path"
    rm -rf "$tmp/x" "$tmp/layer"
  done < <(tail -n +3 "$LAYERS")
  trap - ERR
}

# Store paths this image links to $STORE that are not there yet.
missing_paths() {
  local _digest path
  while read -r _digest path; do
    if [ -L "/nix/store/$path" ] && [ ! -e "$STORE/$path" ]; then printf '/nix/store/%s ' "$path"; fi
  done < <(tail -n +3 "$LAYERS")
}

# Without the registry (an offline host, an outage) nothing has touched the data yet: stop with the one command that
# fills $STORE from the previous image itself, which holds exactly these paths; the next start then skips the fetch.
fetch_failed() { # registry/repo, pinned image
  log "ERROR: cannot download the previous release's server from $1. Copy it from that image instead, then start again:"
  echo "  docker run --rm -v <your data volume>:/var/lib/postgresql --entrypoint sh $2 -c 'mkdir -p $STORE && cp -a $(missing_paths)$STORE/'" >&2
  exit 1
}

# Older releases made template1 refuse connections, and pg_upgrade needs every database but template0 to accept
# them; single-user mode ignores the flag, so it is lifted on the old cluster and put back on the new one.
set_template1_connections() { # bindir datadir true|false
  echo "ALTER DATABASE template1 ALLOW_CONNECTIONS $3" | "$1/postgres" --single -D "$2" -j postgres >/dev/null
}

restore_old() {
  find "$new_data" -mindepth 1 -delete # the directory itself is the entrypoint's lock
  [ -f "$old_data/global/pg_control.old" ] && [ ! -f "$old_data/global/pg_control" ] &&
    mv "$old_data/global/pg_control.old" "$old_data/global/pg_control"
  [ "${template1_closed:-no}" = no ] || set_template1_connections "$old_bin" "$old_data" false
  log "ERROR: upgrade failed; ${old_data} is unchanged and the previous image still starts on it"
}

# A previous-image container still running on OLD_PGDATA (releases before the entrypoint flock never lock it) would see
# its files change under it; pg_upgrade checks only postmaster.pid, which the other container may not have written yet.
exec {old_lock}<"$old_data"
flock -n "$old_lock" || { log "ERROR: another container uses ${old_data}; stop it first"; exit 1; }
fetch_old_store
old_bin="/nix/store/$(sed -n 2p "$LAYERS")/bin"
new_bin=$(dirname "$(readlink -f "$(command -v postgres)")")
checksums=--no-data-checksums
"$old_bin/pg_controldata" "$old_data" | grep -q '^Data page checksum version: *[1-9]' && checksums=--data-checksums

trap restore_old ERR
template1_closed=$(echo "SELECT datallowconn FROM pg_database WHERE datname = 'template1'" |
  "$old_bin/postgres" --single -D "$old_data" -j postgres | grep -q 'datallowconn = "f"' && echo yes || echo no)
[ "$template1_closed" = no ] || set_template1_connections "$old_bin" "$old_data" true
initdb -D "$new_data" -U "$superuser" "$checksums" >/dev/null
# pg_upgrade moves relation data only. Everything else at OLD_PGDATA's top level is the operator's state and travels:
# configuration (pg_hba.conf's scram rules, ALTER SYSTEM's postgresql.auto.conf), pgsodium's root key (a new one
# would leave every encrypted value unreadable), the migration marker, TLS files. Copied before pg_upgrade starts the
# new server, so the key script finds the old key instead of minting one, and a setting the new major rejects fails
# inside pg_upgrade, which rolls back. PostgreSQL's own directories and runtime files stay behind.
shopt -s dotglob nullglob
for entry in "$old_data"/*; do
  # PostgreSQL's directories are base, global and pg_*; pg_hba.conf and pg_ident.conf share the prefix but are files.
  [ -d "$entry" ] && case ${entry##*/} in base | global | pg_*) true ;; *) false ;; esac && continue
  case ${entry##*/} in
    PG_VERSION | postmaster.pid | postmaster.opts | current_logfiles) ;;
    *) cp -a "$entry" "$new_data/" ;;
  esac
done
shopt -u dotglob nullglob
cd /tmp # pg_upgrade writes its logs and delete_old_cluster.sh to the working directory
# --clone (reflinks: OLD_PGDATA stays a usable rollback, no extra space) needs the filesystem to clone between the two
# directories, which is what cp --reflink=always does; --link otherwise. A file probe costs milliseconds, a
# pg_upgrade --check probe a second full consistency pass.
mode=--link
cp --reflink=always "$old_data/PG_VERSION" "$new_data/.clone-probe" 2>/dev/null && mode=--clone
rm -f "$new_data/.clone-probe"
log "upgrading ${old_data} into ${new_data} (pg_upgrade ${mode})"
pg_upgrade -b "$old_bin" -B "$new_bin" -d "$old_data" -D "$new_data" -U "$superuser" -o "$server_opts" -O "$server_opts" "$mode" >&2
trap - ERR
# The carried marker tells the entrypoint's first-start migration which server the data last ran on. A cluster pg_upgrade
# just made has never been migrated by this image, so a marker naming this very server (previous release built from the
# same server, as in the same-major upgrade suite) would skip that migration: drop it, and the migration runs.
[ "$(cat "$new_data/aza-pg-image" 2>/dev/null)" != "$(readlink -f "$(command -v postgres)")" ] || rm "$new_data/aza-pg-image"
[ "$template1_closed" = no ] || set_template1_connections "$new_bin" "$new_data" false
chmod -R u+w "$STORE" && rm -rf "$STORE" # the old server is never needed again: OLD_PGDATA rolls back with the previous image
# OLD_PGDATA stays: --clone and --link share its blocks or files with NEW_PGDATA, so deleting it frees little, and until
# the new server starts it is the rollback (pg_upgrade docs, --link).
log "done: ${new_data} holds the upgraded cluster; ${old_data} is kept (the rollback with --clone; unusable with --link once the new server starts): delete it when done"
