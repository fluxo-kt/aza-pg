#!/bin/bash
# pgsodium root key for this server, as 64 hex characters on stdout. pgsodium and supabase_vault run this
# from their preload (_PG_init) at every server start; a failure stops the server, by design: running
# without the key would silently disable encryption the database may depend on.
#
# The image ships no key. The key is the operator's PGSODIUM_KEY_FILE when set, else pgsodium_root.key in
# the data directory, which this script creates from /dev/urandom at the first start of a new data
# directory (run by the preload, or by initdb script 00-pgsodium-key.sh when nothing preloads pgsodium):
# every database gets its own key, and file-level copies (backups, pg_basebackup replicas) carry it. An operator file is never created here: a missing one means a wrong path, and a new
# random key would make data encrypted under the intended key unreadable. Both inputs are container
# environment, so a server restarted through `docker exec ... pg_ctl` finds the same key. The entrypoint
# validates PGSODIUM_KEY_FILE and keeps the old published key for data directories that predate this
# scheme; see docs/PGSODIUM-SETUP.md.
set -euo pipefail

if [ -n "${PGSODIUM_KEY_FILE:-}" ]; then
    key_file="$PGSODIUM_KEY_FILE"
else
    key_file="${PGDATA:?PGDATA is unset; it comes from the postgres base image}/pgsodium_root.key"
    if [ ! -e "$key_file" ]; then
        umask 077
        # od -v: without it od collapses repeated lines to "*".
        head -c 32 /dev/urandom | od -An -v -tx1 | tr -d ' \n' > "${key_file}.new"
        mv "${key_file}.new" "$key_file"
    fi
fi
key=$(tr -d '[:space:]' < "$key_file")
if ! [[ "$key" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "pgsodium_getkey: ${key_file} must hold 64 hex characters (32 bytes)" >&2
    exit 1
fi
printf '%s\n' "$key"
