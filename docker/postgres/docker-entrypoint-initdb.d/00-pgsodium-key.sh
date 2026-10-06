#!/bin/bash
# Runs only for a new data directory. It records where the directory's pgsodium root key comes from, so a later
# start can tell it apart from a data directory made by an image that predates per-database keys: those keep the
# published key, which the auto-config entrypoint writes only when this record is absent, and with the record a
# missing key stops the server naming its source instead. The data-directory key is created here as well, because
# pgsodium_getkey otherwise creates it only when a preloaded pgsodium or supabase_vault runs it.
set -euo pipefail

getkey="/usr/share/postgresql/${PG_MAJOR}/extension/pgsodium_getkey"
if cmp -s "$getkey" /usr/local/share/aza-pg/pgsodium_getkey; then
    image_getkey=true
elif [ $? -eq 1 ]; then
    image_getkey=false
else
    echo "00-pgsodium-key: cannot compare pgsodium_getkey with the image's copy" >&2
    exit 1
fi
if [ "$image_getkey" = false ]; then
    source=pgsodium_getkey # the operator mounted their own script, which owns the key
elif [ -n "${PGSODIUM_KEY_FILE:-}" ]; then
    source=PGSODIUM_KEY_FILE
else
    "$getkey" > /dev/null
    source="data directory"
fi
printf '%s\n' "$source" > "$PGDATA/pgsodium_key_source"
