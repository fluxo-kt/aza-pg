#!/bin/bash
# aza-pg-major-upgrade OLD_PGDATA NEW_PGDATA: upgrades a data directory made by the previous release's PostgreSQL
# major into NEW_PGDATA (empty or absent) with pg_upgrade, run as the server user. The entrypoint calls it when it
# finds an older-major cluster; the upgrade suite calls it directly.
#
# The old server comes from the release pinned in MANIFEST_METADATA.previousImage. Every store path of it that this
# image lacks is a symlink into $STORE (nix/image.nix); this script fills $STORE from that release's layers, so the
# old binaries run from their own absolute /nix/store paths although postgres cannot write the store.
# Data safety: nothing touches OLD_PGDATA until pg_upgrade --check passed; --clone keeps it intact, and when only
# --link works, a failure after linking restores its pg_control so the previous image still starts on it.
set -euo pipefail

old_data=${1:?usage: aza-pg-major-upgrade OLD_PGDATA NEW_PGDATA}
new_data=${2:?usage: aza-pg-major-upgrade OLD_PGDATA NEW_PGDATA}
STORE=/var/lib/postgresql/.aza-old-store
# Line 1: <registry>/<repo>; line 2: the old server's store path; then "<layer digest> <store path>" (nix/image.nix).
LAYERS=/usr/local/share/aza-pg/previous-layers
superuser=${POSTGRES_USER:-postgres}
# pg_upgrade starts both servers itself; timescaledb and pgaudit refuse to load unless preloaded, and pgsodium needs
# its key script. The entrypoint exports its list; a direct call reads the image default from the entrypoint, its owner.
preload=${SHARED_PRELOAD_LIBRARIES:-$(sed -n "s/^readonly DEFAULT_SHARED_PRELOAD_LIBRARIES=\"\(.*\)\"$/\1/p" /usr/local/bin/docker-auto-config-entrypoint.sh)}
server_opts="-c shared_preload_libraries=${preload:?no preload list} -c pgsodium.getkey_script=/usr/share/postgresql/${PG_MAJOR:?}/extension/pgsodium_getkey"
log() { echo "[POSTGRES] [MAJOR-UPGRADE] $*" >&2; }

fetch_old_store() {
  local ref digest path token tmp
  read -r ref <"$LAYERS"
  mkdir -p "$STORE"
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
}

# Older releases made template1 refuse connections, and pg_upgrade needs every database but template0 to accept
# them; single-user mode ignores the flag, so it is lifted on the old cluster and put back on the new one.
set_template1_connections() { # bindir datadir true|false
  echo "ALTER DATABASE template1 ALLOW_CONNECTIONS $3" | "$1/postgres" --single -D "$2" -j postgres >/dev/null
}

restore_old() {
  rm -rf "$new_data"
  [ -f "$old_data/global/pg_control.old" ] && [ ! -f "$old_data/global/pg_control" ] &&
    mv "$old_data/global/pg_control.old" "$old_data/global/pg_control"
  [ "${template1_closed:-no}" = no ] || set_template1_connections "$old_bin" "$old_data" false
  log "ERROR: upgrade failed; ${old_data} is unchanged and the previous image still starts on it"
}

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
cd "$new_data"
mode=--link
pg_upgrade -b "$old_bin" -B "$new_bin" -d "$old_data" -D "$new_data" -U "$superuser" -o "$server_opts" -O "$server_opts" --check --clone >/dev/null 2>&1 && mode=--clone
log "upgrading ${old_data} into ${new_data} (pg_upgrade ${mode})"
pg_upgrade -b "$old_bin" -B "$new_bin" -d "$old_data" -D "$new_data" -U "$superuser" -o "$server_opts" -O "$server_opts" "$mode" >&2
trap - ERR
[ "$template1_closed" = no ] || set_template1_connections "$new_bin" "$new_data" false
log "done: ${new_data} holds the upgraded cluster"
